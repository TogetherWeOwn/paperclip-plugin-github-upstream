import type { PluginContext } from "@paperclipai/plugin-sdk";
import { itemKey, type TrackedItemRef, type UpstreamConfig } from "./config.js";
import { backoffDelayMs, GITHUB_API_BASE, githubGet, githubGraphql, type FetchLike, type GitHubResult } from "./github.js";
import {
  backfillPatch,
  describeChange,
  findCardForItem,
  fingerprintOf,
  githubUrlsInText,
  headerBlock,
  isOursItem,
  labelNamesFor,
  parseGitHubUrl,
  syncLabelIds,
  withHeader,
  type CardLike,
  type ItemSnapshot,
} from "./mapping.js";
import { ITEM_ORIGIN_KIND } from "./manifest.js";
import { isBackedOff, setBackoff, stateKey, type RunStats } from "./state.js";

/** Stored per-item sync state. ETags make unchanged answers 304s. */
export interface ItemRecord {
  etags: { issue?: string | null; pull?: string | null; reviews?: string | null; checkRuns?: string | null };
  /** The kind the item resolved to (origin IDs carry no kind; a wrong guess self-corrects). */
  resolvedKind: "issue" | "pull" | "discussion" | null;
  fingerprint: string | null;
  /** Fingerprint of the last change that actually woke the card (never set in dry-run). */
  wokenFingerprint: string | null;
  snapshot: ItemSnapshot | null;
  cardId: string | null;
  checkedAt: string;
}

export type ItemMap = Record<string, ItemRecord>;

export interface ItemDeps {
  fetchImpl: FetchLike;
  now?: () => number;
}

export interface ItemOutcome {
  item: string;
  card: string | null;
  status:
    | "unchanged"
    | "woke"
    | "would-wake"
    | "created"
    | "would-create"
    | "mapped"
    | "wake-failed"
    | "not-ours"
    | "error"
    | "skipped-backoff"
    | "skipped-no-tracker";
  reason?: string;
  detail?: string;
}

interface GitHubIssue {
  number?: number;
  title?: string | null;
  state?: string | null;
  updated_at?: string | null;
  comments?: number | null;
  html_url?: string | null;
  user?: { login?: string | null } | null;
  pull_request?: unknown;
}

interface GitHubPull {
  number?: number;
  title?: string | null;
  state?: string | null;
  draft?: boolean | null;
  merged?: boolean | null;
  updated_at?: string | null;
  comments?: number | null;
  html_url?: string | null;
  user?: { login?: string | null } | null;
  head?: { sha?: string | null; label?: string | null } | null;
}

interface GitHubReview {
  id?: number;
  state?: string | null;
}

interface GitHubCheckRuns {
  total_count?: number;
  check_runs?: Array<{ status?: string | null; conclusion?: string | null; name?: string | null }>;
}

const CHECK_RUN_CONCLUSIONS_FAILURE = new Set(["failure", "cancelled", "timed_out", "action_required", "stale"]);

function aggregateChecks(runs: GitHubCheckRuns | null): ItemSnapshot["checkConclusion"] {
  const list = runs?.check_runs ?? [];
  if (list.length === 0) return "none";
  if (list.some((r) => r.conclusion && CHECK_RUN_CONCLUSIONS_FAILURE.has(r.conclusion))) return "failure";
  if (list.some((r) => r.status !== "completed")) return "pending";
  if (list.some((r) => r.conclusion === "neutral")) return "neutral";
  return "success";
}

const DISCOVERY_SEARCH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Track every item: ETag GETs for issues/PRs, one GraphQL query per
 * discussion. On a real change the owning card is woken with a deterministic
 * one-line reason; labels and the description header are synced on change.
 */
