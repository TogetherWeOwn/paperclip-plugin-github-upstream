import { randomUUID } from "node:crypto";
import type { Issue, IssueExecutionPolicy } from "@paperclipai/shared";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { resolveConfig, type UpstreamConfig } from "./config.js";
import { needsSecurityReview, resolveReviewTier, type ResolvedTier, type RiskTier } from "./review-tiers.js";
import { stateKey } from "./state.js";

/**
 * Review-guard (TWO-5794 + TWO-5879): a code card must never sit in
 * `in_review` with no live reviewer. There is no project/company default
 * `executionPolicy` — the creator's stages (or lack of them) are all the
 * card gets — so this guard stamps the configured default stages onto code
 * cards that reach `in_review` (or are created as code work) without one,
 * and stamps an audit comment.
 *
 * TWO-5879 risk-tiers that staffing by the PR's changed paths (via each
 * repo's `.github/review-tiers.yml`, matched against the workspace diff):
 * QA runs on every tier, Security only on Sensitive/unknown. The tier is
 * recomputed on every head — a push can add sensitive paths — so a card
 * already stamped QA-only is upgraded (Security prepended, existing stage
 * IDs preserved) when a later head tiers Sensitive. A pending Security
 * stage is never downgraded when a later head tiers lower.
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
 * - Workspace metadata for the tier diff — needs `project.workspaces.read` and
 *   `execution.workspaces.read` (`ctx.projects.getWorkspaceForIssue`,
 *   `ctx.executionWorkspaces.get`). The checkout path and base ref come from
 *   the host; only read-only `git` (merge-base, diff, ls-files, rev-parse)
 *   runs there. Any lookup or git failure tiers Sensitive.
 *
 * Idempotence / loop safety: an `issue.updated` caused by the guard's own
 * `issues.update` re-enters the handler, sees a live reviewer stage (or
 * `auto` mode), and returns without writing. The `applied` plugin-state record
 * additionally dedupes the audit comment across event/sweep retries, keyed by
 * tier so a re-tiered head earns exactly one upgrade comment. v1
 * limitation (noted, not solved): the record is read-modify-write, so a
 * concurrent event+sweep pair can both pass the dedupe check and duplicate
 * one audit comment; the policy write itself is idempotent.
 */

export type ReviewGuardOutcome =
  | { applied: true; stages: number; commented: boolean; tier: RiskTier; upgraded: boolean }
  | { applied: false; reason: "disabled" | "not-code-card" | "has-stages" | "auto-mode" | "unconfigured" | "dry-run" | "terminal" | "no-eligible-reviewers" | "comment-retried" };

/** Code work = bound to a project workspace (a repo). Per TWO-5794, workspace presence is the signal. */
export const isReviewCodeCard = (issue: Pick<Issue, "projectWorkspaceId">): boolean =>
  typeof issue.projectWorkspaceId === "string" && issue.projectWorkspaceId.length > 0;

/** A card already has a live reviewer stage (or an explicit `auto` opt-out) that the guard must not touch.
 *  A stage with no participant carrying an `agentId`/`userId` can never be decided, so it is not live. */
export const hasLiveReviewStage = (issue: Pick<Issue, "executionPolicy">): boolean => {
  const policy = issue.executionPolicy;
  if (!policy) return false;
  if (policy.mode === "auto") return true;
  return (
    Array.isArray(policy.stages) &&
    policy.stages.some((stage) =>
      stage.participants.some((p) => (typeof p.agentId === "string" && p.agentId.length > 0) || (typeof p.userId === "string" && p.userId.length > 0)),
    )
  );
};

const dedupe = (ids: string[]): string[] => [...new Set(ids)];

/** Per-project override wins; otherwise the company default. Deduped, order preserved. */
const pickReview = (
  config: Pick<UpstreamConfig, "defaultReviewAgentIds" | "reviewAgentIdsByProjectId">,
  issue: Pick<Issue, "projectId">,
): { agentIds: string[]; source: string } => {
  if (issue.projectId) {
    const override = config.reviewAgentIdsByProjectId[issue.projectId];
    if (override && override.length > 0) return { agentIds: dedupe(override), source: `project override ${issue.projectId}` };
  }
  return { agentIds: dedupe(config.defaultReviewAgentIds), source: "company default" };
};

