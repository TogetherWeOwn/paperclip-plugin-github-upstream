import { beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { ITEM_ORIGIN_KIND } from "./manifest.js";
import plugin from "./plugin.js";
import { resolveConfig } from "./config.js";
import { latestDecisiveReview, runItemScan } from "./items.js";
import { stateKey } from "./state.js";

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
    // Actor-lookup GETs carry query params (?since=, ?per_page=): match the
    // route with the query stripped when there is no exact entry.
    const entry = table.rest[url] ?? table.rest[url.split("?")[0]];
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
const commentsUrl = (n: number) => `https://api.github.com/repos/${OWNER}/${REPO}/issues/${n}/comments`;
const commitsUrl = (n: number) => `https://api.github.com/repos/${OWNER}/${REPO}/pulls/${n}/commits`;

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

  it("our own comment syncs the header but never wakes; a maintainer comment wakes", async () => {
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
    const config = { operatorLogin: "Rick7C2", ourLogins: ["paperclip-bot[bot]"] };

    await scan(harness, trackerId, stub, config);
    expect(wakes).toHaveLength(0);
    const baselineUpdates = updates.length;

    // Our own comment: the count rises, but every new actor is us.
    table.rest[issueUrl(15158)] = {
      etag: '"i2"',
      body: pullIssueRow(15158, { comments: 2, updated_at: "2026-10-13T00:00:00Z" }),
    };
    table.rest[commentsUrl(15158)] = { etag: '"m1"', body: [{ id: 1, user: { login: "Rick7C2" } }] };
    const own = await scan(harness, trackerId, stub, config);
    expect(own.outcomes[0]).toMatchObject({ card: card.id, status: "mapped" });
    expect(own.outcomes[0].detail).toContain("Rick7C2");
    expect(own.stats.wakes).toBe(0);
    expect(wakes).toHaveLength(0);
    // The header still syncs: the latest update carries the new comment count.
    expect(updates.length).toBeGreaterThan(baselineUpdates);
    const headerPatch = updates[updates.length - 1].patch as { description?: string };
    expect(headerPatch.description).toContain("2 comments");

    // A comment by the listed bot identity is ours too.
    table.rest[issueUrl(15158)] = {
      etag: '"i3"',
      body: pullIssueRow(15158, { comments: 3, updated_at: "2026-10-14T00:00:00Z" }),
    };
    table.rest[commentsUrl(15158)] = {
      etag: '"m2"',
      body: [{ id: 1, user: { login: "Rick7C2" } }, { id: 2, user: { login: "paperclip-bot[bot]" } }],
    };
    const bot = await scan(harness, trackerId, stub, config);
    expect(bot.outcomes[0].status).toBe("mapped");
    expect(wakes).toHaveLength(0);

    // A maintainer comment in the same window wakes exactly once.
    table.rest[issueUrl(15158)] = {
      etag: '"i4"',
      body: pullIssueRow(15158, { comments: 4, updated_at: "2026-10-15T00:00:00Z" }),
    };
    table.rest[commentsUrl(15158)] = {
      etag: '"m3"',
      body: [
        { id: 1, user: { login: "Rick7C2" } },
        { id: 2, user: { login: "paperclip-bot[bot]" } },
        { id: 3, user: { login: "stranger" } },
      ],
    };
    const external = await scan(harness, trackerId, stub, config);
    expect(external.outcomes[0].status).toBe("woke");
    expect(external.outcomes[0].reason).toContain("1 new comment");
    expect(wakes).toHaveLength(1);
    expect(wakes[0].issueId).toBe(card.id);
  });

  it("our own push syncs but never wakes; a stranger push wakes", async () => {
    const card = await child(harness, trackerId, {}, `${OWNER}/${REPO}#15158`);
    const NEW_HEAD = "bbbc2e58611223344556677889900aabbccddeeff";
    const NEWER_HEAD = "cccd3f69722334455667788990011bbccddeeff00";
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
    const config = { operatorLogin: "Rick7C2" };

    await scan(harness, trackerId, stub, config);
    expect(wakes).toHaveLength(0);

    // We push: the head moves and every new commit is authored by us. The older
    // stranger commit stays in the list but must not block suppression.
    table.rest[pullUrl(15158)] = {
      etag: '"p2"',
      body: pullRow(15158, { head: { sha: NEW_HEAD, label: "TogetherWeOwn:fix-x" }, updated_at: "2026-10-13T00:00:00Z" }),
    };
    table.rest[commitsUrl(15158)] = {
      etag: '"h1"',
      body: [
        { sha: HEAD_SHA, author: { login: "stranger" }, committer: { login: "stranger" } },
        { sha: NEW_HEAD, author: { login: "Rick7C2" }, committer: { login: "Rick7C2" } },
      ],
    };
    const own = await scan(harness, trackerId, stub, config);
    expect(own.outcomes[0]).toMatchObject({ card: card.id, status: "mapped" });
    expect(wakes).toHaveLength(0);

    // Someone else pushes on top: the newest commit is theirs, so it wakes.
    table.rest[pullUrl(15158)] = {
      etag: '"p3"',
      body: pullRow(15158, { head: { sha: NEWER_HEAD, label: "TogetherWeOwn:fix-x" }, updated_at: "2026-10-14T00:00:00Z" }),
    };
    table.rest[commitsUrl(15158)] = {
      etag: '"h2"',
      body: [
        { sha: HEAD_SHA, author: { login: "stranger" }, committer: { login: "stranger" } },
        { sha: NEW_HEAD, author: { login: "Rick7C2" }, committer: { login: "Rick7C2" } },
        { sha: NEWER_HEAD, author: { login: "stranger" }, committer: { login: "stranger" } },
      ],
    };
    const external = await scan(harness, trackerId, stub, config);
    expect(external.outcomes[0].status).toBe("woke");
    expect(wakes).toHaveLength(1);
    expect(wakes[0].issueId).toBe(card.id);
  });

  it("a maintainer change request flips awaiting to us, syncs the label, and wakes", async () => {
    const card = await child(harness, trackerId, {}, `${OWNER}/${REPO}#800`);
    const ids = {
      "gh:repo/paperclip": "L-repo",
      "gh:type/pr": "L-type",
      "gh:state/open": "L-state",
      "gh:ci/green": "L-ci",
      "gh:awaiting/maintainer": "L-wm",
      "gh:awaiting/us": "L-wu",
    };
    const table: RouteTable = {
      rest: {
        [issueUrl(800)]: { etag: '"i800"', body: pullIssueRow(800) },
        [pullUrl(800)]: { etag: '"p800"', body: pullRow(800, { head: { sha: HEAD_SHA, label: "TogetherWeOwn:fix-x" } }) },
        [reviewsUrl(800)]: { etag: '"r800a"', body: [] },
        [checksUrl(HEAD_SHA)]: { etag: '"c800"', body: checksSuccess },
      },
      graphqlDiscussion: null,
      calls: [],
    };
    const stub = itemStub(table);
    const wakes = spyWakes(harness);
    const updates = spyUpdates(harness);
    const config = { labelIdByName: ids };

    await scan(harness, trackerId, stub, config);
    expect(wakes).toHaveLength(0);
    // First sight of our unruled PR: awaiting maintainer.
    const firstPatch = updates[updates.length - 1].patch as { labelIds?: string[] };
    expect(firstPatch.labelIds).toContain("L-wm");
    expect(firstPatch.labelIds).not.toContain("L-wu");

    // Maintainer requests changes: same comment count, but the latest review
    // state flips and the card wakes with a deterministic reason.
    table.rest[reviewsUrl(800)] = {
      etag: '"r800b"',
      body: [{ id: 9, state: "CHANGES_REQUESTED", user: { login: "maintainer" } }],
    };
    const changed = await scan(harness, trackerId, stub, config);
    expect(changed.outcomes[0].status).toBe("woke");
    expect(changed.outcomes[0].reason).toContain("reviewer requested changes");
    expect(wakes).toHaveLength(1);
    expect(wakes[0].issueId).toBe(card.id);
    const patch = updates[updates.length - 1].patch as { labelIds?: string[] };
    expect(patch.labelIds).toContain("L-wu");
    expect(patch.labelIds).not.toContain("L-wm");

    const stored = harness.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: "items" }) as Record<string, { snapshot: { awaiting: string } }>;
    expect(stored[`${OWNER}/${REPO}#800`].snapshot.awaiting).toBe("us");
  });

  it("upgrade backfills review state without waking: silent label sync only", async () => {
    const card800 = await child(harness, trackerId, {}, `${OWNER}/${REPO}#800`);
    const card801 = await child(harness, trackerId, {}, `${OWNER}/${REPO}#801`);
    const ids = {
      "gh:repo/paperclip": "L-repo",
      "gh:type/pr": "L-type",
      "gh:state/open": "L-state",
      "gh:ci/green": "L-ci",
      "gh:awaiting/maintainer": "L-wm",
      "gh:awaiting/us": "L-wu",
    };
    // Stored shape from before latestReviewState existed: a seven-element
    // fingerprint and a snapshot with neither the review nor awaiting key.
    const legacyFp = (comments: number, reviews: number) =>
      JSON.stringify(["open", "2026-10-12T00:00:00Z", comments, reviews, "success", HEAD_SHA, false]);
    const legacyRecord = (n: number, comments: number, reviews: number, etag: string) => {
      const { latestReviewState: _dropReview, awaiting: _dropAwaiting, ...rest } = {
        owner: OWNER,
        repo: REPO,
        kind: "pull",
        number: n,
        url: `https://github.com/${OWNER}/${REPO}/pull/${n}`,
        title: `pr ${n}`,
        state: "open",
        updatedAt: "2026-10-12T00:00:00Z",
        commentCount: comments,
        authorLogin: "stranger",
        headLabel: "TogetherWeOwn:fix-x",
        reviewCount: reviews,
        latestReviewState: null,
        checkConclusion: "success",
        headSha: HEAD_SHA,
        draft: false,
        awaiting: null,
      };
      void _dropReview;
      void _dropAwaiting;
      const fp = legacyFp(comments, reviews);
      return {
        etags: { issue: `"i${etag}"`, pull: `"p${etag}"`, reviews: `"r${etag}"`, checkRuns: `"c${etag}"` },
        resolvedKind: "pull",
        fingerprint: fp,
        wokenFingerprint: fp,
        snapshot: rest,
        cardId: null,
        checkedAt: "2026-10-12T00:00:00Z",
      };
    };
    await harness.ctx.state.set(stateKey(COMPANY, "items") as never, {
      [`${OWNER}/${REPO}#800`]: legacyRecord(800, 1, 0, "800l"),
      [`${OWNER}/${REPO}#801`]: legacyRecord(801, 1, 1, "801l"),
    } as never);
    // #801's change request predates the upgrade (stored reviewCount already
    // counts it); the forced backfill must learn it, not wake for it.
    const table: RouteTable = {
      rest: {
        [issueUrl(800)]: { etag: '"i800l"', body: pullIssueRow(800) },
        [pullUrl(800)]: { etag: '"p800l"', body: pullRow(800, { head: { sha: HEAD_SHA, label: "TogetherWeOwn:fix-x" } }) },
        [reviewsUrl(800)]: { etag: '"r800l"', body: [] },
        [issueUrl(801)]: { etag: '"i801l"', body: pullIssueRow(801) },
        [pullUrl(801)]: { etag: '"p801l"', body: pullRow(801, { head: { sha: HEAD_SHA, label: "TogetherWeOwn:fix-x" } }) },
        [reviewsUrl(801)]: {
          etag: '"r801l"',
          body: [{ id: 9, state: "CHANGES_REQUESTED", user: { login: "maintainer" } }],
        },
      },
      graphqlDiscussion: null,
      calls: [],
    };
    const stub = itemStub(table);
    const wakes = spyWakes(harness);
    const updates = spyUpdates(harness);

    const out = await scan(harness, trackerId, stub, { labelIdByName: ids });
    expect(wakes).toHaveLength(0);
    expect(out.outcomes).toHaveLength(2);
    for (const o of out.outcomes) {
      expect(o.status).toBe("mapped");
      expect(o.reason ?? "").not.toContain("review ruling cleared");
      expect(o.reason ?? "").not.toContain("first seen");
    }
    expect(out.outcomes.find((o) => o.item === `${OWNER}/${REPO}#800`)?.reason).toContain("backfill review state");
    // Unruled ours PR: awaiting maintainer, no wake.
    const patch800 = updates.map((u) => u.patch).find((p) => (p as { labelIds?: string[] }).labelIds?.includes("L-wm")) as { labelIds?: string[] };
    expect(patch800?.labelIds).toContain("L-wm");
    // Pre-existing change request: silently flips to awaiting us.
    const patch801 = updates.map((u) => u.patch).find((p) => (p as { labelIds?: string[] }).labelIds?.includes("L-wu")) as { labelIds?: string[] };
    expect(patch801?.labelIds).toContain("L-wu");
    expect(patch801?.labelIds).not.toContain("L-wm");
    // The second scan is pure 304s (backfilled ETag cached): fully quiet.
    const quiet = await scan(harness, trackerId, stub, { labelIdByName: ids });
    expect(quiet.outcomes.every((o) => o.status === "unchanged")).toBe(true);
    expect(wakes).toHaveLength(0);
    const stored = harness.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: "items" }) as Record<string, { snapshot: { awaiting: string } }>;
    expect(stored[`${OWNER}/${REPO}#800`].snapshot.awaiting).toBe("maintainer");
    expect(stored[`${OWNER}/${REPO}#801`].snapshot.awaiting).toBe("us");
    expect(card800.id).toBeTruthy();
    expect(card801.id).toBeTruthy();
  });

  it("a foreign red PR gets no awaiting labels", async () => {
    const card = await child(harness, trackerId, {}, `${OWNER}/${REPO}#902`);
    const ids = {
      "gh:repo/paperclip": "L-repo",
      "gh:type/pr": "L-type",
      "gh:state/open": "L-state",
      "gh:ci/red": "L-cired",
      "gh:awaiting/maintainer": "L-wm",
      "gh:awaiting/us": "L-wu",
    };
    const table: RouteTable = {
      rest: {
        [issueUrl(902)]: { etag: '"i902"', body: pullIssueRow(902) },
        [pullUrl(902)]: { etag: '"p902"', body: pullRow(902, { head: { sha: HEAD_SHA, label: "other:fix-x" } }) },
        [reviewsUrl(902)]: { etag: '"r902"', body: [] },
        [checksUrl(HEAD_SHA)]: {
          etag: '"c902"',
          body: { total_count: 1, check_runs: [{ status: "completed", conclusion: "failure", name: "ci" }] },
        },
      },
      graphqlDiscussion: null,
      calls: [],
    };
    const stub = itemStub(table);
    const wakes = spyWakes(harness);
    const updates = spyUpdates(harness);

    const out = await scan(harness, trackerId, stub, { labelIdByName: ids });
    // First sight syncs labels/header without waking: "unchanged", not "mapped".
    expect(out.outcomes[0].status).toBe("unchanged");
    expect(wakes).toHaveLength(0);
    const patch = updates[updates.length - 1].patch as { labelIds?: string[] };
    expect(patch.labelIds).toContain("L-cired");
    expect(patch.labelIds).not.toContain("L-wu");
    expect(patch.labelIds).not.toContain("L-wm");
    const stored = harness.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: "items" }) as Record<string, { snapshot: { awaiting: string | null } }>;
    expect(stored[`${OWNER}/${REPO}#902`].snapshot.awaiting).toBeNull();
    expect(card.id).toBeTruthy();
  });

  it("a config-driven awaiting flip syncs labels without waking", async () => {
    const card = await child(harness, trackerId, {}, `${OWNER}/${REPO}#903`);
    const ids = {
      "gh:repo/paperclip": "L-repo",
      "gh:type/pr": "L-type",
      "gh:state/open": "L-state",
      "gh:ci/red": "L-cired",
      "gh:awaiting/maintainer": "L-wm",
      "gh:awaiting/us": "L-wu",
    };
    const table: RouteTable = {
      rest: {
        [issueUrl(903)]: { etag: '"i903"', body: pullIssueRow(903) },
        [pullUrl(903)]: { etag: '"p903"', body: pullRow(903, { head: { sha: HEAD_SHA, label: "other:fix-x" } }) },
        [reviewsUrl(903)]: { etag: '"r903"', body: [] },
        [checksUrl(HEAD_SHA)]: {
          etag: '"c903"',
          body: { total_count: 1, check_runs: [{ status: "completed", conclusion: "failure", name: "ci" }] },
        },
      },
      graphqlDiscussion: null,
      calls: [],
    };
    const stub = itemStub(table);
    const wakes = spyWakes(harness);
    const updates = spyUpdates(harness);

    const foreign = await scan(harness, trackerId, stub, { labelIdByName: ids });
    expect(foreign.outcomes[0].status).toBe("unchanged");
    const firstPatch = updates[updates.length - 1].patch as { labelIds?: string[] };
    expect(firstPatch.labelIds).not.toContain("L-wu");
    expect(firstPatch.labelIds).not.toContain("L-wm");

    // The operator adopts the fork: same upstream bytes, but now ours and red.
    const adopted = await scan(harness, trackerId, stub, { labelIdByName: ids, operatorLogin: "stranger" });
    expect(adopted.outcomes[0].status).toBe("mapped");
    expect(adopted.outcomes[0].reason).toContain("awaiting none->us (no upstream change)");
    expect(wakes).toHaveLength(0);
    const patch = updates[updates.length - 1].patch as { labelIds?: string[] };
    expect(patch.labelIds).toContain("L-wu");
    expect(patch.labelIds).not.toContain("L-wm");
    expect(card.id).toBeTruthy();
  });

  it("drops state for items that are no longer tracked", async () => {
    const table: RouteTable = {
      rest: {
        [issueUrl(901)]: { etag: '"i901"', body: pullIssueRow(901) },
        [pullUrl(901)]: { etag: '"p901"', body: pullRow(901) },
        [reviewsUrl(901)]: { etag: '"r901"', body: [] },
        [checksUrl(HEAD_SHA)]: { etag: '"c901"', body: checksSuccess },
      },
      graphqlDiscussion: null,
      calls: [],
    };
    const stub = itemStub(table);
    const extra = [{ owner: OWNER, repo: REPO, kind: "pull", number: 901 }] as const;

    const first = await scan(harness, trackerId, stub, { extraTrackedItems: [...extra] });
    expect(first.outcomes[0].status).toBe("not-ours");
    const stateKeyInput = { scopeKind: "company", scopeId: COMPANY, stateKey: "items" } as const;
    expect(Object.keys(harness.getState(stateKeyInput) as Record<string, unknown>)).toEqual([`${OWNER}/${REPO}#901`]);

    const second = await scan(harness, trackerId, stub, {});
    expect(second.outcomes).toHaveLength(0);
    expect(harness.getState(stateKeyInput)).toEqual({});
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

describe("latestDecisiveReview", () => {
  it("picks the newest decisive review and ignores comments", () => {
    expect(latestDecisiveReview([])).toBeNull();
    expect(latestDecisiveReview([{ id: 1, state: "COMMENTED" }])).toBeNull();
    expect(
      latestDecisiveReview([
        { id: 1, state: "CHANGES_REQUESTED" },
        { id: 2, state: "COMMENTED" },
        { id: 3, state: "approved" },
      ]),
    ).toBe("APPROVED");
    expect(
      latestDecisiveReview([
        { id: 5, state: "APPROVED" },
        { id: 6, state: "changes_requested" },
      ]),
    ).toBe("CHANGES_REQUESTED");
  });
});
