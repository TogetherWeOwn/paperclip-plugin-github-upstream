import type { PluginContext } from "@paperclipai/plugin-sdk";
import { releaseKey, repoKey, type UpstreamConfig } from "./config.js";
import { backoffDelayMs, GITHUB_API_BASE, githubGet, type FetchLike } from "./github.js";
import { RELEASE_ORIGIN_KIND } from "./manifest.js";
import { isBackedOff, setBackoff, stateKey, type RunStats } from "./state.js";

interface GitHubRelease {
  tag_name?: string | null;
  name?: string | null;
  html_url?: string | null;
  published_at?: string | null;
}

export interface ReleaseRecord {
  etag: string | null;
  /** Tag from the last 200 response. */
  tag: string | null;
  /** Tag for which a release-intake card was actually created (never set in dry-run). */
  createdTag: string | null;
  checkedAt: string;
}

export type ReleaseMap = Record<string, ReleaseRecord>;

export interface ReleaseDeps {
  fetchImpl: FetchLike;
  now?: () => number;
}

export interface ReleaseOutcome {
  repo: string;
  status: "not-modified" | "created" | "would-create" | "already-created" | "skipped-backoff" | "error";
  tag: string | null;
  detail?: string;
}

/**
 * Scan each configured release repo. A 304 means do nothing. A new tag
 * creates exactly one release-intake card, deduped by state (`createdTag`)
 * plus a pre-create lookup by originKind/originId (covers state loss).
 * Concurrent duplicate creation is left to the host's per-job serialization.
 */
export async function runReleaseScan(
  ctx: PluginContext,
  companyId: string,
  config: UpstreamConfig,
  deps: ReleaseDeps,
): Promise<{ outcomes: ReleaseOutcome[]; stats: RunStats }> {
  const now = deps.now ?? Date.now;
  const stats: RunStats = { at: new Date(now()).toISOString(), job: "release-scan", ok200: 0, notModified304: 0, errors: 0, wakes: 0, creates: 0 };
  const outcomes: ReleaseOutcome[] = [];

  const stored = (await ctx.state.get(stateKey(companyId, "releases")) as ReleaseMap | null) ?? {};
  const next: ReleaseMap = { ...stored };
  const token = await resolveToken(ctx, companyId, config);

  for (const repo of config.releaseRepos) {
    const parts = repo.split("/");
    const [owner, name] = parts;
    if (!owner || !name || parts.length !== 2) {
      stats.errors += 1;
      outcomes.push({ repo, status: "error", tag: null, detail: "not an owner/repo pair" });
      continue;
    }
    const key = repoKey(owner, name);
    if (await isBackedOff(ctx, companyId, now())) {
      outcomes.push({ repo: key, status: "skipped-backoff", tag: next[key]?.tag ?? null });
      continue;
    }
    const previous = next[key] ?? null;
    try {
      const url = `${GITHUB_API_BASE}/repos/${owner}/${name}/releases/latest`;
      const result = await githubGet<GitHubRelease>(deps.fetchImpl, token, url, previous?.etag ?? null);
      if (result.rateLimited) {
        stats.errors += 1;
        await setBackoff(ctx, companyId, now() + backoffDelayMs(result, now()));
        outcomes.push({ repo: key, status: "skipped-backoff", tag: previous?.tag ?? null, detail: `rate limited (HTTP ${result.status})` });
        continue;
      }
      if (result.notModified) {
        stats.notModified304 += 1;
        const record: ReleaseRecord = {
          etag: previous?.etag ?? null,
          tag: previous?.tag ?? null,
          createdTag: previous?.createdTag ?? null,
          checkedAt: stats.at,
        };
        next[key] = record;
        // A dry-run (or a crashed run) may have stored the tag without ever
        // creating the card. The 304 carries no body, so refetch once without
        // an ETag to build the card from real data.
        if (!config.dryRun && record.tag && record.tag !== record.createdTag) {
          const outcome = await ensureReleaseCard(ctx, companyId, config, stats, owner, name, previous?.tag ?? null, record, null, deps.fetchImpl, token, url);
          outcomes.push(outcome);
        } else {
          outcomes.push({ repo: key, status: "not-modified", tag: record.tag });
        }
        continue;
      }
      if (result.status !== 200 || !result.data) {
        stats.errors += 1;
        outcomes.push({ repo: key, status: "error", tag: previous?.tag ?? null, detail: `HTTP ${result.status}` });
        continue;
      }
      stats.ok200 += 1;
      const tag = typeof result.data.tag_name === "string" && result.data.tag_name.length > 0 ? result.data.tag_name : null;
      if (!tag) {
        stats.errors += 1;
        outcomes.push({ repo: key, status: "error", tag: null, detail: "latest release has no tag_name" });
        continue;
      }
      const record: ReleaseRecord = { etag: result.etag, tag, createdTag: previous?.createdTag ?? null, checkedAt: stats.at };
      next[key] = record;
      outcomes.push(await ensureReleaseCard(ctx, companyId, config, stats, owner, name, previous?.tag ?? null, record, result.data, deps.fetchImpl, token, url));
    } catch (err) {
      stats.errors += 1;
      outcomes.push({ repo: key, status: "error", tag: previous?.tag ?? null, detail: String(err) });
    }
  }

  await ctx.state.set(stateKey(companyId, "releases"), next);
  return { outcomes, stats };
}

