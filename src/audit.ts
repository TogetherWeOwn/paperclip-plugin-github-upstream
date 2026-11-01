import type { PluginContext } from "@paperclipai/plugin-sdk";
import { itemKey, type TrackedItemRef, type UpstreamConfig } from "./config.js";
import { resolveAuthToken } from "./github-app.js";
import { backoffDelayMs, GITHUB_API_BASE, githubGet, githubGraphql, type FetchLike } from "./github.js";
import { capsOf, wakesUsed } from "./items.js";
import { findCardForItem, parseGitHubUrl, safeUpstreamUrl, type CardLike } from "./mapping.js";
import { ITEM_ORIGIN_KIND, ORIGIN_KIND_PREFIX } from "./manifest.js";
import { isBackedOff, setBackoff, stateKey, type RunStats } from "./state.js";

/**
 * Audit trail for the upstream gate (TWO-819): flag upstream items, comments
 * and reviews posted from our account that have no approved gate card.
 *
 * Deterministic, no LLM. Runs at most hourly. GitHub reads are ETag-
 * conditional where the API allows (per-item comment/review reads); search
 * has no 304 path, so search calls happen once per org/login per run.
 *
 * A post counts as gated when a Paperclip issue exists that is titled
 * `Upstream gate …`, is `done`, is parented to the item's follow-through
 * card, and whose approval (its `completedAt`) is at or before the post's
 * `created_at`. v1 accepts `status == done` plus the parent link: the SDK
 * exposes no execution-decision reads, so the two stage approvals cannot be
 * verified individually (see TWO-819 for the SDK gap note). A missing
 * `completedAt` also counts as gated rather than flagging on a guess.
 *
 * Anything posted before AUDIT_CUTOVER_ISO is out of scope: the TWO-809 audit
 * cards (TWO-810…TWO-818) already cover it, so it is never flagged.
 */

/** Backfill cutover: posts older than this are covered by TWO-810…TWO-818. */
export const AUDIT_CUTOVER_ISO = "2026-11-02T00:00:00Z";

/**
 * Search-watermark overlap: the watermark advances to the scan *start* minus
 * this window, so posts created during the scan (or slow to appear in the
 * search index) are re-examined next run. Re-examination is safe: per-item
 * cursors and flag keys make reruns idempotent.
 */
export const SCAN_OVERLAP_MS = 5 * 60 * 1000;

/** Label applied to the follow-through card of an ungated post. */
export const UNGATED_LABEL_NAME = "upstream:ungated";

/** Gate cards carry this title prefix (see the `upstream-gate` skill). */
export const GATE_TITLE_PREFIX = "Upstream gate";

/**
 * Origin identity for Chief-of-Staff flag cards. This must sit under
 * ORIGIN_KIND_PREFIX (colon-separated): the SDK rejects any other
 * `plugin:` namespace at write time, so a dot-separated kind fails closed.
 * Flag cards therefore share the GitHub tab's item list with the release
 * intake cards; both are plugin cards, not tracked upstream items.
 */
export const UNGATED_FLAG_ORIGIN_KIND = `${ORIGIN_KIND_PREFIX}ungated-flag`;

/** Repo-relative path for an item, used as the safe-URL fallback. */
function itemPath(item: TrackedItemRef): string {
  const leaf = item.kind === "pull" ? "pull" : item.kind === "discussion" ? "discussions" : "issues";
  return `/${leaf}/${item.number}`;
}

/** Tracker subtree cards as the audit sees them: mapping fields plus gate fields. */
export type AuditCard = CardLike & {
  title: string;
  status: string;
  parentId?: string | null;
  completedAt?: string | null;
};

/** Idempotency key for Chief-of-Staff flag cards and wakes. */
export const ungatedKey = (postUrl: string): string => `ungated:${postUrl}`;

export interface AuditPost {
  postUrl: string;
  item: TrackedItemRef & { kind: "issue" | "pull" | "discussion" };
  authorLogin: string;
  createdAt: string;
  postKind: "item" | "comment" | "review";
}

export interface AuditOutcome {
  post: string;
  item: string;
  card: string | null;
  status:
    | "gated"
    | "flagged"
    | "would-flag"
    | "duplicate"
    | "capped"
    | "skipped-cutover"
    | "skipped-no-tracker"
    | "skipped-backoff"
    | "error";
  reason?: string;
  detail?: string;
}

export interface AuditDeps {
  fetchImpl: FetchLike;
  now?: () => number;
}

export interface AuditState {
  lastSearchAt: string | null;
  /** Per-item cursor: latest watched-login post created_at observed. */
  cursors: Record<string, string>;
  /** Per-item ETags for comment/review reads (`${itemKey}:${endpoint}`). */
  etags: Record<string, string | null>;
  /** ETag keys whose last read ended on a full 100-row page: page 1 may hide
   * later pages behind a 304, so these reads are never conditional. */
  fullPages: Record<string, true>;
  /** Flagged posts by post URL (creation + wake dedupe). */
  flags: Record<string, { item: string; cardId: string | null; at: string }>;
  /** Judged post URLs by item (`postUrl -> createdAt`): same-second posts
   * share a cursor timestamp, so the timestamp alone cannot dedupe them. */
  seen: Record<string, Record<string, string>>;
}

