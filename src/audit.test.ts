import { beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { ITEM_ORIGIN_KIND } from "./manifest.js";
import plugin from "./plugin.js";
import { resolveConfig } from "./config.js";
import { AUDIT_CUTOVER_ISO, runAuditScan, SCAN_OVERLAP_MS, ungatedKey, UNGATED_LABEL_NAME } from "./audit.js";
import { stateKey } from "./state.js";

const COMPANY = "c-1";
const OWNER = "paperclipai";
const REPO = "paperclip";
const AGENT = "7b8f576c-ebce-447f-a904-dda322df4220";
const COS = "ad0e6eaa-51a3-41dd-97d8-af46a84fc5e9";
const UNGATED_ID = "L-ungated";

const POST_AT = "2026-11-02T12:00:00Z";
const GATE_BEFORE = "2026-11-02T10:00:00Z";
const GATE_AFTER = "2026-11-02T14:00:00Z";

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

const json = (body: unknown, etag: string | null, status = 200) =>
  new Response(status === 304 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(etag ? { etag } : {}) },
  });

interface RouteTable {
  rest: Record<string, { etag: string; body: unknown }>;
  searchItems: Array<{ html_url: string }>;
  graphqlDiscussion: unknown;
}

/** Stub the GitHub surface audit.ts reads: search, REST rows/comments/reviews, GraphQL. */
function auditStub(table: RouteTable): FetchStub {
  return (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (url === "https://api.github.com/graphql") {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("search(")) {
        return json({ data: { search: { nodes: [] } } }, null);
      }
      return json({ data: { repository: { discussion: table.graphqlDiscussion } } }, null);
    }
    if (url.startsWith("https://api.github.com/search/issues")) {
      return json({ total_count: table.searchItems.length, items: table.searchItems }, null);
    }
    const entry = table.rest[url] ?? table.rest[url.split("?")[0]];
    if (!entry) return new Response("not found", { status: 404 });
    if (headers.get("If-None-Match") === entry.etag) {
      return new Response(null, { status: 304, headers: { etag: entry.etag } });
    }
    return json(entry.body, entry.etag);
  }) as FetchStub;
}

const issueUrl = (n: number) => `https://api.github.com/repos/${OWNER}/${REPO}/issues/${n}`;
const commentsUrl = (n: number) => `https://api.github.com/repos/${OWNER}/${REPO}/issues/${n}/comments`;
const reviewsUrl = (n: number) => `https://api.github.com/repos/${OWNER}/${REPO}/pulls/${n}/reviews`;

const issueHtml = (n: number) => `https://github.com/${OWNER}/${REPO}/issues/${n}`;
const pullHtml = (n: number) => `https://github.com/${OWNER}/${REPO}/pull/${n}`;

const issueRow = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `issue ${n}`,
  state: "open",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: POST_AT,
  comments: 1,
  html_url: issueHtml(n),
  user: { login: "stranger" },
  ...extra,
});

const comment = (n: number, login: string, createdAt = POST_AT) => ({
  id: n,
  html_url: `${issueHtml(100)}#issuecomment-${n}`,
  created_at: createdAt,
  updated_at: createdAt,
  user: { login },
});

async function setup() {
  const harness = createTestHarness({ manifest, config: {} });
  harness.seed({ companies: [{ id: COMPANY, name: "TWO", issuePrefix: "TWO" } as never] });
  await plugin.definition.setup(harness.ctx);
  const tracker = await harness.ctx.issues.create({ companyId: COMPANY, title: "upstream tracker" });
  return { harness, trackerId: tracker.id };
}

const TOKEN_REF = { type: "secret_ref", secretId: "test-token" };

const scan = (harness: TestHarness, trackerId: string, stub: FetchStub, config: Record<string, unknown> = {}) =>
  runAuditScan(
    harness.ctx,
    COMPANY,
    resolveConfig({ tokenSecretRef: TOKEN_REF, followThroughTrackerIssueId: trackerId, labelIdByName: { [UNGATED_LABEL_NAME]: UNGATED_ID }, ...config }),
    { fetchImpl: stub },
  );

