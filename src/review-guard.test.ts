import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { REVIEW_GUARD_JOB_KEY } from "./manifest.js";
import plugin from "./plugin.js";
import { resolveConfig } from "./config.js";
import {
  buildReviewPolicy,
  buildUpgradedPolicy,
  ensureReviewPolicy,
  hasLiveReviewStage,
  isReviewCodeCard,
  pickQaAgentIds,
  pickReviewAgentIds,
  pickSecurityAgentIds,
  runReviewGuardSweep,
} from "./review-guard.js";
import type { ResolvedTier } from "./review-tiers.js";

const COMPANY = "c-1";
const PROJECT = "p-1";
const WORKSPACE = "w-1";
const SECURITY = "b1c2d3e4-1111-4111-8111-111111111111";
const QA = "b2c2d3e4-2222-4222-8222-222222222222";
const EXTRA = "b3c2d3e4-3333-4333-8333-333333333333";

const GUARD_CONFIG: Record<string, unknown> = {
  reviewGuardEnabled: true,
  defaultReviewAgentIds: [SECURITY, QA],
};

interface UpdateCall {
  issueId: string;
  patch: Record<string, unknown>;
}

function spyUpdates(harness: TestHarness): UpdateCall[] {
  const calls: UpdateCall[] = [];
  const orig = harness.ctx.issues.update.bind(harness.ctx.issues);
  harness.ctx.issues.update = (async (issueId: string, patch: Record<string, unknown>, companyId: string) => {
    calls.push({ issueId, patch });
    return orig(issueId, patch as never, companyId);
  }) as typeof harness.ctx.issues.update;
  return calls;
}

function spyComments(harness: TestHarness): Array<{ issueId: string; body: string }> {
  const calls: Array<{ issueId: string; body: string }> = [];
  const orig = harness.ctx.issues.createComment.bind(harness.ctx.issues);
  harness.ctx.issues.createComment = (async (issueId: string, body: string, companyId: string, options?: never) => {
    calls.push({ issueId, body });
    return orig(issueId, body, companyId, options);
  }) as typeof harness.ctx.issues.createComment;
  return calls;
}

/** Seed a minimal issue row: only the fields the review-guard reads are set; the rest is cast away. */
function seedIssue(harness: TestHarness, overrides: Record<string, unknown> = {}) {
  const issue = {
    id: randomUUID(),
    companyId: COMPANY,
    projectId: PROJECT,
    projectWorkspaceId: WORKSPACE,
    status: "in_review",
    executionPolicy: null,
    ...overrides,
  };
  harness.seed({ issues: [issue as never] });
  return issue;
}

async function setup(config: Record<string, unknown> = GUARD_CONFIG) {
  const harness = createTestHarness({ manifest, config: {} });
  harness.seed({ companies: [{ id: COMPANY, name: "TWO", issuePrefix: "TWO" } as never] });
  await plugin.definition.setup(harness.ctx);
  harness.setConfig(config);
  return harness;
}

const emitIssue = (harness: TestHarness, type: "issue.created" | "issue.updated", issueId: string) =>
  harness.emit(type, {}, { companyId: COMPANY, entityId: issueId, entityType: "issue" });

