import { describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { ITEM_JOB_KEY, RELEASE_JOB_KEY } from "./manifest.js";
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
  ...extra,
});

async function setup(config: Record<string, unknown> = {}) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({ companies: [{ id: COMPANY, name: "TWO", issuePrefix: "TWO" } as never] });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

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
        "issues.wakeup",
        "jobs.schedule",
        "http.outbound",
        "secrets.read-ref",
        "plugin.state.read",
        "plugin.state.write",
      ]),
    );
    const jobs = Object.fromEntries((manifest.jobs ?? []).map((j) => [j.jobKey, j.schedule]));
    expect(jobs[RELEASE_JOB_KEY]).toBe("*/10 * * * *");
    expect(jobs[ITEM_JOB_KEY]).toBe("*/15 * * * *");
    for (const key of [
      "tokenSecretRef",
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
    ]) {
      expect(manifest.instanceConfigSchema?.properties).toHaveProperty(key);
    }
  });

  it("runs the release scan through the registered job and records per-run stats", async () => {
    const harness = await setup({ releaseRepos: ["router-for-me/CLIProxyAPI"] });
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
    harness.setConfig({ followThroughTrackerIssueId: tracker.id, dryRun: true });
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

  it("a rate-limited item scan backs off and skips the next run", async () => {
    const harness = await setup();
    const tracker = await harness.ctx.issues.create({ companyId: COMPANY, title: "tracker" });
    const config = resolveConfig({
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
