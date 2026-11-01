import { beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { RELEASE_JOB_KEY, RELEASE_ORIGIN_KIND } from "./manifest.js";
import plugin from "./plugin.js";
import { resolveConfig } from "./config.js";
import { runReleaseScan } from "./releases.js";

const COMPANY = "c-1";

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

const json = (body: unknown, etag: string | null, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(etag ? { etag } : {}) },
  });

/** Stub GitHub `releases/latest` with per-tag bodies; honours If-None-Match. */
function releaseStub(tags: Record<string, { etag: string; body: Record<string, unknown> }>): { stub: FetchStub; calls: string[] } {
  const calls: string[] = [];
  const stub: FetchStub = async (url, init) => {
    calls.push(url);
    const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/releases\/latest$/.exec(url);
    if (!match) return new Response("not found", { status: 404 });
    const repo = `${match[1]}/${match[2]}`;
    const entry = tags[repo];
    if (!entry) return new Response("not found", { status: 404 });
    const headers = new Headers(init?.headers);
    if (headers.get("If-None-Match") === entry.etag) return new Response(null, { status: 304, headers: { etag: entry.etag } });
    return json(entry.body, entry.etag);
  };
  return { stub, calls };
}

const releaseBody = (tag: string) => ({
  tag_name: tag,
  name: tag,
  html_url: `https://github.com/router-for-me/CLIProxyAPI/releases/tag/${tag}`,
  published_at: "2026-11-01T00:00:00Z",
});

async function setup(config: Record<string, unknown> = {}) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({ companies: [{ id: COMPANY, name: "TWO", issuePrefix: "TWO" } as never] });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

const scan = (harness: TestHarness, fetchImpl: FetchStub, config: Record<string, unknown> = {}) =>
  runReleaseScan(harness.ctx, COMPANY, resolveConfig({ releaseRepos: ["router-for-me/CLIProxyAPI"], ...config }), { fetchImpl });

describe("release job", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await setup();
  });

  it("a 304 path causes no creates", async () => {
    const { stub } = releaseStub({ "router-for-me/CLIProxyAPI": { etag: '"v1"', body: releaseBody("v8.0.50") } });
    harness.ctx.http.fetch = stub;
    const first = await scan(harness, stub);
    expect(first.outcomes).toEqual([{ repo: "router-for-me/CLIProxyAPI", status: "created", tag: "v8.0.50" }]);

    const second = await scan(harness, stub);
    expect(second.outcomes).toEqual([{ repo: "router-for-me/CLIProxyAPI", status: "not-modified", tag: "v8.0.50" }]);
    expect(second.stats.notModified304).toBe(1);
    expect(second.stats.creates).toBe(0);
  });

  it("a new release creates exactly one card, deduped across runs and restarts", async () => {
    const backing = { "router-for-me/CLIProxyAPI": { etag: '"v2"', body: releaseBody("v8.0.51") } };
    const { stub, calls } = releaseStub(backing);
    harness.ctx.http.fetch = stub;

    const first = await scan(harness, stub);
    expect(first.outcomes).toEqual([{ repo: "router-for-me/CLIProxyAPI", status: "created", tag: "v8.0.51" }]);
    const cards = await harness.ctx.issues.list({ companyId: COMPANY, originKind: RELEASE_ORIGIN_KIND, originId: "router-for-me/CLIProxyAPI@v8.0.51" });
    expect(cards).toHaveLength(1);
    expect(cards[0].assigneeAgentId).toBe("c4bd17fa-72df-43b4-83cd-df59ec7de5d0");
    expect(cards[0].description).toContain("router-for-me/CLIProxyAPI@v8.0.51");
    expect(cards[0].description).toContain("release-intake");

    // Same worker, second run: 304, no duplicate.
    const second = await scan(harness, stub);
    expect(second.stats.creates).toBe(0);
    expect((await harness.ctx.issues.list({ companyId: COMPANY, originKind: RELEASE_ORIGIN_KIND })).length).toBe(1);

    // Fresh worker (restart) with the same plugin state: still no duplicate.
    await plugin.definition.setup(harness.ctx);
    harness.ctx.http.fetch = stub;
    const third = await scan(harness, stub);
    expect(third.stats.creates).toBe(0);
    expect(third.outcomes[0].status).toBe("not-modified");
    expect(calls.filter((u) => u.includes("releases/latest"))).toHaveLength(3);
  });

  it("does not duplicate when plugin state was lost but the card exists", async () => {
    const { stub } = releaseStub({ "router-for-me/CLIProxyAPI": { etag: '"v3"', body: releaseBody("v8.0.52") } });
    harness.ctx.http.fetch = stub;
    await harness.ctx.issues.create({
      companyId: COMPANY,
      title: "existing",
      assigneeAgentId: "c4bd17fa-72df-43b4-83cd-df59ec7de5d0",
      originKind: RELEASE_ORIGIN_KIND,
      originId: "router-for-me/CLIProxyAPI@v8.0.52",
    });
    const result = await scan(harness, stub);
    expect(result.outcomes[0].status).toBe("already-created");
    expect(result.stats.creates).toBe(0);
  });

  it("dry-run logs the intended create without creating, then the real run creates it", async () => {
    const { stub } = releaseStub({ "router-for-me/CLIProxyAPI": { etag: '"v4"', body: releaseBody("v8.0.53") } });
    harness.ctx.http.fetch = stub;
    const dry = await scan(harness, stub, { dryRun: true });
    expect(dry.outcomes[0].status).toBe("would-create");
    expect((await harness.ctx.issues.list({ companyId: COMPANY, originKind: RELEASE_ORIGIN_KIND })).length).toBe(0);

    // The tag was observed but no card may exist yet: the live run refetches
    // the body ( unconditional GET after the 304) and creates exactly one card.
    const live = await scan(harness, stub);
    expect(live.outcomes[0].status).toBe("created");
    expect((await harness.ctx.issues.list({ companyId: COMPANY, originKind: RELEASE_ORIGIN_KIND, originId: "router-for-me/CLIProxyAPI@v8.0.53" })).length).toBe(1);
  });

  it("registers the job and records per-run 304/200 stats in plugin state", async () => {
    const { stub } = releaseStub({ "router-for-me/CLIProxyAPI": { etag: '"v5"', body: releaseBody("v8.0.54") } });
    harness.setConfig({ releaseRepos: ["router-for-me/CLIProxyAPI"] });
    harness.ctx.http.fetch = stub;
    await harness.runJob(RELEASE_JOB_KEY);
    await harness.runJob(RELEASE_JOB_KEY);
    const runs = harness.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: "runs" }) as Array<{ ok200: number; notModified304: number }>;
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ ok200: 1, notModified304: 0 });
    expect(runs[1]).toMatchObject({ ok200: 0, notModified304: 1 });
  });
});
