import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateAuthConfig } from "./config.js";
import { runDryRun } from "./dryrun.js";

const json = (body: unknown, etag: string | null, status = 200) =>
  new Response(status === 304 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(etag ? { etag } : {}) },
  });

describe("dry-run", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("an App-mode config plus a CLI token runs token-backed instead of erroring", async () => {
    // A production config using GitHub App auth, carried by the dry-run CLI
    // with an explicit PAT: the CLI token wins and the App triple is cleared,
    // so the exactly-one-mode guard must not reject the run.
    const fetchStub = vi.fn(async (url: string) => {
      if (String(url).endsWith("/releases/latest")) {
        return json(
          {
            tag_name: "v8.0.51",
            name: "v8.0.51",
            html_url: "https://github.com/octo/Example/releases/tag/v8.0.51",
            published_at: "2026-11-01T00:00:00Z",
          },
          '"dry1"',
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchStub);

    const result = await runDryRun({
      companyId: "c-1",
      token: "ghp_cli_token",
      config: {
        appId: "123456",
        installationId: "789",
        appPrivateKeySecretRef: { type: "secret_ref", secretId: "github-app-key" },
        releaseRepos: ["octo/Example"],
      },
      cards: [],
      statePath: join(mkdtempSync(join(tmpdir(), "dryrun-")), "state.json"),
    });

    // The injected CLI token binding replaced the App triple.
    expect(result.config.tokenSecretRef).toEqual({ type: "secret_ref", secretId: "dry-run" });
    expect(result.config.appId).toBe("");
    expect(validateAuthConfig(result.config)).toBeNull();
    // No auth error: the first-seen tag baselines quietly instead of refusing.
    expect(result.releaseOutcomes).toEqual([
      { repo: "octo/example", status: "already-created", tag: "v8.0.51", detail: expect.stringContaining("baseline") },
    ]);
    expect(result.stats.every((s) => s.errors === 0)).toBe(true);
  });
});
