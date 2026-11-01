/**
 * GitHub App authentication for the upstream reader.
 *
 * The plugin holds no long-lived credential: on each scan it signs a short
 * RS256 JWT from the App private key (held as a company secret, resolved at
 * call time), exchanges it for a 1-hour installation token, and uses that
 * token for every REST/GraphQL read. The installation token lives in process
 * memory only, and is refreshed 5 minutes before `expires_at`.
 *
 * The JWT and the token are never logged and never written to plugin state.
 * The only outbound host is `api.github.com` (via {@link GITHUB_API_BASE});
 * the installation ID is digits-only so config text can never steer the mint
 * URL anywhere else.
 */

import { createHash, createSign } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { GITHUB_API_BASE, USER_AGENT, type FetchLike } from "./github.js";
import { GITHUB_NUMERIC_ID_RE, validateAuthConfig, type UpstreamConfig } from "./config.js";

const b64url = (input: string | Buffer): string =>
  (typeof input === "string" ? Buffer.from(input, "utf8") : input).toString("base64url");

export interface AppIdentity {
  appId: string;
  installationId: string;
  /** PEM-encoded RSA private key, resolved from the company secret at call time. */
  privateKeyPem: string;
}

/**
 * Sign the App JWT: RS256, `iss` = appId, `iat` 60s in the past (clock skew),
 * `exp` 10 minutes after `iat` (well inside GitHub's 10-minute ceiling).
 * Throws on a malformed key: callers fail closed, creating and waking nothing.
 */
export function buildAppJwt(identity: Pick<AppIdentity, "appId" | "privateKeyPem">, nowSec = Math.floor(Date.now() / 1000)): string {
  if (!GITHUB_NUMERIC_ID_RE.test(identity.appId)) {
    throw new Error("invalid GitHub App auth: appId must be the numeric App ID");
  }
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const iat = nowSec - 60;
  const payload = b64url(JSON.stringify({ iat, exp: iat + 600, iss: identity.appId }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  // Throws when the PEM does not parse: the scan fails closed, no cards.
  const signature = signer.sign(identity.privateKeyPem).toString("base64url");
  return `${signingInput}.${signature}`;
}

interface MintResult {
  token: string;
  expiresAtMs: number;
}

/**
 * Exchange the App JWT for an installation token. The request carries an
 * empty `permissions` subset: the App has no repository permissions, and
 * public metadata reads need none. Throws on any non-2xx response or an
 * unparseable body.
 */
export async function mintInstallationToken(
  fetchImpl: FetchLike,
  identity: AppIdentity,
  nowMs = Date.now(),
): Promise<MintResult> {
  if (!GITHUB_NUMERIC_ID_RE.test(identity.installationId)) {
    throw new Error("invalid GitHub App auth: installationId must be the numeric installation ID");
  }
  const jwt = buildAppJwt(identity, Math.floor(nowMs / 1000));
  const url = `${GITHUB_API_BASE}/app/installations/${identity.installationId}/access_tokens`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ permissions: {} }),
      redirect: "error",
    });
  } finally {
    // The JWT lives only in this frame: nothing to scrub beyond not storing it.
  }
  if (!res.ok) {
    throw new Error(`GitHub App token mint failed: HTTP ${res.status}`);
  }
  let body: unknown = null;
  try {
    body = JSON.parse(await res.text());
  } catch {
    body = null;
  }
  const token = typeof (body as { token?: unknown } | null)?.token === "string"
    ? (body as { token: string }).token
    : "";
  const expiresAt = typeof (body as { expires_at?: unknown } | null)?.expires_at === "string"
    ? (body as { expires_at: string }).expires_at
    : "";
  const expiresAtMs = Date.parse(expiresAt);
  if (!token || !Number.isFinite(expiresAtMs)) {
    throw new Error("GitHub App token mint failed: response carries no token/expiry");
  }
  return { token, expiresAtMs };
}

/** Refresh 5 minutes before expiry, so a slow tick never runs on a dead token. */
export const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

const cacheKeyOf = (identity: AppIdentity): string => {
  const keyHash = createHash("sha256").update(identity.privateKeyPem, "utf8").digest("hex").slice(0, 16);
  return `${identity.appId}:${identity.installationId}:${keyHash}`;
};

/** Process-memory-only token cache. Never persisted, never logged. */
const tokenCache = new Map<string, MintResult>();

/** Drop the in-memory token cache. Used by tests; the worker never calls it. */
export function clearGithubAppTokenCache(): void {
  tokenCache.clear();
}

/**
 * Return a live installation token, minting (and caching) when the cached one
 * is missing or within 5 minutes of expiry.
 */
export async function getInstallationToken(
  fetchImpl: FetchLike,
  identity: AppIdentity,
  nowMs = Date.now(),
): Promise<string> {
  const key = cacheKeyOf(identity);
  const cached = tokenCache.get(key);
  if (cached && nowMs < cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS) return cached.token;
  const fresh = await mintInstallationToken(fetchImpl, identity, nowMs);
  tokenCache.set(key, fresh);
  return fresh.token;
}

/**
 * Resolve the GitHub credential for a scan. Exactly one auth mode must be
 * configured (see {@link validateAuthConfig}): either the PAT binding or the
 * GitHub App triple. Throws on any misconfiguration or mint failure, and
 * callers record an error without ever falling back to an anonymous scan.
 * Secret values are resolved at call time and never cached beyond the
 * in-memory installation token above.
 */
export async function resolveAuthToken(
  ctx: PluginContext,
  companyId: string,
  config: UpstreamConfig,
  fetchImpl: FetchLike,
  nowMs = Date.now(),
): Promise<string> {
  const invalid = validateAuthConfig(config);
  if (invalid) throw new Error(invalid);
  if (config.tokenSecretRef) {
    try {
      const token = await ctx.secrets.resolve(config.tokenSecretRef, { companyId });
      // An empty credential must fail closed: the HTTP layer omits
      // Authorization for falsy tokens, which would silently scan anonymously.
      if (!token || token.trim().length === 0) {
        throw new Error("tokenSecretRef resolved to an empty credential: refusing unauthenticated scan");
      }
      return token;
    } catch (err) {
      throw new Error(`tokenSecretRef does not resolve: ${String(err)}`);
    }
  }
  if (!config.appPrivateKeySecretRef) throw new Error("incomplete GitHub App auth: missing appPrivateKeySecretRef");
  let privateKeyPem: string;
  try {
    privateKeyPem = await ctx.secrets.resolve(config.appPrivateKeySecretRef, { companyId });
  } catch (err) {
    throw new Error(`appPrivateKeySecretRef does not resolve: ${String(err)}`);
  }
  if (!privateKeyPem || privateKeyPem.trim().length === 0) {
    throw new Error("appPrivateKeySecretRef resolved to an empty credential: refusing unauthenticated scan");
  }
  return getInstallationToken(fetchImpl, {
    appId: config.appId,
    installationId: config.installationId,
    privateKeyPem,
  }, nowMs);
}
