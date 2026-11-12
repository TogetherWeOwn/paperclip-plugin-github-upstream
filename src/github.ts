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
  /**
   * True when the response signals rate limiting: a 429, a 403 with no budget
   * left, or a 403 that carries an explicit Retry-After. GitHub sends
   * `x-ratelimit-used` on every response, so a bare 403 (no access, deleted
   * repo) must NOT back off the whole company.
   */
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
    res.status === 429 || (res.status === 403 && (remaining === 0 || retryAfterSec !== null));
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
 * Shim for paperclipai/paperclip#13084. The plugin SDK's worker `http.fetch`
 * rebuilds the host reply as `new Response(result.body, {status, ...})`, and
 * the host serializes a 304's empty body as `""`. A non-null body on a
 * null-body status makes that constructor throw this TypeError, so every
 * genuine 304 reaches the plugin as an exception. Only this exact failure on a
 * conditional request is mapped back to not-modified; 204/205, unconditional
 * requests and every other TypeError still throw. The rebuilt reply's headers
 * (rate-limit hints) are lost with it.
 * REMOVE once the installed SDK rebuilds null-body statuses with a null body
 * (open fix PRs paperclipai/paperclip#13133 / #17282).
 */
// Exact undici constructor message only: any other TypeError that merely mentions a 304 must stay an error.
const SDK_NULL_BODY_304 = /^Response constructor: Invalid response status code 304$/;
export const isSdkNullBody304 = (err: unknown): boolean =>
  err instanceof TypeError && SDK_NULL_BODY_304.test(err.message);

/**
 * ETag-conditional GET. `etag` may be null (unconditional). The token is sent
 * as a Bearer header and never logged. Redirects are refused outright so the
 * `Authorization` header can never follow one. Throws only on network failure
 * or a disallowed URL; HTTP error statuses are returned for the caller to record.
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
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", headers, redirect: "error" });
  } catch (err) {
    if (etag && isSdkNullBody304(err)) return toResult<T>(new Response(null, { status: 304 }), null, etag);
    throw err;
  }
  if (res.status === 304) return toResult<T>(res, null, etag);
  return toResult<T>(res, await parseJson<T>(res), firstHeader(res.headers, "etag"));
}

export interface GraphqlError {
  message: string;
  /** e.g. "RATE_LIMITED" on a 200 response that hit the secondary limit. */
  type?: string;
}

/** True when a GraphQL 200 carries a rate-limit error payload. */
export function isGraphqlRateLimited(errors: Array<GraphqlError> | null | undefined): boolean {
  return !!errors?.some((e) => e.type === "RATE_LIMITED");
}

/** GraphQL POST for discussions (the GraphQL API has no 304 path). */
export async function githubGraphql<T>(
  fetchImpl: FetchLike,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ data: T | null; errors: Array<GraphqlError> | null; status: number }> {
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
    redirect: "error",
  });
  const body = await parseJson<{ data?: T | null; errors?: Array<GraphqlError> }>(res);
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