const EMPTY_AUDIT_STATE: AuditState = { lastSearchAt: null, cursors: {}, etags: {}, fullPages: {}, flags: {}, seen: {} };

/** Watched logins: auditLogins plus the operator/bot identities, lowercased. */
export function watchedLogins(config: UpstreamConfig): Set<string> {
  const out = new Set<string>();
  for (const login of [...config.auditLogins, config.operatorLogin, ...config.ourLogins]) {
    const trimmed = login.trim().toLowerCase();
    if (trimmed) out.add(trimmed);
  }
  return out;
}

const isWatched = (watched: Set<string>, login: string | null | undefined): login is string =>
  !!login && watched.has(login.toLowerCase());

interface GitHubSearchItem {
  html_url?: string;
  updated_at?: string;
}

interface GitHubItemRow {
  number?: number;
  title?: string | null;
  state?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  html_url?: string | null;
  user?: { login?: string | null } | null;
}

interface GitHubComment {
  html_url?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  user?: { login?: string | null } | null;
}

interface GitHubReview {
  id?: number;
  html_url?: string | null;
  submitted_at?: string | null;
  state?: string | null;
  user?: { login?: string | null } | null;
}

interface CandidateMeta {
  ref: TrackedItemRef & { kind: "issue" | "pull" | "discussion" };
  authorLogin: string | null;
  createdAt: string | null;
  title: string | null;
  url: string;
}

/**
 * Hourly audit: find recent upstream posts by our account with no approved
 * gate card, label their follow-through card and open a card for the Chief
 * of Staff. Returns one outcome per examined post.
 */
export async function runAuditScan(
  ctx: PluginContext,
  companyId: string,
  config: UpstreamConfig,
  deps: AuditDeps,
): Promise<{ outcomes: AuditOutcome[]; stats: RunStats }> {
  const now = deps.now ?? Date.now;
  const startMs = now();
  const stats: RunStats = { at: new Date(startMs).toISOString(), job: "audit-scan", ok200: 0, notModified304: 0, errors: 0, wakes: 0, creates: 0, capped: 0 };
  const outcomes: AuditOutcome[] = [];
  let token: string;
  try {
    token = await resolveAuthToken(ctx, companyId, config, deps.fetchImpl, startMs);
  } catch (err) {
    // Fail closed: no token, no unauthenticated scan.
    stats.errors += 1;
    outcomes.push({ post: "-", item: "-", card: null, status: "error", detail: `refusing unauthenticated scan: ${String(err)}` });
    return { outcomes, stats };
  }
  const watched = watchedLogins(config);

  if (watched.size === 0) {
    outcomes.push({ post: "-", item: "-", card: null, status: "error", detail: "no watched logins configured" });
    return { outcomes, stats };
  }

  const stored = ((await ctx.state.get(stateKey(companyId, "audit")) as AuditState | null) ?? EMPTY_AUDIT_STATE);
  const state: AuditState = {
    lastSearchAt: stored.lastSearchAt,
    cursors: { ...stored.cursors },
    etags: { ...stored.etags },
    fullPages: { ...(stored.fullPages ?? {}) },
    flags: { ...stored.flags },
    seen: { ...(stored.seen ?? {}) },
  };

  if (!config.followThroughTrackerIssueId) {
    outcomes.push({ post: "-", item: "-", card: null, status: "skipped-no-tracker", detail: "followThroughTrackerIssueId is empty" });
    return { outcomes, stats };
  }
  if (await isBackedOff(ctx, companyId, now())) {
    outcomes.push({ post: "-", item: "-", card: null, status: "skipped-backoff" });
    return { outcomes, stats };
  }

  const tracker = await ctx.issues.getSubtree(config.followThroughTrackerIssueId, companyId).catch(() => null);
  if (!tracker) {
    stats.errors += 1;
    outcomes.push({ post: "-", item: "-", card: null, status: "error", detail: "tracker subtree unreadable" });
    return { outcomes, stats };
  }
  const allCards = tracker.issues.filter(
    (c) => c.id !== tracker.rootIssueId,
  ) as AuditCard[];
  // Follow-through mapping sees direct tracker children only (like item-scan);
  // gate cards live one level down and must never match as follow-throughs.
  const directChildren = allCards.filter((c) => c.parentId === config.followThroughTrackerIssueId);

  const onRateLimited = async (untilMs: number): Promise<void> => {
    await setBackoff(ctx, companyId, untilMs);
  };

  const searchCursor = state.lastSearchAt ?? AUDIT_CUTOVER_ISO;
  const collected = await collectCandidates(deps.fetchImpl, token, config, searchCursor, stats,
    async (untilMs) => onRateLimited(untilMs), now());
  if (collected === "rate-limited") {
    outcomes.push({ post: "-", item: "-", card: null, status: "error", detail: "rate limited" });
    return { outcomes, stats };
  }
  // Any failed read makes the run incomplete: the search watermark is held so
  // unseen posts stay in next run's window. Completed-item progress (cursors,
  // ETags, flags) is still persisted so processed posts are never double-flagged.
  let incomplete = collected.incomplete;
  const candidates = collected.refs;

  let aborted = false;
  for (const ref of candidates.values()) {
    if (await isBackedOff(ctx, companyId, now())) {
      outcomes.push({ post: "-", item: itemKey(ref), card: null, status: "skipped-backoff" });
      aborted = true;
      break;
    }
    // Snapshot this item's ETags and full-page markers: a failed item must
    // retry with its old read positions, otherwise a 304 would hide the posts
    // it never finished processing.
    const key = itemKey(ref);
    const etagSnapshot: Record<string, string | null> = {};
    for (const k of Object.keys(state.etags)) {
      if (k.startsWith(`${key}:`)) etagSnapshot[k] = state.etags[k];
    }
    const fullSnapshot: Record<string, true> = {};
    for (const k of Object.keys(state.fullPages)) {
      if (k.startsWith(`${key}:`)) fullSnapshot[k] = true;
    }
    const restoreReads = (): void => {
      for (const k of Object.keys(state.etags)) {
        if (k.startsWith(`${key}:`) && !(k in etagSnapshot)) delete state.etags[k];
      }
      for (const [k, v] of Object.entries(etagSnapshot)) state.etags[k] = v;
      for (const k of Object.keys(state.fullPages)) {
        if (k.startsWith(`${key}:`) && !(k in fullSnapshot)) delete state.fullPages[k];
      }
      for (const k of Object.keys(fullSnapshot)) state.fullPages[k] = true;
    };
    try {
      const itemOutcomes = await processItem(ctx, companyId, config, deps.fetchImpl, token, watched, ref, directChildren, allCards, state, stats,
        async (untilMs) => onRateLimited(untilMs), now());
      outcomes.push(...itemOutcomes);
      // Errors and budget deferrals both hold the search watermark: the
      // unread or uncapped posts stay in next run's window.
      if (itemOutcomes.some((o) => o.status === "error" || o.status === "capped")) {
        incomplete = true;
        restoreReads();
        if (itemOutcomes.some((o) => o.detail === "rate limited")) {
          aborted = true;
          break;
        }
      }
    } catch (err) {
      incomplete = true;
      restoreReads();
      stats.errors += 1;
      outcomes.push({ post: "-", item: key, card: null, status: "error", detail: String(err) });
    }
  }

  if (!config.dryRun) {
    if (!aborted && !incomplete) {
      state.lastSearchAt = new Date(startMs - SCAN_OVERLAP_MS).toISOString();
    }
    await ctx.state.set(stateKey(companyId, "audit"), state);
  }
  return { outcomes, stats };
}