async function followThrough(harness: TestHarness, trackerId: string, n: number) {
  return harness.ctx.issues.create({
    companyId: COMPANY,
    parentId: trackerId,
    title: `child ${OWNER}/${REPO}#${n}`,
    assigneeAgentId: AGENT,
    originKind: ITEM_ORIGIN_KIND,
    originId: `${OWNER}/${REPO}#${n}`,
  } as never);
}

async function gateCard(harness: TestHarness, parentId: string, completedAt: string | null) {
  const gate = await harness.ctx.issues.create({
    companyId: COMPANY,
    parentId,
    title: `Upstream gate (N): ${OWNER}/${REPO} issue — test`,
    assigneeAgentId: AGENT,
    status: "done",
  } as never);
  if (completedAt) {
    // completedAt is server-set in production; the harness stores whatever patch it gets.
    await harness.ctx.issues.update(gate.id, { completedAt } as never, COMPANY);
  }
  return gate;
}

const flagCards = (harness: TestHarness) =>
  harness.ctx.issues.list({ companyId: COMPANY, assigneeAgentId: COS });

describe("audit job", () => {
  let harness: TestHarness;
  let trackerId: string;

  beforeEach(async () => {
    ({ harness, trackerId } = await setup());
  });

  it("a gated post produces no flag", async () => {
    const card = await followThrough(harness, trackerId, 100);
    await gateCard(harness, card.id, GATE_BEFORE);
    const table: RouteTable = {
      rest: {
        [issueUrl(100)]: { etag: '"i1"', body: issueRow(100) },
        [commentsUrl(100)]: { etag: '"m1"', body: [comment(1, "Rick7C2")] },
      },
      searchItems: [{ html_url: issueHtml(100) }],
      graphqlDiscussion: null,
    };
    const out = await scan(harness, trackerId, auditStub(table));
    expect(out.outcomes).toHaveLength(1);
    expect(out.outcomes[0]).toMatchObject({ item: `${OWNER}/${REPO}#100`, status: "gated" });
    expect(out.stats).toMatchObject({ wakes: 0, creates: 0 });
    expect(await flagCards(harness)).toHaveLength(0);
    const refetched = await harness.ctx.issues.get(card.id, COMPANY);
    expect(refetched?.labelIds ?? []).not.toContain(UNGATED_ID);
  });

  it("an ungated post is labelled and flagged, deduped on a rerun", async () => {
    const table: RouteTable = {
      rest: {
        [issueUrl(200)]: {
          etag: '"i1"',
          body: issueRow(200, { title: "issue 200", user: { login: "Rick7C2" }, created_at: POST_AT }),
        },
        [commentsUrl(200)]: { etag: '"m1"', body: [] },
      },
      searchItems: [{ html_url: issueHtml(200) }],
      graphqlDiscussion: null,
    };
    const stub = auditStub(table);
    const wakes: Array<{ issueId: string; options?: { idempotencyKey?: string | null } }> = [];
    const origWake = harness.ctx.issues.requestWakeup.bind(harness.ctx.issues);
    harness.ctx.issues.requestWakeup = (async (issueId: string, companyId: string, options?: { idempotencyKey?: string | null }) => {
      wakes.push({ issueId, options });
      return origWake(issueId, companyId, options as never);
    }) as typeof harness.ctx.issues.requestWakeup;

    const first = await scan(harness, trackerId, stub);
    expect(first.outcomes).toHaveLength(1);
    expect(first.outcomes[0]).toMatchObject({ item: `${OWNER}/${REPO}#200`, status: "flagged" });
    expect(first.stats).toMatchObject({ creates: 2, wakes: 1 });

    // The follow-through card was created and labelled.
    const owned = await harness.ctx.issues.list({ companyId: COMPANY, originKind: ITEM_ORIGIN_KIND, originId: `${OWNER}/${REPO}#200` });
    expect(owned).toHaveLength(1);
    expect(owned[0].labelIds ?? []).toContain(UNGATED_ID);

    // The Chief-of-Staff card carries the post URL, timestamp and author.
    const flags = await flagCards(harness);
    expect(flags).toHaveLength(1);
    expect(flags[0].title).toBe(`Ungated upstream post: ${OWNER}/${REPO}#200`);
    expect(flags[0].description).toContain(issueHtml(200));
    expect(flags[0].description).toContain(POST_AT);
    expect(flags[0].description).toContain("@Rick7C2");
    expect(wakes).toHaveLength(1);
    expect(wakes[0].options?.idempotencyKey).toBe(ungatedKey(issueHtml(200)));

    // Rerun: comment reads are 304, cursors advanced — no second flag.
    const second = await scan(harness, trackerId, stub);
    expect(second.outcomes.every((o) => o.status !== "flagged" && o.status !== "would-flag")).toBe(true);
    expect(await flagCards(harness)).toHaveLength(1);
    expect(wakes).toHaveLength(1);

    // Even forcing a reprocess (fresh ETags, reset cursor) cannot double-flag.
    table.rest[commentsUrl(200)] = { etag: '"m2"', body: [] };
    const auditState = (await harness.ctx.state.get(stateKey(COMPANY, "audit") as never) as { cursors: Record<string, string> });
    auditState.cursors = {};
    await harness.ctx.state.set(stateKey(COMPANY, "audit") as never, auditState as never);
    table.rest[issueUrl(200)] = {
      etag: '"i2"',
      body: issueRow(200, { title: "issue 200", user: { login: "Rick7C2" }, created_at: POST_AT }),
    };
    const third = await scan(harness, trackerId, stub);
    expect(third.outcomes).toHaveLength(1);
    expect(third.outcomes[0].status).toBe("duplicate");
    expect(await flagCards(harness)).toHaveLength(1);
    expect(wakes).toHaveLength(1);
  });

  it("a post made before the gate approval is flagged", async () => {
    const card = await followThrough(harness, trackerId, 100);
    await gateCard(harness, card.id, GATE_AFTER);
    const table: RouteTable = {
      rest: {
        [issueUrl(100)]: { etag: '"i1"', body: issueRow(100) },
        [commentsUrl(100)]: { etag: '"m1"', body: [comment(1, "Rick7C2")] },
      },
      searchItems: [{ html_url: issueHtml(100) }],
      graphqlDiscussion: null,
    };
    const out = await scan(harness, trackerId, auditStub(table));
    expect(out.outcomes).toHaveLength(1);
    expect(out.outcomes[0]).toMatchObject({ item: `${OWNER}/${REPO}#100`, status: "flagged" });
    expect(out.outcomes[0].reason).toContain("after the post");
    const flags = await flagCards(harness);
    expect(flags).toHaveLength(1);
    const refetched = await harness.ctx.issues.get(card.id, COMPANY);
    expect(refetched?.labelIds ?? []).toContain(UNGATED_ID);
  });

  it("a comment on someone else's item is detected and gets a card", async () => {
    const table: RouteTable = {
      rest: {
        [issueUrl(100)]: { etag: '"i1"', body: issueRow(100) },
        [commentsUrl(100)]: { etag: '"m1"', body: [comment(1, "Rick7C2")] },
      },
      searchItems: [{ html_url: issueHtml(100) }],
      graphqlDiscussion: null,
    };
    const out = await scan(harness, trackerId, auditStub(table));
    expect(out.outcomes).toHaveLength(1);
    expect(out.outcomes[0]).toMatchObject({ item: `${OWNER}/${REPO}#100`, status: "flagged" });
    // The stranger-authored item had no card: the audit created one and labelled it.
    const owned = await harness.ctx.issues.list({ companyId: COMPANY, originKind: ITEM_ORIGIN_KIND, originId: `${OWNER}/${REPO}#100` });
    expect(owned).toHaveLength(1);
    expect(owned[0].labelIds ?? []).toContain(UNGATED_ID);
    expect(await flagCards(harness)).toHaveLength(1);
  });

  it("a review by our account on someone else's PR is detected", async () => {
    const table: RouteTable = {
      rest: {
        [issueUrl(300)]: {
          etag: '"i1"',
          body: { ...issueRow(300), html_url: pullHtml(300), pull_request: {} },
        },
        [`https://api.github.com/repos/${OWNER}/${REPO}/pulls/300`]: { etag: '"p1"', body: { number: 300 } },
        [commentsUrl(300)]: { etag: '"m1"', body: [] },
        [`https://api.github.com/repos/${OWNER}/${REPO}/pulls/300/comments`]: { etag: '"q1"', body: [] },
        [reviewsUrl(300)]: {
          etag: '"r1"',
          body: [{ id: 9, html_url: `${pullHtml(300)}#pullrequestreview-9`, submitted_at: POST_AT, state: "COMMENTED", user: { login: "Rick7C2" } }],
        },
      },
      searchItems: [{ html_url: pullHtml(300) }],
      graphqlDiscussion: null,
    };
    const out = await scan(harness, trackerId, auditStub(table));
    expect(out.outcomes).toHaveLength(1);
    expect(out.outcomes[0]).toMatchObject({ item: `${OWNER}/${REPO}#300`, status: "flagged" });
    expect(out.outcomes[0].post).toContain("pullrequestreview-9");
    expect(await flagCards(harness)).toHaveLength(1);
  });

  it("a post from before the cutover is never flagged", async () => {
    const oldComment = comment(1, "Rick7C2", "2026-10-15T00:00:00Z");
    const table: RouteTable = {
      rest: {
        [issueUrl(100)]: { etag: '"i1"', body: issueRow(100) },
        [commentsUrl(100)]: { etag: '"m1"', body: [oldComment] },
      },
      searchItems: [{ html_url: issueHtml(100) }],
      graphqlDiscussion: null,
    };
    const out = await scan(harness, trackerId, auditStub(table));
    expect(out.outcomes).toHaveLength(0);
    expect(out.stats).toMatchObject({ wakes: 0, creates: 0 });
    expect(await flagCards(harness)).toHaveLength(0);
    expect(AUDIT_CUTOVER_ISO).toBe("2026-11-02T00:00:00Z");
  });

  it("an aborted run keeps completed-item progress but holds the watermark", async () => {
    const base = auditStub({
      rest: {
        [issueUrl(200)]: {
          etag: '"i1"',
          body: issueRow(200, { user: { login: "Rick7C2" }, created_at: POST_AT }),
        },
        [commentsUrl(200)]: { etag: '"m1"', body: [] },
        [issueUrl(201)]: {
          etag: '"i2"',
          body: issueRow(201, { user: { login: "Rick7C2" }, created_at: POST_AT }),
        },
        [commentsUrl(201)]: { etag: '"m2"', body: [] },
      },
      searchItems: [{ html_url: issueHtml(200) }, { html_url: issueHtml(201) }],
      graphqlDiscussion: null,
    });
    let limit201 = true;
    const stub = (async (url: string, init?: RequestInit) => {
      if (url === issueUrl(201) && limit201) return new Response("limited", { status: 429 });
      return base(url, init);
    }) as FetchStub;
    const config = resolveConfig({ tokenSecretRef: TOKEN_REF, followThroughTrackerIssueId: trackerId, labelIdByName: { [UNGATED_LABEL_NAME]: UNGATED_ID } });
    const t0 = Date.parse("2026-11-02T13:00:00Z");

    const first = await runAuditScan(harness.ctx, COMPANY, config, { fetchImpl: stub, now: () => t0 });
    expect(first.outcomes).toHaveLength(2);
    expect(first.outcomes[0]).toMatchObject({ status: "flagged" });
    expect(first.outcomes[1]).toMatchObject({ status: "error", detail: "rate limited" });

    // The flag survived, but the watermark did not advance past the unread item.
    const mid = (await harness.ctx.state.get(stateKey(COMPANY, "audit") as never) as {
      lastSearchAt: string | null; flags: Record<string, unknown>;
    });
    expect(mid.lastSearchAt).toBeNull();
    expect(Object.keys(mid.flags)).toEqual([issueHtml(200)]);
    expect(await flagCards(harness)).toHaveLength(1);

    // After the limit lifts the second item flags without re-flagging the first.
    limit201 = false;
    const second = await runAuditScan(harness.ctx, COMPANY, config, { fetchImpl: stub, now: () => t0 + 120_000 });
    expect(second.outcomes.filter((o) => o.status === "flagged")).toHaveLength(1);
    expect(second.outcomes.filter((o) => o.status === "duplicate")).toHaveLength(0);
    expect(await flagCards(harness)).toHaveLength(2);
  });

  it("a failed search holds the watermark instead of skipping posts", async () => {
    const stub = (async (url: string) => {
      if (url.startsWith("https://api.github.com/search/issues")) {
        return new Response("boom", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    }) as FetchStub;
    const config = resolveConfig({ tokenSecretRef: TOKEN_REF, followThroughTrackerIssueId: trackerId, labelIdByName: { [UNGATED_LABEL_NAME]: UNGATED_ID } });
    const out = await runAuditScan(harness.ctx, COMPANY, config, { fetchImpl: stub });
    expect(out.stats.errors).toBeGreaterThan(0);
    const stored = (await harness.ctx.state.get(stateKey(COMPANY, "audit") as never) as { lastSearchAt: string | null });
    expect(stored.lastSearchAt).toBeNull();
    expect(await flagCards(harness)).toHaveLength(0);
  });

  it("a failed item read is an error, not a silent skip", async () => {
    const stub = (async (url: string, init?: RequestInit) => {
      if (url === issueUrl(100)) return new Response("boom", { status: 500 });
      return auditStub({
        rest: {},
        searchItems: [{ html_url: issueHtml(100) }],
        graphqlDiscussion: null,
      })(url, init);
    }) as FetchStub;
    const out = await scan(harness, trackerId, stub);
    expect(out.outcomes).toHaveLength(1);
    expect(out.outcomes[0]).toMatchObject({ item: `${OWNER}/${REPO}#100`, status: "error", detail: "item read failed" });
    expect(await flagCards(harness)).toHaveLength(0);
    const stored = (await harness.ctx.state.get(stateKey(COMPANY, "audit") as never) as { lastSearchAt: string | null });
    expect(stored.lastSearchAt).toBeNull();
  });

  it("the watermark advances to scan start minus the overlap window", async () => {
    const t0 = Date.parse("2026-11-02T13:00:00Z");
    const config = resolveConfig({ tokenSecretRef: TOKEN_REF, followThroughTrackerIssueId: trackerId, labelIdByName: { [UNGATED_LABEL_NAME]: UNGATED_ID } });
    await runAuditScan(harness.ctx, COMPANY, config, {
      fetchImpl: auditStub({ rest: {}, searchItems: [], graphqlDiscussion: null }),
      now: () => t0,
    });
    const stored = (await harness.ctx.state.get(stateKey(COMPANY, "audit") as never) as { lastSearchAt: string });
    expect(stored.lastSearchAt).toBe(new Date(t0 - SCAN_OVERLAP_MS).toISOString());
  });

  it("reviews past the first page are still audited", async () => {
    const strangers = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      html_url: `${pullHtml(300)}#pullrequestreview-${i + 1}`,
      submitted_at: POST_AT,
      state: "APPROVED",
      user: { login: "stranger" },
    }));
    const ours = {
      id: 101,
      html_url: `${pullHtml(300)}#pullrequestreview-101`,
      submitted_at: POST_AT,
      state: "COMMENTED",
      user: { login: "Rick7C2" },
    };
    const base = auditStub({
      rest: {
        [issueUrl(300)]: {
          etag: '"i1"',
          body: { ...issueRow(300), html_url: pullHtml(300), pull_request: {} },
        },
        [commentsUrl(300)]: { etag: '"m1"', body: [] },
        [`https://api.github.com/repos/${OWNER}/${REPO}/pulls/300/comments`]: { etag: '"q1"', body: [] },
      },
      searchItems: [{ html_url: pullHtml(300) }],
      graphqlDiscussion: null,
    });
    const stub = (async (url: string, init?: RequestInit) => {
      if (url.includes(`/pulls/300/reviews`)) {
        if (url.includes("page=2")) return json([ours], '"r2"');
        return json(strangers, '"r1"');
      }
      return base(url, init);
    }) as FetchStub;
    const out = await scan(harness, trackerId, stub);
    expect(out.outcomes).toHaveLength(1);
    expect(out.outcomes[0]).toMatchObject({ item: `${OWNER}/${REPO}#300`, status: "flagged" });
    expect(out.outcomes[0].post).toContain("pullrequestreview-101");
    expect(await flagCards(harness)).toHaveLength(1);
  });

  it("an exhausted spend budget defers the flag to the next tick", async () => {
    const table: RouteTable = {
      rest: {
        [issueUrl(200)]: {
          etag: '"i1"',
          body: issueRow(200, { title: "issue 200", user: { login: "Rick7C2" }, created_at: POST_AT }),
        },
        [commentsUrl(200)]: { etag: '"m1"', body: [] },
      },
      searchItems: [{ html_url: issueHtml(200) }],
      graphqlDiscussion: null,
    };
    const stub = auditStub(table);
    const config = (extra: Record<string, unknown> = {}) =>
      resolveConfig({ tokenSecretRef: TOKEN_REF, followThroughTrackerIssueId: trackerId, labelIdByName: { [UNGATED_LABEL_NAME]: UNGATED_ID }, ...extra });

    const capped = await runAuditScan(harness.ctx, COMPANY, config({ maxCreatesPerTick: 0 }), { fetchImpl: stub });
    expect(capped.outcomes).toHaveLength(1);
    expect(capped.outcomes[0].status).toBe("capped");
    expect(capped.stats.capped).toBe(1);
    expect(await flagCards(harness)).toHaveLength(0);

    // Nothing was consumed: the watermark and cursor are held for the retry.
    const mid = (await harness.ctx.state.get(stateKey(COMPANY, "audit") as never) as {
      lastSearchAt: string | null; cursors: Record<string, string>;
    });
    expect(mid.lastSearchAt).toBeNull();
    expect(mid.cursors[`${OWNER}/${REPO}#200`]).toBeUndefined();

    // Next tick with budget flags the post exactly once.
    const flagged = await runAuditScan(harness.ctx, COMPANY, config({}), { fetchImpl: stub });
    expect(flagged.outcomes).toHaveLength(1);
    expect(flagged.outcomes[0].status).toBe("flagged");
    expect(await flagCards(harness)).toHaveLength(1);
  });

  it("dry-run reports intended flags without writing", async () => {
    const table: RouteTable = {
      rest: {
        [issueUrl(200)]: {
          etag: '"i1"',
          body: issueRow(200, { title: "issue 200", user: { login: "Rick7C2" }, created_at: POST_AT }),
        },
        [commentsUrl(200)]: { etag: '"m1"', body: [] },
      },
      searchItems: [{ html_url: issueHtml(200) }],
      graphqlDiscussion: null,
    };
    let writes = 0;
    for (const method of ["create", "update", "requestWakeup"] as const) {
      const orig = (harness.ctx.issues[method] as (...args: never[]) => Promise<never>).bind(harness.ctx.issues);
      (harness.ctx.issues[method] as (...args: never[]) => Promise<never>) = (async (...args: never[]) => {
        writes += 1;
        return orig(...args);
      }) as never;
    }
    const out = await scan(harness, trackerId, auditStub(table), { dryRun: true });
    expect(out.outcomes).toHaveLength(1);
    expect(out.outcomes[0].status).toBe("would-flag");
    expect(writes).toBe(0);
    expect(await flagCards(harness)).toHaveLength(0);
  });
});
