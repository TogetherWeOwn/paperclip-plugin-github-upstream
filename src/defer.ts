import type { PluginContext, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import type { Issue } from "@paperclipai/shared";
import { DEFER_TOOL_NAME } from "./manifest.js";

export { DEFER_TOOL_NAME };

/**
 * Status-only `blocked` -> `backlog` move under plugin authority.
 *
 * Why this tool exists: the native resume guard treats any agent status change
 * on a blocked card as a resume, so an already-decided deferral fails with
 * 409 and needs a board executor. This tool executes that single transition
 * with plugin authority, attributed to the calling agent.
 *
 * Security contract (see the tool description in manifest.ts):
 * - Decision reference must resolve to a `done` issue whose title/description
 *   or comments name the target card. Free text is not authorization.
 * - Only `blocked` -> `backlog`. Terminal cards and cards with a pending
 *   review stage are refused.
 * - The update patch is status-only: blocker edges, stages and monitors are
 *   untouched by construction (the handler never sends them in the patch).
 * - Idempotent: a target already in `backlog` returns success without a new
 *   comment or update.
 */

export interface DeferParams {
  targetIssueId: string;
  decisionIssueId: string;
  revisitTrigger: string;
}

const MAX_REVISIT_TRIGGER_LENGTH = 2000;

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function parseDeferParams(params: unknown): { ok: true; value: DeferParams } | { ok: false; error: string } {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return { ok: false, error: "defer_blocked_card expects an object with targetIssueId, decisionIssueId and revisitTrigger" };
  }
  const record = params as Record<string, unknown>;
  if (!nonEmptyString(record.targetIssueId)) {
    return { ok: false, error: "targetIssueId is required (the blocked card's issue UUID)" };
  }
  if (!nonEmptyString(record.decisionIssueId)) {
    return { ok: false, error: "decisionIssueId is required (the done decision card's issue UUID)" };
  }
  if (!nonEmptyString(record.revisitTrigger)) {
    return { ok: false, error: "revisitTrigger is required (the observable revisit event or date for this deferral)" };
  }
  if (record.revisitTrigger.trim().length > MAX_REVISIT_TRIGGER_LENGTH) {
    return { ok: false, error: `revisitTrigger must be at most ${MAX_REVISIT_TRIGGER_LENGTH} characters` };
  }
  return {
    ok: true,
    value: {
      targetIssueId: record.targetIssueId.trim(),
      decisionIssueId: record.decisionIssueId.trim(),
      revisitTrigger: record.revisitTrigger.trim(),
    },
  };
}

/** A pending review stage is live while the execution state points at a stage. */
export function hasPendingReviewStage(issue: Pick<Issue, "executionState">): boolean {
  const state = issue.executionState;
  if (!state) return false;
  return state.currentStageId != null || state.currentStageType != null;
}

export const TERMINAL_STATUSES = new Set(["done", "cancelled"]);

export type DeferRefusal =
  | "target-not-found"
  | "decision-not-found"
  | "decision-not-done"
  | "decision-does-not-name-target"
  | "decision-is-target"
  | "target-terminal"
  | "target-not-blocked"
  | "target-pending-review";