export async function runItemScan(
  ctx: PluginContext,
  companyId: string,
  config: UpstreamConfig,
  deps: ItemDeps,
): Promise<{ outcomes: ItemOutcome[]; stats: RunStats }> {
  const now = deps.now ?? Date.now;
  const stats: RunStats = { at: new Date(now()).toISOString(), job: "item-scan", ok200: 0, notModified304: 0, errors: 0, wakes: 0, creates: 0 };
  const outcomes: ItemOutcome[] = [];
  const token = await resolveToken(ctx, companyId, config);

  const stored = (await ctx.state.get(stateKey(companyId, "items")) as ItemMap | null) ?? {};
  const next: ItemMap = { ...stored };

  if (!config.followThroughTrackerIssueId) {
    outcomes.push({ item: "-", card: null, status: "skipped-no-tracker", detail: "followThroughTrackerIssueId is empty" });
    await ctx.state.set(stateKey(companyId, "items"), next);
    return { outcomes, stats };
  }

  const tracker = await ctx.issues.getSubtree(config.followThroughTrackerIssueId, companyId).catch(() => null);
  if (!tracker) {
    stats.errors += 1;
    outcomes.push({ item: "-", card: null, status: "error", detail: "tracker subtree unreadable" });
    return { outcomes, stats };
  }
  const children = tracker.issues.filter(
    (c) => c.id !== tracker.rootIssueId && (c as { parentId?: string }).parentId === config.followThroughTrackerIssueId,
  );

  // Resolve the tracked set: explicit config items plus every tracker child
  // that resolves to a GitHub item (originId, work product URL, or description URL).
  const tracked = new Map<string, TrackedItemRef & { kind: "issue" | "pull" | "discussion" }>();
  for (const extra of config.extraTrackedItems) tracked.set(itemKey(extra), extra);
  for (const child of children) {
    const ref = refFromCard(child);
    if (ref) tracked.set(itemKey(ref), { ...(tracked.get(itemKey(ref)) ?? ref), ...ref });
  }

  for (const item of tracked.values()) {
    if (await isBackedOff(ctx, companyId, now())) {
      outcomes.push({ item: itemKey(item), card: next[itemKey(item)]?.cardId ?? null, status: "skipped-backoff" });
      break;
    }
    try {
      const outcome = await syncOneItem(ctx, companyId, config, deps.fetchImpl, token, item, children, next, stats, now());
      outcomes.push(outcome);
      if (outcome.status === "error" && outcome.detail?.startsWith("rate limited")) break;
    } catch (err) {
      stats.errors += 1;
      outcomes.push({ item: itemKey(item), card: next[itemKey(item)]?.cardId ?? null, status: "error", detail: String(err) });
    }
  }

  await runDiscovery(ctx, companyId, config, deps, token, children, tracked, outcomes, stats, now());
  await ctx.state.set(stateKey(companyId, "items"), next);
  return { outcomes, stats };
}

