/**
 * Deterministic GitHub HTTP layer. Every read is ETag-conditional where the
 * API supports it; an unchanged answer is a 304 that costs nothing. The base
 * URL is allow-listed to api.github.com, so this client structurally cannot
 * reach any other management API.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const GITHUB_API_BASE = "https://api.github.com";
export const USER_AGENT = "Paperclip-github-upstream/0.1.0 (+https://github.com/TogetherWeOwn/paperclip-plugin-github-upstream)";

export interface GitHubResult<T> {
  /** Raw HTTP status. */
  status: number;
  /** True when the response was 304: the caller's cached copy is still current. */
  notModified: boolean;
  /** Response ETag header, if any. */
  etag: string | null;
  /** Parsed body, or null on 304 / empty / unparseable bodies. */
  data: T | null;
  /** Remaining rate-limit budget, if the response says. */
  rateRemaining: number | null;
  /** Rate-limit reset as epoch seconds, if the response says. */
  rateResetAt: number | null;
  /** Retry-After as milliseconds, if the response says. */
  retryAfterMs: number | null;
  /** True when the response signals rate limiting (429, or 403 with no budget left). */
  rateLimited: boolean;
}

const firstHeader = (headers: Headers, name: string): string | null => {
  const value = headers.get(name);
  return value && value.length > 0 ? value : null;
};

const toInt = (value: string | null): number | null => {
  if (value === null) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
};

function assertAllowedUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`github: refusing to fetch unparseable URL`);
  }
  if (parsed.origin !== GITHUB_API_BASE) {
    throw new Error(`github: refusing to fetch outside ${GITHUB_API_BASE}`);
  }
}

async function parseJson<T>(res: Response): Promise<T | null> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function toResult<T>(res: Response, data: T | null, etag: string | null): GitHubResult<T> {
  const remaining = toInt(firstHeader(res.headers, "x-ratelimit-remaining"));
  const resetAt = toInt(firstHeader(res.headers, "x-ratelimit-reset"));
  const retryAfterSec = toInt(firstHeader(res.headers, "retry-after"));
  const rateLimited =
    res.status === 429 || (res.status === 403 && (remaining === 0 || firstHeader(res.headers, "x-ratelimit-used") !== null));
  return {
    status: res.status,
    notModified: res.status === 304,
    etag,
    data,
    rateRemaining: remaining,
    rateResetAt: resetAt,
    retryAfterMs: retryAfterSec !== null ? retryAfterSec * 1000 : null,
    rateLimited,
  };
}

/**
 * ETag-conditional GET. `etag` may be null (unconditional). The token is sent
 * as a Bearer header and never logged. Throws only on network failure or a
 * disallowed URL; HTTP error statuses are returned for the caller to record.
 */
export async function githubGet<T>(
  fetchImpl: FetchLike,
  token: string,
  url: string,
  etag: string | null,
): Promise<GitHubResult<T>> {
  assertAllowedUrl(url);
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (etag) headers["If-None-Match"] = etag;
  const res = await fetchImpl(url, { method: "GET", headers });
  if (res.status === 304) return toResult<T>(res, null, etag);
  return toResult<T>(res, await parseJson<T>(res), firstHeader(res.headers, "etag"));
}

/** GraphQL POST for discussions (the GraphQL API has no 304 path). */
export async function githubGraphql<T>(
  fetchImpl: FetchLike,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ data: T | null; errors: Array<{ message: string }> | null; status: number }> {
  assertAllowedUrl(`${GITHUB_API_BASE}/graphql`);
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchImpl(`${GITHUB_API_BASE}/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const body = await parseJson<{ data?: T | null; errors?: Array<{ message: string }> }>(res);
  return { data: body?.data ?? null, errors: body?.errors ?? null, status: res.status };
}

/** Compute how long to back off after a rate-limited response. */
export function backoffDelayMs(result: Pick<GitHubResult<unknown>, "retryAfterMs" | "rateResetAt">, nowMs = Date.now()): number {
  if (result.retryAfterMs !== null && result.retryAfterMs >= 0) return result.retryAfterMs + 1000;
  if (result.rateResetAt !== null) {
    const wait = result.rateResetAt * 1000 - nowMs + 1000;
    if (wait > 0) return Math.min(wait, 60 * 60 * 1000);
  }
  return 60 * 1000;
}