describe("review-guard helpers", () => {
  it("treats only workspace-bound cards as code cards", () => {
    expect(isReviewCodeCard({ projectWorkspaceId: WORKSPACE })).toBe(true);
    expect(isReviewCodeCard({ projectWorkspaceId: null })).toBe(false);
    expect(isReviewCodeCard({ projectWorkspaceId: "" })).toBe(false);
  });

  it("treats staged and auto-mode policies as live, empty/missing as none", () => {
    expect(hasLiveReviewStage({ executionPolicy: null })).toBe(false);
    expect(hasLiveReviewStage({ executionPolicy: { mode: "normal", commentRequired: true, stages: [] } })).toBe(false);
    expect(hasLiveReviewStage({ executionPolicy: { mode: "auto", commentRequired: true, stages: [] } })).toBe(true);
    // A participant-less stage can never be decided, so it is not live.
    expect(
      hasLiveReviewStage({
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [{ id: randomUUID(), type: "review", approvalsNeeded: 1, participants: [] }],
        },
      }),
    ).toBe(false);
    expect(
      hasLiveReviewStage({
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [{ id: randomUUID(), type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "agent", agentId: SECURITY }] }],
        },
      }),
    ).toBe(true);
  });

  it("prefers the project override and falls back to the default", () => {
    const config = resolveConfig({ defaultReviewAgentIds: [QA], reviewAgentIdsByProjectId: { [PROJECT]: [SECURITY] } });
    expect(pickReviewAgentIds(config, { projectId: PROJECT })).toEqual([SECURITY]);
    expect(pickReviewAgentIds(config, { projectId: "other" })).toEqual([QA]);
    expect(pickReviewAgentIds(config, { projectId: null })).toEqual([QA]);
  });

  it("builds a normal-mode policy with one review stage per reviewer", () => {
    const policy = buildReviewPolicy([SECURITY, QA]);
    expect(policy.mode).toBe("normal");
    expect(policy.stages).toHaveLength(2);
    expect(policy.stages.map((s) => s.participants[0]?.agentId)).toEqual([SECURITY, QA]);
    expect(policy.stages.every((s) => s.type === "review" && s.approvalsNeeded === 1)).toBe(true);
    expect(new Set(policy.stages.map((s) => s.id)).size).toBe(2);
  });
});