/** A read that can fail without rate limiting (5xx, malformed body, …). */
type ReadResult<T> = T | "rate-limited" | "failed";

interface SearchResult {
  refs: Array<TrackedItemRef & { kind: "issue" | "pull" | "discussion" }>;
  /** True when the search errored or overflowed: candidates may be missing. */
  failed: boolean;
}

/**
 * Candidate items: recent search hits for authored/commented issues and PRs
 * per configured org and repo, plus authored discussions per org. Search has
 * no pagination here (first page, updated desc): our own posts are rare, and
 * an overflowing or failed page marks the run incomplete (watermark held) so
 * nothing is silently dropped.
 */
async function collectCandidates(
  fetchImpl: FetchLike,
  token: string,
  config: UpstreamConfig,
  searchCursor: string,
  stats: RunStats,
  onRateLimited: (untilMs: number) => Promise<void>,
  nowMs: number,
): Promise<{ refs: Map<string, TrackedItemRef & { kind: "issue" | "pull" | "discussion" }>; incomplete: boolean } | "rate-limited"> {
  const out = new Map<string, TrackedItemRef & { kind: "issue" | "pull" | "discussion" }>();
  let incomplete = false;
  const logins = [...watchedLogins(config)];
  // Deterministic order: orgs, then repos, then logins.
  const scopes: string[] = [
    ...[...config.auditOrgs].sort().map((o) => `org:${o}`),
    ...[...config.auditRepos].sort().map((r) => `repo:${r}`),
  ];
  const allowed = new Set([
    ...config.auditOrgs.map((o) => o.toLowerCase()),
    ...config.auditRepos.map((r) => r.toLowerCase()),
  ]);
  const keep = (ref: TrackedItemRef & { kind: "issue" | "pull" | "discussion" }): void => {
    if (ref.owner.toLowerCase() === "togetherweown") return;
    if (!allowed.has(ref.owner.toLowerCase()) && !allowed.has(`${ref.owner}/${ref.repo}`.toLowerCase())) return;
    if (!out.has(itemKey(ref))) out.set(itemKey(ref), ref);
  };

  for (const scope of scopes) {
    for (const login of [...logins].sort()) {
      for (const kind of ["issue", "pull-request"] as const) {
        for (const role of ["author", "commenter"] as const) {
          const query = `${scope} is:${kind} ${role}:${login} updated:>=${searchCursor}`;
          const found = await searchIssues(fetchImpl, token, query, stats, onRateLimited, nowMs);
          if (found === "rate-limited") return "rate-limited";
          if (found.failed) incomplete = true;
          for (const ref of found.refs) keep(ref);
        }
      }
      // Reviews without comments don't surface as `commenter:`: a watched
      // approval or changes-requested review is only discoverable this way.
      const reviewed = await searchIssues(fetchImpl, token, `${scope} is:pull-request reviewed-by:${login} updated:>=${searchCursor}`, stats, onRateLimited, nowMs);
      if (reviewed === "rate-limited") return "rate-limited";
      if (reviewed.failed) incomplete = true;
      for (const ref of reviewed.refs) keep(ref);
      const discussions = await searchDiscussions(fetchImpl, token, `${scope} author:${login}`, stats, onRateLimited, nowMs);
      if (discussions === "rate-limited") return "rate-limited";
      // Discussion search has no updated-since filter and caps at 20 rows, so
      // an overflow cannot freeze the watermark (it would wedge it forever);
      // it is surfaced as an error instead.
      if (discussions.failed) stats.errors += 1;
      for (const ref of discussions.refs) keep(ref);
    }
  }
  return { refs: out, incomplete };
}

