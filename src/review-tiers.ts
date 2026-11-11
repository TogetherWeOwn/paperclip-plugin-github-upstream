/**
 * Path-based risk tiers (TWO-5879). The review-guard varies review depth by
 * risk: every change gets QA, and Sensitive/unknown changes additionally get
 * Security. Tiers are driven by each repo's `.github/review-tiers.yml`, matched
 * against the card's changed paths in its workspace checkout.
 *
 * Fail-closed contract (TWO-5879): a missing tier map, an unreadable diff, or
 * any unmatched path tiers Sensitive ("unknown" stages as Sensitive). A
 * malformed map fails the same way — the parser throws and the caller tiers
 * Sensitive, never guessing.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { Issue } from "@paperclipai/shared";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const execFileAsync = promisify(execFile);

export type RiskTier = "low" | "ordinary" | "sensitive" | "unknown";

export interface ReviewTierMap {
  low: string[];
  ordinary: string[];
  sensitive: string[];
}

/** The tier map's own path: changing it is review-policy enforcement, always Sensitive. */
export const TIER_MAP_PATH = ".github/review-tiers.yml";

/** Stage mapping: unknown fails closed to Sensitive (Security + QA). QA runs on every tier. */
export const needsSecurityReview = (tier: RiskTier): boolean => tier === "sensitive" || tier === "unknown";

/**
 * Parse the `.github/review-tiers.yml` subset the guard understands:
 *
 *   low:
 *     - "docs/**"
 *   ordinary:
 *     - "src/ui/**"
 *   sensitive:
 *     - "src/auth/**"
 *     - ".github/workflows/**"
 *
 * Inline lists (`low: ["docs/**"]`) are accepted too. Anything else — an
 * unknown key, a duplicate key, wrong indentation, flow items outside a list
 * — throws, and the caller tiers Sensitive.
 */