describe("review-guard events (real SDK contract)", () => {
  it("stamps the default policy + audit comment on issue.created for a code card", async () => {
    const harness = await setup();
    const updates = spyUpdates(harness);
    const comments = spyComments(harness);
    const issue = seedIssue(harness);

    await emitIssue(harness, "issue.created", issue.id);

    expect(updates).toHaveLength(1);
    expect(updates[0].issueId).toBe(issue.id);
    const policy = (updates[0].patch as { executionPolicy: ReturnType<typeof buildReviewPolicy> }).executionPolicy;
    expect(policy.mode).toBe("normal");
    expect(policy.stages.map((s) => s.participants[0]?.agentId)).toEqual([SECURITY, QA]);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Default review policy applied by review-guard");

    const stored = await harness.ctx.issues.get(issue.id, COMPANY);
    expect(stored?.executionPolicy?.stages).toHaveLength(2);
  });

  it("stamps on issue.updated when a code card enters in_review without stages", async () => {
    const harness = await setup();
    const updates = spyUpdates(harness);
    const issue = seedIssue(harness, { status: "in_review" });

    await emitIssue(harness, "issue.updated", issue.id);
    expect(updates).toHaveLength(1);
  });

  it("leaves a card that already has stages untouched", async () => {
    const harness = await setup();
    const updates = spyUpdates(harness);
    const comments = spyComments(harness);
    const issue = seedIssue(harness, {
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{ id: randomUUID(), type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: SECURITY }] }],
      },
    });

    await emitIssue(harness, "issue.updated", issue.id);
    expect(updates).toHaveLength(0);
    expect(comments).toHaveLength(0);
  });

  it("respects an explicit auto mode (opt-out)", async () => {
    const harness = await setup();
    const updates = spyUpdates(harness);
    const issue = seedIssue(harness, { executionPolicy: { mode: "auto", commentRequired: false, stages: [] } });

    await emitIssue(harness, "issue.updated", issue.id);
    expect(updates).toHaveLength(0);
  });

  it("leaves non-code cards (no workspace) untouched", async () => {
    const harness = await setup();
    const updates = spyUpdates(harness);
    const issue = seedIssue(harness, { projectWorkspaceId: null });

    await emitIssue(harness, "issue.updated", issue.id);
    expect(updates).toHaveLength(0);
  });

  it("never stamps the executor as their own reviewer", async () => {
    const harness = await setup();
    const updates = spyUpdates(harness);
    const issue = seedIssue(harness, { assigneeAgentId: QA });

    await emitIssue(harness, "issue.created", issue.id);

    expect(updates).toHaveLength(1);
    const policy = (updates[0].patch as { executionPolicy: ReturnType<typeof buildReviewPolicy> }).executionPolicy;
    expect(policy.stages.map((s) => s.participants[0]?.agentId)).toEqual([SECURITY]);
  });

  it("fails closed instead of downgrading to QA-only when the executor is the Security reviewer", async () => {
    // No workspace checkout seeded, so the tier fails closed to Sensitive and
    // the card needs Security; the only Security reviewer is the executor, so
    // the guard must not stamp a QA-only policy.
    const harness = await setup();
    const updates = spyUpdates(harness);
    const issue = seedIssue(harness, { assigneeAgentId: SECURITY });

    await emitIssue(harness, "issue.created", issue.id);
    expect(updates).toHaveLength(0);

    const outcome = await ensureReviewPolicy(
      harness.ctx,
      COMPANY,
      (await harness.ctx.issues.get(issue.id, COMPANY)) as never,
      resolveConfig(GUARD_CONFIG),
    );
    expect(outcome).toEqual({ applied: false, reason: "no-eligible-reviewers" });
  });

  it("fails closed (no stamp) when the executor is the only configured reviewer", async () => {
    const harness = await setup({ reviewGuardEnabled: true, defaultReviewAgentIds: [SECURITY] });
    const updates = spyUpdates(harness);
    const issue = seedIssue(harness, { assigneeAgentId: SECURITY });

    await emitIssue(harness, "issue.created", issue.id);
    expect(updates).toHaveLength(0);

    const outcome = await ensureReviewPolicy(
      harness.ctx,
      COMPANY,
      (await harness.ctx.issues.get(issue.id, COMPANY)) as never,
      resolveConfig({ reviewGuardEnabled: true, defaultReviewAgentIds: [SECURITY] }),
    );
    expect(outcome).toEqual({ applied: false, reason: "no-eligible-reviewers" });
  });

  it("also excludes the return assignee", async () => {
    const harness = await setup();
    const updates = spyUpdates(harness);
    const issue = seedIssue(harness, { executionState: { returnAssignee: { type: "agent", agentId: QA } } });

    await emitIssue(harness, "issue.created", issue.id);

    expect(updates).toHaveLength(1);
    const policy = (updates[0].patch as { executionPolicy: ReturnType<typeof buildReviewPolicy> }).executionPolicy;
    expect(policy.stages.map((s) => s.participants[0]?.agentId)).toEqual([SECURITY]);
  });

  it("dedupes duplicate configured reviewers into one stage", async () => {
    const harness = await setup({
      reviewGuardEnabled: true,
      defaultReviewAgentIds: [SECURITY, QA],
      reviewSecurityAgentIds: [SECURITY],
      reviewQaAgentIds: [QA, QA],
    });
    const updates = spyUpdates(harness);
    const issue = seedIssue(harness);

    await emitIssue(harness, "issue.created", issue.id);

    expect(updates).toHaveLength(1);
    const policy = (updates[0].patch as { executionPolicy: ReturnType<typeof buildReviewPolicy> }).executionPolicy;
    expect(policy.stages.map((s) => s.participants[0]?.agentId)).toEqual([SECURITY, QA]);
  });

  it("skips terminal cards (done/cancelled)", async () => {
    for (const status of ["done", "cancelled"] as const) {
      const harness = await setup();
      const updates = spyUpdates(harness);
      const comments = spyComments(harness);
      const issue = seedIssue(harness, { status });

      await emitIssue(harness, "issue.updated", issue.id);
      expect(updates).toHaveLength(0);
      expect(comments).toHaveLength(0);
    }
  });

  it("stamps a card whose only stage has no participants", async () => {
    const harness = await setup();
    const updates = spyUpdates(harness);
    const issue = seedIssue(harness, {
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{ id: randomUUID(), type: "review", approvalsNeeded: 1, participants: [] }],
      },
    });

    await emitIssue(harness, "issue.updated", issue.id);
    expect(updates).toHaveLength(1);
  });

  it("preserves existing policy fields (e.g. monitor) when stamping", async () => {
    const harness = await setup();
    const updates = spyUpdates(harness);
    const monitor = { nextCheckAt: new Date().toISOString(), notes: "keep", scheduledBy: "agent" } as never;
    const issue = seedIssue(harness, { executionPolicy: { mode: "normal", commentRequired: false, stages: [], monitor } });

    await emitIssue(harness, "issue.created", issue.id);

    expect(updates).toHaveLength(1);
    const policy = (updates[0].patch as { executionPolicy: ReturnType<typeof buildReviewPolicy> }).executionPolicy;
    expect(policy.monitor).toEqual(monitor);
    expect(policy.stages).toHaveLength(2);
  });

  it("audit comment names the company default when no project override applies", async () => {
    const harness = await setup();
    const comments = spyComments(harness);
    const issue = seedIssue(harness);

    await emitIssue(harness, "issue.created", issue.id);

    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("company default");
    expect(comments[0].body).not.toContain("project override");
  });

  it("uses the per-project override when configured", async () => {
    const harness = await setup({
      ...GUARD_CONFIG,
      reviewAgentIdsByProjectId: { [PROJECT]: [SECURITY, EXTRA] },
    });
    const updates = spyUpdates(harness);
    const issue = seedIssue(harness);

    const comments = spyComments(harness);
    await emitIssue(harness, "issue.created", issue.id);
    const policy = (updates[0].patch as { executionPolicy: ReturnType<typeof buildReviewPolicy> }).executionPolicy;
    expect(policy.stages.map((s) => s.participants[0]?.agentId)).toEqual([SECURITY, EXTRA]);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain(`project override ${PROJECT}`);
  });

  it("honors the plugin-wide dryRun flag too", async () => {
    const harness = await setup({ ...GUARD_CONFIG, dryRun: true });
    const updates = spyUpdates(harness);
    const comments = spyComments(harness);
    const issue = seedIssue(harness);

    await emitIssue(harness, "issue.created", issue.id);
    expect(updates).toHaveLength(0);
    expect(comments).toHaveLength(0);
  });

  it("retries a failed audit comment on the next event", async () => {
    const harness = await setup();
    const config = resolveConfig(GUARD_CONFIG);
    const issue = seedIssue(harness);
    let attempts = 0;
    const bodies: string[] = [];
    const origComment = harness.ctx.issues.createComment.bind(harness.ctx.issues);
    harness.ctx.issues.createComment = (async (...args: Parameters<typeof origComment>) => {
      attempts += 1;
      if (attempts === 1) throw new Error("comment blew up");
      bodies.push(String(args[1]));
      return origComment(...args);
    }) as typeof harness.ctx.issues.createComment;

    await expect(ensureReviewPolicy(harness.ctx, COMPANY, issue as never, config)).rejects.toThrow("comment blew up");
    // The policy is stamped, but the comment failed: the next call must retry
    // the comment even though the card now has live stages.
    const fresh = (await harness.ctx.issues.get(issue.id, COMPANY)) as never;
    const retry = await ensureReviewPolicy(harness.ctx, COMPANY, fresh, config);
    expect(retry).toEqual({ applied: false, reason: "comment-retried" });
    expect(attempts).toBe(2);
    expect(bodies[0]).toContain("company default");
    const third = await ensureReviewPolicy(harness.ctx, COMPANY, (await harness.ctx.issues.get(issue.id, COMPANY)) as never, config);
    expect(third).toEqual({ applied: false, reason: "has-stages" });
    expect(attempts).toBe(2);
  });

  it("retried audit comment keeps the original config source after a config change", async () => {
    const harness = await setup();
    const bodies: string[] = [];
    const issue = seedIssue(harness);
    let attempts = 0;
    const origComment = harness.ctx.issues.createComment.bind(harness.ctx.issues);
    harness.ctx.issues.createComment = (async (...args: Parameters<typeof origComment>) => {
      attempts += 1;
      if (attempts === 1) throw new Error("comment blew up");
      bodies.push(String(args[1]));
      return origComment(...args);
    }) as typeof harness.ctx.issues.createComment;

    await expect(
      ensureReviewPolicy(harness.ctx, COMPANY, issue as never, resolveConfig(GUARD_CONFIG)),
    ).rejects.toThrow("comment blew up");
    // Config changes to a project override before the retry: the card still
    // carries the company-default stages, so the retry must say so.
    const changed = { ...GUARD_CONFIG, reviewAgentIdsByProjectId: { [PROJECT]: [EXTRA] } };
    const retry = await ensureReviewPolicy(
      harness.ctx,
      COMPANY,
      (await harness.ctx.issues.get(issue.id, COMPANY)) as never,
      resolveConfig(changed),
    );
    expect(retry).toEqual({ applied: false, reason: "comment-retried" });
    expect(bodies[0]).toContain("company default");
    expect(bodies[0]).not.toContain("project override");
  });

  it("dry-run writes nothing", async () => {
    const harness = await setup({ ...GUARD_CONFIG, reviewGuardDryRun: true });
    const updates = spyUpdates(harness);
    const comments = spyComments(harness);
    const issue = seedIssue(harness);

    await emitIssue(harness, "issue.created", issue.id);
    expect(updates).toHaveLength(0);
    expect(comments).toHaveLength(0);
    const stored = await harness.ctx.issues.get(issue.id, COMPANY);
    expect(stored?.executionPolicy ?? null).toBe(null);
  });

  it("is inert when disabled or unconfigured", async () => {
    const disabled = await setup({ reviewGuardEnabled: false, defaultReviewAgentIds: [QA] });
    const disabledUpdates = spyUpdates(disabled);
    await emitIssue(disabled, "issue.created", seedIssue(disabled).id);
    expect(disabledUpdates).toHaveLength(0);

    const unconfigured = await setup({ reviewGuardEnabled: true, defaultReviewAgentIds: [] });
    const unconfiguredUpdates = spyUpdates(unconfigured);
    await emitIssue(unconfigured, "issue.created", seedIssue(unconfigured).id);
    expect(unconfiguredUpdates).toHaveLength(0);
  });

  it("does not loop or duplicate on its own issue.updated", async () => {
    const harness = await setup();
    const updates = spyUpdates(harness);
    const comments = spyComments(harness);
    const issue = seedIssue(harness);

    await emitIssue(harness, "issue.created", issue.id);
    await emitIssue(harness, "issue.updated", issue.id);
    await emitIssue(harness, "issue.updated", issue.id);

    expect(updates).toHaveLength(1);
    expect(comments).toHaveLength(1);
  });

  it("skips silently when the company has no config row (fail closed)", async () => {
    const harness = await setup({});
    harness.setConfig({});
    const updates = spyUpdates(harness);
    const issue = seedIssue(harness);

    await expect(emitIssue(harness, "issue.created", issue.id)).resolves.toBeUndefined();
    expect(updates).toHaveLength(0);
  });
});

