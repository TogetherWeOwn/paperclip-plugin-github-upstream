import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { ITEM_ORIGIN_KIND, RELEASE_ORIGIN_KIND } from "./manifest.js";
import plugin from "./plugin.js";
import { resolveConfig, validateAuthConfig } from "./config.js";
import { GITHUB_API_BASE } from "./github.js";
import {
  buildAppJwt,
  clearGithubAppTokenCache,
  getInstallationToken,
  mintInstallationToken,
  resolveAuthToken,
  type AppIdentity,
} from "./github-app.js";
import { runReleaseScan } from "./releases.js";
import { runItemScan } from "./items.js";

const COMPANY = "c-1";
const APP_ID = "123456";
const INSTALLATION_ID = "789012";
const KEY_REF = { type: "secret_ref", secretId: "app-private-key" };
const TOKEN_REF = { type: "secret_ref", secretId: "test-token" };

let privateKeyPem = "";
let otherPrivateKeyPem = "";
let publicKeyPem = "";

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  privateKeyPem = pair.privateKey;
  publicKeyPem = pair.publicKey;
  otherPrivateKeyPem = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).privateKey;
});

beforeEach(() => {
  clearGithubAppTokenCache();
});

const identity = (extra: Partial<AppIdentity> = {}): AppIdentity => ({
  appId: APP_ID,
  installationId: INSTALLATION_ID,
  privateKeyPem,
  ...extra,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

interface MintCall {
  url: string;
  init: RequestInit;
}

function mintStub(token: string, expiresAt: string, calls: MintCall[], status = 200) {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    if (status !== 200) return new Response("denied", { status });
    return json({ token, expires_at: expiresAt });
  }) as (url: string, init?: RequestInit) => Promise<Response>;
}

const decodeJwt = (jwt: string) => {
  const [header, payload, signature] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>,
    signingInput: `${header}.${payload}`,
    signature,
  };
};

describe("validateAuthConfig", () => {
  it("accepts PAT-only and full App auth, rejects anything else", () => {
    const patOnly = resolveConfig({ tokenSecretRef: TOKEN_REF });
    expect(validateAuthConfig(patOnly)).toBeNull();

    const appFull = resolveConfig({ appId: APP_ID, installationId: INSTALLATION_ID, appPrivateKeySecretRef: KEY_REF });
    expect(validateAuthConfig(appFull)).toBeNull();

    // Numeric IDs passed as numbers are stringified and accepted.
    const appNumeric = resolveConfig({ appId: 123456, installationId: 789012, appPrivateKeySecretRef: KEY_REF });
    expect(appNumeric.appId).toBe("123456");
    expect(validateAuthConfig(appNumeric)).toBeNull();

    expect(validateAuthConfig(resolveConfig({}))).toMatch(/no GitHub auth/);

    expect(
      validateAuthConfig(resolveConfig({ tokenSecretRef: TOKEN_REF, appId: APP_ID, installationId: INSTALLATION_ID, appPrivateKeySecretRef: KEY_REF })),
    ).toMatch(/exactly one auth mode/);

    // A partial App triple fails closed with the missing fields named.
    expect(validateAuthConfig(resolveConfig({ appId: APP_ID }))).toMatch(/missing installationId, appPrivateKeySecretRef/);
    expect(validateAuthConfig(resolveConfig({ installationId: INSTALLATION_ID, appPrivateKeySecretRef: KEY_REF }))).toMatch(/missing appId/);

    // Malformed IDs fail closed instead of steering the mint URL.
    expect(
      validateAuthConfig(resolveConfig({ appId: "abc", installationId: INSTALLATION_ID, appPrivateKeySecretRef: KEY_REF })),
    ).toMatch(/appId must be the numeric App ID/);
    expect(
      validateAuthConfig(resolveConfig({ appId: APP_ID, installationId: "install/1", appPrivateKeySecretRef: KEY_REF })),
    ).toMatch(/installationId must be the numeric installation ID/);
  });

  it("treats a string tokenSecretRef as unset (fails closed)", () => {
    const config = resolveConfig({ tokenSecretRef: "secret-id-as-string" });
    expect(config.tokenSecretRef).toBeNull();
    expect(validateAuthConfig(config)).toMatch(/no GitHub auth/);
  });
});