/** Resolve the GitHub item a tracker child owns, if any. */
function refFromCard(card: CardLike & { description?: string | null }): (TrackedItemRef & { kind: "issue" | "pull" | "discussion" }) | null {
  if (card.originKind === ITEM_ORIGIN_KIND && card.originId) {
    const match = /^([^/]+)\/([^/#@]+)#(\d+)$/.exec(card.originId.trim());
    if (match) {
      const kind = kindFromCard(card);
      return { owner: match[1], repo: match[2], number: Number.parseInt(match[3], 10), kind };
    }
  }
  for (const wp of card.workProducts ?? []) {
    if (!wp.url) continue;
    const ref = parseGitHubUrl(wp.url);
    if (ref) return ref;
  }
  for (const url of githubUrlsInText(card.description ?? "")) {
    const ref = parseGitHubUrl(url);
    if (ref) return ref;
  }
  return null;
}

function kindFromCard(card: CardLike): "issue" | "pull" | "discussion" {
  const urls: string[] = [];
  for (const wp of card.workProducts ?? []) if (wp.url) urls.push(wp.url);
  if (typeof card.description === "string") urls.push(...githubUrlsInText(card.description));
  for (const url of urls) {
    const ref = parseGitHubUrl(url);
    if (ref) return ref.kind;
  }
  return "pull";
}


async function syncOneItem(
  ctx: PluginContext,
  companyId: string,
  config: UpstreamConfig,
  fetchImpl: FetchLike,
  token: string,
  item: TrackedItemRef & { kind: "issue" | "pull" | "discussion" },
  children: CardLike[],
  next: ItemMap,
  stats: RunStats,
  nowMs: number,
): Promise<ItemOutcome> {
  const key = itemKey(item);
  const previous: ItemRecord = next[key] ?? { etags: {}, resolvedKind: null, fingerprint: null, wokenFingerprint: null, snapshot: null, cardId: null, checkedAt: "" };
  const etags = { ...previous.etags };

  const fetched = await fetchSnapshot(fetchImpl, token, item, etags, stats, previous, async (untilMs) => {
    await setBackoff(ctx, companyId, untilMs);
  }, nowMs);
  if (fetched === "rate-limited") {
    return { item: key, card: previous.cardId, status: "error", detail: "rate limited" };
  }

  const record: ItemRecord = {
    etags,
    resolvedKind: fetched.resolvedKind,
    fingerprint: fingerprintOf(fetched.snapshot),
    wokenFingerprint: previous.wokenFingerprint,
    snapshot: fetched.snapshot,
    cardId: previous.cardId,
    checkedAt: new Date(nowMs).toISOString(),
  };
  next[key] = record;
  if (config.dryRun && previous.fingerprint !== record.fingerprint) {
    // Honest dry-run: persist the cache (ETags, snapshot, resolved kind) but
    // not the wake bookkeeping (fingerprint, wokenFingerprint). Reporting the
    // same change again on a repeated dry run is correct; consuming it would
    // steal the live run's wake. Unchanged items persist normally, which is
    // what makes a repeated dry run mostly 304s.
    next[key] = {
      ...record,
      fingerprint: previous.fingerprint,
      wokenFingerprint: previous.wokenFingerprint,
    };
  }
  const snapshot = fetched.snapshot;

  let card = findCardForItem(children, item);
  if (card && !previous.cardId) record.cardId = card.id;
  if (!card) {
    // A new "ours" item with no card gets a child of the tracker.
    const ours = isOursItem(config, { headLabel: snapshot.headLabel, authorLogin: snapshot.authorLogin });
    if (!ours) {
      return { item: key, card: null, status: "not-ours", detail: "no card and not an ours item" };
    }
    if (config.dryRun) {
      return { item: key, card: null, status: "would-create", reason: `would create follow-through card for ${key}` };
    }
    const created = await ctx.issues.create({
      companyId,
      parentId: config.followThroughTrackerIssueId,
      title: `Upstream follow-through: ${key} — ${snapshot.title ?? snapshot.kind}`,
      description: `${headerBlock(snapshot)}\n\nOwns upstream ${snapshot.url} until upstream merges or closes it.`,
      assigneeAgentId: config.followThroughAssigneeAgentId,
      originKind: ITEM_ORIGIN_KIND,
      originId: key,
    });
    record.cardId = created.id;
    stats.creates += 1;
    return { item: key, card: created.id, status: "created", reason: `created follow-through card for ${key}` };
  }

  const changed = previous.fingerprint !== null && previous.fingerprint !== record.fingerprint;
  const firstSeen = previous.fingerprint === null;
  if (changed || firstSeen) {
    const patch: Record<string, unknown> = {};
    const backfill = !config.dryRun ? backfillPatch(card, item) : null;
    if (backfill) {
      patch.originKind = backfill.originKind;
      patch.originId = backfill.originId;
    }
    const desiredLabels = labelNamesFor(snapshot);
    const currentNames = (card.labels ?? []).map((l) => l.name);
    const { labelIds, changed: labelsChanged } = syncLabelIds(card.labelIds, currentNames, desiredLabels, config.labelIdByName);
    if (labelsChanged) patch.labelIds = labelIds;
    const { description, changed: headerChanged } = withHeader(card.description, snapshot);
    if (headerChanged) patch.description = description;
    const detail = previous.snapshot ? (describeChange(previous.snapshot, snapshot) ?? "first seen") : "first seen";
    if (Object.keys(patch).length > 0) {
      if (config.dryRun) {
        return { item: key, card: card.id, status: "would-wake", reason: detail, detail: "would update labels/header" };
      }
      await ctx.issues.update(card.id, patch as never, companyId);
    }
    if (firstSeen || record.wokenFingerprint === record.fingerprint) {
      record.wokenFingerprint = record.fingerprint;
      return { item: key, card: card.id, status: changed ? "mapped" : "unchanged", reason: detail, detail: "labels/header synced, no wake (first seen or already woken)" };
    }
    if (config.dryRun) {
      return { item: key, card: card.id, status: "would-wake", reason: `upstream ${key}: ${detail}` };
    }
    try {
      await ctx.issues.requestWakeup(card.id, companyId, {
        reason: `upstream ${key}: ${detail}`,
        idempotencyKey: `upstream:${key}:${record.fingerprint}`,
      });
      record.wokenFingerprint = record.fingerprint;
      stats.wakes += 1;
      return { item: key, card: card.id, status: "woke", reason: `upstream ${key}: ${detail}` };
    } catch (err) {
      record.wokenFingerprint = record.fingerprint;
      stats.errors += 1;
      return { item: key, card: card.id, status: "wake-failed", reason: detail, detail: String(err) };
    }
  }
  if (record.wokenFingerprint === null && previous.snapshot) {
    // State predates wokenFingerprint tracking: adopt without waking.
    record.wokenFingerprint = record.fingerprint;
  }
  return { item: key, card: card?.id ?? previous.cardId, status: "unchanged" };
}

/** A fetch that hit the rate limit (caller stops the run). */
type FetchResult = { snapshot: ItemSnapshot; resolvedKind: "issue" | "pull" | "discussion" } | "rate-limited";

/** Fetch one item's snapshot, reusing stored ETags. Mutates `etags` in place. */
async function fetchSnapshot(
  fetchImpl: FetchLike,
  token: string,
  item: TrackedItemRef & { kind: "issue" | "pull" | "discussion" },
  etags: NonNullable<ItemRecord["etags"]>,
  stats: RunStats,
  previous: ItemRecord,
  onRateLimited: (untilMs: number) => Promise<void>,
  nowMs: number,
): Promise<FetchResult> {
  const kind = previous.resolvedKind ?? item.kind;
  if (kind === "discussion") {
    const snapshot = await fetchDiscussion(fetchImpl, token, item, stats, onRateLimited, nowMs);
    if (!snapshot) return "rate-limited";
    return { snapshot, resolvedKind: "discussion" };
  }

  const issueUrl = `${GITHUB_API_BASE}/repos/${item.owner}/${item.repo}/issues/${item.number}`;
  const issueRes = await conditionalGet<GitHubIssue>(fetchImpl, token, issueUrl, etags.issue ?? null, stats, onRateLimited, nowMs);
  if (!issueRes) return "rate-limited";
  if (!issueRes.notModified) etags.issue = issueRes.etag;
  const issue = issueRes.notModified ? null : requireData(issueRes, issueUrl);
  const looksLikePull = kind === "pull" && (issue === null || issue.pull_request !== undefined || !previous.resolvedKind);
  if (!looksLikePull) {
    if (!issue && !previous.snapshot) throw new Error(`HTTP 304 with no stored snapshot for ${itemKey(item)}`);
    const g: GitHubIssue | null = issue;
    const snapshot: ItemSnapshot = {
      owner: item.owner,
      repo: item.repo,
      kind: "issue",
      number: item.number,
      url: g?.html_url ?? previous.snapshot?.url ?? `https://github.com/${item.owner}/${item.repo}/issues/${item.number}`,
      title: g?.title ?? previous.snapshot?.title ?? null,
      state: g?.state === "closed" ? "closed" : (previous.snapshot?.state ?? "open"),
      updatedAt: g?.updated_at ?? previous.snapshot?.updatedAt ?? null,
      commentCount: g?.comments ?? previous.snapshot?.commentCount ?? 0,
      authorLogin: g?.user?.login ?? previous.snapshot?.authorLogin ?? null,
      headLabel: null,
      reviewCount: 0,
      checkConclusion: "none",
      headSha: null,
      draft: false,
    };
    return { snapshot, resolvedKind: "issue" };
  }

  // PR path: the issue row carries comments/title, pulls/* carries the rest.
  // A 304 on the issue row still refreshes PR sub-resources via their own ETags.
  const base: ItemSnapshot = {
    owner: item.owner,
    repo: item.repo,
    kind: "pull",
    number: item.number,
    url: issue?.html_url ?? previous.snapshot?.url ?? `https://github.com/${item.owner}/${item.repo}/pull/${item.number}`,
    title: issue?.title ?? previous.snapshot?.title ?? null,
    state: previous.snapshot?.state ?? "open",
    updatedAt: issue?.updated_at ?? previous.snapshot?.updatedAt ?? null,
    commentCount: issue?.comments ?? previous.snapshot?.commentCount ?? 0,
    authorLogin: issue?.user?.login ?? previous.snapshot?.authorLogin ?? null,
    headLabel: previous.snapshot?.headLabel ?? null,
    reviewCount: previous.snapshot?.reviewCount ?? 0,
    checkConclusion: previous.snapshot?.checkConclusion ?? "none",
    headSha: previous.snapshot?.headSha ?? null,
    draft: previous.snapshot?.draft ?? false,
  };
  const snapshot = await fetchPullRest(fetchImpl, token, item, etags, stats, base, onRateLimited, nowMs);
  if (!snapshot) return "rate-limited";
  if (snapshot === "not-a-pull") {
    // The origin ID guessed PR but the item is an issue: self-correct permanently.
    const corrected: ItemSnapshot = { ...base, kind: "issue", reviewCount: 0, checkConclusion: "none", headSha: null, draft: false, headLabel: null };
    return { snapshot: corrected, resolvedKind: "issue" };
  }
  return { snapshot, resolvedKind: "pull" };
}

interface ConditionalData<T> {
  notModified: boolean;
  status: number;
  etag: string | null;
  data: T | null;
}

async function conditionalGet<T>(
  fetchImpl: FetchLike,
  token: string,
  url: string,
  etag: string | null,
  stats: RunStats,
  onRateLimited: (untilMs: number) => Promise<void>,
  nowMs: number,
): Promise<ConditionalData<T> | null> {
  const res = await githubGet<T>(fetchImpl, token, url, etag);
  if (res.rateLimited) {
    await onRateLimited(nowMs + backoffDelayMs(res, nowMs));
    return null;
  }
  if (res.notModified) {
    stats.notModified304 += 1;
    return { notModified: true, status: res.status, etag, data: null };
  }
  if (res.status !== 200) {
    stats.errors += 1;
    return { notModified: false, status: res.status, etag: res.etag, data: null };
  }
  stats.ok200 += 1;
  return { notModified: false, status: res.status, etag: res.etag, data: res.data };
}

const requireData = <T>(res: ConditionalData<T>, url: string): T => {
  if (res.notModified || res.status !== 200 || res.data === null) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.data;
};

async function fetchPullRest(
  fetchImpl: FetchLike,
  token: string,
  item: TrackedItemRef,
  etags: NonNullable<ItemRecord["etags"]>,
  stats: RunStats,
  base: ItemSnapshot,
  onRateLimited: (untilMs: number) => Promise<void>,
  nowMs: number,
): Promise<ItemSnapshot | "not-a-pull" | null> {
  const rest = `${GITHUB_API_BASE}/repos/${item.owner}/${item.repo}`;
  const pullRes = await conditionalGet<GitHubPull>(fetchImpl, token, `${rest}/pulls/${item.number}`, etags.pull ?? null, stats, onRateLimited, nowMs);
  if (!pullRes) return null;
  if (!pullRes.notModified) etags.pull = pullRes.etag;
  // A 404 here means the origin ID guessed PR but the item is an issue;
  // the caller self-corrects the stored kind permanently.
  if (pullRes.status === 404) return "not-a-pull";
  const pull = pullRes.notModified ? null : requireData(pullRes, `${rest}/pulls/${item.number}`);
  let headSha = base.headSha;
  let headLabel = base.headLabel;
  let draft = base.draft;
  let state = base.state;
  if (pull) {
    headSha = pull.head?.sha ?? headSha;
    headLabel = pull.head?.label ?? headLabel;
    draft = pull.draft ?? draft;
    state = pull.merged ? "merged" : pull.state === "closed" ? "closed" : "open";
    if (pull.updated_at) base.updatedAt = pull.updated_at;
    if (pull.html_url) base.url = pull.html_url;
    if (pull.title) base.title = pull.title;
    if (pull.user?.login) base.authorLogin = pull.user.login;
  }
  const reviewsRes = await conditionalGet<GitHubReview[]>(fetchImpl, token, `${rest}/pulls/${item.number}/reviews`, etags.reviews ?? null, stats, onRateLimited, nowMs);
  if (!reviewsRes) return null;
  if (!reviewsRes.notModified) {
    etags.reviews = reviewsRes.etag;
    if (Array.isArray(reviewsRes.data)) base.reviewCount = reviewsRes.data.length;
  }
  // Check runs: only while checks are pending (or the head moved, or never checked).
  const checksSettled = (base.checkConclusion === "success" || base.checkConclusion === "neutral" || base.checkConclusion === "failure") && headSha === (base.headSha ?? null) && etags.checkRuns;
  if (headSha && !checksSettled) {
    const checksRes = await conditionalGet<GitHubCheckRuns>(fetchImpl, token, `${rest}/commits/${headSha}/check-runs`, etags.checkRuns ?? null, stats, onRateLimited, nowMs);
    if (!checksRes) return null;
    if (!checksRes.notModified) {
      etags.checkRuns = checksRes.etag;
      if (checksRes.status === 200) base.checkConclusion = aggregateChecks(checksRes.data);
    }
  }
  return { ...base, headSha, headLabel, draft, state };
}

const DISCUSSION_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    discussion(number: $number) {
      title
      url
      updatedAt
      closed
      author { login }
      comments(first: 1) { totalCount }
    }
  }
}`;

async function fetchDiscussion(
  fetchImpl: FetchLike,
  token: string,
  item: TrackedItemRef,
  stats: RunStats,
  onRateLimited: (untilMs: number) => Promise<void>,
  nowMs: number,
): Promise<ItemSnapshot | null> {
  const res = await githubGraphql<{
    repository?: { discussion?: { title?: string; url?: string; updatedAt?: string; closed?: boolean; author?: { login?: string }; comments?: { totalCount?: number } } | null } | null;
  }>(fetchImpl, token, DISCUSSION_QUERY, { owner: item.owner, repo: item.repo, number: item.number });
  if (res.status === 429 || res.status === 403) {
    await onRateLimited(nowMs + 60 * 1000);
    return null;
  }
  if (res.status !== 200 || !res.data?.repository?.discussion) {
    stats.errors += 1;
    throw new Error(`GraphQL discussion ${itemKey(item)} HTTP ${res.status}`);
  }
  stats.ok200 += 1;
  const d = res.data.repository.discussion;
  return {
    owner: item.owner,
    repo: item.repo,
    kind: "discussion",
    number: item.number,
    url: d.url ?? `https://github.com/${item.owner}/${item.repo}/discussions/${item.number}`,
    title: d.title ?? null,
    state: d.closed ? "closed" : "open",
    updatedAt: d.updatedAt ?? null,
    commentCount: d.comments?.totalCount ?? 0,
    authorLogin: d.author?.login ?? null,
    headLabel: null,
    reviewCount: 0,
    checkConclusion: "none",
    headSha: null,
    draft: false,
  };
}

