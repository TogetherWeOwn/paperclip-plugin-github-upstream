import { beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { RELEASE_JOB_KEY, RELEASE_ORIGIN_KIND } from "./manifest.js";
import plugin from "./plugin.js";
import { resolveConfig } from "./config.js";
import { releaseCardBody, runReleaseScan } from "./releases.js";

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

const TOKEN_REF = { type: "secret_ref", secretId: "test-token" };

const scan = (harness: TestHarness, fetchImpl: FetchStub, config: Record<string, unknown> = {}) =>
  runReleaseScan(harness.ctx, COMPANY, resolveConfig({ tokenSecretRef: TOKEN_REF, releaseRepos: ["router-for-me/CLIProxyAPI"], ...config }), { fetchImpl });

describe("release job", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await setup();
  });

  it("a fresh install baselines the first-seen tag, then a new tag creates one card", async () => {
    const backing: Record<string, { etag: string; body: Record<string, unknown> }> = {
      "router-for-me/CLIProxyAPI": { etag: '"v1"', body: releaseBody("v8.0.50") },
    };
    const { stub } = releaseStub(backing);
    harness.ctx.http.fetch = stub;
    // No compareBases entry: the running version is recorded, never carded.
    const first = await scan(harness, stub);
    expect(first.outcomes).toEqual([
      { repo: "router-for-me/cliproxyapi", status: "already-created", tag: "v8.0.50", detail: expect.stringContaining("baseline") },
    ]);
    expect(first.stats.creates).toBe(0);
    expect(await harness.ctx.issues.list({ companyId: COMPANY, originKind: RELEASE_ORIGIN_KIND })).toHaveLength(0);

    backing["router-for-me/CLIProxyAPI"] = { etag: '"v1b"', body: releaseBody("v8.0.51") };
    const second = await scan(harness, stub);
    expect(second.outcomes).toEqual([{ repo: "router-for-me/cliproxyapi", status: "created", tag: "v8.0.51" }]);

    const third = await scan(harness, stub);
    expect(third.outcomes).toEqual([{ repo: "router-for-me/cliproxyapi", status: "not-modified", tag: "v8.0.51" }]);
    expect(third.stats.notModified304).toBe(1);
    expect(third.stats.creates).toBe(0);
  });

  it("a new release creates exactly one card, deduped across runs and restarts", async () => {
    const backing = { "router-for-me/CLIProxyAPI": { etag: '"v2"', body: releaseBody("v8.0.51") } };
    const { stub, calls } = releaseStub(backing);
    harness.ctx.http.fetch = stub;
    const base = { compareBases: { "router-for-me/CLIProxyAPI": "v8.0.50" } };

    const first = await scan(harness, stub, base);
    expect(first.outcomes).toEqual([{ repo: "router-for-me/cliproxyapi", status: "created", tag: "v8.0.51" }]);
    const cards = await harness.ctx.issues.list({ companyId: COMPANY, originKind: RELEASE_ORIGIN_KIND, originId: "router-for-me/cliproxyapi@v8.0.51" });
    expect(cards).toHaveLength(1);
    expect(cards[0].assigneeAgentId).toBe("c4bd17fa-72df-43b4-83cd-df59ec7de5d0");
    expect(cards[0].description).toContain("router-for-me/cliproxyapi@v8.0.51");
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
      originId: "router-for-me/cliproxyapi@v8.0.52",
    });
    const result = await scan(harness, stub);
    expect(result.outcomes[0].status).toBe("already-created");
    expect(result.stats.creates).toBe(0);
  });

  it("first sight at the compare base records the baseline and creates no card", async () => {
    const backing: Record<string, { etag: string; body: Record<string, unknown> }> = {
      "router-for-me/CLIProxyAPI": { etag: '"b1"', body: releaseBody("v8.0.51") },
    };
    const { stub } = releaseStub(backing);
    harness.ctx.http.fetch = stub;
    const base = { compareBases: { "router-for-me/CLIProxyAPI": "v8.0.51" } };

    // A dry run first reports the baseline without recording or carding it.
    const dry = await scan(harness, stub, { ...base, dryRun: true });
    expect(dry.outcomes).toEqual([
      { repo: "router-for-me/cliproxyapi", status: "already-created", tag: "v8.0.51", detail: expect.stringContaining("baseline") },
    ]);
    expect(dry.stats.creates).toBe(0);

    // The live run records the baseline instead of carding the running version.
    const first = await scan(harness, stub, base);
    expect(first.outcomes[0]).toMatchObject({ status: "already-created", tag: "v8.0.51" });
    expect(first.stats.creates).toBe(0);
    expect(await harness.ctx.issues.list({ companyId: COMPANY, originKind: RELEASE_ORIGIN_KIND })).toHaveLength(0);

    // Still the baseline on a 304: no late card either.
    const steady = await scan(harness, stub, base);
    expect(steady.outcomes).toEqual([{ repo: "router-for-me/cliproxyapi", status: "not-modified", tag: "v8.0.51" }]);
    expect(steady.stats.creates).toBe(0);

    // A newer tag than the base still creates exactly one card.
    backing["router-for-me/CLIProxyAPI"] = { etag: '"b2"', body: releaseBody("v8.0.52") };
    const next = await scan(harness, stub, base);
    expect(next.outcomes).toEqual([{ repo: "router-for-me/cliproxyapi", status: "created", tag: "v8.0.52" }]);
    expect(await harness.ctx.issues.list({ companyId: COMPANY, originKind: RELEASE_ORIGIN_KIND })).toHaveLength(1);
  });

  it("a first-seen tag newer than the compare base still creates a card", async () => {
    const { stub } = releaseStub({ "router-for-me/CLIProxyAPI": { etag: '"n1"', body: releaseBody("v8.0.52") } });
    harness.ctx.http.fetch = stub;
    const result = await scan(harness, stub, { compareBases: { "router-for-me/CLIProxyAPI": "v8.0.51" } });
    expect(result.outcomes).toEqual([{ repo: "router-for-me/cliproxyapi", status: "created", tag: "v8.0.52" }]);
  });

  it("dry-run reports the intended create without creating, then the real run creates it", async () => {
    const backing: Record<string, { etag: string; body: Record<string, unknown> }> = {
      "router-for-me/CLIProxyAPI": { etag: '"v4"', body: releaseBody("v8.0.53") },
    };
    const { stub } = releaseStub(backing);
    harness.ctx.http.fetch = stub;
    const base = { compareBases: { "router-for-me/CLIProxyAPI": "v8.0.53" } };
    // Baseline the running version first, so the install version never cards.
    const first = await scan(harness, stub, base);
    expect(first.outcomes[0]).toMatchObject({ status: "already-created", tag: "v8.0.53" });

    backing["router-for-me/CLIProxyAPI"] = { etag: '"v4b"', body: releaseBody("v8.0.54") };
    const dry = await scan(harness, stub, { ...base, dryRun: true });
    expect(dry.outcomes[0].status).toBe("would-create");
    expect((await harness.ctx.issues.list({ companyId: COMPANY, originKind: RELEASE_ORIGIN_KIND })).length).toBe(0);

    // The dry run records nothing: the live run creates exactly one card.
    const live = await scan(harness, stub, base);
    expect(live.outcomes[0].status).toBe("created");
    expect((await harness.ctx.issues.list({ companyId: COMPANY, originKind: RELEASE_ORIGIN_KIND, originId: "router-for-me/cliproxyapi@v8.0.54" })).length).toBe(1);
  });

  it("F1: release create caps defer the overflow to the next tick", async () => {
    const backing: Record<string, { etag: string; body: Record<string, unknown> }> = {
      "router-for-me/CLIProxyAPI": { etag: '"m1"', body: releaseBody("v8.0.51") },
      "paperclipai/paperclip": {
        etag: '"m2"',
        body: { ...releaseBody("v1.2.4"), html_url: "https://github.com/paperclipai/paperclip/releases/tag/v1.2.4" },
      },
    };
    const { stub } = releaseStub(backing);
    harness.ctx.http.fetch = stub;
    const config = {
      releaseRepos: ["router-for-me/CLIProxyAPI", "paperclipai/paperclip"],
      compareBases: { "router-for-me/CLIProxyAPI": "v8.0.50", "paperclipai/paperclip": "v1.2.3" },
      maxCreatesPerTick: 1,
    };
    const first = await scan(harness, stub, config);
    expect(first.outcomes.find((o) => o.repo === "router-for-me/cliproxyapi")?.status).toBe("created");
    expect(first.outcomes.find((o) => o.repo === "paperclipai/paperclip")?.status).toBe("capped");
    expect(first.stats.creates).toBe(1);
    expect(first.stats.capped).toBe(1);

    const second = await scan(harness, stub, config);
    expect(second.outcomes.find((o) => o.repo === "paperclipai/paperclip")?.status).toBe("created");
    expect(second.stats.capped).toBe(0);
    expect(await harness.ctx.issues.list({ companyId: COMPANY, originKind: RELEASE_ORIGIN_KIND })).toHaveLength(2);
  });

  it("registers the job and records per-run 304/200 stats in plugin state", async () => {
    const { stub } = releaseStub({ "router-for-me/CLIProxyAPI": { etag: '"v5"', body: releaseBody("v8.0.54") } });
    harness.setConfig({ tokenSecretRef: TOKEN_REF, releaseRepos: ["router-for-me/CLIProxyAPI"] });
    // Seed a prior baseline so the first run sees a *new* tag: 200 then 304.
    await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, stateKey: "releases" }, {
      "router-for-me/cliproxyapi": { etag: '"old"', tag: "v8.0.0", createdTag: "v8.0.0", checkedAt: new Date(0).toISOString() },
    });
    harness.ctx.http.fetch = stub;
    await harness.runJob(RELEASE_JOB_KEY);
    await harness.runJob(RELEASE_JOB_KEY);
    const runs = harness.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: "runs" }) as Array<{ ok200: number; notModified304: number }>;
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ ok200: 1, notModified304: 0 });
    expect(runs[1]).toMatchObject({ ok200: 0, notModified304: 1 });
  });
});