async function searchIssues(
  fetchImpl: FetchLike,
  token: string,
  query: string,
  stats: RunStats,
  onRateLimited: (untilMs: number) => Promise<void>,
  nowMs: number,
): Promise<SearchResult | "rate-limited"> {
  const url = `${GITHUB_API_BASE}/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=100`;
  const res = await githubGet<{ total_count?: number; items?: GitHubSearchItem[] }>(fetchImpl, token, url, null);
  if (res.rateLimited) {
    await onRateLimited(nowMs + backoffDelayMs(res, nowMs));
    return "rate-limited";
  }
  if (res.status !== 200 || !res.data) {
    stats.errors += 1;
    return { refs: [], failed: true };
  }
  stats.ok200 += 1;
  const out: Array<TrackedItemRef & { kind: "issue" | "pull" | "discussion" }> = [];
  for (const item of res.data.items ?? []) {
    if (!item.html_url) continue;
    const ref = parseGitHubUrl(item.html_url);
    if (ref) out.push(ref);
  }
  // First page only by design; an overflow (or any failure) marks the run
  // incomplete so the watermark is held instead of silently dropping items.
  const failed = typeof res.data.total_count === "number" && res.data.total_count > (res.data.items ?? []).length;
  if (failed) stats.errors += 1;
  return { refs: out, failed };
}

async function searchDiscussions(
  fetchImpl: FetchLike,
  token: string,
  query: string,
  stats: RunStats,
  onRateLimited: (untilMs: number) => Promise<void>,
  nowMs: number,
): Promise<SearchResult | "rate-limited"> {
  const res = await githubGraphql<{
    search?: { discussionCount?: number; nodes?: Array<{ number?: number; repository?: { nameWithOwner?: string } }> | null } | null;
  }>(
    fetchImpl,
    token,
    `query($q: String!) { search(query: $q, type: DISCUSSION, first: 20) { discussionCount nodes { ... on Discussion { number repository { nameWithOwner } } } } }`,
    { q: query },
  );
  if (res.status === 429 || res.status === 403) {
    await onRateLimited(nowMs + 60 * 1000);
    return "rate-limited";
  }
  if (res.status !== 200 || !res.data?.search) {
    stats.errors += 1;
    return { refs: [], failed: true };
  }
  stats.ok200 += 1;
  const out: Array<TrackedItemRef & { kind: "issue" | "pull" | "discussion" }> = [];
  for (const node of res.data.search.nodes ?? []) {
    const full = node.repository?.nameWithOwner;
    if (!full || typeof node.number !== "number") continue;
    const [owner, repo] = full.split("/");
    if (owner && repo) out.push({ owner, repo, kind: "discussion", number: node.number });
  }
  // First 20 only by design; the caller surfaces the overflow as an error.
  const failed = typeof res.data.search.discussionCount === "number" &&
    res.data.search.discussionCount > (res.data.search.nodes ?? []).length;
  return { refs: out, failed };
}