describe("review-guard sweep", () => {
  it("stamps only in_review code cards without stages", async () => {
    const harness = await setup();
    const updates = spyUpdates(harness);
    const comments = spyComments(harness);
    const bare = seedIssue(harness);
    seedIssue(harness, { status: "todo" });
    seedIssue(harness, { executionPolicy: buildReviewPolicy([SECURITY, QA]) });
    seedIssue(harness, { projectWorkspaceId: null });

    await harness.runJob(REVIEW_GUARD_JOB_KEY);

    expect(updates).toHaveLength(1);
    expect(updates[0].issueId).toBe(bare.id);
    expect(comments).toHaveLength(1);
  });

  it("does not re-comment on a second sweep", async () => {
    const harness = await setup();
    const updates = spyUpdates(harness);
    const comments = spyComments(harness);
    seedIssue(harness);

    await harness.runJob(REVIEW_GUARD_JOB_KEY);
    await harness.runJob(REVIEW_GUARD_JOB_KEY);

    expect(updates).toHaveLength(1);
    expect(comments).toHaveLength(1);
  });

  it("one failing card does not abort the sweep for later cards", async () => {
    const harness = await setup();
    const bad = seedIssue(harness);
    const good = seedIssue(harness);
    const origUpdate = harness.ctx.issues.update.bind(harness.ctx.issues);
    harness.ctx.issues.update = (async (issueId: string, patch: Record<string, unknown>, companyId: string) => {
      if (issueId === bad.id) throw new Error("host rejected this card");
      return origUpdate(issueId, patch as never, companyId);
    }) as typeof harness.ctx.issues.update;

    const summary = await runReviewGuardSweep(harness.ctx, COMPANY, resolveConfig(GUARD_CONFIG));
    const stored = await harness.ctx.issues.get(good.id, COMPANY);
    expect(stored?.executionPolicy?.stages).toHaveLength(2);
    expect(summary.skipped.error).toBe(1);
  });

  it("ensureReviewPolicy reports why a card was skipped", async () => {
    const harness = await setup();
    const issue = seedIssue(harness, { projectWorkspaceId: null }) as never;

    const outcome = await ensureReviewPolicy(harness.ctx, COMPANY, issue, resolveConfig(GUARD_CONFIG));
    expect(outcome).toEqual({ applied: false, reason: "not-code-card" });
  });
});

