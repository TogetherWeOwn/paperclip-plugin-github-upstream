import { describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { PARKED_JOB_KEY } from "./manifest.js";
import plugin from "./plugin.js";
import { resolveConfig } from "./config.js";
import { buildParkedReason, extractRevisitTrigger, isParkedRoot } from "./parked.js";

const COMPANY = "c-parked";
const AGENT = "agent-assignee-1";

async function setup(config: Record<string, unknown> = {}) {
  const harness = createTestHarness({ manifest, config: { parkedPropagationEnabled: true, ...config } });
  harness.seed({
    companies: [{ id: COMPANY, name: "TWO", issuePrefix: "TWO" } as never],
    agents: [{ id: AGENT, companyId: COMPANY, status: "idle" } as never],
  });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

const emitRootUpdate = (harness: TestHarness, rootId: string) =>
  harness.emit("issue.updated", { issueId: rootId }, { entityId: rootId, companyId: COMPANY });

describe("isParkedRoot", () => {
  it("treats backlog and cancelled as parked", () => {
    expect(isParkedRoot({ status: "backlog", title: "", description: null })?.kind).toBe("backlog");
    expect(isParkedRoot({ status: "cancelled", title: "", description: null })?.kind).toBe("cancelled");
  });

  it("treats NO-GO and deferred dispositions as parked", () => {
    expect(isParkedRoot({ status: "todo", title: "NO-GO: launch", description: null })?.kind).toBe("no-go");
    expect(isParkedRoot({ status: "in_progress", title: "x", description: "Decision: deferred to next quarter" })?.kind).toBe("deferred");
    expect(isParkedRoot({ status: "blocked", title: "parked, no go", description: null })?.kind).toBe("no-go");
  });

  it("does not treat live, done or blocked statuses as parked", () => {
    for (const status of ["todo", "in_progress", "in_review", "done", "blocked"] as const) {
      expect(isParkedRoot({ status, title: "plain", description: null })).toBeNull();
    }
  });

  it("does not treat 'defer to' delegation as parked", () => {
    expect(isParkedRoot({ status: "todo", title: "defer to QA", description: "please defer to the QA agent" })).toBeNull();
  });
});

describe("extractRevisitTrigger", () => {
  it("prefers a revisit line in the description", () => {
    const trigger = extractRevisitTrigger({
      description: "Parked pending upstream.\nrevisit: when CLIProxyAPI v9 lands",
      monitorNextCheckAt: null,
      unblockDescriptor: null,
    });
    expect(trigger).toContain("CLIProxyAPI v9 lands");
  });

  it("falls back to the monitor schedule, then the unblock action, then null", () => {
    expect(
      extractRevisitTrigger({ description: null, monitorNextCheckAt: new Date("2026-12-01T00:00:00Z"), unblockDescriptor: null }),
    ).toContain("2026-12-01");
    expect(
      extractRevisitTrigger({ description: null, monitorNextCheckAt: null, unblockDescriptor: { owner: "board", action: "board decides" } }),
    ).toContain("board decides");
    expect(extractRevisitTrigger({ description: null, monitorNextCheckAt: null, unblockDescriptor: null })).toBeNull();
  });
});

describe("buildParkedReason", () => {
  it("carries the parked root, its status and the revisit trigger", () => {
    const reason = buildParkedReason(
      { id: "root-1", identifier: "TWO-100", title: "Blocker", status: "backlog" },
      "backlog",
      "when upstream lands",
      "2026-11-11T00:00:00.000Z",
      "evt-1",
    );
    expect(reason.headline).toContain("TWO-100");
    expect(reason.headline).toContain("backlog");
    expect(reason.headline).toContain("when upstream lands");
    expect(reason.body).toContain(reason.marker);
    expect(reason.idempotencyKey).toBe("parked:root-1:backlog");
    expect(reason.body).toContain("Wake/comment only");
  });

  it("marks an absent revisit trigger honestly", () => {
    const reason = buildParkedReason(
      { id: "root-1", identifier: null, title: "Blocker", status: "cancelled" },
      "cancelled",
      null,
      "2026-11-11T00:00:00.000Z",
      null,
    );
    expect(reason.headline).toContain("none recorded on the parked root");
  });
});

describe("parked-blocker propagation (event path)", () => {
  it("wakes blocked dependents of a freshly parked root without mutating them", async () => {
    const harness = await setup();
    const root = await harness.ctx.issues.create({ companyId: COMPANY, title: "Parked root", status: "backlog", description: "revisit: upstream release" });
    const dep = await harness.ctx.issues.create({
      companyId: COMPANY,
      title: "Dependent",
      status: "blocked",
      assigneeAgentId: AGENT,
      blockedByIssueIds: [root.id],
    });
    const before = await harness.ctx.issues.get(dep.id, COMPANY);

    const invoked: string[] = [];
    harness.ctx.agents.invoke = (async (agentId: string) => {
      invoked.push(agentId);
      return { runId: "run-1" };
    }) as typeof harness.ctx.agents.invoke;
    const wakeups = vi.spyOn(harness.ctx.issues, "requestWakeup");

    await emitRootUpdate(harness, root.id);

    const comments = await harness.ctx.issues.listComments(dep.id, COMPANY);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Parked blocker:");
    expect(comments[0]?.body).toContain("upstream release");
    // The host refuses issue-scoped wakes for unresolved blockers; the
    // fallback agent invocation is what actually wakes the assignee.
    expect(wakeups).toHaveBeenCalledTimes(1);
    expect(invoked).toEqual([AGENT]);
    const after = await harness.ctx.issues.get(dep.id, COMPANY);
    expect(after?.status).toBe(before?.status);
    expect(after?.assigneeAgentId).toBe(before?.assigneeAgentId);
  });

  it("dedupes per (root transition, dependent) across repeated events", async () => {
    const harness = await setup();
    const root = await harness.ctx.issues.create({ companyId: COMPANY, title: "Parked root", status: "backlog" });
    const dep = await harness.ctx.issues.create({
      companyId: COMPANY,
      title: "Dependent",
      status: "blocked",
      assigneeAgentId: AGENT,
      blockedByIssueIds: [root.id],
    });
    let invokes = 0;
    harness.ctx.agents.invoke = (async () => {
      invokes += 1;
      return { runId: "run-1" };
    }) as typeof harness.ctx.agents.invoke;

    await emitRootUpdate(harness, root.id);
    await emitRootUpdate(harness, root.id);

    expect(invokes).toBe(1);
    expect(await harness.ctx.issues.listComments(dep.id, COMPANY)).toHaveLength(1);
  });

  it("skips terminal dependents", async () => {
    const harness = await setup();
    const root = await harness.ctx.issues.create({ companyId: COMPANY, title: "Parked root", status: "cancelled" });
    const done = await harness.ctx.issues.create({
      companyId: COMPANY,
      title: "Done dependent",
      status: "done",
      assigneeAgentId: AGENT,
      blockedByIssueIds: [root.id],
    });
    let invokes = 0;
    harness.ctx.agents.invoke = (async () => {
      invokes += 1;
      return { runId: "run-1" };
    }) as typeof harness.ctx.agents.invoke;

    await emitRootUpdate(harness, root.id);

    expect(invokes).toBe(0);
    expect(await harness.ctx.issues.listComments(done.id, COMPANY)).toHaveLength(0);
  });

  it("does nothing for a non-parked root", async () => {
    const harness = await setup();
    const root = await harness.ctx.issues.create({ companyId: COMPANY, title: "Live root", status: "in_progress" });
    const dep = await harness.ctx.issues.create({
      companyId: COMPANY,
      title: "Dependent",
      status: "blocked",
      assigneeAgentId: AGENT,
      blockedByIssueIds: [root.id],
    });
    let invokes = 0;
    harness.ctx.agents.invoke = (async () => {
      invokes += 1;
      return { runId: "run-1" };
    }) as typeof harness.ctx.agents.invoke;

    await emitRootUpdate(harness, root.id);

    expect(invokes).toBe(0);
    expect(await harness.ctx.issues.listComments(dep.id, COMPANY)).toHaveLength(0);
  });

  it("is inert when disabled or in dry-run", async () => {
    const off = await setup({ parkedPropagationEnabled: false });
    const offRoot = await off.ctx.issues.create({ companyId: COMPANY, title: "Parked root", status: "backlog" });
    const offDep = await off.ctx.issues.create({
      companyId: COMPANY,
      title: "Dependent",
      status: "blocked",
      assigneeAgentId: AGENT,
      blockedByIssueIds: [offRoot.id],
    });
    await emitRootUpdate(off, offRoot.id);
    expect(await off.ctx.issues.listComments(offDep.id, COMPANY)).toHaveLength(0);

    const dry = await setup({ dryRun: true });
    const dryRoot = await dry.ctx.issues.create({ companyId: COMPANY, title: "Parked root", status: "backlog" });
    const dryDep = await dry.ctx.issues.create({
      companyId: COMPANY,
      title: "Dependent",
      status: "blocked",
      assigneeAgentId: AGENT,
      blockedByIssueIds: [dryRoot.id],
    });
    let dryInvokes = 0;
    dry.ctx.agents.invoke = (async () => {
      dryInvokes += 1;
      return { runId: "run-1" };
    }) as typeof dry.ctx.agents.invoke;
    await emitRootUpdate(dry, dryRoot.id);
    expect(dryInvokes).toBe(0);
    expect(await dry.ctx.issues.listComments(dryDep.id, COMPANY)).toHaveLength(0);
  });

  it("comments but does not wake a dependent with no agent assignee", async () => {
    const harness = await setup();
    const root = await harness.ctx.issues.create({ companyId: COMPANY, title: "Parked root", status: "backlog" });
    const dep = await harness.ctx.issues.create({
      companyId: COMPANY,
      title: "Unassigned dependent",
      status: "blocked",
      blockedByIssueIds: [root.id],
    });
    let invokes = 0;
    harness.ctx.agents.invoke = (async () => {
      invokes += 1;
      return { runId: "run-1" };
    }) as typeof harness.ctx.agents.invoke;

    await emitRootUpdate(harness, root.id);

    expect(invokes).toBe(0);
    expect(await harness.ctx.issues.listComments(dep.id, COMPANY)).toHaveLength(1);
  });

  it("bounds fan-out and drains the queue on the next tick (self-heal)", async () => {
    const harness = await setup({ parkedMaxWakesPerEvent: 1 });
    const root = await harness.ctx.issues.create({ companyId: COMPANY, title: "Parked root", status: "backlog" });
    const depA = await harness.ctx.issues.create({
      companyId: COMPANY,
      title: "Dependent A",
      status: "blocked",
      assigneeAgentId: AGENT,
      blockedByIssueIds: [root.id],
    });
    const depB = await harness.ctx.issues.create({
      companyId: COMPANY,
      title: "Dependent B",
      status: "blocked",
      assigneeAgentId: AGENT,
      blockedByIssueIds: [root.id],
    });
    let invokes = 0;
    harness.ctx.agents.invoke = (async () => {
      invokes += 1;
      return { runId: "run-1" };
    }) as typeof harness.ctx.agents.invoke;

    await emitRootUpdate(harness, root.id);
    expect(invokes).toBe(1);
    const aAfterEvent = await harness.ctx.issues.listComments(depA.id, COMPANY);
    const bAfterEvent = await harness.ctx.issues.listComments(depB.id, COMPANY);
    expect(aAfterEvent.length + bAfterEvent.length).toBe(1);

    await harness.runJob(PARKED_JOB_KEY);
    expect(invokes).toBe(2);
    expect(await harness.ctx.issues.listComments(depA.id, COMPANY)).toHaveLength(1);
    expect(await harness.ctx.issues.listComments(depB.id, COMPANY)).toHaveLength(1);

    // Draining is idempotent: a second tick does not re-wake.
    await harness.runJob(PARKED_JOB_KEY);
    expect(invokes).toBe(2);
  });

  it("re-propagates on a re-park and not after un-parking", async () => {
    const harness = await setup();
    const root = await harness.ctx.issues.create({ companyId: COMPANY, title: "Root", status: "backlog" });
    const dep = await harness.ctx.issues.create({
      companyId: COMPANY,
      title: "Dependent",
      status: "blocked",
      assigneeAgentId: AGENT,
      blockedByIssueIds: [root.id],
    });
    let invokes = 0;
    harness.ctx.agents.invoke = (async () => {
      invokes += 1;
      return { runId: "run-1" };
    }) as typeof harness.ctx.agents.invoke;

    await emitRootUpdate(harness, root.id);
    expect(invokes).toBe(1);

    // Un-park: window closes.
    await harness.ctx.issues.update(root.id, { status: "in_progress" }, COMPANY);
    await emitRootUpdate(harness, root.id);
    expect(invokes).toBe(1);

    // Re-park in a different parked status: fresh transition, wakes again.
    await harness.ctx.issues.update(root.id, { status: "cancelled" }, COMPANY);
    await emitRootUpdate(harness, root.id);
    expect(invokes).toBe(2);
    expect(await harness.ctx.issues.listComments(dep.id, COMPANY)).toHaveLength(2);
  });

  it("does not enqueue work for dependents the plugin already commented", async () => {
    const harness = await setup();
    const root = await harness.ctx.issues.create({ companyId: COMPANY, title: "Parked root", status: "backlog" });
    const dep = await harness.ctx.issues.create({
      companyId: COMPANY,
      title: "Dependent",
      status: "blocked",
      assigneeAgentId: AGENT,
      blockedByIssueIds: [root.id],
    });
    // Simulate a lost state record: wipe plugin state, keeping the comment.
    let invokes = 0;
    harness.ctx.agents.invoke = (async () => {
      invokes += 1;
      return { runId: "run-1" };
    }) as typeof harness.ctx.agents.invoke;
    await emitRootUpdate(harness, root.id);
    expect(invokes).toBe(1);
    expect(await harness.ctx.issues.listComments(dep.id, COMPANY)).toHaveLength(1);
    // State lost, but the marker check prevents a duplicate comment on retry.
    await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, stateKey: "parked-propagation" }, { windows: {}, pending: [] });
    await emitRootUpdate(harness, root.id);
    expect(await harness.ctx.issues.listComments(dep.id, COMPANY)).toHaveLength(1);
  });
});

describe("parked config", () => {
  it("defaults to disabled with a bounded fan-out", () => {
    const config = resolveConfig({});
    expect(config.parkedPropagationEnabled).toBe(false);
    expect(config.parkedMaxWakesPerEvent).toBe(25);
    const explicit = resolveConfig({ parkedPropagationEnabled: true, parkedMaxWakesPerEvent: 3 });
    expect(explicit.parkedPropagationEnabled).toBe(true);
    expect(explicit.parkedMaxWakesPerEvent).toBe(3);
  });
});
