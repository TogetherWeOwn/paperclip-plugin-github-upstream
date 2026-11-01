import type { Issue } from "@paperclipai/plugin-sdk";
import { itemKey, type TrackedItemRef, type UpstreamConfig } from "./config.js";
import { ITEM_ORIGIN_KIND } from "./manifest.js";

/** Deterministic view of one upstream item, built only from GitHub API fields. */
export interface ItemSnapshot {
  owner: string;
  repo: string;
  kind: "issue" | "pull" | "discussion";
  number: number;
  url: string;
  title: string | null;
  /** Canonical lifecycle: PRs report merged separately from closed. */
  state: "open" | "closed" | "merged";
  updatedAt: string | null;
  commentCount: number;
  /** GitHub login of the item author, for the "ours" check. */
  authorLogin: string | null;
  /** PR head label (forkOwner:branch), for the "ours" check. Null for issues/discussions. */
  headLabel: string | null;
  reviewCount: number;
  /** Worst check-run conclusion, or pending/none. */
  checkConclusion: "success" | "failure" | "pending" | "neutral" | "none";
  headSha: string | null;
  draft: boolean;
  /** Latest decisive review state (APPROVED / CHANGES_REQUESTED), or null when no reviewer has ruled. */
  latestReviewState: "APPROVED" | "CHANGES_REQUESTED" | null;
  /**
   * Whose court the ball is in. Derived deterministically from the fields
   * above (never fetched separately): closed/merged items need nobody, open
   * PRs needing our action are "us", everything open that waits on upstream
   * is "maintainer".
   */
  awaiting: "us" | "maintainer" | null;
}

export type CardLike = Pick<Issue, "id" | "originKind" | "originId"> & {
  labels?: Array<{ name: string }> | undefined;
  labelIds?: string[] | undefined;
  description?: string | null | undefined;
  workProducts?: Array<{ url: string | null }> | undefined;
};

