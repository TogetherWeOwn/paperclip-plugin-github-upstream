import { describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { AUDIT_JOB_KEY, ITEM_JOB_KEY, RELEASE_JOB_KEY, REVIEW_GUARD_JOB_KEY } from "./manifest.js";
import plugin from "./plugin.js";
import { resolveConfig } from "./config.js";
import { runItemScan } from "./items.js";
import { recordRunStats, type RunStats } from "./state.js";

const COMPANY = "c-1";

const stats = (extra: Partial<RunStats> = {}): RunStats => ({
  at: new Date(0).toISOString(),
  job: "item-scan",
  ok200: 0,
  notModified304: 0,
  errors: 0,
  wakes: 0,
  creates: 0,
  capped: 0,
  ...extra,
});

async function setup(config: Record<string, unknown> = {}) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({ companies: [{ id: COMPANY, name: "TWO", issuePrefix: "TWO" } as never] });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

const TOKEN_REF = { type: "secret_ref", secretId: "test-token" };

const getRuns = (harness: TestHarness) =>
  harness.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: "runs" }) as RunStats[];

describe("plugin wiring", () => {
  it("declares the capability and schedule contract", () => {
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining([
        "companies.read",
        "issues.read",
        "issue.subtree.read",
        "issues.create",
        "issues.update",
        "issue.comments.create",
        "issues.wakeup",
        "jobs.schedule",
        "http.outbound",
        "secrets.read-ref",
        "plugin.state.read",
        "plugin.state.write",
        "events.subscribe",
        "ui.page.register",
        "events.subscribe",
        "issue.relations.read",
        "issue.comments.read",
        "issue.comments.create",
        "agents.invoke",
      ]),
    );
    const jobs = Object.fromEntries((manifest.jobs ?? []).map((j) => [j.jobKey, j.schedule]));
    expect(jobs[RELEASE_JOB_KEY]).toBe("*/10 * * * *");
    expect(jobs[ITEM_JOB_KEY]).toBe("*/15 * * * *");
    expect(jobs[AUDIT_JOB_KEY]).toBe("11 * * * *");
    expect(jobs[REVIEW_GUARD_JOB_KEY]).toBe("*/15 * * * *");
    for (const key of [
      "tokenSecretRef",
      "reviewGuardEnabled",
      "reviewGuardDryRun",
      "defaultReviewAgentIds",
      "reviewAgentIdsByProjectId",
      "appId",
      "installationId",
      "appPrivateKeySecretRef",
      "releaseRepos",
      "releaseIntakeAssigneeAgentId",
      "followThroughTrackerIssueId",
      "followThroughAssigneeAgentId",
      "ourHeadPrefixes",
      "operatorLogin",
      "ourLogins",
      "extraTrackedItems",
      "discoveryQueries",
      "compareBases",
      "labelIdByName",
      "dryRun",
      "auditLogins",
      "auditOrgs",
      "auditRepos",
      "chiefOfStaffAgentId",
      "maxCreatesPerTick",
      "maxWakesPerTick",
      "parkedPropagationEnabled",
      "parkedMaxWakesPerEvent",
    ]) {
      expect(manifest.instanceConfigSchema?.properties).toHaveProperty(key);
    }
  });

  it("mirrors the host install's manifest/capability consistency check", async () => {
    // The SDK's pluginManifestV1Schema does not enforce capability ↔ feature
    // consistency for UI slots, but the host install path does
    // (server/src/routes/plugins.ts via plugin-capability-validator:
    // "Missing required capabilities for declared features: ...").
    // This test replicates that check so CI catches the class of error that
    // rejected 2ab13e1 for a missing ui.page.register. Keep REQUIRED_CAPS in
    // sync with the host validator when slot types or capabilities change.
    const { pluginManifestV1Schema } = await import("@paperclipai/shared");
    const parsed = pluginManifestV1Schema.safeParse(manifest);
    expect(parsed.success).toBe(true);

    const REQUIRED_FOR_JOBS = ["jobs.schedule"];
    const REQUIRED_UI_SLOT_CAPABILITIES: Record<string, string> = {
      page: "ui.page.register",
      sidebar: "ui.sidebar.register",
      routeSidebar: "ui.sidebar.register",
      sidebarPanel: "ui.sidebar.register",
      projectSidebarItem: "ui.sidebar.register",
      detailTab: "ui.detailTab.register",
      taskDetailView: "ui.detailTab.register",
      dashboardWidget: "ui.dashboardWidget.register",
      commentAnnotation: "ui.commentAnnotation.register",
      commentContextMenuItem: "ui.commentAnnotation.register",
    };
    const caps = new Set(manifest.capabilities);

    if ((manifest.jobs ?? []).length > 0) {
      for (const required of REQUIRED_FOR_JOBS) {
        expect(caps.has(required as never)).toBe(true);
      }
    }
    for (const slot of manifest.ui?.slots ?? []) {
      const required = REQUIRED_UI_SLOT_CAPABILITIES[slot.type];
      expect(required).toBeDefined();
      expect(caps.has(required as never)).toBe(true);
    }
    // The declared GitHub tab is a page slot, so the host requires exactly this.
    expect(manifest.ui?.slots?.some((s) => s.type === "page")).toBe(true);
    expect(caps.has("ui.page.register" as never)).toBe(true);
    expect(manifest.entrypoints.ui).toBeTruthy();
  });

  it("F9: the manifest requires secret_ref object bindings, never bare strings", async () => {
    const props = manifest.instanceConfigSchema?.properties as Record<string, any>;
    for (const key of ["tokenSecretRef", "appPrivateKeySecretRef"]) {
      expect(props[key].type).toBe("object");
      expect(props[key].required).toEqual(expect.arrayContaining(["type", "secretId"]));
      expect(props[key].properties.type).toEqual({ enum: ["secret_ref"] });
    }
  });

  it("runs the release scan through the registered job and records per-run stats", async () => {
    const harness = await setup({ tokenSecretRef: TOKEN_REF, releaseRepos: ["router-for-me/CLIProxyAPI"] });
    // Seed a prior baseline so the first run sees a *new* tag and creates the card.
    await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, stateKey: "releases" }, {
      "router-for-me/cliproxyapi": { etag: '"old"', tag: "v8.0.0", createdTag: "v8.0.0", checkedAt: new Date(0).toISOString() },
    });
    let etag = '"w1"';
    harness.ctx.http.fetch = (async (url: string, init?: RequestInit) => {
      if (new Headers(init?.headers).get("If-None-Match") === etag) {
        return new Response(null, { status: 304, headers: { etag } });
      }
      return new Response(
        JSON.stringify({ tag_name: "v8.0.1", name: "v8.0.1", html_url: "https://github.com/r/C/releases/tag/v8.0.1", published_at: "2026-11-01T00:00:00Z" }),
        { status: 200, headers: { "content-type": "application/json", etag } },
      );
    }) as typeof harness.ctx.http.fetch;

    await harness.runJob(RELEASE_JOB_KEY);
    await harness.runJob(RELEASE_JOB_KEY);
    const runs = getRuns(harness);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ job: "release-scan", ok200: 1, creates: 1 });
    expect(runs[1]).toMatchObject({ job: "release-scan", ok200: 0, notModified304: 1, creates: 0 });
    void etag;
  });

  it("dry-run through the item job performs no writes", async () => {
    const harness = await setup();
    const tracker = await harness.ctx.issues.create({ companyId: COMPANY, title: "tracker" });
    const card = await harness.ctx.issues.create({
      companyId: COMPANY,
      parentId: tracker.id,
      title: "child",
      assigneeAgentId: "7b8f576c-ebce-447f-a904-dda322df4220",
      originKind: "plugin:togetherweown.github-upstream:item",
      originId: "paperclipai/paperclip#9",
    });
    void card;
    harness.setConfig({ tokenSecretRef: TOKEN_REF, followThroughTrackerIssueId: tracker.id, dryRun: true });
    let calls = 0;
    for (const method of ["create", "update", "requestWakeup"] as const) {
      const orig = (harness.ctx.issues[method] as (...args: never[]) => Promise<never>).bind(harness.ctx.issues);
      (harness.ctx.issues[method] as (...args: never[]) => Promise<never>) = (async (...args: never[]) => {
        calls += 1;
        return orig(...args);
      }) as never;
    }
    harness.ctx.http.fetch = (async (url: string) => {
      if (url.endsWith("/issues/9")) {
        return new Response(
          JSON.stringify({ number: 9, title: "t", state: "open", updated_at: "2026-11-01T00:00:00Z", comments: 7, html_url: "https://github.com/paperclipai/paperclip/issues/9", user: { login: "x" } }),
          { status: 200, headers: { "content-type": "application/json", etag: '"dry1"' } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof harness.ctx.http.fetch;

    await harness.runJob(ITEM_JOB_KEY);
    expect(calls).toBe(0);
    const runs = getRuns(harness);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ job: "item-scan", ok200: 1 });
  });

  it("runs the audit scan through the registered job with no candidates", async () => {
    const harness = await setup();
    const tracker = await harness.ctx.issues.create({ companyId: COMPANY, title: "tracker" });
    harness.setConfig({
      tokenSecretRef: TOKEN_REF,
      followThroughTrackerIssueId: tracker.id,
      auditOrgs: ["paperclipai"],
      auditLogins: ["Rick7C2"],
    });
    harness.ctx.http.fetch = (async (url: string) => {
      const body =
        url === "https://api.github.com/graphql"
          ? { data: { search: { nodes: [] } } }
          : { total_count: 0, items: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof harness.ctx.http.fetch;

    await harness.runJob(AUDIT_JOB_KEY);
    const runs = getRuns(harness);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ job: "audit-scan", errors: 0, wakes: 0, creates: 0 });
    expect(runs[0].ok200).toBeGreaterThan(0);
  });

  it("a rate-limited item scan backs off and skips the next run", async () => {
    const harness = await setup();
    const tracker = await harness.ctx.issues.create({ companyId: COMPANY, title: "tracker" });
    const config = resolveConfig({
      tokenSecretRef: TOKEN_REF,
      followThroughTrackerIssueId: tracker.id,
      extraTrackedItems: [{ owner: "paperclipai", repo: "paperclip", kind: "issue", number: 11 }],
    });
    const limited = (async () => new Response("slow down", { status: 429, headers: { "retry-after": "120" } })) as (url: string, init?: RequestInit) => Promise<Response>;

    const first = await runItemScan(harness.ctx, COMPANY, config, { fetchImpl: limited });
    expect(first.outcomes).toEqual([
      { item: "paperclipai/paperclip#11", card: null, status: "error", detail: "rate limited" },
    ]);
    const backoff = (await harness.ctx.state.get({ scopeKind: "company", scopeId: COMPANY, stateKey: "rate-limit" })) as { backoffUntil: string } | null;
    expect(backoff?.backoffUntil).toBeTruthy();

    // Immediate second run: the stored backoff holds, no HTTP happens.
    let fetched = false;
    const guard = (async () => {
      fetched = true;
      return new Response("unreachable", { status: 500 });
    }) as (url: string, init?: RequestInit) => Promise<Response>;
    const second = await runItemScan(harness.ctx, COMPANY, config, { fetchImpl: guard });
    expect(second.outcomes).toEqual([
      { item: "paperclipai/paperclip#11", card: null, status: "skipped-backoff" },
    ]);
    expect(fetched).toBe(false);
  });

  it("skips companies with no plugin config row (fail closed, no runs recorded)", async () => {
    const harness = await setup();
    await harness.runJob(RELEASE_JOB_KEY);
    await harness.runJob(ITEM_JOB_KEY);
    expect(getRuns(harness) ?? []).toHaveLength(0);
  });

  it("run history is bounded", async () => {
    const harness = await setup();
    for (let i = 0; i < 55; i += 1) {
      await recordRunStats(harness.ctx, COMPANY, stats({ ok200: i }));
    }
    const runs = getRuns(harness);
    expect(runs).toHaveLength(50);
    expect(runs[0]).toMatchObject({ ok200: 5 });
    expect(runs[49]).toMatchObject({ ok200: 54 });
  });
});