export const pickReviewAgentIds = (
  config: Pick<UpstreamConfig, "defaultReviewAgentIds" | "reviewAgentIdsByProjectId">,
  issue: Pick<Issue, "projectId">,
): string[] => pickReview(config, issue).agentIds;

/**
 * QA staffing (TWO-5879): the explicit QA role list wins; otherwise the
 * legacy chain's position split applies (everything after the first ID).
 * A single-ID legacy chain reads as QA-only.
 */
export const pickQaAgentIds = (
  config: Pick<UpstreamConfig, "defaultReviewAgentIds" | "reviewAgentIdsByProjectId" | "reviewQaAgentIds" | "reviewQaAgentIdsByProjectId">,
  issue: Pick<Issue, "projectId">,
): string[] => pickQa(config, issue).agentIds;

/** QA staffing with its audit attribution: a per-project role override, the
 *  company role list, or the legacy chain — named so the audit comment
 *  identifies the configuration that actually staffed the card. */
const pickQa = (
  config: Pick<UpstreamConfig, "defaultReviewAgentIds" | "reviewAgentIdsByProjectId" | "reviewQaAgentIds" | "reviewQaAgentIdsByProjectId">,
  issue: Pick<Issue, "projectId">,
): { agentIds: string[]; source: string } => {
  if (issue.projectId) {
    const override = config.reviewQaAgentIdsByProjectId[issue.projectId];
    if (override && override.length > 0) return { agentIds: dedupe(override), source: `project override ${issue.projectId}` };
  }
  if (config.reviewQaAgentIds.length > 0) return { agentIds: dedupe(config.reviewQaAgentIds), source: "company default" };
  const chain = pickReview(config, issue);
  return { agentIds: chain.agentIds.length >= 2 ? dedupe(chain.agentIds.slice(1)) : dedupe(chain.agentIds), source: chain.source };
};

/**
 * Security staffing (TWO-5879): the explicit Security role list wins;
 * otherwise the legacy chain's first ID is Security. A chain of fewer than
 * two IDs leaves Security unstaffed (Sensitive cards fail closed).
 */
export const pickSecurityAgentIds = (
  config: Pick<UpstreamConfig, "defaultReviewAgentIds" | "reviewAgentIdsByProjectId" | "reviewSecurityAgentIds" | "reviewSecurityAgentIdsByProjectId">,
  issue: Pick<Issue, "projectId">,
): string[] => pickSecurity(config, issue).agentIds;

/** Security staffing with its audit attribution (see {@link pickQa}). */
const pickSecurity = (
  config: Pick<UpstreamConfig, "defaultReviewAgentIds" | "reviewAgentIdsByProjectId" | "reviewSecurityAgentIds" | "reviewSecurityAgentIdsByProjectId">,
  issue: Pick<Issue, "projectId">,
): { agentIds: string[]; source: string } => {
  if (issue.projectId) {
    const override = config.reviewSecurityAgentIdsByProjectId[issue.projectId];
    if (override && override.length > 0) return { agentIds: dedupe(override), source: `project override ${issue.projectId}` };
  }
  if (config.reviewSecurityAgentIds.length > 0) return { agentIds: dedupe(config.reviewSecurityAgentIds), source: "company default" };
  const chain = pickReview(config, issue);
  return { agentIds: chain.agentIds.length >= 2 ? [chain.agentIds[0] as string] : [], source: chain.source };
};

/** Agent IDs already carrying a live stage on the card, if any. */
const stageAgentIds = (issue: Pick<Issue, "executionPolicy">): Set<string> => {
  const ids = new Set<string>();
  for (const stage of issue.executionPolicy?.stages ?? []) {
    for (const p of stage.participants) {
      if (typeof p.agentId === "string" && p.agentId.length > 0) ids.add(p.agentId);
      if (typeof p.userId === "string" && p.userId.length > 0) ids.add(`user:${p.userId}`);
    }
  }
  return ids;
};