describe("review-guard config resolution", () => {
  it("defaults to disabled with no reviewers (fail closed)", () => {
    const config = resolveConfig({});
    expect(config.reviewGuardEnabled).toBe(false);
    expect(config.reviewGuardDryRun).toBe(false);
    expect(config.defaultReviewAgentIds).toEqual([]);
    expect(config.reviewAgentIdsByProjectId).toEqual({});
    expect(config.reviewQaAgentIds).toEqual([]);
    expect(config.reviewQaAgentIdsByProjectId).toEqual({});
    expect(config.reviewSecurityAgentIds).toEqual([]);
    expect(config.reviewSecurityAgentIdsByProjectId).toEqual({});
  });

  it("keeps explicit values, drops empty entries, only true enables", () => {
    const config = resolveConfig({
      reviewGuardEnabled: "yes" as never,
      reviewGuardDryRun: true,
      defaultReviewAgentIds: [QA, "", QA],
      reviewAgentIdsByProjectId: { [PROJECT]: [SECURITY], "": [QA], empty: [] },
      reviewQaAgentIds: [EXTRA, EXTRA],
      reviewSecurityAgentIdsByProjectId: { [PROJECT]: [SECURITY] },
    });
    expect(config.reviewGuardEnabled).toBe(false);
    expect(config.reviewGuardDryRun).toBe(true);
    expect(config.defaultReviewAgentIds).toEqual([QA]);
    expect(config.reviewAgentIdsByProjectId).toEqual({ [PROJECT]: [SECURITY] });
    expect(config.reviewQaAgentIds).toEqual([EXTRA]);
    expect(config.reviewSecurityAgentIdsByProjectId).toEqual({ [PROJECT]: [SECURITY] });
  });
});

