import { randomUUID } from "node:crypto";
import type { Issue, IssueExecutionPolicy } from "@paperclipai/shared";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { resolveConfig, type UpstreamConfig } from "./config.js";
import { stateKey } from "./state.js";

/**
 * Review-guard (TWO-5794): a code card must never sit in `in_review` with no
 * live reviewer. There is no project/company default `executionPolicy` — the
 * creator's stages (or lack of them) are all the card gets — so this guard
 * stamps the configured default stages onto code cards that reach `in_review`
 * (or are created as code work) without one, and stamps an audit comment.
 *
 * SDK contract used (stock SDK, no core patch):
 * - `ctx.events.on("issue.created" | "issue.updated")` — needs `events.subscribe`.
 *   Events carry `companyId` + `entityId`; the guard re-reads the issue via
 *   `ctx.issues.get`, so no payload shape is assumed.
 * - `ctx.issues.update(issueId, patch, companyId)` — needs `issues.update`. The
 *   typed surface is `Partial<Pick<Issue, …>>` (a creator-subset), but the wire
 *   protocol is `patch: Record<string, unknown>` and the host `updateIssueSchema`
 *   (`createIssueBaseSchema.omit(…).partial()`, omitting only `createdByUserId`/
 *   `responsibleUserId`/`watchdog`) accepts `executionPolicy`. The patch is cast
 *   once, in `applyReviewPolicy`, with this citation.
 * - `ctx.issues.createComment` — needs `issue.comments.create`; the audit stamp.
 *
 * Idempotence / loop safety: an `issue.updated` caused by the guard's own
 * `issues.update` re-enters the handler, sees a live reviewer stage (or
 * `auto` mode), and returns without writing. The `applied` plugin-state record
 * additionally dedupes the audit comment across event/sweep retries.
 */

export type ReviewGuardOutcome =
  | { applied: true; stages: number; commented: boolean }
  | { applied: false; reason: "disabled" | "not-code-card" | "has-stages" | "auto-mode" | "unconfigured" | "dry-run" };

/** Code work = bound to a project workspace (a repo). Per TWO-5794, workspace presence is the signal. */
export const isReviewCodeCard = (issue: Pick<Issue, "projectWorkspaceId">): boolean =>
  typeof issue.projectWorkspaceId === "string" && issue.projectWorkspaceId.length > 0;

/** A card already has a live reviewer stage (or an explicit `auto` opt-out) that the guard must not touch. */
export const hasLiveReviewStage = (issue: Pick<Issue, "executionPolicy">): boolean => {
  const policy = issue.executionPolicy;
  if (!policy) return false;
  if (policy.mode === "auto") return true;
  return Array.isArray(policy.stages) && policy.stages.length > 0;
};

/** Per-project override wins; otherwise the company default. */
export const pickReviewAgentIds = (
  config: Pick<UpstreamConfig, "defaultReviewAgentIds" | "reviewAgentIdsByProjectId">,
  issue: Pick<Issue, "projectId">,
): string[] => {
  if (issue.projectId) {
    const override = config.reviewAgentIdsByProjectId[issue.projectId];
    if (override && override.length > 0) return override;
  }
  return config.defaultReviewAgentIds;
};

/** Host shape (`issueExecutionPolicySchema`): `normal` mode, one `review` stage per reviewer, `approvalsNeeded: 1`. */
export const buildReviewPolicy = (agentIds: string[]): IssueExecutionPolicy => ({
  mode: "normal",
  commentRequired: true,
  stages: agentIds.map((agentId) => ({
    id: randomUUID(),
    type: "review",
    approvalsNeeded: 1,
    participants: [{ id: randomUUID(), type: "agent", agentId }],
  })),
});

type AppliedRecord = Record<string, { at: string; stages: number }>;

const readApplied = async (ctx: PluginContext, companyId: string): Promise<AppliedRecord> =>
  ((await ctx.state.get(stateKey(companyId, "review-guard.applied"))) as AppliedRecord | null) ?? {};

const writeApplied = async (ctx: PluginContext, companyId: string, applied: AppliedRecord): Promise<void> => {
  await ctx.state.set(stateKey(companyId, "review-guard.applied"), applied);
};

/**
 * Ensure one issue carries the default review policy. Returns what happened so
 * sweeps can count and tests can pin the contract. Never throws for a
 * legitimate no-op; plugin-internal failures (update/comment) propagate so the
 * host logs them and the sweep retries next tick.
 */