/** Examine one candidate item for watched-login posts newer than its cursor. */
async function processItem(
  ctx: PluginContext,
  companyId: string,
  config: UpstreamConfig,
  fetchImpl: FetchLike,
  token: string,
  watched: Set<string>,
  ref: TrackedItemRef & { kind: "issue" | "pull" | "discussion" },
  directChildren: AuditCard[],
  allCards: AuditCard[],
  state: AuditState,
  stats: RunStats,
  onRateLimited: (untilMs: number) => Promise<void>,
  nowMs: number,
): Promise<AuditOutcome[]> {
  const key = itemKey(ref);
  const cursor = state.cursors[key] ?? AUDIT_CUTOVER_ISO;

  const meta = ref.kind === "discussion"
    ? await fetchDiscussionMeta(fetchImpl, token, ref, stats, onRateLimited, nowMs)
    : await fetchItemMeta(fetchImpl, token, ref, stats, onRateLimited, nowMs);
  if (meta === "rate-limited") {
    return [{ post: "-", item: key, card: null, status: "error", detail: "rate limited" }];
  }
  if (meta === "failed") {
    return [{ post: "-", item: key, card: null, status: "error", detail: "item read failed" }];
  }
  if (!meta) return [];

  // Same-second posts share a cursor timestamp, so judged URLs dedupe what the
  // timestamp cannot. Entries older than the cursor can never reappear.
  const seenForItem = state.seen[key] ?? {};
  for (const [u, t] of Object.entries(seenForItem)) {
    if (t < cursor) delete seenForItem[u];
  }

  const posts: AuditPost[] = [];
  if (isWatched(watched, meta.authorLogin) && (meta.createdAt ?? "") >= AUDIT_CUTOVER_ISO && (meta.createdAt ?? "") >= cursor && !seenForItem[meta.url]) {
    posts.push({ postUrl: meta.url, item: ref, authorLogin: meta.authorLogin, createdAt: meta.createdAt as string, postKind: "item" });
  }
  const thread = ref.kind === "discussion"
    ? await fetchDiscussionPosts(fetchImpl, token, ref, watched, cursor, stats, onRateLimited, nowMs)
    : await fetchThreadPosts(fetchImpl, token, ref, watched, cursor, state, key, stats, onRateLimited, nowMs);
  if (thread === "rate-limited") {
    return [{ post: "-", item: key, card: null, status: "error", detail: "rate limited" }];
  }
  if (thread === "failed") {
    return [{ post: "-", item: key, card: null, status: "error", detail: "thread read failed" }];
  }
  posts.push(...thread.filter((p) => !seenForItem[p.postUrl]));
  posts.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

  const outcomes: AuditOutcome[] = [];
  for (const post of posts) {
    if (post.createdAt < AUDIT_CUTOVER_ISO) {
      outcomes.push({ post: post.postUrl, item: key, card: null, status: "skipped-cutover" });
      continue;
    }
    outcomes.push(await judgePost(ctx, companyId, config, post, directChildren, allCards, state, stats, nowMs));
  }

  if (!config.dryRun && posts.length > 0) {
    // Capped posts are deferred, not consumed: only judged posts join the
    // seen set, so a capped post is re-yielded (not silently dropped) next tick.
    for (let i = 0; i < posts.length; i += 1) {
      if (outcomes[i].status !== "capped") seenForItem[posts[i].postUrl] = posts[i].createdAt;
    }
    state.seen[key] = seenForItem;
    // Capped posts are deferred, not consumed: the cursor advances only
    // through the leading run of judged posts, so a capped post (and
    // everything after it) is re-examined next run.
    let lastConsumed: string | null = null;
    for (let i = 0; i < posts.length; i += 1) {
      if (outcomes[i].status === "capped") break;
      lastConsumed = posts[i].createdAt;
    }
    if (lastConsumed !== null && lastConsumed > cursor) state.cursors[key] = lastConsumed;
  }
  return outcomes;
}

/** Canonical author/created_at/title for an issue or PR (uncached: candidates are few). */
async function fetchItemMeta(
  fetchImpl: FetchLike,
  token: string,
  ref: TrackedItemRef & { kind: "issue" | "pull" | "discussion" },
  stats: RunStats,
  onRateLimited: (untilMs: number) => Promise<void>,
  nowMs: number,
): Promise<CandidateMeta | null | ReadResult<never>> {
  const res = await githubGet<GitHubItemRow>(fetchImpl, token, `${GITHUB_API_BASE}/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`, null);
  if (res.rateLimited) {
    await onRateLimited(nowMs + backoffDelayMs(res, nowMs));
    return "rate-limited";
  }
  if (res.status === 404) return null;
  if (res.status !== 200 || !res.data) {
    stats.errors += 1;
    return "failed";
  }
  stats.ok200 += 1;
  const row = res.data;
  return {
    ref,
    authorLogin: row.user?.login ?? null,
    createdAt: row.created_at ?? null,
    title: row.title ?? null,
    url: row.html_url ?? `https://github.com/${ref.owner}/${ref.repo}/issues/${ref.number}`,
  };
}

const DISCUSSION_META_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    discussion(number: $number) {
      title url createdAt author { login }
      comments(first: 100) {
        totalCount
        nodes { url createdAt author { login } replies(first: 50) { totalCount nodes { url createdAt author { login } } } }
      }
    }
  }
}`;

interface DiscussionActor {
  url?: string;
  createdAt?: string;
  author?: { login?: string };
}

interface DiscussionNode {
  title?: string;
  url?: string;
  createdAt?: string;
  author?: { login?: string };
  comments?: {
    totalCount?: number;
    nodes?: Array<DiscussionActor & { replies?: { totalCount?: number; nodes?: DiscussionActor[] | null } | null }> | null;
  };
}

async function discussionNode(
  fetchImpl: FetchLike,
  token: string,
  ref: TrackedItemRef & { kind: "issue" | "pull" | "discussion" },
  stats: RunStats,
  onRateLimited: (untilMs: number) => Promise<void>,
  nowMs: number,
): Promise<DiscussionNode | null | ReadResult<never>> {
  const res = await githubGraphql<{ repository?: { discussion?: DiscussionNode | null } | null }>(
    fetchImpl, token, DISCUSSION_META_QUERY, { owner: ref.owner, repo: ref.repo, number: ref.number },
  );
  if (res.status === 429 || res.status === 403) {
    await onRateLimited(nowMs + 60 * 1000);
    return "rate-limited";
  }
  if (res.status !== 200 || !res.data?.repository?.discussion) {
    stats.errors += 1;
    return "failed";
  }
  stats.ok200 += 1;
  return res.data.repository.discussion;
}

async function fetchDiscussionMeta(
  fetchImpl: FetchLike,
  token: string,
  ref: TrackedItemRef & { kind: "issue" | "pull" | "discussion" },
  stats: RunStats,
  onRateLimited: (untilMs: number) => Promise<void>,
  nowMs: number,
): Promise<CandidateMeta | null | ReadResult<never>> {
  const node = await discussionNode(fetchImpl, token, ref, stats, onRateLimited, nowMs);
  if (node === "rate-limited" || node === "failed" || !node) return node;
  return {
    ref,
    authorLogin: node.author?.login ?? null,
    createdAt: node.createdAt ?? null,
    title: node.title ?? null,
    url: node.url ?? `https://github.com/${ref.owner}/${ref.repo}/discussions/${ref.number}`,
  };
}

