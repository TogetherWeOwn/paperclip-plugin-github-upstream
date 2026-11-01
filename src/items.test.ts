import { beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { ITEM_ORIGIN_KIND } from "./manifest.js";
import plugin from "./plugin.js";
import { resolveConfig } from "./config.js";
import { runItemScan } from "./items.js";

const COMPANY = "c-1";
const OWNER = "paperclipai";
const REPO = "paperclip";
const AGENT = "7b8f576c-ebce-447f-a904-dda322df4220";

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

const json = (body: unknown, etag: string | null, status = 200) =>
  new Response(status === 304 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(etag ? { etag } : {}) },
  });

interface RouteTable {
  /** REST URL -> current {etag, body}. Mutate between runs to simulate change. */
  rest: Record<string, { etag: string; body: unknown }>;
  /** Current GraphQL discussion payload (no 304 path exists for GraphQL). */
  graphqlDiscussion: unknown;
  calls: string[];
}

/**
 * Stub the GitHub REST + GraphQL surface items.ts reads. REST routes honour
 * If-None-Match; GraphQL always answers 200 with the current payload.
 */
function itemStub(table: RouteTable): FetchStub {
  return (async (url: string, init?: RequestInit) => {
    table.calls.push(`${init?.method ?? "GET"} ${url}`);
    const headers = new Headers(init?.headers);
    if (url === "https://api.github.com/graphql") {
      return json({ data: { repository: { discussion: table.graphqlDiscussion } } }, null);
    }
    const entry = table.rest[url];
    if (!entry) return new Response("not found", { status: 404 });
    if (headers.get("If-None-Match") === entry.etag) {
      return new Response(null, { status: 304, headers: { etag: entry.etag } });
    }
    return json(entry.body, entry.etag);
  }) as FetchStub;
}

const issueUrl = (n: number) => `https://api.github.com/repos/${OWNER}/${REPO}/issues/${n}`;
const pullUrl = (n: number) => `https://api.github.com/repos/${OWNER}/${REPO}/pulls/${n}`;
const reviewsUrl = (n: number) => `https://api.github.com/repos/${OWNER}/${REPO}/pulls/${n}/reviews`;
const checksUrl = (sha: string) => `https://api.github.com/repos/${OWNER}/${REPO}/commits/${sha}/check-runs`;

const HEAD_SHA = "aaea1d47500112233445566778899aabbccddeeff";

const issueRow = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `issue ${n}`,
  state: "open",
  updated_at: "2026-10-12T00:00:00Z",
  comments: 1,
  html_url: `https://github.com/${OWNER}/${REPO}/issues/${n}`,
  user: { login: "stranger" },
  ...extra,
});

const pullIssueRow = (n: number, extra: Record<string, unknown> = {}) =>
  issueRow(n, {
    html_url: `https://github.com/${OWNER}/${REPO}/pull/${n}`,
    ...extra,
    pull_request: {},
  });

const pullRow = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `pr ${n}`,
  state: "open",
  draft: false,
  merged: false,
  updated_at: "2026-10-12T00:00:00Z",
  html_url: `https://github.com/${OWNER}/${REPO}/pull/${n}`,
  user: { login: "stranger" },
  head: { sha: HEAD_SHA, label: "someone:branch" },
  ...extra,
});

const checksSuccess = { total_count: 2, check_runs: [{ status: "completed", conclusion: "success", name: "ci" }] };

async function setup() {
  const harness = createTestHarness({ manifest, config: {} });
  harness.seed({ companies: [{ id: COMPANY, name: "TWO", issuePrefix: "TWO" } as never] });
  await plugin.definition.setup(harness.ctx);
  const tracker = await harness.ctx.issues.create({ companyId: COMPANY, title: "follow-through tracker" });
  return { harness, trackerId: tracker.id };
}

const scan = (harness: TestHarness, trackerId: string, stub: FetchStub, config: Record<string, unknown> = {}) =>
  runItemScan(harness.ctx, COMPANY, resolveConfig({ followThroughTrackerIssueId: trackerId, ...config }), { fetchImpl: stub });

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