export async function ensureReviewPolicy(
  ctx: PluginContext,
  companyId: string,
  issue: Issue,
  config: Pick<UpstreamConfig, "reviewGuardEnabled" | "reviewGuardDryRun" | "defaultReviewAgentIds" | "reviewAgentIdsByProjectId">,
): Promise<ReviewGuardOutcome> {
  if (!config.reviewGuardEnabled) return { applied: false, reason: "disabled" };
  if (!isReviewCodeCard(issue)) return { applied: false, reason: "not-code-card" };
  const policy = issue.executionPolicy;
  if (policy && policy.mode === "auto") return { applied: false, reason: "auto-mode" };
  if (hasLiveReviewStage(issue)) return { applied: false, reason: "has-stages" };

  const agentIds = pickReviewAgentIds(config, issue);
  if (agentIds.length === 0) {
    // Fail closed when unconfigured: never invent a reviewer.
    ctx.logger.info("review-guard skipped: no review agent IDs configured for company", { companyId, issueId: issue.id });
    return { applied: false, reason: "unconfigured" };
  }

  if (config.reviewGuardDryRun) {
    ctx.logger.info("review-guard dry-run: would stamp default review policy", {
      companyId,
      issueId: issue.id,
      stages: agentIds.length,
    });
    return { applied: false, reason: "dry-run" };
  }

  const applied = await readApplied(ctx, companyId);
  const alreadyStamped = applied[issue.id] !== undefined;

  // Cast cites the module header: the wire protocol is `Record<string, unknown>`
  // and the host `updateIssueSchema` accepts `executionPolicy`; the SDK's typed
  // Pick is a creator-subset, not the wire contract.
  const next = await ctx.issues.update(
    issue.id,
    { executionPolicy: buildReviewPolicy(agentIds) } as never,
    companyId,
  );
  const stageCount = next.executionPolicy?.stages?.length ?? agentIds.length;

  // Audit-stamp once: if the state record is already there (event + sweep both
  // raced the same card), skip the duplicate comment. If the comment fails, the
  // record is not written, so the next sweep retries the stamp.
  let commented = false;
  if (!alreadyStamped) {
    await ctx.issues.createComment(
      issue.id,
      `Default review policy applied by review-guard: ${stageCount} reviewer stage${stageCount === 1 ? "" : "s"} (config: ${issue.projectId ? `project override ${issue.projectId}` : "company default"}).`,
      companyId,
    );
    commented = true;
    await writeApplied(ctx, companyId, {
      ...applied,
      [issue.id]: { at: new Date().toISOString(), stages: stageCount },
    });
  }

  ctx.logger.info("review-guard applied default review policy", {
    companyId,
    issueId: issue.id,
    stages: stageCount,
    commented,
  });
  return { applied: true, stages: stageCount, commented };
}

/** Handle one `issue.created` / `issue.updated` event. Fail-closed on missing config, like the scans. */
export const handleReviewEvent = async (ctx: PluginContext, event: PluginEvent): Promise<void> => {
  if (event.entityType && event.entityType !== "issue") return;
  const issueId = typeof event.entityId === "string" && event.entityId.length > 0 ? event.entityId : null;
  if (!issueId) return;
  const companyId = event.companyId;
  if (!companyId) return;

  const raw = await ctx.config.get(companyId);
  if (!raw || Object.keys(raw).length === 0) {
    ctx.logger.info("review-guard event skipped: no plugin config for company", { companyId, issueId });
    return;
  }
  const config = resolveConfig(raw);
  if (!config.reviewGuardEnabled) return;

  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue) return;
  // Belt-and-braces on the event-time trigger conditions (TWO-5794): code cards
  // at creation always covered; afterwards the `in_review` entry is what matters.
  // The `ensures` below is idempotent, so also covering the created-but-not-yet
  // `in_review` case is what stamps the policy before review begins.
  await ensureReviewPolicy(ctx, companyId, issue, config);
};

/** Sweep backstop: every `in_review` card in the company, newest contract first. */
export const SWEEP_PAGE = 100;

export async function runReviewGuardSweep(
  ctx: PluginContext,
  companyId: string,
  config: Pick<UpstreamConfig, "reviewGuardEnabled" | "reviewGuardDryRun" | "defaultReviewAgentIds" | "reviewAgentIdsByProjectId">,
): Promise<{ checked: number; applied: number; skipped: Record<string, number> }> {
  const skipped: Record<string, number> = {};
  const tally = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  let checked = 0;
  let appliedCount = 0;
  if (!config.reviewGuardEnabled) {
    tally("disabled");
    return { checked, applied: appliedCount, skipped };
  }
  let offset = 0;
  for (;;) {
    const rows = await ctx.issues.list({ companyId, status: "in_review", limit: SWEEP_PAGE, offset });
    if (rows.length === 0) break;
    for (const row of rows) {
      checked += 1;
      const outcome = await ensureReviewPolicy(ctx, companyId, row, config);
      if (outcome.applied) appliedCount += 1;
      else tally(outcome.reason);
    }
    if (rows.length < SWEEP_PAGE) break;
    offset += rows.length;
  }
  ctx.logger.info("review-guard sweep finished", { companyId, checked, applied: appliedCount, skipped });
  return { checked, applied: appliedCount, skipped };
}