export interface DeferPreconditions {
  target: Issue;
  decision: Issue;
  decisionComments: string[];
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * True when `text` contains `token` as a standalone token (case-insensitive).
 * Substring matching is not enough: an identifier like `TWO-1` is a prefix of
 * `TWO-10`, so `includes` would let a decision for a different card authorize
 * this deferral.
 */
export function containsStandaloneToken(text: string, token: string): boolean {
  const pattern = new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(token)}(?![A-Za-z0-9-])`, "i");
  return pattern.test(text);
}

export function decisionNamesTarget(
  decision: Pick<Issue, "title" | "description">,
  decisionComments: string[],
  target: Pick<Issue, "id" | "identifier">,
): boolean {
  const texts = [decision.title, decision.description ?? "", ...decisionComments];
  const needles = [target.id, target.identifier].filter((n): n is string => typeof n === "string" && n.length > 0);
  if (needles.length === 0) return false;
  return texts.some((text) => needles.some((needle) => containsStandaloneToken(text, needle)));
}

export function checkDeferPreconditions(
  preconditions: DeferPreconditions,
): { ok: true } | { ok: false; refusal: DeferRefusal; error: string } {
  const { target, decision, decisionComments } = preconditions;
  if (decision.id === target.id) {
    return { ok: false, refusal: "decision-is-target", error: "decisionIssueId must differ from targetIssueId" };
  }
  if (decision.status !== "done") {
    return {
      ok: false,
      refusal: "decision-not-done",
      error: `decision card ${decision.identifier ?? decision.id} is not done (status: ${decision.status}); only a recorded decision authorizes a deferral`,
    };
  }
  if (!decisionNamesTarget(decision, decisionComments, target)) {
    return {
      ok: false,
      refusal: "decision-does-not-name-target",
      error: `decision card ${decision.identifier ?? decision.id} does not name target card ${target.identifier ?? target.id}`,
    };
  }
  if (TERMINAL_STATUSES.has(target.status)) {
    return { ok: false, refusal: "target-terminal", error: `target card is terminal (status: ${target.status})` };
  }
  if (target.status !== "blocked" && target.status !== "backlog") {
    return {
      ok: false,
      refusal: "target-not-blocked",
      error: `only blocked -> backlog is permitted (target status: ${target.status})`,
    };
  }
  if (hasPendingReviewStage(target)) {
    return { ok: false, refusal: "target-pending-review", error: "target card has a pending review stage" };
  }
  return { ok: true };
}

/** Marker that identifies a deferral audit comment posted by this tool. */
export const DEFER_AUDIT_MARKER = "Deferred via `defer_blocked_card`";

export function hasDeferAuditComment(comments: string[], decision: Pick<Issue, "id" | "identifier">): boolean {
  const needles = [decision.id, decision.identifier].filter((n): n is string => typeof n === "string" && n.length > 0);
  return comments.some(
    (body) =>
      body.includes(DEFER_AUDIT_MARKER) &&
      needles.some((needle) => containsStandaloneToken(body, needle)),
  );
}

/** Audit comment posted on the target card after a successful deferral. */
export function deferAuditComment(input: {
  callerAgentId: string;
  callerRunId: string;
  decisionIdentifier: string | null;
  decisionId: string;
  revisitTrigger: string;
}): string {
  const decisionRef = input.decisionIdentifier ? `${input.decisionIdentifier} (${input.decisionId})` : input.decisionId;
  return [
    `${DEFER_AUDIT_MARKER} (plugin authority, status-only ` + "`blocked` -> `backlog`).",
    "",
    `- Caller agent: ${input.callerAgentId}`,
    `- Caller run: ${input.callerRunId}`,
    `- Decision reference: ${decisionRef}`,
    `- Revisit trigger: ${input.revisitTrigger}`,
    "",
    "Blocker edges, review stages and monitors were not touched by this transition.",
  ].join("\n");
}

export function registerDeferTool(ctx: PluginContext): void {
  ctx.tools.register(
    DEFER_TOOL_NAME,
    {
      displayName: "Defer blocked card",
      description:
        "Move one blocked Paperclip card to backlog under plugin authority (status-only blocked -> backlog), for an already-decided deferral the native resume guard blocks. Requires a done decision card naming the target. Refuses terminal cards and cards with a pending review stage. Idempotent.",
      parametersSchema: {
        type: "object",
        properties: {
          targetIssueId: {
            type: "string",
            description: "UUID of the blocked card to defer.",
          },
          decisionIssueId: {
            type: "string",
            description: "UUID of the done decision card that names the target card and records the defer decision.",
          },
          revisitTrigger: {
            type: "string",
            description: "Observable revisit event or UTC date that reopens this deferral.",
          },
        },
        required: ["targetIssueId", "decisionIssueId", "revisitTrigger"],
      },
    },
    async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
      const parsed = parseDeferParams(params);
      if (!parsed.ok) {
        return { error: parsed.error };
      }
      const { targetIssueId, decisionIssueId, revisitTrigger } = parsed.value;
      const companyId = runCtx.companyId;

      const target = await ctx.issues.get(targetIssueId, companyId);
      if (!target) {
        return { error: `targetIssueId ${targetIssueId} not found in this company` };
      }
      const decision = await ctx.issues.get(decisionIssueId, companyId);
      if (!decision) {
        return { error: `decisionIssueId ${decisionIssueId} not found in this company` };
      }
      const decisionComments = (await ctx.issues.listComments(decision.id, companyId)).map((c) => c.body);

      const checked = checkDeferPreconditions({ target, decision, decisionComments });
      if (!checked.ok) {
        return { error: checked.error, data: { refusal: checked.refusal, deferred: false } };
      }

      // Idempotent: already deferred, no second update. Self-heal the audit
      // comment if a prior attempt moved the card but lost the comment.
      if (target.status === "backlog") {
        const targetComments = (await ctx.issues.listComments(target.id, companyId)).map((c) => c.body);
        if (!hasDeferAuditComment(targetComments, decision)) {
          await ctx.issues.createComment(
            target.id,
            deferAuditComment({
              callerAgentId: runCtx.agentId,
              callerRunId: runCtx.runId,
              decisionIdentifier: decision.identifier ?? null,
              decisionId: decision.id,
              revisitTrigger,
            }),
            companyId,
          );
        }
        return {
          content: `${target.identifier ?? target.id} is already in backlog; nothing changed.`,
          data: { deferred: true, alreadyDeferred: true, targetId: target.id, decisionId: decision.id },
        };
      }

      // Re-read immediately before the write: another actor may have moved the
      // card or started a review stage since the first read.
      const fresh = await ctx.issues.get(target.id, companyId);
      if (!fresh) {
        return { error: `targetIssueId ${target.id} disappeared during the call` };
      }
      const rechecked = checkDeferPreconditions({ target: fresh, decision, decisionComments });
      if (!rechecked.ok) {
        return { error: rechecked.error, data: { refusal: rechecked.refusal, deferred: false } };
      }
      if (fresh.status === "backlog") {
        return {
          content: `${fresh.identifier ?? fresh.id} is already in backlog; nothing changed.`,
          data: { deferred: true, alreadyDeferred: true, targetId: fresh.id, decisionId: decision.id },
        };
      }

      // Status-only patch under plugin authority, attributed to the caller.
      const updated = await ctx.issues.update(
        target.id,
        { status: "backlog" },
        companyId,
        { actorAgentId: runCtx.agentId, actorRunId: runCtx.runId },
      );
      if (updated.status !== "backlog") {
        return { error: `target did not move to backlog (status: ${updated.status})` };
      }
      await ctx.issues.createComment(
        target.id,
        deferAuditComment({
          callerAgentId: runCtx.agentId,
          callerRunId: runCtx.runId,
          decisionIdentifier: decision.identifier ?? null,
          decisionId: decision.id,
          revisitTrigger,
        }),
        companyId,
      );
      return {
        content: `${updated.identifier ?? updated.id} deferred: blocked -> backlog.`,
        data: { deferred: true, alreadyDeferred: false, targetId: target.id, decisionId: decision.id },
      };
    },
  );
}