describe("review-guard role split (TWO-5879)", () => {
  it("splits the legacy chain by position: first Security, rest QA", () => {
    const config = resolveConfig({ defaultReviewAgentIds: [SECURITY, QA] });
    expect(pickSecurityAgentIds(config, { projectId: PROJECT })).toEqual([SECURITY]);
    expect(pickQaAgentIds(config, { projectId: PROJECT })).toEqual([QA]);
    // Single-ID chain reads as QA-only; Security is unstaffed.
    const single = resolveConfig({ defaultReviewAgentIds: [QA] });
    expect(pickSecurityAgentIds(single, { projectId: PROJECT })).toEqual([]);
    expect(pickQaAgentIds(single, { projectId: PROJECT })).toEqual([QA]);
  });

  it("lets explicit role lists win over the legacy split, per role", () => {
    const config = resolveConfig({
      defaultReviewAgentIds: [SECURITY, QA],
      reviewQaAgentIds: [EXTRA],
    });
    expect(pickQaAgentIds(config, { projectId: PROJECT })).toEqual([EXTRA]);
    // Security unset falls back to the legacy split for that role alone.
    expect(pickSecurityAgentIds(config, { projectId: PROJECT })).toEqual([SECURITY]);
  });

  it("lets per-project role overrides win", () => {
    const config = resolveConfig({
      defaultReviewAgentIds: [SECURITY, QA],
      reviewQaAgentIdsByProjectId: { [PROJECT]: [EXTRA] },
    });
    expect(pickQaAgentIds(config, { projectId: PROJECT })).toEqual([EXTRA]);
    expect(pickQaAgentIds(config, { projectId: "other" })).toEqual([QA]);
  });

  it("prepends fresh Security stages ahead of untouched existing stages", () => {
    const existing = buildReviewPolicy([QA]);
    const upgraded = buildUpgradedPolicy(existing, [SECURITY]);
    expect(upgraded.stages.map((s) => s.participants[0]?.agentId)).toEqual([SECURITY, QA]);
    // The preserved stage keeps its id (and any approval recorded against it).
    expect(upgraded.stages[1]?.id).toBe(existing.stages[0]?.id);
    expect(upgraded.stages[0]?.id).not.toBe(existing.stages[0]?.id);
  });
});