describe("buildAppJwt", () => {
  it("signs RS256 claims iss/iat/exp with a 10-minute lifetime", () => {
    const nowSec = 1794000000;
    const jwt = buildAppJwt({ appId: APP_ID, privateKeyPem }, nowSec);
    const { header, payload, signingInput, signature } = decodeJwt(jwt);
    expect(header).toMatchObject({ alg: "RS256", typ: "JWT" });
    expect(payload.iss).toBe(APP_ID);
    expect(payload.iat).toBe(nowSec - 60);
    expect(payload.exp).toBe(nowSec - 60 + 600);
    expect((payload.exp as number) - (payload.iat as number)).toBe(600);
    const verifier = createVerify("RSA-SHA256");
    verifier.update(signingInput);
    verifier.end();
    expect(verifier.verify(publicKeyPem, signature, "base64url")).toBe(true);
  });

  it("throws on a malformed private key (callers fail closed)", () => {
    expect(() => buildAppJwt({ appId: APP_ID, privateKeyPem: "not-a-pem" })).toThrow();
  });

  it("throws on a non-numeric appId", () => {
    expect(() => buildAppJwt({ appId: "owner/app", privateKeyPem })).toThrow(/numeric App ID/);
  });
});

describe("mintInstallationToken", () => {
  it("POSTs the JWT to the digits-only mint URL with an empty permissions subset", async () => {
    const calls: MintCall[] = [];
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const fetchImpl = mintStub("inst-token-1", expiresAt, calls);
    const { token, expiresAtMs } = await mintInstallationToken(fetchImpl, identity());
    expect(token).toBe("inst-token-1");
    expect(expiresAtMs).toBe(Date.parse(expiresAt));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${GITHUB_API_BASE}/app/installations/${INSTALLATION_ID}/access_tokens`);
    // The installation ID is digits-only, so config text can never steer this URL off-host.
    expect(new URL(calls[0].url).origin).toBe(GITHUB_API_BASE);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.redirect).toBe("error");
    expect(calls[0].init.body).toBe(JSON.stringify({ permissions: {} }));
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("Authorization")).toMatch(/^Bearer eyJ/);
  });

  it("throws on a non-2xx mint response or a body with no token/expiry", async () => {
    const calls: MintCall[] = [];
    await expect(mintInstallationToken(mintStub("x", new Date().toISOString(), calls, 401), identity())).rejects.toThrow(
      /HTTP 401/,
    );
    const badBody = (async () => json({ token: "", expires_at: "n/a" })) as (url: string, init?: RequestInit) => Promise<Response>;
    await expect(mintInstallationToken(badBody, identity())).rejects.toThrow(/no token\/expiry/);
  });

  it("refuses a non-numeric installationId without calling fetch", async () => {
    let fetched = false;
    const guard = (async () => {
      fetched = true;
      return new Response("unreachable", { status: 500 });
    }) as (url: string, init?: RequestInit) => Promise<Response>;
    await expect(mintInstallationToken(guard, identity({ installationId: "org/1" }))).rejects.toThrow(
      /numeric installation ID/,
    );
    expect(fetched).toBe(false);
  });
});

describe("getInstallationToken cache", () => {
  const expiresAt = (nowMs: number) => new Date(nowMs + 3600_000).toISOString();

  it("mints once for repeated calls", async () => {
    const calls: MintCall[] = [];
    const nowMs = Date.now();
    const fetchImpl = mintStub("cached-1", expiresAt(nowMs), calls);
    expect(await getInstallationToken(fetchImpl, identity(), nowMs)).toBe("cached-1");
    expect(await getInstallationToken(fetchImpl, identity(), nowMs + 60_000)).toBe("cached-1");
    expect(calls).toHaveLength(1);
  });

  it("refreshes within 5 minutes of expiry", async () => {
    const calls: MintCall[] = [];
    const nowMs = Date.now();
    let n = 0;
    const rotating = (async () => {
      n += 1;
      calls.push({ url: "mint", init: {} });
      return json({ token: `token-${n}`, expires_at: expiresAt(nowMs) });
    }) as (url: string, init?: RequestInit) => Promise<Response>;
    expect(await getInstallationToken(rotating, identity(), nowMs)).toBe("token-1");
    // 50 minutes in: still live, no refresh.
    expect(await getInstallationToken(rotating, identity(), nowMs + 50 * 60_000)).toBe("token-1");
    expect(calls).toHaveLength(1);
    // 56 minutes in (4 left): refreshes.
    expect(await getInstallationToken(rotating, identity(), nowMs + 56 * 60_000)).toBe("token-2");
    expect(calls).toHaveLength(2);
  });

  it("keys the cache on the private key: a rotated key re-mints", async () => {
    const calls: MintCall[] = [];
    const nowMs = Date.now();
    const fetchImpl = mintStub("k", expiresAt(nowMs), calls);
    await getInstallationToken(fetchImpl, identity(), nowMs);
    await getInstallationToken(fetchImpl, identity({ privateKeyPem: otherPrivateKeyPem }), nowMs);
    expect(calls).toHaveLength(2);
  });
});

describe("resolveAuthToken + scans in App mode", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = createTestHarness({ manifest, config: {} });
    harness.seed({ companies: [{ id: COMPANY, name: "TWO", issuePrefix: "TWO" } as never] });
    await plugin.definition.setup(harness.ctx);
    // The harness stub resolves any ref to `resolved:...`; App mode needs a
    // real PEM so the JWT actually signs in these tests.
    harness.ctx.secrets.resolve = (async () => privateKeyPem) as typeof harness.ctx.secrets.resolve;
  });

  const appConfig = (extra: Record<string, unknown> = {}) =>
    resolveConfig({
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      appPrivateKeySecretRef: KEY_REF,
      releaseRepos: ["router-for-me/CLIProxyAPI"],
      compareBases: { "router-for-me/CLIProxyAPI": "v8.0.50" },
      ...extra,
    });

  it("uses the minted installation token for every release read", async () => {
    const authHeaders: Array<string | null> = [];
    const mintCalls: MintCall[] = [];
    const tag = { tag_name: "v8.0.51", name: "v8.0.51", html_url: "https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.51", published_at: "2026-11-01T00:00:00Z" };
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.includes("/app/installations/")) {
        mintCalls.push({ url, init: init ?? {} });
        return json({ token: "inst-token-1", expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      authHeaders.push(new Headers(init?.headers).get("Authorization"));
      return new Response(JSON.stringify(tag), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"r1"' },
      });
    }) as (url: string, init?: RequestInit) => Promise<Response>;

    const { outcomes, stats } = await runReleaseScan(harness.ctx, COMPANY, appConfig(), { fetchImpl });
    expect(outcomes).toEqual([{ repo: "router-for-me/cliproxyapi", status: "created", tag: "v8.0.51" }]);
    expect(stats.creates).toBe(1);
    expect(mintCalls).toHaveLength(1);
    expect(authHeaders.length).toBeGreaterThan(0);
    for (const header of authHeaders) expect(header).toBe("Bearer inst-token-1");
  });

  it("uses the minted token for item reads too", async () => {
    const tracker = await harness.ctx.issues.create({ companyId: COMPANY, title: "tracker" });
    await harness.ctx.issues.create({
      companyId: COMPANY,
      parentId: tracker.id,
      title: "child",
      assigneeAgentId: "7b8f576c-ebce-447f-a904-dda322df4220",
      originKind: ITEM_ORIGIN_KIND,
      originId: "paperclipai/paperclip#9",
    });
    const authHeaders: Array<string | null> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.includes("/app/installations/")) {
        return json({ token: "inst-token-9", expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      authHeaders.push(new Headers(init?.headers).get("Authorization"));
      if (url.endsWith("/issues/9")) {
        return new Response(
          JSON.stringify({ number: 9, title: "t", state: "open", updated_at: "2026-11-01T00:00:00Z", comments: 1, html_url: "https://github.com/paperclipai/paperclip/issues/9", user: { login: "x" } }),
          { status: 200, headers: { "content-type": "application/json", etag: '"i9"' } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as (url: string, init?: RequestInit) => Promise<Response>;

    const config = resolveConfig({
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      appPrivateKeySecretRef: KEY_REF,
      followThroughTrackerIssueId: tracker.id,
    });
    const result = await runItemScan(harness.ctx, COMPANY, config, { fetchImpl });
    // The bare originId guesses PR and self-corrects to issue via one 404
    // probe (counted as an error); the scan itself must not error out.
    expect(result.outcomes.map((o) => o.status)).not.toContain("error");
    expect(authHeaders.length).toBeGreaterThan(0);
    for (const header of authHeaders) expect(header).toBe("Bearer inst-token-9");
  });

  it("a bad private key fails closed: error outcome, no cards, no API reads", async () => {
    harness.ctx.secrets.resolve = (async () => "not-a-pem") as typeof harness.ctx.secrets.resolve;
    let fetched = false;
    const guard = (async () => {
      fetched = true;
      return new Response("unreachable", { status: 500 });
    }) as (url: string, init?: RequestInit) => Promise<Response>;
    // The JWT cannot even be signed, so the mint POST never goes out either.
    const { outcomes, stats } = await runReleaseScan(harness.ctx, COMPANY, appConfig(), { fetchImpl: guard });
    expect(stats.errors).toBe(1);
    expect(outcomes[0].status).toBe("error");
    expect(outcomes[0].detail).toMatch(/refusing unauthenticated scan/);
    expect(fetched).toBe(false);
    expect(await harness.ctx.issues.list({ companyId: COMPANY, originKind: RELEASE_ORIGIN_KIND })).toHaveLength(0);
  });

  it("configuring both auth modes fails the scan without any fetch", async () => {
    let fetched = false;
    const guard = (async () => {
      fetched = true;
      return new Response("unreachable", { status: 500 });
    }) as (url: string, init?: RequestInit) => Promise<Response>;
    const config = resolveConfig({ tokenSecretRef: TOKEN_REF, appId: APP_ID, installationId: INSTALLATION_ID, appPrivateKeySecretRef: KEY_REF });
    const { outcomes } = await runReleaseScan(harness.ctx, COMPANY, config, { fetchImpl: guard });
    expect(outcomes[0].status).toBe("error");
    expect(outcomes[0].detail).toMatch(/exactly one auth mode/);
    expect(fetched).toBe(false);
  });

  it("never persists the JWT or the installation token in plugin state", async () => {
    let seenJwt = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.includes("/app/installations/")) {
        seenJwt = new Headers(init?.headers).get("Authorization") ?? "";
        return json({ token: "inst-token-state-probe", expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      return new Response(
        JSON.stringify({ tag_name: "v8.0.51", name: "v8.0.51", html_url: "https://github.com/r/C/releases/tag/v8.0.51", published_at: "2026-11-01T00:00:00Z" }),
        { status: 200, headers: { "content-type": "application/json", etag: '"rs"' } },
      );
    }) as (url: string, init?: RequestInit) => Promise<Response>;
    await runReleaseScan(harness.ctx, COMPANY, appConfig(), { fetchImpl });
    expect(seenJwt).toMatch(/^Bearer eyJ/);
    const releases = harness.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: "releases" });
    const dump = JSON.stringify(releases);
    expect(dump).not.toContain("inst-token-state-probe");
    expect(dump).not.toContain(seenJwt.replace(/^Bearer /, ""));
  });

  it("an empty resolved PAT fails closed instead of scanning anonymously", async () => {
    harness.ctx.secrets.resolve = (async () => "  ") as typeof harness.ctx.secrets.resolve;
    let fetched = false;
    const guard = (async () => {
      fetched = true;
      return new Response("public data", { status: 200, headers: { "content-type": "application/json" } });
    }) as (url: string, init?: RequestInit) => Promise<Response>;
    const { outcomes, stats } = await runReleaseScan(
      harness.ctx,
      COMPANY,
      resolveConfig({ tokenSecretRef: TOKEN_REF, releaseRepos: ["router-for-me/CLIProxyAPI"] }),
      { fetchImpl: guard },
    );
    expect(stats.errors).toBe(1);
    expect(outcomes[0].status).toBe("error");
    expect(outcomes[0].detail).toMatch(/refusing unauthenticated scan/);
    expect(fetched).toBe(false);
  });

  it("an empty resolved App private key fails closed too", async () => {
    harness.ctx.secrets.resolve = (async () => "") as typeof harness.ctx.secrets.resolve;
    let fetched = false;
    const guard = (async () => {
      fetched = true;
      return new Response("unreachable", { status: 500 });
    }) as (url: string, init?: RequestInit) => Promise<Response>;
    const { outcomes } = await runReleaseScan(harness.ctx, COMPANY, appConfig(), { fetchImpl: guard });
    expect(outcomes[0].status).toBe("error");
    expect(outcomes[0].detail).toMatch(/refusing unauthenticated scan/);
    expect(fetched).toBe(false);
  });

  it("PAT mode still resolves through the secrets stub", async () => {
    const token = await resolveAuthToken(
      harness.ctx,
      COMPANY,
      resolveConfig({ tokenSecretRef: TOKEN_REF }),
      (async () => new Response("unused", { status: 500 })) as (url: string, init?: RequestInit) => Promise<Response>,
    );
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });
});
