import { describe, expect, it } from "vitest";
import { GITHUB_API_BASE, githubGet, githubGraphql, isGraphqlRateLimited } from "./github.js";

const get = (status: number, headers: Record<string, string> = {}, body: unknown = { ok: true }) =>
  (async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })) as (
    url: string,
    init?: RequestInit,
  ) => Promise<Response>;

describe("githubGet rate-limit classification (F8)", () => {
  it("rate-limits on 429", async () => {
    const res = await githubGet(get(429, { "retry-after": "30" }), "t", `${GITHUB_API_BASE}/repos/a/b`, null);
    expect(res.rateLimited).toBe(true);
  });

  it("rate-limits on 403 only with zero budget left or an explicit retry-after", async () => {
    const exhausted = await githubGet(get(403, { "x-ratelimit-remaining": "0" }), "t", `${GITHUB_API_BASE}/repos/a/b`, null);
    expect(exhausted.rateLimited).toBe(true);

    const retryAfter = await githubGet(get(403, { "x-ratelimit-remaining": "59", "retry-after": "60" }), "t", `${GITHUB_API_BASE}/repos/a/b`, null);
    expect(retryAfter.rateLimited).toBe(true);
    expect(retryAfter.retryAfterMs).toBe(60_000);
  });

  it("does NOT rate-limit on a bare 403 with budget left (no access, deleted repo)", async () => {
    const res = await githubGet(get(403, { "x-ratelimit-remaining": "42", "x-ratelimit-used": "18" }), "t", `${GITHUB_API_BASE}/repos/a/b`, null);
    expect(res.status).toBe(403);
    expect(res.rateLimited).toBe(false);
  });
});

describe("redirect and origin pinning (F9)", () => {
  it("sends redirect:'error' on GETs so the token never follows a redirect", async () => {
    let redirect: string | undefined;
    const capture = (async (_url: string, init?: RequestInit) => {
      redirect = (init as { redirect?: string } | undefined)?.redirect;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as (url: string, init?: RequestInit) => Promise<Response>;
    await githubGet(capture, "t", `${GITHUB_API_BASE}/repos/a/b`, null);
    expect(redirect).toBe("error");
  });

  it("sends redirect:'error' on GraphQL POSTs too", async () => {
    let redirect: string | undefined;
    const capture = (async (_url: string, init?: RequestInit) => {
      redirect = (init as { redirect?: string } | undefined)?.redirect;
      return new Response(JSON.stringify({ data: null }), { status: 200, headers: { "content-type": "application/json" } });
    }) as (url: string, init?: RequestInit) => Promise<Response>;
    await githubGraphql(capture, "t", "query { x }", {});
    expect(redirect).toBe("error");
  });

  it("refuses URLs outside api.github.com", async () => {
    const guard = (async () => new Response("unreachable", { status: 500 })) as (
      url: string,
      init?: RequestInit,
    ) => Promise<Response>;
    await expect(githubGet(guard, "t", "https://api.github.com.evil.example/repos/a/b", null)).rejects.toThrow(
      /refusing to fetch outside/,
    );
  });
});

describe("isGraphqlRateLimited", () => {
  it("detects RATE_LIMITED error payloads on a 200", () => {
    expect(isGraphqlRateLimited([{ message: "slow down", type: "RATE_LIMITED" }])).toBe(true);
    expect(isGraphqlRateLimited([{ message: "boom" }])).toBe(false);
    expect(isGraphqlRateLimited(null)).toBe(false);
    expect(isGraphqlRateLimited([])).toBe(false);
  });
});