describe("review-guard tiering (TWO-5879)", () => {
  const LOW: ResolvedTier = { tier: "low", reason: "2 changed paths classified low", changedPaths: ["README.md"], headSha: "abc" };
  const ORDINARY: ResolvedTier = { tier: "ordinary", reason: "1 changed path classified ordinary", changedPaths: ["src/ui/x.tsx"], headSha: "abc" };
  const SENSITIVE: ResolvedTier = { tier: "sensitive", reason: "sensitive path src/auth/x.ts (2 changed)", changedPaths: ["src/auth/x.ts"], headSha: "def" };
  const UNKNOWN: ResolvedTier = { tier: "unknown", reason: "unmatched path src/new/x.ts", changedPaths: ["src/new/x.ts"], headSha: "def" };

  it("stamps QA-only for low and ordinary, Security then QA for sensitive and unknown", async () => {
    for (const [tiering, expected] of [
      [LOW, [QA]],
      [ORDINARY, [QA]],
      [SENSITIVE, [SECURITY, QA]],
      [UNKNOWN, [SECURITY, QA]],
    ] as const) {
      const harness = await setup();
      const updates = spyUpdates(harness);
      const comments = spyComments(harness);
      const issue = seedIssue(harness);
      const fresh = (await harness.ctx.issues.get(issue.id, COMPANY)) as never;
      const outcome = await ensureReviewPolicy(harness.ctx, COMPANY, fresh, resolveConfig(GUARD_CONFIG), tiering);
      expect(outcome.applied).toBe(true);
      const policy = (updates[0].patch as { executionPolicy: ReturnType<typeof buildReviewPolicy> }).executionPolicy;
      expect(policy.stages.map((s) => s.participants[0]?.agentId)).toEqual(expected);
      expect(comments[0].body).toContain(`tier ${tiering.tier}`);
    }
  });

  it("marks the policy as upgraded when it prepends Security to a QA-only card", async () => {
    const harness = await setup();
    const updates = spyUpdates(harness);
    const comments = spyComments(harness);
    const qaStageId = randomUUID();
    const issue = seedIssue(harness, {
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{ id: qaStageId, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "agent", agentId: QA }] }],
      },
    });
    const fresh = (await harness.ctx.issues.get(issue.id, COMPANY)) as never;
    const outcome = await ensureReviewPolicy(harness.ctx, COMPANY, fresh, resolveConfig(GUARD_CONFIG), SENSITIVE);
    expect(outcome).toEqual({ applied: true, stages: 2, commented: true, tier: "sensitive", upgraded: true });
    const policy = (updates[0].patch as { executionPolicy: ReturnType<typeof buildReviewPolicy> }).executionPolicy;
    expect(policy.stages.map((s) => s.participants[0]?.agentId)).toEqual([SECURITY, QA]);
    expect(policy.stages[1]?.id).toBe(qaStageId);
    expect(comments[0].body).toContain("upgraded review policy");
    expect(comments[0].body).toContain("src/auth/x.ts");

    // Re-running on the same tier does not re-upgrade or re-comment.
    const again = await ensureReviewPolicy(harness.ctx, COMPANY, (await harness.ctx.issues.get(issue.id, COMPANY)) as never, resolveConfig(GUARD_CONFIG), SENSITIVE);
    expect(again).toEqual({ applied: false, reason: "has-stages" });
    expect(updates).toHaveLength(1);
    expect(comments).toHaveLength(1);
  });

  it("never downgrades a pending Security stage when a later head tiers lower", async () => {
    const harness = await setup();
    const updates = spyUpdates(harness);
    const issue = seedIssue(harness, { executionPolicy: buildReviewPolicy([SECURITY, QA]) });
    const fresh = (await harness.ctx.issues.get(issue.id, COMPANY)) as never;
    const outcome = await ensureReviewPolicy(harness.ctx, COMPANY, fresh, resolveConfig(GUARD_CONFIG), LOW);
    expect(outcome).toEqual({ applied: false, reason: "has-stages" });
    expect(updates).toHaveLength(0);
  });

  it("leaves a sensitive card unstamped when no Security reviewer is staffed", async () => {
    const harness = await setup();
    const updates = spyUpdates(harness);
    const issue = seedIssue(harness);
    const fresh = (await harness.ctx.issues.get(issue.id, COMPANY)) as never;
    // QA-only legacy chain: the Sensitive tier cannot be staffed without Security.
    const outcome = await ensureReviewPolicy(harness.ctx, COMPANY, fresh, resolveConfig({ reviewGuardEnabled: true, defaultReviewAgentIds: [QA] }), SENSITIVE);
    expect(outcome).toEqual({ applied: false, reason: "no-eligible-reviewers" });
    expect(updates).toHaveLength(0);
    // The same card on a low tier still stamps QA.
    const lowOutcome = await ensureReviewPolicy(harness.ctx, COMPANY, fresh, resolveConfig({ reviewGuardEnabled: true, defaultReviewAgentIds: [QA] }), LOW);
    expect(lowOutcome.applied).toBe(true);
  });

  it("flags (never silently keeps QA-only) a Sensitive head whose QA-only card has no eligible Security reviewer", async () => {
    const harness = await setup();
    const updates = spyUpdates(harness);
    const comments = spyComments(harness);
    const issue = seedIssue(harness, { executionPolicy: buildReviewPolicy([QA]) });
    const fresh = (await harness.ctx.issues.get(issue.id, COMPANY)) as never;
    // QA-only legacy chain: no Security staffing exists at all.
    const config = resolveConfig({ reviewGuardEnabled: true, defaultReviewAgentIds: [QA] });
    const outcome = await ensureReviewPolicy(harness.ctx, COMPANY, fresh, config, SENSITIVE);
    expect(outcome).toEqual({ applied: false, reason: "no-eligible-reviewers" });
    expect(updates).toHaveLength(0);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("no eligible Security reviewer stage");
    expect(comments[0].body).toContain("tier sensitive");
    // A second call on the same tier does not re-flag.
    const again = await ensureReviewPolicy(harness.ctx, COMPANY, (await harness.ctx.issues.get(issue.id, COMPANY)) as never, config, SENSITIVE);
    expect(again).toEqual({ applied: false, reason: "no-eligible-reviewers" });
    expect(comments).toHaveLength(1);
  });

  it("fails closed to Sensitive in production without a checkout", async () => {
    const harness = await setup();
    const updates = spyUpdates(harness);
    const issue = seedIssue(harness);
    await emitIssue(harness, "issue.created", issue.id);
    const policy = (updates[0].patch as { executionPolicy: ReturnType<typeof buildReviewPolicy> }).executionPolicy;
    // No workspace seeded: tier failed closed, so the full chain is stamped.
    expect(policy.stages.map((s) => s.participants[0]?.agentId)).toEqual([SECURITY, QA]);
  });
});