/** The card's executor must never be stamped as its own reviewer. */
const executorAgentIds = (issue: Pick<Issue, "assigneeAgentId" | "executionState">): Set<string> => {
  const ids = new Set<string>();
  if (issue.assigneeAgentId) ids.add(issue.assigneeAgentId);
  const returnAssignee = issue.executionState?.returnAssignee;
  if (returnAssignee && typeof returnAssignee.agentId === "string" && returnAssignee.agentId.length > 0) {
    ids.add(returnAssignee.agentId);
  }
  return ids;
};

/** Host shape (`issueExecutionPolicySchema`): `normal` mode, one `review` stage per reviewer, `approvalsNeeded: 1`.
 *  Existing policy fields (e.g. `monitor`) are preserved; only mode/comment/stages are stamped. */
export const buildReviewPolicy = (agentIds: string[], existing?: IssueExecutionPolicy | null): IssueExecutionPolicy => ({
  ...(existing ?? {}),
  mode: "normal",
  commentRequired: true,
  stages: agentIds.map((agentId) => ({
    id: randomUUID(),
    type: "review",
    approvalsNeeded: 1,
    participants: [{ id: randomUUID(), type: "agent", agentId }],
  })),
});

/**
 * Upgrade policy for a re-tiered head (TWO-5879): the fresh Security stages
 * are prepended to the untouched existing stages, so an in-flight reviewer
 * keeps their stage id (and any approval already recorded against it).
 */
export const buildUpgradedPolicy = (existing: IssueExecutionPolicy, securityAgentIds: string[]): IssueExecutionPolicy => ({
  ...existing,
  mode: "normal",
  commentRequired: true,
  stages: [...buildReviewPolicy(securityAgentIds).stages, ...existing.stages],
});

type AppliedRecord = Record<
  string,
  { at: string; stages: number; commented?: boolean; source?: string; tier?: RiskTier; pendingBody?: string }
>;

type ReviewGuardConfig = Pick<
  UpstreamConfig,
  | "reviewGuardEnabled"
  | "reviewGuardDryRun"
  | "dryRun"
  | "defaultReviewAgentIds"
  | "reviewAgentIdsByProjectId"
  | "reviewQaAgentIds"
  | "reviewQaAgentIdsByProjectId"
  | "reviewSecurityAgentIds"
  | "reviewSecurityAgentIdsByProjectId"
>;

const readApplied = async (ctx: PluginContext, companyId: string): Promise<AppliedRecord> =>
  ((await ctx.state.get(stateKey(companyId, "review-guard.applied"))) as AppliedRecord | null) ?? {};

const writeApplied = async (ctx: PluginContext, companyId: string, applied: AppliedRecord): Promise<void> => {
  await ctx.state.set(stateKey(companyId, "review-guard.applied"), applied);
};

/**
 * Ensure one issue carries the tier-appropriate review policy. Returns what
 * happened so sweeps can count and tests can pin the contract. Never throws
 * for a legitimate no-op; plugin-internal failures (update/comment)
 * propagate so the host logs them and the sweep retries next tick.
 *
 * `tiering` overrides the live workspace tier for tests; production always
 * resolves it from the card's current head via {@link resolveReviewTier}.
 */