const GITHUB_ITEM_RE =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(pull|issues|discussions)\/(\d+)(?:[/?#].*)?$/i;

/** Parse a github.com issue/PR/discussion URL into an item ref. */
export function parseGitHubUrl(url: string): (TrackedItemRef & { kind: "issue" | "pull" | "discussion" }) | null {
  const match = GITHUB_ITEM_RE.exec(url.trim());
  if (!match) return null;
  const [, owner, repo, section, num] = match;
  if (!owner || !repo || !num) return null;
  const kind = section.toLowerCase() === "pull" ? "pull" : section.toLowerCase() === "issues" ? "issue" : "discussion";
  return { owner, repo, kind, number: Number.parseInt(num, 10) };
}

export const itemOriginId = (item: Pick<TrackedItemRef, "owner" | "repo" | "number">): string => itemKey(item);

const URL_RE = /https?:\/\/github\.com\/[^\s)"']+/gi;

/** Every github.com URL mentioned in free text (descriptions, notes). */
export function githubUrlsInText(text: string): string[] {
  return text.match(URL_RE) ?? [];
}

const matchesItem = (url: string, item: Pick<TrackedItemRef, "owner" | "repo" | "number">): boolean => {
  const ref = parseGitHubUrl(url);
  return !!ref && ref.owner === item.owner && ref.repo === item.repo && ref.number === item.number;
};

/**
 * Find the card for an item: first by originId, then by GitHub URL work
 * product, then by a GitHub URL in the description (the shape most existing
 * follow-through cards are in). Mirrors refFromCard's tracking so a tracked
 * item always resolves to the card that caused it to be tracked.
 */
export function findCardForItem<T extends CardLike>(cards: T[], item: Pick<TrackedItemRef, "owner" | "repo" | "number">): T | null {
  const originId = itemOriginId(item);
  const byOrigin = cards.find((c) => c.originKind === ITEM_ORIGIN_KIND && c.originId === originId);
  if (byOrigin) return byOrigin;
  for (const card of cards) {
    for (const wp of card.workProducts ?? []) {
      if (wp.url && matchesItem(wp.url, item)) return card;
    }
    if (typeof card.description === "string") {
      for (const url of githubUrlsInText(card.description)) {
        if (matchesItem(url, item)) return card;
      }
    }
  }
  return null;
}

/** Patch that backfills originKind/originId on a card found by work product. Null when already set. */
export function backfillPatch<T extends CardLike>(card: T, item: Pick<TrackedItemRef, "owner" | "repo" | "number">): { originKind: string; originId: string } | null {
  const originId = itemOriginId(item);
  if (card.originKind === ITEM_ORIGIN_KIND && card.originId === originId) return null;
  return { originKind: ITEM_ORIGIN_KIND, originId };
}

/** Stable fingerprint of every field that counts as a real change. */
export function fingerprintOf(snapshot: ItemSnapshot): string {
  return JSON.stringify([
    snapshot.state,
    snapshot.updatedAt,
    snapshot.commentCount,
    snapshot.reviewCount,
    snapshot.latestReviewState,
    snapshot.checkConclusion,
    snapshot.headSha,
    snapshot.draft,
  ]);
}

/** One-line deterministic summary of what changed, or null when nothing did. */
export function describeChange(previous: ItemSnapshot, next: ItemSnapshot): string | null {
  const parts: string[] = [];
  if (previous.state !== next.state) parts.push(`state ${previous.state}->${next.state}`);
  if (previous.commentCount !== next.commentCount) {
    const delta = next.commentCount - previous.commentCount;
    parts.push(delta > 0 ? `${delta} new comment${delta === 1 ? "" : "s"}` : `comments ${previous.commentCount}->${next.commentCount}`);
  }
  if (previous.reviewCount !== next.reviewCount) {
    const delta = next.reviewCount - previous.reviewCount;
    parts.push(delta > 0 ? `${delta} new review${delta === 1 ? "" : "s"}` : `reviews ${previous.reviewCount}->${next.reviewCount}`);
  }
  if (previous.checkConclusion !== next.checkConclusion) parts.push(`checks ${previous.checkConclusion}->${next.checkConclusion}`);
  if (previous.latestReviewState !== next.latestReviewState) {
    parts.push(
      next.latestReviewState === "CHANGES_REQUESTED"
        ? "reviewer requested changes"
        : next.latestReviewState === "APPROVED"
          ? "reviewer approved"
          : `review ruling cleared (${previous.latestReviewState ?? "none"}->none)`,
    );
  }
  if ((previous.headSha ?? null) !== (next.headSha ?? null)) {
    parts.push(`head ${shortSha(previous.headSha)}->${shortSha(next.headSha)}`);
  }
  if (previous.draft !== next.draft) parts.push(next.draft ? "marked draft" : "marked ready");
  if (parts.length === 0 && (previous.updatedAt ?? null) !== (next.updatedAt ?? null)) {
    parts.push(`activity ${previous.updatedAt ?? "?"}->${next.updatedAt ?? "?"}`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

const shortSha = (sha: string | null): string => (sha ? sha.slice(0, 7) : "?");

/** Label names kept in sync on each card. */
export function labelNamesFor(snapshot: ItemSnapshot): string[] {
  const ci = snapshot.checkConclusion === "success" || snapshot.checkConclusion === "neutral" ? "green" : snapshot.checkConclusion === "failure" ? "red" : "pending";
  const labels = [
    `gh:repo/${snapshot.repo}`,
    `gh:type/${snapshot.kind === "pull" ? "pr" : snapshot.kind}`,
    `gh:state/${snapshot.state}`,
    `gh:ci/${ci}`,
  ];
  if (snapshot.awaiting === "us") labels.push("gh:awaiting/us");
  if (snapshot.awaiting === "maintainer") labels.push("gh:awaiting/maintainer");
  return labels;
}

/**
 * Decide whose court the ball is in. Heuristic, documented in the README:
 * closed/merged items need nobody; an open PR that is a draft, has red
 * checks, or has a maintainer requesting changes needs us; an approved open
 * PR waits on the maintainer to merge; any other open ours item waits on the
 * maintainer to respond. Non-ours items never get an awaiting label.
 */
export function decideAwaiting(
  config: UpstreamConfig,
  snapshot: Pick<
    ItemSnapshot,
    "kind" | "state" | "draft" | "checkConclusion" | "latestReviewState" | "headLabel" | "authorLogin"
  >,
): "us" | "maintainer" | null {
  if (snapshot.state !== "open") return null;
  const ours = isOursItem(config, { headLabel: snapshot.headLabel, authorLogin: snapshot.authorLogin });
  // Someone else's item is never our court, whatever its review or CI state:
  // the tab only tracks actionability for ours items.
  if (!ours) return null;
  if (snapshot.kind === "pull") {
    if (snapshot.draft) return "us";
    if (snapshot.checkConclusion === "failure") return "us";
    if (snapshot.latestReviewState === "CHANGES_REQUESTED") return "us";
    if (snapshot.latestReviewState === "APPROVED") return "maintainer";
    return "maintainer";
  }
  return "maintainer";
}

/**
 * Merge desired gh:* labels into the card's label set. Names without an ID in
 * `labelIdByName` are skipped (the plugin has no labels read API). Stale gh:*
 * labels are removed; every other label is preserved. Stale IDs are also swept
 * by reverse lookup so read paths that return IDs without names cannot
 * accumulate replaced gh:* labels (e.g. gh:awaiting/maintainer after a flip to
 * gh:awaiting/us).
 */
export function syncLabelIds(
  currentIds: string[] | undefined,
  currentNames: string[] | undefined,
  desiredNames: string[],
  labelIdByName: Record<string, string>,
): { labelIds: string[]; changed: boolean } {
  const names = new Set(currentNames ?? []);
  const ids = new Set(currentIds ?? []);
  // Drop stale gh:* labels.
  for (const name of [...names]) {
    if (name.startsWith("gh:") && !desiredNames.includes(name)) {
      names.delete(name);
      const id = labelIdByName[name];
      if (id) ids.delete(id);
    }
  }
  // Some read paths return label IDs without names; drop IDs that only ever
  // name stale gh:* labels so a replaced facet cannot linger.
  const namesById = new Map<string, string[]>();
  for (const [name, id] of Object.entries(labelIdByName)) {
    const list = namesById.get(id) ?? [];
    list.push(name);
    namesById.set(id, list);
  }
  for (const id of [...ids]) {
    const mapped = namesById.get(id) ?? [];
    if (
      mapped.length > 0 &&
      mapped.every((n) => n.startsWith("gh:")) &&
      !mapped.some((n) => desiredNames.includes(n))
    ) {
      ids.delete(id);
    }
  }
  for (const name of desiredNames) {
    const id = labelIdByName[name];
    if (!id) continue;
    names.add(name);
    ids.add(id);
  }
  const labelIds = [...ids];
  const before = new Set(currentIds ?? []);
  const changed = labelIds.length !== before.size || labelIds.some((id) => !before.has(id));
  return { labelIds, changed };
}

const headerOpenFor = (item: Pick<TrackedItemRef, "owner" | "repo" | "number">): string =>
  `<!-- github-upstream: ${itemOriginId(item)} -->`;
const HEADER_CLOSE = "<!-- /github-upstream -->";

/** Short header kept at the top of each card's description. */
export function headerBlock(snapshot: ItemSnapshot): string {
  const open = headerOpenFor(snapshot);
  const ci = snapshot.checkConclusion;
  const head = snapshot.headSha ? ` · head \`${shortSha(snapshot.headSha)}\`${snapshot.draft ? " (draft)" : ""}` : "";
  return [
    open,
    `Upstream: [${snapshot.owner}/${snapshot.repo}#${snapshot.number}](${snapshot.url}) · ${snapshot.kind} · ${snapshot.state} · CI ${ci}`,
    `Last upstream activity: ${snapshot.updatedAt ?? "unknown"} · ${snapshot.commentCount} comments · ${snapshot.reviewCount} reviews${head}`,
    "Synced by togetherweown.github-upstream; edit below this line.",
    HEADER_CLOSE,
  ].join("\n");
}

/** Replace the header block, preserving everything the card owner wrote below it. */
export function withHeader(description: string | null | undefined, snapshot: ItemSnapshot): { description: string; changed: boolean } {
  const block = headerBlock(snapshot);
  const current = description ?? "";
  const open = headerOpenFor(snapshot);
  const start = current.indexOf(open);
  if (start === -1) {
    const next = current.length > 0 ? `${block}\n\n${current}` : `${block}\n`;
    return { description: next, changed: true };
  }
  const end = current.indexOf(HEADER_CLOSE, start);
  const after = end === -1 ? "" : current.slice(end + HEADER_CLOSE.length);
  const next = `${block}${after}`;
  return { description: next, changed: next !== current };
}

/** A PR/issue counts as ours when its head or author matches the configured identity. */
export function isOursItem(
  config: UpstreamConfig,
  item: { headLabel: string | null; authorLogin: string | null },
): boolean {
  if (item.headLabel && config.ourHeadPrefixes.some((p) => item.headLabel!.startsWith(p))) return true;
  if (config.operatorLogin && item.authorLogin === config.operatorLogin) return true;
  return false;
}

/**
 * A GitHub actor login counts as ours when it is the operator or a listed
 * `ourLogins` entry (e.g. the coming bot identity). Compared case-insensitively:
 * GitHub logins are case-preserving but not case-sensitive.
 */
export function isOurLogin(config: UpstreamConfig, login: string | null | undefined): boolean {
  if (!login) return false;
  const lower = login.toLowerCase();
  if (config.operatorLogin && config.operatorLogin.toLowerCase() === lower) return true;
  return config.ourLogins.some((l) => l.toLowerCase() === lower);
}
