import { describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { DEFER_TOOL_NAME } from "./manifest.js";
import plugin from "./plugin.js";
import {
  checkDeferPreconditions,
  containsStandaloneToken,
  decisionNamesTarget,
  hasPendingReviewStage,
  parseDeferParams,
} from "./defer.js";

const COMPANY = "c-1";
const CALLER = "f8b12892-e5cd-45c5-8592-37c6bfb6a4a5";
const RUN = "run-1";

async function setup() {
  const harness = createTestHarness({ manifest });
  harness.seed({ companies: [{ id: COMPANY, name: "TWO", issuePrefix: "TWO" } as never] });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

/** Create a blocked target and a done decision naming it. */
async function seedPair(harness: TestHarness) {
  const blocker = await harness.ctx.issues.create({ companyId: COMPANY, title: "blocker card" });
  const target = await harness.ctx.issues.create({
    companyId: COMPANY,
    title: "blocked card",
    status: "blocked",
    blockedByIssueIds: [blocker.id],
  });
  const decision = await harness.ctx.issues.create({
    companyId: COMPANY,
    title: "decide defer for blocked card",
    description: `Decision: defer ${target.identifier ?? target.id} until the revisit event.`,
    status: "done",
  });
  return { blocker, target, decision };
}

const runCtx = { agentId: CALLER, runId: RUN, companyId: COMPANY, projectId: "p-1" };

describe("parseDeferParams", () => {
  it("accepts a well-formed call", () => {
    const parsed = parseDeferParams({
      targetIssueId: " a ",
      decisionIssueId: "b",
      revisitTrigger: " 2026-12-01T00:00:00Z ",
    });
    expect(parsed).toEqual({
      ok: true,
      value: { targetIssueId: "a", decisionIssueId: "b", revisitTrigger: "2026-12-01T00:00:00Z" },
    });
  });

  it("rejects missing or blank fields and non-objects", () => {
    expect(parseDeferParams(null).ok).toBe(false);
    expect(parseDeferParams([]).ok).toBe(false);
    expect(parseDeferParams({ decisionIssueId: "b", revisitTrigger: "x" }).ok).toBe(false);
    expect(parseDeferParams({ targetIssueId: "a", revisitTrigger: "x" }).ok).toBe(false);
    expect(parseDeferParams({ targetIssueId: "a", decisionIssueId: "b", revisitTrigger: "  " }).ok).toBe(false);
    expect(parseDeferParams({ targetIssueId: "a", decisionIssueId: "b", revisitTrigger: "x".repeat(2001) }).ok).toBe(false);
  });
});

describe("hasPendingReviewStage", () => {
  it("is true only while the execution state points at a stage", () => {
    const base = { status: "blocked", executionState: null } as never;
    expect(hasPendingReviewStage(base)).toBe(false);
    expect(
      hasPendingReviewStage({ executionState: { currentStageId: "stage-1", currentStageType: "review" } } as never),
    ).toBe(true);
    expect(hasPendingReviewStage({ executionState: { currentStageId: null, currentStageType: null } } as never)).toBe(false);
  });
});

describe("containsStandaloneToken", () => {
  it("does not let TWO-1 authorize a decision naming TWO-10 (prefix collision)", () => {
    expect(containsStandaloneToken("Decision: defer TWO-10 until Q3", "TWO-1")).toBe(false);
    expect(containsStandaloneToken("Decision: defer TWO-10 until Q3", "TWO-10")).toBe(true);
    expect(containsStandaloneToken("[TWO-1](/TWO/issues/TWO-1)", "TWO-1")).toBe(true);
    expect(containsStandaloneToken("defer two-1", "TWO-1")).toBe(true);
    expect(containsStandaloneToken("defer xtwo-1x", "TWO-1")).toBe(false);
  });

  it("treats underscores and dollar signs as identifier characters", () => {
    expect(containsStandaloneToken("Decision: defer TWO-1_archive until Q3", "TWO-1")).toBe(false);
    expect(containsStandaloneToken("Decision: defer TWO-1$foo until Q3", "TWO-1")).toBe(false);
    expect(containsStandaloneToken("Decision: defer _TWO-1 until Q3", "TWO-1")).toBe(false);
    expect(containsStandaloneToken("Decision: defer $TWO-1 until Q3", "TWO-1")).toBe(false);
  });
});

describe("decisionNamesTarget", () => {
  const target = { id: "t-1", identifier: "TWO-1" };
  it("matches on the identifier or UUID in title, description or comments", () => {
    expect(decisionNamesTarget({ title: "defer TWO-1", description: null }, [], target)).toBe(true);
    expect(decisionNamesTarget({ title: "x", description: "names t-1" }, [], target)).toBe(true);
    expect(decisionNamesTarget({ title: "x", description: null }, ["see TWO-1"], target)).toBe(true);
    expect(decisionNamesTarget({ title: "x", description: "unrelated" }, [], target)).toBe(false);
    expect(decisionNamesTarget({ title: "defer TWO-10", description: null }, [], target)).toBe(false);
  });
  it("falls back to the UUID when the identifier is absent", () => {
    expect(decisionNamesTarget({ title: "defer t-1", description: null }, [], { id: "t-1", identifier: null })).toBe(true);
    expect(decisionNamesTarget({ title: "x", description: "x" }, [], { id: "", identifier: null })).toBe(false);
  });
});

describe("checkDeferPreconditions", () => {
  type IssueLike = Parameters<typeof checkDeferPreconditions>[0]["target"];
  const decision = { id: "d-1", title: "decide defer TWO-9", description: null, status: "done" } as unknown as IssueLike;
  const target = { id: "t-9", identifier: "TWO-9", status: "blocked", executionState: null } as unknown as IssueLike;

  it("accepts a done, naming decision for a blocked card", () => {
    expect(checkDeferPreconditions({ target, decision, decisionComments: [] })).toEqual({ ok: true });
  });

  it("refuses a not-done decision", () => {
    const result = checkDeferPreconditions({ target, decision: { ...decision, status: "in_progress" }, decisionComments: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe("decision-not-done");
  });

  it("refuses a decision that does not name the target (free text is not authorization)", () => {
    const result = checkDeferPreconditions({
      target,
      decision: { ...decision, title: "defer something" },
      decisionComments: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe("decision-does-not-name-target");
  });

  it("refuses terminal targets and non-blocked targets", () => {
    for (const status of ["done", "cancelled"] as const) {
      const result = checkDeferPreconditions({ target: { ...target, status }, decision, decisionComments: [] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal).toBe("target-terminal");
    }
    for (const status of ["todo", "in_progress", "in_review"] as const) {
      const result = checkDeferPreconditions({ target: { ...target, status }, decision, decisionComments: [] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal).toBe("target-not-blocked");
    }
  });

  it("refuses a target with a pending review stage", () => {
    const result = checkDeferPreconditions({
      target: {
        ...target,
        executionState: { currentStageId: "s", currentStageType: "review" } as unknown as typeof target.executionState,
      },
      decision,
      decisionComments: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe("target-pending-review");
  });

  it("refuses a decision that is the target itself", () => {
    const result = checkDeferPreconditions({ target, decision: { ...decision, id: "t-9" }, decisionComments: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe("decision-is-target");
  });
});

describe("defer_blocked_card tool", () => {
  it("moves blocked -> backlog, attributes the caller, and leaves blockers untouched", async () => {
    const harness = await setup();
    const { blocker, target, decision } = await seedPair(harness);
    const before = (await harness.ctx.issues.get(target.id, COMPANY))!;
    expect(before.status).toBe("blocked");

    const result = await harness.executeTool(DEFER_TOOL_NAME, {
      targetIssueId: target.id,
      decisionIssueId: decision.id,
      revisitTrigger: "publish the design record, or 2026-12-01T00:00:00Z",
    }, runCtx);

    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({ deferred: true, alreadyDeferred: false });
    const after = (await harness.ctx.issues.get(target.id, COMPANY))!;
    expect(after.status).toBe("backlog");
    // Blocker edges, assignee and stages untouched: only the status moved.
    const subtree = await harness.ctx.issues.getSubtree(target.id, COMPANY, { includeRelations: true });
    expect(subtree.relations?.[target.id]?.blockedBy.map((b) => b.id)).toEqual([blocker.id]);
    expect(after.assigneeAgentId).toBe(before.assigneeAgentId);

    const comments = await harness.ctx.issues.listComments(target.id, COMPANY);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain(CALLER);
    expect(comments[0].body).toContain(decision.identifier ?? decision.id);
    expect(comments[0].body).toContain("publish the design record");
  });

  it("is idempotent: a second call changes nothing and adds no comment", async () => {
    const harness = await setup();
    const { target, decision } = await seedPair(harness);
    const params = { targetIssueId: target.id, decisionIssueId: decision.id, revisitTrigger: "2026-12-01T00:00:00Z" };
    const first = await harness.executeTool(DEFER_TOOL_NAME, params, runCtx);
    expect(first.data).toMatchObject({ deferred: true, alreadyDeferred: false });
    const second = await harness.executeTool(DEFER_TOOL_NAME, params, runCtx);
    expect(second.error).toBeUndefined();
    expect(second.data).toMatchObject({ deferred: true, alreadyDeferred: true });
    expect(await harness.ctx.issues.listComments(target.id, COMPANY)).toHaveLength(1);
  });

  it("refuses when the decision does not name the target, leaving the card blocked", async () => {
    const harness = await setup();
    const { target } = await seedPair(harness);
    const unrelated = await harness.ctx.issues.create({
      companyId: COMPANY,
      title: "decide something else",
      description: "no target named here",
      status: "done",
    });
    const result = await harness.executeTool(DEFER_TOOL_NAME, {
      targetIssueId: target.id,
      decisionIssueId: unrelated.id,
      revisitTrigger: "x",
    }, runCtx);
    expect(result.error).toMatch(/does not name/);
    expect((await harness.ctx.issues.get(target.id, COMPANY))!.status).toBe("blocked");
    expect(await harness.ctx.issues.listComments(target.id, COMPANY)).toHaveLength(0);
  });

  it("refuses a not-done decision", async () => {
    const harness = await setup();
    const { target } = await seedPair(harness);
    const open = await harness.ctx.issues.create({
      companyId: COMPANY,
      title: `decide defer ${target.identifier ?? target.id}`,
      status: "in_progress",
    });
    const result = await harness.executeTool(DEFER_TOOL_NAME, {
      targetIssueId: target.id,
      decisionIssueId: open.id,
      revisitTrigger: "x",
    }, runCtx);
    expect(result.error).toMatch(/not done/);
    expect((await harness.ctx.issues.get(target.id, COMPANY))!.status).toBe("blocked");
  });

  it("refuses terminal and non-blocked targets without touching them", async () => {
    const harness = await setup();
    const { decision } = await seedPair(harness);
    for (const status of ["done", "cancelled", "in_progress"] as const) {
      const card = await harness.ctx.issues.create({
        companyId: COMPANY,
        title: `card ${status}`,
        status,
      });
      // The decision above names only the first target; create a fresh decision naming this card.
      // Reuse the seed target's decision is not valid here, so make a per-card decision.
      const perCardDecision = await harness.ctx.issues.create({
        companyId: COMPANY,
        title: `decide defer ${card.identifier ?? card.id}`,
        status: "done",
      });
      const result = await harness.executeTool(DEFER_TOOL_NAME, {
        targetIssueId: card.id,
        decisionIssueId: perCardDecision.id,
        revisitTrigger: "x",
      }, runCtx);
      expect(result.error).toBeTruthy();
      expect((await harness.ctx.issues.get(card.id, COMPANY))!.status).toBe(status);
      void decision;
    }
  });

  it("leaves monitors untouched (status-only patch)", async () => {
    const harness = await setup();
    const { target, decision } = await seedPair(harness);
    // Seed a monitor on the target by seeding the stored issue directly.
    harness.seed({
      issues: [
        {
          ...(await harness.ctx.issues.get(target.id, COMPANY))!,
          monitorNextCheckAt: new Date("2026-12-01T00:00:00Z"),
          monitorAttemptCount: 2,
        } as never,
      ],
    });
    const result = await harness.executeTool(DEFER_TOOL_NAME, {
      targetIssueId: target.id,
      decisionIssueId: decision.id,
      revisitTrigger: "2026-12-01T00:00:00Z",
    }, runCtx);
    expect(result.error).toBeUndefined();
    const after = (await harness.ctx.issues.get(target.id, COMPANY))!;
    expect(after.status).toBe("backlog");
    expect(new Date(after.monitorNextCheckAt as never).toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(after.monitorAttemptCount).toBe(2);
  });

  it("rejects unknown target or decision ids", async () => {
    const harness = await setup();
    const { target, decision } = await seedPair(harness);
    const missingTarget = await harness.executeTool(DEFER_TOOL_NAME, {
      targetIssueId: "no-such-uuid",
      decisionIssueId: decision.id,
      revisitTrigger: "x",
    }, runCtx);
    expect(missingTarget.error).toMatch(/targetIssueId .* not found/);
    const missingDecision = await harness.executeTool(DEFER_TOOL_NAME, {
      targetIssueId: target.id,
      decisionIssueId: "no-such-uuid",
      revisitTrigger: "x",
    }, runCtx);
    expect(missingDecision.error).toMatch(/decisionIssueId .* not found/);
    expect((await harness.ctx.issues.get(target.id, COMPANY))!.status).toBe("blocked");
  });

  it("repairs the audit comment when the card reaches backlog between the two reads", async () => {
    const harness = await setup();
    const { target, decision } = await seedPair(harness);
    // Another actor moves the card to backlog between the handler's first
    // and second reads, but fails before posting its audit comment.
    const originalGet = harness.ctx.issues.get.bind(harness.ctx.issues);
    let targetReads = 0;
    harness.ctx.issues.get = (async (...args: never[]) => {
      if (args[0] === target.id) targetReads += 1;
      const issue = await (originalGet as (...a: never[]) => Promise<never>)(...args);
      if (args[0] === target.id && targetReads === 2) {
        await harness.ctx.issues.update(target.id, { status: "backlog" }, COMPANY);
        return originalGet(target.id, COMPANY) as never;
      }
      return issue;
    }) as typeof harness.ctx.issues.get;
    const result = await harness.executeTool(DEFER_TOOL_NAME, {
      targetIssueId: target.id,
      decisionIssueId: decision.id,
      revisitTrigger: "2026-12-01T00:00:00Z",
    }, runCtx);
    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({ deferred: true, alreadyDeferred: true });
    const comments = await harness.ctx.issues.listComments(target.id, COMPANY);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain(CALLER);
  });

  it("self-heals a lost audit comment on the idempotent path", async () => {
    const harness = await setup();
    const { target, decision } = await seedPair(harness);
    // Simulate a prior attempt that moved the card but lost the comment.
    await harness.ctx.issues.update(target.id, { status: "backlog" }, COMPANY);
    expect(await harness.ctx.issues.listComments(target.id, COMPANY)).toHaveLength(0);
    const result = await harness.executeTool(DEFER_TOOL_NAME, {
      targetIssueId: target.id,
      decisionIssueId: decision.id,
      revisitTrigger: "2026-12-01T00:00:00Z",
    }, runCtx);
    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({ deferred: true, alreadyDeferred: true });
    const comments = await harness.ctx.issues.listComments(target.id, COMPANY);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain(CALLER);
  });

  it("refuses when another actor moves the card before the write (re-read guard)", async () => {
    const harness = await setup();
    const { target, decision } = await seedPair(harness);
    // Intercept the second read of the target: after the handler's first
    // check, another actor closes the card.
    const originalGet = harness.ctx.issues.get.bind(harness.ctx.issues);
    let targetReads = 0;
    harness.ctx.issues.get = (async (...args: never[]) => {
      if (args[0] === target.id) targetReads += 1;
      const issue = await (originalGet as (...a: never[]) => Promise<never>)(...args);
      if (args[0] === target.id && targetReads === 2) {
        await harness.ctx.issues.update(target.id, { status: "done" }, COMPANY);
        return originalGet(target.id, COMPANY) as never;
      }
      return issue;
    }) as typeof harness.ctx.issues.get;
    const result = await harness.executeTool(DEFER_TOOL_NAME, {
      targetIssueId: target.id,
      decisionIssueId: decision.id,
      revisitTrigger: "x",
    }, runCtx);
    expect(result.error).toBeTruthy();
    expect((await originalGet(target.id, COMPANY))!.status).toBe("done");
  });

  it("rejects malformed calls without touching the card", async () => {
    const harness = await setup();
    const { target, decision } = await seedPair(harness);
    for (const params of [null, {}, { targetIssueId: target.id }, { targetIssueId: target.id, decisionIssueId: decision.id }]) {
      const result = await harness.executeTool(DEFER_TOOL_NAME, params, runCtx);
      expect(result.error).toBeTruthy();
    }
    expect((await harness.ctx.issues.get(target.id, COMPANY))!.status).toBe("blocked");
    expect(await harness.ctx.issues.listComments(target.id, COMPANY)).toHaveLength(0);
  });
});