async function fetchDiscussionPosts(
  fetchImpl: FetchLike,
  token: string,
  ref: TrackedItemRef & { kind: "issue" | "pull" | "discussion" },
  watched: Set<string>,
  cursor: string,
  stats: RunStats,
  onRateLimited: (untilMs: number) => Promise<void>,
  nowMs: number,
): Promise<AuditPost[] | ReadResult<never>> {
  const node = await discussionNode(fetchImpl, token, ref, stats, onRateLimited, nowMs);
  if (node === "rate-limited" || node === "failed") return node;
  if (!node) return [];
  const posts: AuditPost[] = [];
  // First 100 comments / 50 replies only; deeper threads are surfaced as an
  // error (visible in run stats) rather than silently skipped.
  if (typeof node.comments?.totalCount === "number" && node.comments.totalCount > (node.comments.nodes ?? []).length) {
    stats.errors += 1;
  }
  for (const comment of node.comments?.nodes ?? []) {
    if (isWatched(watched, comment.author?.login) && (comment.createdAt ?? "") >= cursor && (comment.createdAt ?? "") >= AUDIT_CUTOVER_ISO && comment.url) {
      posts.push({ postUrl: comment.url, item: ref, authorLogin: comment.author!.login as string, createdAt: comment.createdAt as string, postKind: "comment" });
    }
    if (typeof comment.replies?.totalCount === "number" && comment.replies.totalCount > (comment.replies.nodes ?? []).length) {
      stats.errors += 1;
    }
    for (const reply of comment.replies?.nodes ?? []) {
      if (isWatched(watched, reply.author?.login) && (reply.createdAt ?? "") >= cursor && (reply.createdAt ?? "") >= AUDIT_CUTOVER_ISO && reply.url) {
        posts.push({ postUrl: reply.url, item: ref, authorLogin: reply.author!.login as string, createdAt: reply.createdAt as string, postKind: "comment" });
      }
    }
  }
  return posts;
}

/**
 * Comments, PR review comments and PR reviews by watched logins newer than
 * the cursor. Comment lists are ETag-conditional per item; reviews have no
 * `since` support, so they are ETag-conditional and filtered client-side.
 */
async function fetchThreadPosts(
  fetchImpl: FetchLike,
  token: string,
  ref: TrackedItemRef & { kind: "issue" | "pull" | "discussion" },
  watched: Set<string>,
  cursor: string,
  state: AuditState,
  key: string,
  stats: RunStats,
  onRateLimited: (untilMs: number) => Promise<void>,
  nowMs: number,
): Promise<AuditPost[] | ReadResult<never>> {
  const posts: AuditPost[] = [];
  const rest = `${GITHUB_API_BASE}/repos/${ref.owner}/${ref.repo}`;

  const pages = await fetchCommentPages(fetchImpl, token, `${rest}/issues/${ref.number}/comments`, cursor, state, `${key}:issue-comments`, stats, onRateLimited, nowMs);
  if (pages === "rate-limited" || pages === "failed") return pages;
  for (const comment of pages) {
    if (isWatched(watched, comment.user?.login) && (comment.created_at ?? "") >= cursor && (comment.created_at ?? "") >= AUDIT_CUTOVER_ISO && comment.html_url) {
      posts.push({ postUrl: comment.html_url, item: ref, authorLogin: comment.user!.login as string, createdAt: comment.created_at as string, postKind: "comment" });
    }
  }

  if (ref.kind === "pull") {
    const inline = await fetchCommentPages(fetchImpl, token, `${rest}/pulls/${ref.number}/comments`, cursor, state, `${key}:pr-comments`, stats, onRateLimited, nowMs);
    if (inline === "rate-limited" || inline === "failed") return inline;
    for (const comment of inline) {
      if (isWatched(watched, comment.user?.login) && (comment.created_at ?? "") >= cursor && (comment.created_at ?? "") >= AUDIT_CUTOVER_ISO && comment.html_url) {
        posts.push({ postUrl: comment.html_url, item: ref, authorLogin: comment.user!.login as string, createdAt: comment.created_at as string, postKind: "comment" });
      }
    }
    const reviews = await fetchReviews(fetchImpl, token, `${rest}/pulls/${ref.number}/reviews`, state, `${key}:reviews`, stats, onRateLimited, nowMs);
    if (reviews === "rate-limited" || reviews === "failed") return reviews;
    for (const review of reviews) {
      if (isWatched(watched, review.user?.login) && (review.submitted_at ?? "") >= cursor && (review.submitted_at ?? "") >= AUDIT_CUTOVER_ISO && review.html_url) {
        posts.push({ postUrl: review.html_url, item: ref, authorLogin: review.user!.login as string, createdAt: review.submitted_at as string, postKind: "review" });
      }
    }
  }
  return posts;
}