export function parseReviewTierMap(text: string): ReviewTierMap {
  const map: ReviewTierMap = { low: [], ordinary: [], sensitive: [] };
  let current: keyof ReviewTierMap | null = null;
  let inlineList = false;
  let blockIndent: number | null = null;
  let inTiers = false;
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  const versioned = lines.some((line) => /^version\s*:/.test(line));
  let versionSeen = false;
  let defaultSeen = false;
  let tiersSeen = false;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = stripComment(lines[i] ?? "");
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (versioned && !raw.startsWith(" ") && !raw.startsWith("\t")) {
      if (current && !inlineList && map[current].length === 0) throw new Error("invalid tier map: no patterns in block list");
      current = null;
      inTiers = false;
      if (/^version:\s*1\s*(?:#.*)?$/.test(raw) && !versionSeen) versionSeen = true;
      else if (/^default_tier:\s*sensitive\s*(?:#.*)?$/.test(raw) && !defaultSeen) defaultSeen = true;
      else if (/^tiers:\s*(?:#.*)?$/.test(raw) && !tiersSeen) { tiersSeen = true; inTiers = true; }
      else throw new Error(`invalid tier map line ${i + 1}: ${JSON.stringify(raw)}`);
      continue;
    }
    // Tier keys are top-level in legacy maps, nested under tiers in v1.
    const tierLine = versioned ? (inTiers && /^  [^ ]/.test(raw) ? raw.slice(2) : null) : (!raw.startsWith(" ") && !raw.startsWith("\t") ? raw : null);
    if (tierLine !== null) {
      if (current && !inlineList && map[current].length === 0) throw new Error("invalid tier map: no patterns in block list");
      const keyMatch = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(tierLine);
      if (!keyMatch) throw new Error(`invalid tier map line ${i + 1}: ${JSON.stringify(raw)}`);
      const key = keyMatch[1] ?? "";
      if (key !== "low" && key !== "ordinary" && key !== "sensitive") {
        throw new Error(`invalid tier map: unknown key "${key}"`);
      }
      if (seen.has(key)) throw new Error(`invalid tier map: duplicate key "${key}"`);
      seen.add(key);
      current = key;
      blockIndent = null;
      const inline = (keyMatch[2] ?? "").trim();
      inlineList = inline !== "";
      if (inlineList) {
        for (const item of parseInlineList(inline)) map[key].push(validatePattern(item));
      }
      continue;
    }
    // Block list item under the current key.
    const itemMatch = /^( +)-\s+(.*)$/.exec(raw);
    const indent = itemMatch?.[1]?.length ?? 0;
    if (!itemMatch || current === null || inlineList || (versioned ? indent !== 4 : indent < 1) || (blockIndent !== null && blockIndent !== indent)) {
      throw new Error(`invalid tier map line ${i + 1}: ${JSON.stringify(raw)}`);
    }
    blockIndent = indent;
    map[current].push(validatePattern(dequote(itemMatch[2] ?? "")));
  }
  if (current && !inlineList && map[current].length === 0) throw new Error("invalid tier map: no patterns in block list");
  if (versioned && (!versionSeen || !defaultSeen || !tiersSeen || seen.size !== 3)) {
    throw new Error("invalid tier map: incomplete v1 schema");
  }
  const total = map.low.length + map.ordinary.length + map.sensitive.length;
  if (!versioned && total === 0) throw new Error("invalid tier map: no patterns");
  return map;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1] ?? ""))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

/** Split `["a", 'b', c]` (or a bare scalar) into de-quoted items. Throws on malformed flow. */
function parseInlineList(inline: string): string[] {
  if (!inline.startsWith("[")) {
    // A bare value after `key:` is not a list: fail closed rather than guess.
    throw new Error(`invalid tier map: expected a list for "${inline}"`);
  }
  if (!inline.endsWith("]")) throw new Error("invalid tier map: unterminated inline list");
  const inner = inline.slice(1, -1).trim();
  if (inner === "") return [];
  const items: string[] = [];
  let buf = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      buf += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === ",") {
      items.push(dequote(buf));
      buf = "";
    } else if (ch === "[") {
      throw new Error("invalid tier map: nested inline list");
    } else {
      buf += ch;
    }
  }
  if (quote !== null) throw new Error("invalid tier map: unterminated quote");
  items.push(dequote(buf));
  return items;
}

function dequote(value: string): string {
  let v = value.trim();
  // Strip a trailing inline comment outside quotes ( "path # note").
  if (!v.startsWith('"') && !v.startsWith("'")) {
    const hash = v.indexOf(" #");
    if (hash !== -1) v = v.slice(0, hash).trim();
  }
  if (/^"[^"\\]*"$/.test(v) || /^'[^'\\]*'$/.test(v)) return v.slice(1, -1);
  // Accept only a deliberately small, unambiguous YAML plain-scalar subset.
  if (!/^[A-Za-z0-9_.][A-Za-z0-9_./*?-]*$/.test(v) || /^(null|true|false|~|[0-9]+)$/i.test(v)) {
    throw new Error(`invalid tier map: ambiguous scalar ${JSON.stringify(value)}`);
  }
  return v;
}

/** A pattern is a repo-relative glob. Absolute paths, parents and backslashes never match — the map is invalid. */
function validatePattern(pattern: string): string {
  const normalized = pattern.trim().replace(/^\.\//, "");
  if (normalized === "") throw new Error("invalid tier map: empty pattern");
  if (isAbsolute(normalized) || normalized.includes("..") || normalized.includes("\\")) {
    throw new Error(`invalid tier map: unsafe pattern ${JSON.stringify(pattern)}`);
  }
  if (normalized.length > 512) throw new Error(`invalid tier map: pattern too long: ${JSON.stringify(pattern).slice(0, 80)}`);
  return normalized;
}

const REGEXP_SPECIAL = /[\\.^$+()|[\]{}]/g;

/**
 * Glob match for tier patterns: `**` crosses directories, `*`/`?` stay inside
 * one segment, and a glob-free pattern matches that path or everything under
 * `pattern/`. Anchored both ways: `src/*.test.ts` never matches
 * `src/ui/x.test.ts`, and `docs/**` never matches `src/docs/x.md`.
 */
export function matchGlob(pattern: string, path: string): boolean {
  const normalizedPath = path.replace(/^\.\//, "");
  const hasGlob = /[*?]/.test(pattern);
  if (!hasGlob) {
    const dir = pattern.endsWith("/") ? pattern : `${pattern}/`;
    return normalizedPath === pattern || normalizedPath.startsWith(dir);
  }
  let regex = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] ?? "";
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches zero or more leading directories; `/**` the same at the end; bare `**` everything.
        if (pattern[i + 2] === "/") {
          regex += "(?:.*/)?";
          i += 2;
        } else if (i > 0 && pattern[i - 1] === "/") {
          regex += ".*";
          i += 1;
        } else {
          regex += ".*";
          i += 1;
        }
      } else {
        regex += "[^/]*";
      }
    } else if (ch === "?") {
      regex += "[^/]";
    } else {
      regex += ch.replace(REGEXP_SPECIAL, "\\$&");
    }
  }
  regex += "$";
  return new RegExp(regex).test(normalizedPath);
}

/** One path's tier: Sensitive wins over Ordinary wins over Low; unmatched paths are unknown (fail closed). */
export function classifyPath(map: ReviewTierMap, path: string): RiskTier {
  const normalized = path.replace(/^\.\//, "");
  if (normalized === "" || isAbsolute(normalized) || normalized.includes("..") || normalized.includes("\\")) return "unknown";
  if (map.sensitive.some((p) => matchGlob(p, normalized))) return "sensitive";
  if (map.ordinary.some((p) => matchGlob(p, normalized))) return "ordinary";
  if (map.low.some((p) => matchGlob(p, normalized))) return "low";
  return "unknown";
}

export interface TieredPaths {
  tier: RiskTier;
  /** Changed paths that forced Sensitive or unknown (including unmatched ones). */
  gatedPaths: string[];
  /** Changed paths with no map entry at all (unknown). */
  unmatchedPaths: string[];
}

const TIER_RANK: Record<RiskTier, number> = { low: 0, ordinary: 1, sensitive: 2, unknown: 3 };

/** The PR's tier is the highest tier among its changed paths. An empty list is
 *  absence of evidence, not low risk — it fails closed to Sensitive until a
 *  real diff exists (e.g. a stamp attempted at creation, before any execution
 *  workspace/head). {@link resolveReviewTier} reports the empty-diff reason
 *  ahead of this fallback; the default stays fail-closed by construction. */
export function tierForPaths(map: ReviewTierMap, paths: string[]): TieredPaths {
  let tier: RiskTier = paths.length === 0 ? "sensitive" : "low";
  const gatedPaths: string[] = [];
  const unmatchedPaths: string[] = [];
  for (const path of paths) {
    const normalized = path.replace(/^\.\//, "");
    // Editing the tier map itself can never tier below Sensitive, whatever the map says.
    const forced = normalized === TIER_MAP_PATH ? "sensitive" : classifyPath(map, normalized);
    if (forced === "unknown") unmatchedPaths.push(normalized);
    if (forced === "sensitive" || forced === "unknown") gatedPaths.push(normalized);
    if (TIER_RANK[forced] > TIER_RANK[tier]) tier = forced;
  }
  return { tier, gatedPaths, unmatchedPaths };
}

export interface ResolvedTier {
  tier: RiskTier;
  /** Why, for the audit comment: the gating path, the unmatched path, or the fail-closed reason. */
  reason: string;
  changedPaths: string[];
  headSha: string | null;
}

const MAX_CHANGED_PATHS = 2000;
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 1024 * 1024;

/** Fail-closed result: full review, never silently under-reviewed. */
const failClosed = (reason: string): ResolvedTier => ({ tier: "sensitive", reason, changedPaths: [], headSha: null });

/**
 * Resolve the risk tier for one card's current head: read the checkout's
 * `.github/review-tiers.yml` and classify every changed path against the
 * workspace base. Any failure — no checkout, missing or invalid map,
 * unreadable diff — tiers Sensitive.
 */
export async function resolveReviewTier(
  ctx: PluginContext,
  companyId: string,
  issue: Issue,
): Promise<ResolvedTier> {
  // The issue's execution workspace holds its own head; the primary project
  // workspace may sit on the base branch, so it is only the fallback.
  let checkout: string | null = null;
  let baseRef: string | null = null;
  if (issue.executionWorkspaceId) {
    const exec = await ctx.executionWorkspaces.get(issue.executionWorkspaceId, companyId);
    const execPath = exec?.cwd ?? exec?.path ?? null;
    if (execPath) {
      checkout = execPath;
      baseRef = exec?.baseRef ?? null;
    }
  }
  if (!checkout) {
    const workspace = await ctx.projects.getWorkspaceForIssue(issue.id, companyId);
    if (workspace?.path) {
      checkout = workspace.path;
      baseRef = workspace.defaultRef;
    }
  }
  if (!checkout || !isAbsolute(checkout)) return failClosed("fail-closed: no workspace checkout");
  checkout = checkout.replace(/\/$/, "") || "/";

  let map: ReviewTierMap;
  try {
    const text = await readFile(join(checkout, TIER_MAP_PATH), "utf8");
    map = parseReviewTierMap(text);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    return failClosed(missing ? "fail-closed: missing .github/review-tiers.yml" : `fail-closed: unreadable tier map (${String(err)})`);
  }

  const paths = await changedPaths(checkout, baseRef);
  if (paths === null) return failClosed("fail-closed: unreadable diff");
  if (paths.length > MAX_CHANGED_PATHS) return failClosed("fail-closed: diff too large to classify");
  // Zero classified paths is absence of evidence, not low risk: a stamp
  // attempted before any execution workspace/head exists (or against a
  // checkout sitting on the base branch) must not produce a Low/QA-only
  // stamp. Fail closed to Sensitive rather than deferring. The primary
  // project workspace fallback above is known to sit on the base branch,
  // so without this guard the common Sensitive flow would be a QA-only
  // stamp later upgraded onto a possibly-live stage.
  if (paths.length === 0) return failClosed("fail-closed: empty diff (absence of evidence, not low risk)");

  const headSha = await gitHead(checkout);
  if (!headSha) return failClosed("fail-closed: unreadable head");
  const { tier, gatedPaths, unmatchedPaths } = tierForPaths(map, paths);
  if (unmatchedPaths.length > 0) {
    return { tier, reason: `unmatched path ${unmatchedPaths.slice(0, 3).join(", ")}${unmatchedPaths.length > 3 ? ` +${unmatchedPaths.length - 3} more` : ""}`, changedPaths: paths, headSha };
  }
  if (gatedPaths.length > 0) {
    return { tier, reason: `sensitive path ${gatedPaths.slice(0, 3).join(", ")}${gatedPaths.length > 3 ? ` +${gatedPaths.length - 3} more` : ""} (${paths.length} changed)`, changedPaths: paths, headSha };
  }
  // Path classification cannot prove the absence of semantic content triggers.
  return { tier: "sensitive", reason: `fail-closed: content triggers not established absent (path tier ${tier})`, changedPaths: paths, headSha };
}

/**
 * Run read-only `git` in the author-controlled checkout with every
 * execution-bearing config neutralized. Without this, a checkout's own
 * `.git/config` runs code in the plugin host (which holds GitHub
 * credentials) the moment the guard tiers the very worktree being tiered —
 * verified locally with a planted `core.fsmonitor` on the exact
 * `diff`/`ls-files` commands, which executed the hook. `-c` overrides win
 * over any repository config; `--no-ext-diff`/`--no-textconv` plus the
 * locked-down environment cover the remaining diff drivers.
 */
const git = async (checkout: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c", "core.fsmonitor=",
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.pager=cat",
      "-c", "diff.external=",
      "-c", "core.askPass=",
      "-c", "core.alternateRefsCommand=",
      "-C", checkout,
      ...args,
    ],
    {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat" },
    },
  );
  return stdout;
};

/** Changed paths vs the merge-base with HEAD: committed, staged, unstaged, plus untracked (new) files. Null on any git failure. */
async function changedPaths(checkout: string, baseRef: string | null): Promise<string[] | null> {
  try {
    const bases = [baseRef, "origin/main", "main", "origin/master", "master"].filter((b): b is string => typeof b === "string" && b.length > 0);
    let mergeBase: string | null = null;
    for (const base of bases) {
      try {
        const mb = (await git(checkout, ["merge-base", base, "HEAD"])).trim();
        if (mb) {
          mergeBase = mb;
          break;
        }
      } catch {
        // Try the next candidate base.
      }
    }
    if (!mergeBase) return null;
    const splitNul = (s: string): string[] => s.split("\0").filter((p) => p.length > 0);
    // `--no-renames`: plain `--name-only` lists only the destination of a
    // rename, so `git mv src/auth.ts docs/auth.md` would show only the
    // Low-tier destination and tier Low. Expanding every rename into a
    // delete+add surfaces both sides; the sensitive side then wins.
    const tracked = splitNul(await git(checkout, ["diff", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "-z", mergeBase]));
    const untracked = splitNul(await git(checkout, ["ls-files", "--others", "--exclude-standard", "-z"]));
    return [...new Set([...tracked, ...untracked])].sort();
  } catch {
    return null;
  }
}

async function gitHead(checkout: string): Promise<string | null> {
  try {
    const sha = (await git(checkout, ["rev-parse", "HEAD"])).trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}