export async function ensureReviewPolicy(
  ctx: PluginContext,
  companyId: string,
  issue: Issue,
  config: ReviewGuardConfig,
  tiering?: ResolvedTier,
): Promise<ReviewGuardOutcome> {
  if (!config.reviewGuardEnabled) return { applied: false, reason: "disabled" };
  if (issue.status === "done" || issue.status === "cancelled") return { applied: false, reason: "terminal" };
  if (!isReviewCodeCard(issue)) return { applied: false, reason: "not-code-card" };
  const policy = issue.executionPolicy;
  if (policy && policy.mode === "auto") return { applied: false, reason: "auto-mode" };
  // Either dry-run flag suppresses writes, matching the other scans.
  const dryRun = config.reviewGuardDryRun || config.dryRun;

  // Re-tier on every call: a push can add sensitive paths, so the tier of
  // the current head — not the tier at stamp time — decides staffing.
  const resolved = tiering ?? (await resolveReviewTier(ctx, companyId, issue));
  const needsSecurity = needsSecurityReview(resolved.tier);
  // Audit attribution names the configuration that actually staffed this
  // tier: the per-role selectors (project override, company role list, or
  // legacy chain) — not just the legacy chain selector, which mislabels
  // cards staffed by a per-project role override as "company default".
  const qaPicked = pickQa(config, issue);
  const securityPicked = pickSecurity(config, issue);
  const source = needsSecurity
    ? securityPicked.source === qaPicked.source
      ? securityPicked.source
      : `Security ${securityPicked.source}; QA ${qaPicked.source}`
    : qaPicked.source;
  const excluded = executorAgentIds(issue);
  const securityIds = securityPicked.agentIds.filter((id) => !excluded.has(id));
  const qaIds = qaPicked.agentIds.filter((id) => !excluded.has(id));

  const applied = await readApplied(ctx, companyId);
  const prior = applied[issue.id];
  // Records stamped before tiering carry no tier: treat them as matching so
  // they neither re-comment nor block an upgrade check on security presence.
  const tierChanged = prior?.tier !== undefined && prior.tier !== resolved.tier;

  if (hasLiveReviewStage(issue)) {
    // A pending record means a policy write landed but its audit comment
    // failed: retry that exact audit text (persisted as pendingBody, so a
    // failed upgrade still retries as an upgrade with its triggering path,
    // not as a default stamp) instead of hiding behind the live stage.
    // A tier change must not strand the pending audit: the retry runs
    // regardless of the current tier. But it must not shield a Sensitive
    // head from its upgrade either — QA could pass review before the next
    // sweep adds Security — so on a tier change the retry falls through to
    // the upgrade path below instead of returning here.
    if (prior && prior.commented === false && !dryRun) {
      const retrySource = prior.source ?? source;
      const stageCount = prior.stages;
      await ctx.issues.createComment(
        issue.id,
        prior.pendingBody ?? `Default review policy applied by review-guard: ${stageCount} reviewer stage${stageCount === 1 ? "" : "s"} (tier ${prior.tier ?? resolved.tier}; config: ${retrySource}).`,
        companyId,
      );
      await writeApplied(ctx, companyId, { ...applied, [issue.id]: { ...prior, at: new Date().toISOString(), commented: true } });
      ctx.logger.info("review-guard retried audit comment", { companyId, issueId: issue.id });
      if (!tierChanged) return { applied: false, reason: "comment-retried" };
      // Tier moved: keep going — the upgrade/unstall logic below runs now,
      // in this call, not on some later event or sweep.
    }
    // Upgrade path: a later head tiers Sensitive while the card only carries
    // QA (or other) stages. Prepend the missing Security stages; never strip
    // or reorder the stages already there. If Security is unstaffed (no
    // config, or the executor is the Security reviewer) the existing stages
    // stand — removing them would be a downgrade without an audit comment.
    if (needsSecurity) {
      const present = stageAgentIds(issue);
      // Unfiltered Security staffing: an agent already on the card counts
      // as Security even when the eligible list is empty (e.g. it was the
      // executor). Without this, "already carries Security" below can only
      // be true when securityIds is non-empty — the unstaffed case would
      // silently fall through to the same log line (finding: silent QA-only).
      const carriesSecurity = [...present].some((id) => pickSecurityAgentIds(config, issue).includes(id));
      const missing = securityIds.filter((id) => !present.has(id));
      if (!carriesSecurity && securityIds.length === 0) {
        // Fail closed, loudly: a Sensitive head with no eligible Security
        // stage cannot be silently left QA-only. Post an audit comment so
        // QA/humans see the gap (deduped per tier via the applied record)
        // instead of just logging that the head "already carries Security".
        ctx.logger.info("review-guard kept existing stages: Sensitive head without an eligible Security reviewer", {
          companyId,
          issueId: issue.id,
          tier: resolved.tier,
        });
        if (dryRun) return { applied: false, reason: "dry-run" };
        if (!(prior?.tier === resolved.tier && prior.commented === true)) {
          const body = `Review-guard: Sensitive head (tier ${resolved.tier}: ${resolved.reason}) has no eligible Security reviewer stage — card remains without Security review until one is staffed. Not downgraded to QA-only silently (config: ${source}).`;
          await writeApplied(ctx, companyId, {
            ...applied,
            [issue.id]: { at: new Date().toISOString(), stages: issue.executionPolicy?.stages?.length ?? 0, commented: false, source, tier: resolved.tier, pendingBody: body },
          });
          await ctx.issues.createComment(issue.id, body, companyId);
          await writeApplied(ctx, companyId, {
            ...applied,
            [issue.id]: { at: new Date().toISOString(), stages: issue.executionPolicy?.stages?.length ?? 0, commented: true, source, tier: resolved.tier },
          });
        }
        return { applied: false, reason: "no-eligible-reviewers" };
      }
      if (missing.length > 0) {
        if (dryRun) {
          ctx.logger.info("review-guard dry-run: would upgrade review policy with Security", {
            companyId,
            issueId: issue.id,
            tier: resolved.tier,
          });
          return { applied: false, reason: "dry-run" };
        }
        // Cast cites the module header: see the stamp path below.
        const upgraded = await ctx.issues.update(
          issue.id,
          { executionPolicy: buildUpgradedPolicy(issue.executionPolicy as IssueExecutionPolicy, missing) } as never,
          companyId,
        );
        const stageCount = upgraded.executionPolicy?.stages?.length ?? securityIds.length + (issue.executionPolicy?.stages?.length ?? 0);
        const body = `Review-guard upgraded review policy: added ${missing.length} Security stage${missing.length === 1 ? "" : "s"} (tier ${resolved.tier}: ${resolved.reason}; config: ${source}).`;
        await writeApplied(ctx, companyId, {
          ...applied,
          [issue.id]: { at: new Date().toISOString(), stages: stageCount, commented: false, source, tier: resolved.tier, pendingBody: body },
        });
        await ctx.issues.createComment(issue.id, body, companyId);
        await writeApplied(ctx, companyId, {
          ...applied,
          [issue.id]: { at: new Date().toISOString(), stages: stageCount, commented: true, source, tier: resolved.tier },
        });
        ctx.logger.info("review-guard upgraded review policy with Security", {
          companyId,
          issueId: issue.id,
          stages: stageCount,
          tier: resolved.tier,
        });
        return { applied: true, stages: stageCount, commented: true, tier: resolved.tier, upgraded: true };
      }
      ctx.logger.info("review-guard kept existing stages: Sensitive head already carries Security", {
        companyId,
        issueId: issue.id,
        tier: resolved.tier,
      });
    } else {
      // No downgrade: a lower tier never removes a pending Security stage.
      ctx.logger.info("review-guard kept existing stages: lower tier never downgrades", {
        companyId,
        issueId: issue.id,
        tier: resolved.tier,
      });
    }
    return { applied: false, reason: "has-stages" };
  }

  // No live stages: stamp the tier's staffing (QA always; Security added for
  // Sensitive/unknown). A Sensitive head with no usable Security reviewer
  // fails closed — QA-only would silently skip security review.
  const agentIds = dedupe(needsSecurity ? [...securityIds, ...qaIds] : [...qaIds]);
  if (agentIds.length === 0) {
    const staffed = pickSecurityAgentIds(config, issue).length + pickQaAgentIds(config, issue).length > 0;
    if (staffed) {
      // Fail closed: the executor must not review their own card, and no
      // other configured reviewer remains. Never stamp a self-review stage.
      ctx.logger.info("review-guard skipped: configured reviewers are the card executor", { companyId, issueId: issue.id });
      return { applied: false, reason: "no-eligible-reviewers" };
    }
    // Fail closed when unconfigured: never invent a reviewer.
    ctx.logger.info("review-guard skipped: no review agent IDs configured for company", { companyId, issueId: issue.id });
    return { applied: false, reason: "unconfigured" };
  }
  if (needsSecurity && securityIds.length === 0) {
    // Some reviewers exist, but the Security stage the tier requires has
    // none of them: never silently downgrade a Sensitive head to QA-only.
    ctx.logger.info("review-guard skipped: Sensitive head without an eligible Security reviewer", {
      companyId,
      issueId: issue.id,
      tier: resolved.tier,
    });
    return { applied: false, reason: "no-eligible-reviewers" };
  }

  if (dryRun) {
    ctx.logger.info("review-guard dry-run: would stamp default review policy", {
      companyId,
      issueId: issue.id,
      stages: agentIds.length,
      tier: resolved.tier,
    });
    return { applied: false, reason: "dry-run" };
  }

  // Cast cites the module header: the wire protocol is `Record<string, unknown>`
  // and the host `updateIssueSchema` accepts `executionPolicy`; the SDK's typed
  // Pick is a creator-subset, not the wire contract.
  const next = await ctx.issues.update(
    issue.id,
    { executionPolicy: buildReviewPolicy(agentIds, issue.executionPolicy) } as never,
    companyId,
  );
  const stageCount = next.executionPolicy?.stages?.length ?? agentIds.length;

  // Audit-stamp once per tier: if the record already names this tier (event
  // + sweep both raced the same card), skip the duplicate comment. The
  // record is written as pending before the comment so a failed comment is
  // retried by the next event/sweep (see the `hasLiveReviewStage` branch).
  let commented = false;
  if (!prior || prior.tier !== resolved.tier) {
    const body = `Default review policy applied by review-guard: ${stageCount} reviewer stage${stageCount === 1 ? "" : "s"} (tier ${resolved.tier}: ${resolved.reason}; config: ${source}).`;
    await writeApplied(ctx, companyId, {
      ...applied,
      [issue.id]: { at: new Date().toISOString(), stages: stageCount, commented: false, source, tier: resolved.tier, pendingBody: body },
    });
    await ctx.issues.createComment(issue.id, body, companyId);
    commented = true;
    await writeApplied(ctx, companyId, {
      ...applied,
      [issue.id]: { at: new Date().toISOString(), stages: stageCount, commented: true, source, tier: resolved.tier },
    });
  }

  ctx.logger.info("review-guard applied default review policy", {
    companyId,
    issueId: issue.id,
    stages: stageCount,
    commented,
    tier: resolved.tier,
  });
  return { applied: true, stages: stageCount, commented, tier: resolved.tier, upgraded: false };
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
  config: ReviewGuardConfig,
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
      // One failing card must not abort the sweep for every later card
      // (list order is stable, so the same card would fail every tick).
      try {
        // Re-read: a stage (or terminal status) added after the list page must
        // win over the stale row. `ensureReviewPolicy` re-checks liveness on
        // the fresh object immediately before it writes.
        const fresh = await ctx.issues.get(row.id, companyId);
        const outcome = await ensureReviewPolicy(ctx, companyId, fresh ?? row, config);
        if (outcome.applied) appliedCount += 1;
        else tally(outcome.reason);
      } catch (err) {
        tally("error");
        ctx.logger.error("review-guard sweep row failed", { companyId, issueId: row.id, error: String(err) });
      }
    }
    if (rows.length < SWEEP_PAGE) break;
    offset += rows.length;
  }
  ctx.logger.info("review-guard sweep finished", { companyId, checked, applied: appliedCount, skipped });
  return { checked, applied: appliedCount, skipped };
}