/** All comment pages since the cursor; first page ETag-conditional. */
async function fetchCommentPages(
  fetchImpl: FetchLike,
  token: string,
  baseUrl: string,
  cursor: string,
  state: AuditState,
  etagKey: string,
  stats: RunStats,
  onRateLimited: (untilMs: number) => Promise<void>,
  nowMs: number,
): Promise<GitHubComment[] | ReadResult<never>> {
  const out: GitHubComment[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const url = `${baseUrl}?since=${encodeURIComponent(cursor)}&per_page=100&page=${page}`;
    // A 304 on a full first page proves nothing about later pages, so a read
    // that last ended on a full page is never conditional.
    const conditional = page === 1 && !state.fullPages[etagKey] ? (state.etags[etagKey] ?? null) : null;
    const res = await githubGet<GitHubComment[]>(fetchImpl, token, url, conditional);
    if (res.rateLimited) {
      await onRateLimited(nowMs + backoffDelayMs(res, nowMs));
      return "rate-limited";
    }
    if (res.notModified) {
      stats.notModified304 += 1;
      return out;
    }
    if (res.status !== 200 || !Array.isArray(res.data)) {
      stats.errors += 1;
      return "failed";
    }
    stats.ok200 += 1;
    if (page === 1) {
      state.etags[etagKey] = res.etag;
      if (res.data.length === 100) state.fullPages[etagKey] = true;
      else delete state.fullPages[etagKey];
    }
    out.push(...res.data);
    if (res.data.length < 100) break;
    if (page === 10) {
      // Hard cap by design (1000 comments); a busier thread is surfaced as an
      // error rather than silently skipped. Retrying cannot help, so this does
      // not fail the read — the overflow stays visible in run stats.
      stats.errors += 1;
    }
  }
  return out;
}

/**
 * All reviews, oldest first, ETag-conditional on the first page (this endpoint
 * has no `since`). Later pages are plain GETs; a failure fails the whole read
 * so the caller retries with the old ETag instead of advancing past unseen rows.
 */
async function fetchReviews(
  fetchImpl: FetchLike,
  token: string,
  baseUrl: string,
  state: AuditState,
  etagKey: string,
  stats: RunStats,
  onRateLimited: (untilMs: number) => Promise<void>,
  nowMs: number,
): Promise<GitHubReview[] | ReadResult<never>> {
  const out: GitHubReview[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const url = page === 1 ? `${baseUrl}?per_page=100` : `${baseUrl}?per_page=100&page=${page}`;
    const conditional = page === 1 && !state.fullPages[etagKey] ? (state.etags[etagKey] ?? null) : null;
    const res = await githubGet<GitHubReview[]>(fetchImpl, token, url, conditional);
    if (res.rateLimited) {
      await onRateLimited(nowMs + backoffDelayMs(res, nowMs));
      return "rate-limited";
    }
    if (res.notModified) {
      stats.notModified304 += 1;
      return out;
    }
    if (res.status !== 200 || !Array.isArray(res.data)) {
      stats.errors += 1;
      return "failed";
    }
    stats.ok200 += 1;
    if (page === 1) {
      state.etags[etagKey] = res.etag;
      if (res.data.length === 100) state.fullPages[etagKey] = true;
      else delete state.fullPages[etagKey];
    }
    out.push(...res.data);
    if (res.data.length < 100) break;
  }
  return out;
}