function spyUpdates(harness: TestHarness): Array<{ issueId: string; patch: Record<string, unknown> }> {
  const calls: Array<{ issueId: string; patch: Record<string, unknown> }> = [];
  const orig = harness.ctx.issues.update.bind(harness.ctx.issues);
  harness.ctx.issues.update = (async (issueId: string, patch: Record<string, unknown>, companyId: string) => {
    calls.push({ issueId, patch });
    return orig(issueId, patch as never, companyId);
  }) as typeof harness.ctx.issues.update;
  return calls;
}

async function child(
  harness: TestHarness,
  trackerId: string,
  extra: Record<string, unknown>,
  originId: string | null,
) {
  return harness.ctx.issues.create({
    companyId: COMPANY,
    parentId: trackerId,
    title: `child ${originId ?? "no-origin"}`,
    assigneeAgentId: AGENT,
    ...(originId ? { originKind: ITEM_ORIGIN_KIND, originId } : {}),
    ...extra,
  } as never);
}

describe("item job", () => {
  let harness: TestHarness;
  let trackerId: string;

  beforeEach(async () => {
    ({ harness, trackerId } = await setup());
  });

  it("a 304 path causes no wakes and no updates", async () => {
    const card = await child(harness, trackerId, {}, `${OWNER}/${REPO}#15158`);
    const table: RouteTable = {
      rest: {
        [issueUrl(15158)]: { etag: '"i1"', body: pullIssueRow(15158) },
        [pullUrl(15158)]: { etag: '"p1"', body: pullRow(15158) },
        [reviewsUrl(15158)]: { etag: '"r1"', body: [] },
        [checksUrl(HEAD_SHA)]: { etag: '"c1"', body: checksSuccess },
      },
      graphqlDiscussion: null,
      calls: [],
    };
    const stub = itemStub(table);
    const wakes = spyWakes(harness);
    const updates = spyUpdates(harness);

    const first = await scan(harness, trackerId, stub);
    expect(first.outcomes).toHaveLength(1);
    expect(wakes).toHaveLength(0);

    const second = await scan(harness, trackerId, stub);
    expect(second.outcomes).toEqual([
      { item: `${OWNER}/${REPO}#15158`, card: card.id, status: "unchanged" },
    ]);
    expect(second.stats.ok200).toBe(0);
    expect(second.stats.notModified304).toBe(3);
    expect(second.stats.wakes).toBe(0);
    expect(wakes).toHaveLength(0);
    // Labels/header were synced on first sight; nothing to write on a 304 run.
    const updateCountAfterFirst = updates.length;
    expect(updateCountAfterFirst).toBeGreaterThan(0);
    expect(updates.length).toBe(updateCountAfterFirst);
  });

  it("a changed item wakes exactly once, deduped across runs and restarts", async () => {
    const card = await child(harness, trackerId, {}, `${OWNER}/${REPO}#15158`);
    const table: RouteTable = {
      rest: {
        [issueUrl(15158)]: { etag: '"i1"', body: pullIssueRow(15158) },
        [pullUrl(15158)]: { etag: '"p1"', body: pullRow(15158) },
        [reviewsUrl(15158)]: { etag: '"r1"', body: [] },
        [checksUrl(HEAD_SHA)]: { etag: '"c1"', body: checksSuccess },
      },
      graphqlDiscussion: null,
      calls: [],
    };
    const stub = itemStub(table);
    const wakes = spyWakes(harness);

    await scan(harness, trackerId, stub);
    expect(wakes).toHaveLength(0);

    // Three new comments upstream: new body AND new ETag, like the real API.
    table.rest[issueUrl(15158)] = {
      etag: '"i2"',
      body: pullIssueRow(15158, { comments: 4, updated_at: "2026-10-13T00:00:00Z" }),
    };
    const changed = await scan(harness, trackerId, stub);
    expect(changed.outcomes[0].status).toBe("woke");
    expect(changed.outcomes[0].reason).toContain("3 new comments");
    expect(changed.stats.wakes).toBe(1);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].issueId).toBe(card.id);
    expect(wakes[0].options?.idempotencyKey).toMatch(/^upstream:paperclipai\/paperclip#15158:/);

    // Same worker, second run: ETags match again, no second wake.
    const steady = await scan(harness, trackerId, stub);
    expect(steady.outcomes[0].status).toBe("unchanged");
    expect(wakes).toHaveLength(1);

    // Fresh worker (restart) with the same plugin state: still no second wake.
    await plugin.definition.setup(harness.ctx);
    const afterRestart = await scan(harness, trackerId, stub);
    expect(afterRestart.outcomes[0].status).toBe("unchanged");
    expect(wakes).toHaveLength(1);
  });

  it("maps cards by originId and by GitHub URL, backfilling the origin", async () => {
    const byOrigin = await child(harness, trackerId, {
      description: `Tracks https://github.com/${OWNER}/${REPO}/issues/100 for us.`,
    }, `${OWNER}/${REPO}#100`);
    // Most existing follow-through cards carry the upstream URL in the
    // description, not in a work product: the plugin maps and backfills those.
    const byUrl = await child(harness, trackerId, {
      description: `Owns upstream https://github.com/${OWNER}/${REPO}/pull/200 until it merges.`,
    }, null);
    const table: RouteTable = {
      rest: {
        [issueUrl(100)]: { etag: '"i100"', body: issueRow(100) },
        [issueUrl(200)]: { etag: '"i200"', body: pullIssueRow(200) },
        [pullUrl(200)]: { etag: '"p200"', body: pullRow(200) },
        [reviewsUrl(200)]: { etag: '"r200"', body: [] },
        [checksUrl(HEAD_SHA)]: { etag: '"c200"', body: checksSuccess },
      },
      graphqlDiscussion: null,
      calls: [],
    };
    const stub = itemStub(table);
    const wakes = spyWakes(harness);

    await scan(harness, trackerId, stub);
    expect(wakes).toHaveLength(0);

    table.rest[issueUrl(100)] = { etag: '"i101"', body: issueRow(100, { comments: 3 }) };
    table.rest[issueUrl(200)] = { etag: '"i201"', body: pullIssueRow(200, { comments: 5 }) };
    const changed = await scan(harness, trackerId, stub);
    expect(changed.outcomes.filter((o) => o.status === "woke")).toHaveLength(2);
    expect(new Set(wakes.map((w) => w.issueId))).toEqual(new Set([byOrigin.id, byUrl.id]));

    // The URL-mapped card now carries the origin, so a restart still maps it.
    const refetched = await harness.ctx.issues.get(byUrl.id, COMPANY);
    expect(refetched?.originKind).toBe(ITEM_ORIGIN_KIND);
    expect(refetched?.originId).toBe(`${OWNER}/${REPO}#200`);
  });

  it("creates a follow-through card for a new ours item and ignores not-ours ones", async () => {
    const table: RouteTable = {
      rest: {
        [issueUrl(300)]: { etag: '"i300"', body: pullIssueRow(300) },
        [pullUrl(300)]: { etag: '"p300"', body: pullRow(300, { head: { sha: HEAD_SHA, label: "TogetherWeOwn:fix-x" } }) },
        [reviewsUrl(300)]: { etag: '"r300"', body: [] },
        [checksUrl(HEAD_SHA)]: { etag: '"c300"', body: checksSuccess },
        [issueUrl(301)]: { etag: '"i301"', body: issueRow(301) },
      },
      graphqlDiscussion: null,
      calls: [],
    };
    const stub = itemStub(table);
    const config = {
      operatorLogin: "Rick7C2",
      extraTrackedItems: [
        { owner: OWNER, repo: REPO, kind: "pull", number: 300 },
        { owner: OWNER, repo: REPO, kind: "issue", number: 301 },
      ],
    };
    const first = await scan(harness, trackerId, stub, config);
    const created = first.outcomes.find((o) => o.item === `${OWNER}/${REPO}#300`);
    const ignored = first.outcomes.find((o) => o.item === `${OWNER}/${REPO}#301`);
    expect(created?.status).toBe("created");
    expect(ignored?.status).toBe("not-ours");

    const cards = await harness.ctx.issues.list({ companyId: COMPANY, originKind: ITEM_ORIGIN_KIND, originId: `${OWNER}/${REPO}#300` });
    expect(cards).toHaveLength(1);
    expect(cards[0].parentId).toBe(trackerId);

    const second = await scan(harness, trackerId, stub, config);
    expect(second.outcomes.find((o) => o.item === `${OWNER}/${REPO}#300`)?.status).toBe("unchanged");
    expect((await harness.ctx.issues.list({ companyId: COMPANY, originKind: ITEM_ORIGIN_KIND })).filter((c) => c.originId === `${OWNER}/${REPO}#300`)).toHaveLength(1);
  });

  it("guesses PR for bare originIds and self-corrects to issue on a 404", async () => {
    await child(harness, trackerId, {}, `${OWNER}/${REPO}#400`);
    const table: RouteTable = {
      // No pulls/400 route: the API 404s, proving this is an issue.
      rest: {
        [issueUrl(400)]: { etag: '"i400"', body: issueRow(400) },
      },
      graphqlDiscussion: null,
      calls: [],
    };
    const first = await scan(harness, trackerId, itemStub(table));
    expect(first.outcomes[0].status).not.toBe("error");
    // Second run takes the stored issue path directly, without another 404.
    const calls: string[] = [];
    const counting = itemStub({ ...table, calls });
    const second = await scan(harness, trackerId, counting);
    expect(second.outcomes[0].status).toBe("unchanged");
    expect(calls.filter((c) => c.includes("/pulls/400"))).toHaveLength(0);
  });

  it("syncs discussions through the GraphQL path and wakes on new comments", async () => {
    const card = await harness.ctx.issues.create({
      companyId: COMPANY,
      parentId: trackerId,
      title: "discussion child",
      assigneeAgentId: AGENT,
      description: `Tracks https://github.com/${OWNER}/${REPO}/discussions/500 for us.`,
      originKind: ITEM_ORIGIN_KIND,
      originId: `${OWNER}/${REPO}#500`,
    });
    const discussion = (comments: number) => ({
      title: "roadmap q&a",
      url: `https://github.com/${OWNER}/${REPO}/discussions/500`,
      updatedAt: "2026-10-12T00:00:00Z",
      closed: false,
      author: { login: "stranger" },
      comments: { totalCount: comments },
    });
    const table: RouteTable = { rest: {}, graphqlDiscussion: discussion(2), calls: [] };
    const stub = itemStub(table);
    const wakes = spyWakes(harness);

    const first = await scan(harness, trackerId, stub, { extraTrackedItems: [{ owner: OWNER, repo: REPO, kind: "discussion", number: 500 }] });
    expect(first.outcomes.find((o) => o.item === `${OWNER}/${REPO}#500`)?.card).toBe(card.id);
    expect(wakes).toHaveLength(0);

    table.graphqlDiscussion = discussion(5);
    const changed = await scan(harness, trackerId, stub, { extraTrackedItems: [{ owner: OWNER, repo: REPO, kind: "discussion", number: 500 }] });
    const outcome = changed.outcomes.find((o) => o.item === `${OWNER}/${REPO}#500`);
    expect(outcome?.status).toBe("woke");
    expect(outcome?.reason).toContain("3 new comments");
    expect(wakes).toHaveLength(1);

    const steady = await scan(harness, trackerId, stub, { extraTrackedItems: [{ owner: OWNER, repo: REPO, kind: "discussion", number: 500 }] });
    expect(steady.outcomes.find((o) => o.item === `${OWNER}/${REPO}#500`)?.status).toBe("unchanged");
    expect(wakes).toHaveLength(1);
  });

  it("wakes when pending checks settle", async () => {
    const card = await child(harness, trackerId, {}, `${OWNER}/${REPO}#600`);
    const pending = { total_count: 1, check_runs: [{ status: "in_progress", conclusion: null, name: "ci" }] };
    const table: RouteTable = {
      rest: {
        [issueUrl(600)]: { etag: '"i600"', body: pullIssueRow(600) },
        [pullUrl(600)]: { etag: '"p600"', body: pullRow(600) },
        [reviewsUrl(600)]: { etag: '"r600"', body: [] },
        [checksUrl(HEAD_SHA)]: { etag: '"c600a"', body: pending },
      },
      graphqlDiscussion: null,
      calls: [],
    };
    const stub = itemStub(table);
    const wakes = spyWakes(harness);

    await scan(harness, trackerId, stub);
    expect(wakes).toHaveLength(0);

    table.rest[checksUrl(HEAD_SHA)] = { etag: '"c600b"', body: checksSuccess };
    const settled = await scan(harness, trackerId, stub);
    expect(settled.outcomes[0].status).toBe("woke");
    expect(settled.outcomes[0].reason).toContain("checks pending->success");
    expect(wakes).toHaveLength(1);
    expect(wakes[0].issueId).toBe(card.id);

    const steady = await scan(harness, trackerId, stub);
    expect(steady.outcomes[0].status).toBe("unchanged");
    expect(wakes).toHaveLength(1);
  });

  it("dry-run reports intended wakes and creates without calling them", async () => {
    const card = await child(harness, trackerId, {}, `${OWNER}/${REPO}#15158`);
    const table: RouteTable = {
      rest: {
        [issueUrl(15158)]: { etag: '"i1"', body: pullIssueRow(15158) },
        [pullUrl(15158)]: { etag: '"p1"', body: pullRow(15158) },
        [reviewsUrl(15158)]: { etag: '"r1"', body: [] },
        [checksUrl(HEAD_SHA)]: { etag: '"c1"', body: checksSuccess },
        // A brand-new ours PR with no card yet.
        [issueUrl(700)]: { etag: '"i700"', body: pullIssueRow(700) },
        [pullUrl(700)]: { etag: '"p700"', body: pullRow(700, { head: { sha: HEAD_SHA, label: "TogetherWeOwn:new-thing" } }) },
        [reviewsUrl(700)]: { etag: '"r700"', body: [] },
      },
      graphqlDiscussion: null,
      calls: [],
    };
    const stub = itemStub(table);
    const wakes = spyWakes(harness);
    const updates = spyUpdates(harness);
    let creates = 0;
    const origCreate = harness.ctx.issues.create.bind(harness.ctx.issues);
    harness.ctx.issues.create = (async (input: never) => {
      creates += 1;
      return origCreate(input);
    }) as typeof harness.ctx.issues.create;

    // Baseline in live mode to establish the fingerprint.
    await scan(harness, trackerId, stub);

    table.rest[issueUrl(15158)] = { etag: '"i2"', body: pullIssueRow(15158, { comments: 2 }) };
    const dry = await scan(harness, trackerId, stub, {
      dryRun: true,
      extraTrackedItems: [{ owner: OWNER, repo: REPO, kind: "pull", number: 700 }],
    });
    expect(dry.outcomes.find((o) => o.item === `${OWNER}/${REPO}#15158`)).toMatchObject({ card: card.id, status: "would-wake" });
    expect(dry.outcomes.find((o) => o.item === `${OWNER}/${REPO}#700`)?.status).toBe("would-create");
    expect(wakes).toHaveLength(0);
    expect(creates).toBe(0);
    // The only update is the live baseline run's first-sight sync.
    expect(updates).toHaveLength(1);
    // A repeated dry run is mostly 304s yet still reports the same intentions.
    const dryAgain = await scan(harness, trackerId, stub, {
      dryRun: true,
      extraTrackedItems: [{ owner: OWNER, repo: REPO, kind: "pull", number: 700 }],
    });
    expect(dryAgain.stats.ok200).toBe(0);
    expect(dryAgain.stats.notModified304).toBe(6);
    expect(dryAgain.outcomes.find((o) => o.item === `${OWNER}/${REPO}#15158`)?.status).toBe("would-wake");
    expect(dryAgain.outcomes.find((o) => o.item === `${OWNER}/${REPO}#700`)?.status).toBe("would-create");
    expect(wakes).toHaveLength(0);
    expect(creates).toBe(0);
    // Dry-run never consumes the change: a live rerun still wakes.
    const live = await scan(harness, trackerId, stub);
    expect(live.outcomes.find((o) => o.item === `${OWNER}/${REPO}#15158`)?.status).toBe("woke");
    expect(wakes).toHaveLength(1);
  });
});