/** Create the intake card for `record.tag` unless one already exists. Never duplicates. */
async function ensureReleaseCard(
  ctx: PluginContext,
  companyId: string,
  config: UpstreamConfig,
  stats: RunStats,
  owner: string,
  repo: string,
  previousTag: string | null,
  record: ReleaseRecord,
  release: GitHubRelease | null,
  fetchImpl: FetchLike,
  token: string,
  url: string,
): Promise<ReleaseOutcome> {
  const key = repoKey(owner, repo);
  const tag = record.tag;
  if (!tag) return { repo: key, status: "error", tag, detail: "no tag recorded" };
  const originId = releaseKey(owner, repo, tag);
  if (record.createdTag === tag) return { repo: key, status: "already-created", tag };
  if (config.dryRun) {
    return { repo: key, status: "would-create", tag, detail: `would create card originId ${originId}` };
  }
  let body: GitHubRelease | null = release;
  if (!body) {
    const fresh = await githubGet<GitHubRelease>(fetchImpl, token, url, null);
    if (fresh.status !== 200 || !fresh.data) {
      stats.errors += 1;
      return { repo: key, status: "error", tag, detail: `refetch HTTP ${fresh.status}` };
    }
    stats.ok200 += 1;
    body = fresh.data;
    record.etag = fresh.etag;
  }
  const existing = await ctx.issues.list({ companyId, originKind: RELEASE_ORIGIN_KIND, originId });
  if (existing.length > 0) {
    record.createdTag = tag;
    return { repo: key, status: "already-created", tag, detail: `card ${existing[0].identifier ?? existing[0].id} already exists` };
  }
  await createReleaseCard(ctx, companyId, config, owner, repo, tag, body, previousTag);
  record.createdTag = tag;
  stats.creates += 1;
  return { repo: key, status: "created", tag };
}

async function resolveToken(ctx: PluginContext, companyId: string, config: UpstreamConfig): Promise<string> {
  if (!config.tokenSecretRef) return "";
  return ctx.secrets.resolve(config.tokenSecretRef as string, { companyId });
}

export function releaseCardBody(params: {
  owner: string;
  repo: string;
  tag: string;
  releaseUrl: string | null;
  publishedAt: string | null;
  compareBase: string | null;
  previousTag: string | null;
}): string {
  const key = releaseKey(params.owner, params.repo, params.tag);
  const lines = [
    `Upstream release [${key}](${params.releaseUrl ?? `https://github.com/${params.owner}/${params.repo}/releases/tag/${params.tag}`}) published ${params.publishedAt ?? "at an unknown time"}.`,
    "",
  ];
  if (params.releaseUrl) lines.push(`- Release: ${params.releaseUrl}`);
  if (params.compareBase) {
    lines.push(
      `- Changes since our base (\`${params.compareBase}\`): https://github.com/${params.owner}/${params.repo}/compare/${params.compareBase}...${params.tag}`,
    );
  } else {
    lines.push(
      `- Changes: see the release notes above (no recorded base yet; set \`compareBases.${params.owner}/${params.repo}\` in plugin config${params.previousTag ? `; previous seen tag was \`${params.previousTag}\`` : ""}).`,
    );
  }
  lines.push(
    "- Follow the `release-intake` company skill: research the notes, rebase carried patches by content, build and test, then raise the install confirmation.",
    "",
    "Synced by togetherweown.github-upstream; this card was created because the tag is new.",
  );
  return lines.join("\n");
}

async function createReleaseCard(
  ctx: PluginContext,
  companyId: string,
  config: UpstreamConfig,
  owner: string,
  repo: string,
  tag: string,
  release: GitHubRelease | null,
  previousTag: string | null,
): Promise<void> {
  const originId = releaseKey(owner, repo, tag);
  const releaseUrl = typeof release?.html_url === "string" ? release.html_url : null;
  const publishedAt = typeof release?.published_at === "string" ? release.published_at : null;
  const body = releaseCardBody({
    owner,
    repo,
    tag,
    releaseUrl,
    publishedAt,
    compareBase: config.compareBases[`${owner}/${repo}`] ?? null,
    previousTag,
  });
  await ctx.issues.create({
    companyId,
    ...(config.releaseIntakeProjectId ? { projectId: config.releaseIntakeProjectId } : {}),
    title: `Upstream release ${originId} — intake`,
    description: body,
    assigneeAgentId: config.releaseIntakeAssigneeAgentId,
    originKind: RELEASE_ORIGIN_KIND,
    originId,
  });
}