/** Gate match: a `done` gate card under the follow-through card, approved no later than the post. */
function gateApprovalMs(gate: Pick<AuditCard, "completedAt">): number | null {
  const raw = gate.completedAt ?? null;
  if (raw === null) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** Match one post against approved gate cards, flagging when ungated. */
async function judgePost(
  ctx: PluginContext,
  companyId: string,
  config: UpstreamConfig,
  post: AuditPost,
  directChildren: AuditCard[],
  allCards: AuditCard[],
  state: AuditState,
  stats: RunStats,
  nowMs: number,
): Promise<AuditOutcome> {
  const key = itemKey(post.item);
  const caps = capsOf(config);
  let card = findCardForItem(directChildren, post.item);
  if (!card) {
    if (config.dryRun) {
      return { post: post.postUrl, item: key, card: null, status: "would-flag", reason: `would create follow-through card for ${key} and flag ${post.postKind} by @${post.authorLogin}` };
    }
    // Spend cap: leave the post unconsumed (no card, no bookkeeping) so the
    // next tick picks it up. A create assigns an agent, so it spends both budgets.
    if (stats.creates + 1 > caps.maxCreates || wakesUsed(stats) + 1 > caps.maxWakes) {
      stats.capped += 1;
      return { post: post.postUrl, item: key, card: null, status: "capped", reason: `would create follow-through card for ${key}`, detail: "create budget exhausted, deferred to next tick" };
    }
    const created = await ctx.issues.create({
      companyId,
      parentId: config.followThroughTrackerIssueId,
      title: `Upstream follow-through: ${key}`,
      description: `Owns upstream https://github.com/${post.item.owner}/${post.item.repo}/${post.item.kind === "pull" ? "pull" : post.item.kind === "discussion" ? "discussions" : "issues"}/${post.item.number} until upstream merges or closes it.\n\nCreated by togetherweown.github-upstream audit: ungated post by @${post.authorLogin}.`,
      assigneeAgentId: config.followThroughAssigneeAgentId,
      originKind: ITEM_ORIGIN_KIND,
      originId: key,
    });
    card = created as AuditCard;
    directChildren.push(card);
    allCards.push(card);
    stats.creates += 1;
  }

  const gates = allCards.filter(
    (c) => c.parentId === card.id && (c.title ?? "").startsWith(GATE_TITLE_PREFIX) && c.status === "done",
  );
  const postMs = Date.parse(post.createdAt);
  const approved = gates.find((g) => {
    const approval = gateApprovalMs(g);
    // No approval timestamp: v1 accepts `done` plus the parent link.
    if (approval === null) return true;
    return Number.isFinite(postMs) && approval <= postMs;
  });
  if (approved) {
    return { post: post.postUrl, item: key, card: card.id, status: "gated", reason: `approved gate card ${approved.id}` };
  }

  if (state.flags[post.postUrl]) {
    return { post: post.postUrl, item: key, card: card.id, status: "duplicate", reason: "already flagged", detail: `flag card ${state.flags[post.postUrl].cardId}` };
  }
  if (config.dryRun) {
    return { post: post.postUrl, item: key, card: card.id, status: "would-flag", reason: `would flag ${post.postKind} by @${post.authorLogin} with no approved gate card` };
  }
  // Spend cap: leave the flag unwritten (no flag card, no wake, no cursor
  // advance past this post) so the next tick picks it up. Flagging costs one
  // create plus two wake units (the assigned card's wake and the explicit
  // requestWakeup), so both are reserved before either is spent.
  if (stats.creates + 1 > caps.maxCreates || wakesUsed(stats) + 2 > caps.maxWakes) {
    stats.capped += 1;
    return { post: post.postUrl, item: key, card: card.id, status: "capped", reason: `would flag ${post.postKind} by @${post.authorLogin} with no approved gate card`, detail: "create/wake budget exhausted, deferred to next tick" };
  }

  const ungatedId = config.labelIdByName[UNGATED_LABEL_NAME];
  if (ungatedId && !(card.labelIds ?? []).includes(ungatedId)) {
    await ctx.issues.update(card.id, { labelIds: [...(card.labelIds ?? []), ungatedId] }, companyId);
  }
  const reason = gates.length === 0
    ? "no approved gate card"
    : `gate card approved after the post (${gates.map((g) => g.completedAt ?? "?").join(", ")} > ${post.createdAt})`;
  // Upstream URLs ride into assigned-card text and wake reasons, both of which
  // an agent reads as task context. Only the post's own repo path may become
  // a card link; anything else falls back to the constructed item URL.
  const postUrl = safeUpstreamUrl(post.postUrl, post.item.owner, post.item.repo, itemPath(post.item));
  // Crash-safe creation: the in-memory flag keys are only persisted at the
  // end of the run, so a pre-create lookup by origin identity covers state
  // loss (same pattern as the release intake cards).
  const existing = await ctx.issues.list({ companyId, originKind: UNGATED_FLAG_ORIGIN_KIND, originId: ungatedKey(post.postUrl) });
  const flagCard = existing[0] ?? await ctx.issues.create({
    companyId,
    originKind: UNGATED_FLAG_ORIGIN_KIND,
    originId: ungatedKey(post.postUrl),
    title: `Ungated upstream post: ${key}`,
    description: [
      "Flagged by togetherweown.github-upstream audit-scan: upstream post with no approved gate card.",
      "",
      `Post: ${postUrl}`,
      `Item: https://github.com/${post.item.owner}/${post.item.repo} (${key})`,
      `Author: @${post.authorLogin}`,
      `Posted at: ${post.createdAt}`,
      `Follow-through card: ${card.id}`,
      `Reason: ${reason}.`,
      `Cutover: posts before ${AUDIT_CUTOVER_ISO} are out of scope (covered by TWO-810…TWO-818).`,
      ungatedId ? `Follow-through card labelled \`${UNGATED_LABEL_NAME}\`.` : `No \`${UNGATED_LABEL_NAME}\` label ID is configured, so the follow-through card was not labelled.`,
      "Note: approval time is the gate card's completedAt; the plugin SDK exposes no execution-decision reads, so the two stage approvals cannot be verified individually.",
    ].join("\n"),
    assigneeAgentId: config.chiefOfStaffAgentId,
  });
  if (!existing[0]) stats.creates += 1;
  state.flags[post.postUrl] = { item: key, cardId: flagCard.id, at: new Date(nowMs).toISOString() };
  try {
    await ctx.issues.requestWakeup(flagCard.id, companyId, {
      reason: `ungated upstream post by @${post.authorLogin}: ${postUrl}`,
      idempotencyKey: ungatedKey(post.postUrl),
    });
    stats.wakes += 1;
  } catch (err) {
    stats.errors += 1;
    return { post: post.postUrl, item: key, card: card.id, status: "flagged", reason, detail: `flag card ${flagCard.id}; wake failed: ${String(err)}` };
  }
  return { post: post.postUrl, item: key, card: card.id, status: "flagged", reason, detail: `flag card ${flagCard.id}` };
}