describe("release hardening", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await setup();
  });

  interface WakeCall {
    issueId: string;
    companyId: string;
    options?: { reason?: string; idempotencyKey?: string | null };
  }

  function spyWakes(harness: TestHarness): WakeCall[] {
    const calls: WakeCall[] = [];
    const orig = harness.ctx.issues.requestWakeup.bind(harness.ctx.issues);
    harness.ctx.issues.requestWakeup = (async (issueId: string, companyId: string, options?: WakeCall["options"]) => {
      calls.push({ issueId, companyId, options });
      return orig(issueId, companyId, options);
    }) as typeof harness.ctx.issues.requestWakeup;
    return calls;
  }

  const seedState = (tag: string, createdTag: string | null, etag = '"u0"') =>
    harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, stateKey: "releases" }, {
      "router-for-me/cliproxyapi": { etag, tag, createdTag, checkedAt: new Date(0).toISOString() },
    });

  const openCard = (tag: string) =>
    harness.ctx.issues.create({
      companyId: COMPANY,
      title: `Upstream release router-for-me/cliproxyapi@${tag} — intake`,
      description: "intake",
      assigneeAgentId: "c4bd17fa-72df-43b4-83cd-df59ec7de5d0",
      originKind: RELEASE_ORIGIN_KIND,
      originId: `router-for-me/cliproxyapi@${tag}`,
    });

  it("F2: a newer tag retitles the one open card and wakes it at most once", async () => {
    await seedState("v8.0.50", "v8.0.50", '"u1"');
    const card = await openCard("v8.0.50");
    const { stub } = releaseStub({ "router-for-me/CLIProxyAPI": { etag: '"u2"', body: releaseBody("v8.0.51") } });
    const wakes = spyWakes(harness);

    const first = await scan(harness, stub);
    expect(first.outcomes).toEqual([
      { repo: "router-for-me/cliproxyapi", status: "updated", tag: "v8.0.51", detail: expect.stringContaining("updated to v8.0.51") },
    ]);
    const cards = await harness.ctx.issues.list({ companyId: COMPANY, originKind: RELEASE_ORIGIN_KIND });
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe(card.id);
    expect(cards[0].title).toContain("router-for-me/cliproxyapi@v8.0.51");
    // The origin moves with the retitle: it is the durable dedup record.
    expect(cards[0].originId).toBe("router-for-me/cliproxyapi@v8.0.51");
    expect(wakes).toHaveLength(1);
    expect(wakes[0].issueId).toBe(card.id);
    expect(wakes[0].options?.idempotencyKey).toBe("upstream:router-for-me/cliproxyapi@v8.0.51");

    // Steady state: a 304 wakes nothing again.
    const second = await scan(harness, stub);
    expect(second.outcomes).toEqual([{ repo: "router-for-me/cliproxyapi", status: "not-modified", tag: "v8.0.51" }]);
    expect(wakes).toHaveLength(1);
  });

  it("F2: a closed intake card does not own the repo — the next tag opens a new card", async () => {
    await seedState("v8.0.50", "v8.0.50", '"u1"');
    const old = await openCard("v8.0.50");
    await harness.ctx.issues.update(old.id, { status: "done" }, COMPANY);
    const { stub } = releaseStub({ "router-for-me/CLIProxyAPI": { etag: '"u2"', body: releaseBody("v8.0.51") } });

    const result = await scan(harness, stub);
    expect(result.outcomes).toEqual([{ repo: "router-for-me/cliproxyapi", status: "created", tag: "v8.0.51" }]);
    expect(await harness.ctx.issues.list({ companyId: COMPANY, originKind: RELEASE_ORIGIN_KIND })).toHaveLength(2);
  });

  it("F2: plugin state loss with an existing card still creates nothing (originId lookup)", async () => {
    // createdTag covers an older tag and a base is recorded, so this is not the
    // install baseline: the already-created verdict comes from the card lookup.
    await seedState("v8.0.51", "v8.0.51", '"u1"');
    await openCard("v8.0.52");
    const { stub } = releaseStub({ "router-for-me/CLIProxyAPI": { etag: '"u2"', body: releaseBody("v8.0.52") } });

    const result = await scan(harness, stub, { compareBases: { "router-for-me/CLIProxyAPI": "v8.0.51" } });
    expect(result.outcomes[0].status).toBe("already-created");
    expect(result.outcomes[0].detail).toContain("already exists");
    expect(result.stats.creates).toBe(0);
  });

  it("F6: an unsafe tag_name is an error, never a card", async () => {
    const { stub } = releaseStub({
      "router-for-me/CLIProxyAPI": {
        etag: '"bad"',
        body: { ...releaseBody("v8.0.51"), tag_name: "v8.0.51 recklessly; rm -rf" },
      },
    });
    const result = await scan(harness, stub, { compareBases: { "router-for-me/CLIProxyAPI": "v8.0.50" } });
    expect(result.outcomes).toEqual([
      { repo: "router-for-me/cliproxyapi", status: "error", tag: "v8.0.51 recklessly; rm -rf", detail: expect.stringContaining("invalid tag_name") },
    ]);
    expect(result.stats.errors).toBe(1);
    expect(await harness.ctx.issues.list({ companyId: COMPANY, originKind: RELEASE_ORIGIN_KIND })).toHaveLength(0);
  });

  it("a retitled card still dedupes after plugin state loss", async () => {
    await seedState("v8.0.50", "v8.0.50", '"u1"');
    const card = await openCard("v8.0.50");
    const { stub } = releaseStub({ "router-for-me/CLIProxyAPI": { etag: '"u2"', body: releaseBody("v8.0.51") } });

    const first = await scan(harness, stub);
    expect(first.outcomes[0].status).toBe("updated");
    await harness.ctx.issues.update(card.id, { status: "done" }, COMPANY);

    // State is lost, but the closed card carries the newest tag in its
    // originId: the exact lookup finds it instead of creating a duplicate.
    await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, stateKey: "releases" }, {});
    const second = await scan(harness, stub, { compareBases: { "router-for-me/CLIProxyAPI": "v8.0.50" } });
    expect(second.outcomes[0].status).toBe("already-created");
    expect(second.stats.creates).toBe(0);
    expect(await harness.ctx.issues.list({ companyId: COMPANY, originKind: RELEASE_ORIGIN_KIND })).toHaveLength(1);
  });

  it("a wake-exhausted tick creates no release card either (creates spend wakes)", async () => {
    const { stub } = releaseStub({ "router-for-me/CLIProxyAPI": { etag: '"w1"', body: releaseBody("v8.0.55") } });
    const config = {
      compareBases: { "router-for-me/CLIProxyAPI": "v8.0.54" },
      maxCreatesPerTick: 2,
      maxWakesPerTick: 0,
    };
    const first = await scan(harness, stub, config);
    expect(first.outcomes).toEqual([
      { repo: "router-for-me/cliproxyapi", status: "capped", tag: "v8.0.55", detail: expect.stringContaining("deferred to next tick") },
    ]);
    expect(first.stats.creates).toBe(0);
    expect(await harness.ctx.issues.list({ companyId: COMPANY, originKind: RELEASE_ORIGIN_KIND })).toHaveLength(0);

    // The next tick with wake budget creates the card.
    const second = await scan(harness, stub, { ...config, maxWakesPerTick: 5 });
    expect(second.outcomes).toEqual([{ repo: "router-for-me/cliproxyapi", status: "created", tag: "v8.0.55" }]);
  });

  it("a new release updates the existing open intake instead of baselining (state loss, no compareBases)", async () => {
    // Open v8.0.50 intake exists but plugin state was lost: no record at all.
    // Latest is v8.0.51 with no compare base configured. The tag must update
    // the open card, never vanish as an install baseline.
    const card = await openCard("v8.0.50");
    const { stub } = releaseStub({ "router-for-me/CLIProxyAPI": { etag: '"c1"', body: releaseBody("v8.0.51") } });
    const wakes = spyWakes(harness);

    const result = await scan(harness, stub);
    expect(result.outcomes).toEqual([
      { repo: "router-for-me/cliproxyapi", status: "updated", tag: "v8.0.51", detail: expect.stringContaining("updated to v8.0.51") },
    ]);
    const cards = await harness.ctx.issues.list({ companyId: COMPANY, originKind: RELEASE_ORIGIN_KIND });
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe(card.id);
    expect(cards[0].originId).toBe("router-for-me/cliproxyapi@v8.0.51");
    expect(wakes).toHaveLength(1);
  });

  it("a capped release wake retitles now and wakes on the next tick with budget", async () => {
    await seedState("v8.0.50", "v8.0.50", '"u1"');
    const card = await openCard("v8.0.50");
    const { stub } = releaseStub({ "router-for-me/CLIProxyAPI": { etag: '"u2"', body: releaseBody("v8.0.51") } });
    const wakes = spyWakes(harness);

    const capped = await scan(harness, stub, { maxWakesPerTick: 0 });
    expect(capped.outcomes).toEqual([
      { repo: "router-for-me/cliproxyapi", status: "capped", tag: "v8.0.51", detail: expect.stringContaining("wake deferred") },
    ]);
    expect(wakes).toHaveLength(0);
    // The card already moved to the new tag...
    const moved = await harness.ctx.issues.list({ companyId: COMPANY, originKind: RELEASE_ORIGIN_KIND });
    expect(moved).toHaveLength(1);
    expect(moved[0].originId).toBe("router-for-me/cliproxyapi@v8.0.51");

    // ...and the retry tick wakes exactly once instead of going already-created.
    const retry = await scan(harness, stub, { maxWakesPerTick: 5 });
    expect(retry.outcomes).toEqual([
      { repo: "router-for-me/cliproxyapi", status: "updated", tag: "v8.0.51", detail: expect.stringContaining("updated to v8.0.51") },
    ]);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].issueId).toBe(card.id);
  });

  it("a retried release wake keeps the original previous tag in the card body", async () => {
    await seedState("v8.0.50", "v8.0.50", '"u1"');
    await openCard("v8.0.50");
    const { stub } = releaseStub({ "router-for-me/CLIProxyAPI": { etag: '"u2"', body: releaseBody("v8.0.51") } });

    const capped = await scan(harness, stub, { maxWakesPerTick: 0 });
    expect(capped.outcomes[0].status).toBe("capped");
    const moved = (await harness.ctx.issues.list({ companyId: COMPANY, originKind: RELEASE_ORIGIN_KIND }))[0];
    expect(moved.description).toContain("previous seen tag was `v8.0.50`");

    // The retry tick must not rewrite the body with the new tag as its own
    // previous tag: the retitle already happened on the capped tick.
    const retry = await scan(harness, stub, { maxWakesPerTick: 5 });
    expect(retry.outcomes[0].status).toBe("updated");
    const final = (await harness.ctx.issues.list({ companyId: COMPANY, originKind: RELEASE_ORIGIN_KIND }))[0];
    expect(final.description).toContain("previous seen tag was `v8.0.50`");
    expect(final.description).not.toContain("previous seen tag was `v8.0.51`");
  });

  it("mixed-case release state from before the lowercase upgrade still drives the scan", async () => {
    // Pre-upgrade record keyed by configured case; tag v8.0.50 already carded.
    await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, stateKey: "releases" }, {
      "router-for-me/CLIProxyAPI": { etag: '"old"', tag: "v8.0.50", createdTag: "v8.0.50", checkedAt: new Date(0).toISOString() },
    });
    const { stub } = releaseStub({ "router-for-me/CLIProxyAPI": { etag: '"u2"', body: releaseBody("v8.0.51") } });
    const result = await scan(harness, stub);
    // History survived: v8.0.51 is a new release, not a first-seen baseline.
    expect(result.outcomes).toEqual([{ repo: "router-for-me/cliproxyapi", status: "created", tag: "v8.0.51" }]);
  });

  it("a crafted compare base never enters the intake card", async () => {
    const evil = "v8.0.50](https://evil.example) [injected";
    const body = releaseCardBody({
      owner: "router-for-me",
      repo: "CLIProxyAPI",
      tag: "v8.0.51",
      releaseUrl: "https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.51",
      publishedAt: "2026-11-01T00:00:00Z",
      compareBase: evil,
      previousTag: "v8.0.50",
    });
    expect(body).not.toContain(evil);
    expect(body).not.toContain("evil.example");
    expect(body).toContain("no recorded base yet");
    const clean = releaseCardBody({
      owner: "router-for-me",
      repo: "CLIProxyAPI",
      tag: "v8.0.51",
      releaseUrl: "https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.51",
      publishedAt: "2026-11-01T00:00:00Z",
      compareBase: "v8.0.50",
      previousTag: null,
    });
    expect(clean).toContain("compare/v8.0.50...v8.0.51");
  });

  it("F7: a release scan with no auth configured errors without any fetch", async () => {
    let fetched = false;
    const guard = (async () => {
      fetched = true;
      return new Response("unreachable", { status: 500 });
    }) as (url: string, init?: RequestInit) => Promise<Response>;
    const result = await runReleaseScan(
      harness.ctx,
      COMPANY,
      resolveConfig({ releaseRepos: ["router-for-me/CLIProxyAPI"] }),
      { fetchImpl: guard },
    );
    expect(result.stats.errors).toBe(1);
    expect(result.outcomes).toEqual([
      { repo: "-", status: "error", tag: null, detail: expect.stringContaining("refusing unauthenticated scan") },
    ]);
    expect(fetched).toBe(false);
  });
});