/**
 * Hourly discovery of new ours items via issue search (at most a few search
 * calls per run, far inside the 30/min search budget).
 */
async function runDiscovery(
  ctx: PluginContext,
  companyId: string,
  config: UpstreamConfig,
  deps: ItemDeps,
  token: string,
  children: CardLike[],
  tracked: Map<string, TrackedItemRef & { kind: "issue" | "pull" | "discussion" }>,
  outcomes: ItemOutcome[],
  stats: RunStats,
  nowMs: number,
): Promise<void> {
  if (config.discoveryQueries.length === 0 || config.dryRun) return;
  const lastRaw = (await ctx.state.get(stateKey(companyId, "last-discovery-search-at")) as string | null) ?? null;
  if (lastRaw && nowMs - Date.parse(lastRaw) < DISCOVERY_SEARCH_INTERVAL_MS) return;
  await ctx.state.set(stateKey(companyId, "last-discovery-search-at"), new Date(nowMs).toISOString());

  for (const query of config.discoveryQueries.slice(0, 5)) {
    if (await isBackedOff(ctx, companyId, (deps.now ?? Date.now)())) break;
    try {
      const res = await githubGet<{ items?: Array<{ number?: number; html_url?: string; user?: { login?: string } }> }>(
        deps.fetchImpl,
        token,
        `${GITHUB_API_BASE}/search/issues?q=${encodeURIComponent(query)}&per_page=20`,
        null,
      );
      if (res.rateLimited) {
        await setBackoff(ctx, companyId, (deps.now ?? Date.now)() + backoffDelayMs(res, (deps.now ?? Date.now)()));
        outcomes.push({ item: `search:${query}`, card: null, status: "skipped-backoff", detail: "rate limited" });
        break;
      }
      if (res.status !== 200 || !res.data) {
        stats.errors += 1;
        continue;
      }
      stats.ok200 += 1;
      for (const found of res.data.items ?? []) {
        if (!found.html_url) continue;
        const ref = parseGitHubUrl(found.html_url);
        if (!ref || tracked.has(itemKey(ref))) continue;
        if (findCardForItem(children, ref)) {
          tracked.set(itemKey(ref), ref);
          continue;
        }
        // PRs need their head label to judge "ours".
        let headLabel: string | null = null;
        if (ref.kind === "pull") {
          const pull = await githubGet<GitHubPull>(deps.fetchImpl, token, `${GITHUB_API_BASE}/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, null);
          if (!pull.rateLimited && pull.status === 200 && pull.data) {
            stats.ok200 += 1;
            headLabel = pull.data.head?.label ?? null;
          }
        }
        const ours = isOursItem(config, { headLabel, authorLogin: found.user?.login ?? null });
        if (!ours) {
          outcomes.push({ item: itemKey(ref), card: null, status: "not-ours", detail: `discovered via search, not ours` });
          continue;
        }
        const created = await ctx.issues.create({
          companyId,
          parentId: config.followThroughTrackerIssueId,
          title: `Upstream follow-through: ${itemKey(ref)}`,
          description: `Owns upstream ${found.html_url} until upstream merges or closes it.\n\nDiscovered by togetherweown.github-upstream issue search.`,
          assigneeAgentId: config.followThroughAssigneeAgentId,
          originKind: ITEM_ORIGIN_KIND,
          originId: itemKey(ref),
        });
        tracked.set(itemKey(ref), ref);
        stats.creates += 1;
        outcomes.push({ item: itemKey(ref), card: created.id, status: "created", reason: "discovered ours item via search" });
      }
    } catch (err) {
      stats.errors += 1;
      outcomes.push({ item: `search:${query}`, card: null, status: "error", detail: String(err) });
    }
  }
}

async function resolveToken(ctx: PluginContext, companyId: string, config: UpstreamConfig): Promise<string> {
  if (!config.tokenSecretRef) return "";
  return ctx.secrets.resolve(config.tokenSecretRef as string, { companyId });
}

export type { GitHubResult };
