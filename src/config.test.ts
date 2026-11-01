import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUDIT_LOGINS,
  DEFAULT_AUDIT_ORGS,
  DEFAULT_CHIEF_OF_STAFF_ASSIGNEE,
  DEFAULT_FOLLOW_THROUGH_ASSIGNEE,
  DEFAULT_HEAD_PREFIXES,
  DEFAULT_MAX_CREATES_PER_TICK,
  DEFAULT_MAX_WAKES_PER_TICK,
  DEFAULT_RELEASE_INTAKE_ASSIGNEE,
  DEFAULT_RELEASE_REPOS,
  isValidOwnerRepo,
  isValidReleaseTag,
  itemKey,
  releaseKey,
  repoKey,
  resolveConfig,
  validateAuthConfig,
  type UpstreamConfig,
} from "./config.js";

const TOKEN_REF = { type: "secret_ref", secretId: "test-token" } as const;
const KEY_REF = { type: "secret_ref", secretId: "app-private-key" } as const;

const appConfig = (extra: Record<string, unknown> = {}) =>
  resolveConfig({ appId: "123456", installationId: "789012", appPrivateKeySecretRef: KEY_REF, ...extra });

describe("validateAuthConfig", () => {
  it("accepts a PAT-only config", () => {
    const config = resolveConfig({ tokenSecretRef: TOKEN_REF });
    expect(validateAuthConfig(config)).toBeNull();
  });

  it("accepts a complete GitHub App triple", () => {
    expect(validateAuthConfig(appConfig())).toBeNull();
  });

  it("fails closed when no auth mode is configured", () => {
    const config = resolveConfig({});
    expect(validateAuthConfig(config)).toContain("no GitHub auth configured");
  });

  it("rejects setting both PAT and App auth", () => {
    const config = resolveConfig({ tokenSecretRef: TOKEN_REF, appId: "123456" });
    expect(validateAuthConfig(config)).toContain("cannot set both");
  });

  it("rejects a partial App triple with the missing fields named", () => {
    const config = appConfig({ appPrivateKeySecretRef: undefined });
    expect(validateAuthConfig(config)).toContain("incomplete GitHub App auth");
    expect(validateAuthConfig(config)).toContain("appPrivateKeySecretRef");
  });

  it("rejects a non-numeric appId that parsing kept for reporting", () => {
    const config = appConfig({ appId: "my-client-id" });
    expect(validateAuthConfig(config)).toContain("appId must be the numeric App ID");
  });

  it("rejects a non-numeric installationId", () => {
    const config = appConfig({ installationId: "owner/slug" });
    expect(validateAuthConfig(config)).toContain("installationId must be the numeric installation ID");
  });
});

describe("resolveConfig defaults", () => {
  it("applies the documented defaults for an empty config", () => {
    const config = resolveConfig({});
    expect(config.releaseRepos).toEqual(DEFAULT_RELEASE_REPOS);
    expect(config.releaseRepos).not.toBe(DEFAULT_RELEASE_REPOS);
    expect(config.releaseIntakeAssigneeAgentId).toBe(DEFAULT_RELEASE_INTAKE_ASSIGNEE);
    expect(config.followThroughAssigneeAgentId).toBe(DEFAULT_FOLLOW_THROUGH_ASSIGNEE);
    expect(config.ourHeadPrefixes).toEqual(DEFAULT_HEAD_PREFIXES);
    expect(config.auditLogins).toEqual(DEFAULT_AUDIT_LOGINS);
    expect(config.auditOrgs).toEqual(DEFAULT_AUDIT_ORGS);
    expect(config.chiefOfStaffAgentId).toBe(DEFAULT_CHIEF_OF_STAFF_ASSIGNEE);
    expect(config.maxCreatesPerTick).toBe(DEFAULT_MAX_CREATES_PER_TICK);
    expect(config.maxWakesPerTick).toBe(DEFAULT_MAX_WAKES_PER_TICK);
    expect(config.tokenSecretRef).toBeNull();
    expect(config.appId).toBe("");
    expect(config.installationId).toBe("");
    expect(config.appPrivateKeySecretRef).toBeNull();
    expect(config.dryRun).toBe(false);
  });

  it("keeps explicit values and trims the operator login", () => {
    const config = resolveConfig({
      tokenSecretRef: TOKEN_REF,
      releaseRepos: ["octo/Example"],
      operatorLogin: "  Rick7C2  ",
      dryRun: true,
      maxCreatesPerTick: 0,
      maxWakesPerTick: 9,
    });
    expect(config.tokenSecretRef).toEqual(TOKEN_REF);
    expect(config.releaseRepos).toEqual(["octo/Example"]);
    expect(config.operatorLogin).toBe("Rick7C2");
    expect(config.dryRun).toBe(true);
    expect(config.maxCreatesPerTick).toBe(0);
    expect(config.maxWakesPerTick).toBe(9);
  });

  it("ignores unknown keys", () => {
    const config = resolveConfig({ tokenSecretRef: TOKEN_REF, nope: 1 } as Record<string, unknown>);
    expect((config as unknown as Record<string, unknown>).nope).toBeUndefined();
    expect(validateAuthConfig(config)).toBeNull();
  });
});

describe("resolveConfig coercion", () => {
  it("drops empty strings from string arrays and falls back to defaults", () => {
    const config = resolveConfig({ releaseRepos: ["", "octo/Example", 42], ourHeadPrefixes: [""] });
    expect(config.releaseRepos).toEqual(["octo/Example"]);
    expect(config.ourHeadPrefixes).toEqual(DEFAULT_HEAD_PREFIXES);
  });

  it("rejects a legacy string token binding (fails closed to null)", () => {
    const config = resolveConfig({ tokenSecretRef: "legacy-string-ref" });
    expect(config.tokenSecretRef).toBeNull();
    expect(validateAuthConfig(config)).toContain("no GitHub auth configured");
  });

  it("rejects a secret binding without a secretId", () => {
    const config = resolveConfig({ tokenSecretRef: { type: "secret_ref", secretId: "" } });
    expect(config.tokenSecretRef).toBeNull();
  });

  it("accepts numeric app/installation ids and normalizes whitespace", () => {
    const fromNumbers = resolveConfig({ appId: 123456, installationId: 789 });
    expect(fromNumbers.appId).toBe("123456");
    expect(fromNumbers.installationId).toBe("789");
    const fromStrings = resolveConfig({ appId: "  123456  ", installationId: "789 " });
    expect(fromStrings.appId).toBe("123456");
    expect(fromStrings.installationId).toBe("789");
  });

  it("keeps a malformed appId for validation instead of silently unsetting it", () => {
    const config = resolveConfig({ appId: "not-numeric" });
    expect(config.appId).toBe("not-numeric");
  });

  it("falls back for negative or fractional spend caps", () => {
    const config = resolveConfig({ maxCreatesPerTick: -1, maxWakesPerTick: 1.5 });
    expect(config.maxCreatesPerTick).toBe(DEFAULT_MAX_CREATES_PER_TICK);
    expect(config.maxWakesPerTick).toBe(DEFAULT_MAX_WAKES_PER_TICK);
  });

  it("lowercases compare-base keys so lookups hit", () => {
    const config = resolveConfig({ compareBases: { "Octo/Example": "main", empty: "", bad: 42 } });
    expect(config.compareBases).toEqual({ "octo/example": "main" });
  });

  it("drops empty label-map values", () => {
    const config = resolveConfig({ labelIdByName: { "gh:state/open": "L1", empty: "", bad: 7 } });
    expect(config.labelIdByName).toEqual({ "gh:state/open": "L1" });
  });

  it("filters invalid extra tracked items", () => {
    const config = resolveConfig({
      extraTrackedItems: [
        { owner: "octo", repo: "example", kind: "pull", number: 7 },
        { owner: "octo!", repo: "example", kind: "issue", number: 1 },
        { owner: "octo", repo: "example", kind: "pr", number: 2 },
        { owner: "octo", repo: "example", kind: "issue", number: 0 },
        { owner: "octo", repo: "example", kind: "issue", number: 1.5 },
        "nope",
      ],
    });
    expect(config.extraTrackedItems).toEqual([{ owner: "octo", repo: "example", kind: "pull", number: 7 }]);
  });

  it("only true enables dryRun", () => {
    expect(resolveConfig({ dryRun: 1 }).dryRun).toBe(false);
    expect(resolveConfig({ dryRun: true }).dryRun).toBe(true);
  });
});

describe("validators and keys", () => {
  it("validates owner/repo segments", () => {
    expect(isValidOwnerRepo("octo", "example")).toBe(true);
    expect(isValidOwnerRepo("a.b_c-d", "e")).toBe(true);
    expect(isValidOwnerRepo("octo!", "example")).toBe(false);
    expect(isValidOwnerRepo("", "example")).toBe(false);
    expect(isValidOwnerRepo("octo", "a/b")).toBe(false);
  });

  it("validates release tags", () => {
    expect(isValidReleaseTag("v8.0.51")).toBe(true);
    expect(isValidReleaseTag("2026.11.01+build/7")).toBe(true);
    expect(isValidReleaseTag("")).toBe(false);
    expect(isValidReleaseTag("-bad")).toBe(false);
    expect(isValidReleaseTag("has space")).toBe(false);
  });

  it("builds lowercase repo, item and release keys", () => {
    expect(repoKey("PaperclipAI", "Paperclip")).toBe("paperclipai/paperclip");
    expect(itemKey({ owner: "PaperclipAI", repo: "Paperclip", number: 7 })).toBe("paperclipai/paperclip#7");
    expect(releaseKey("PaperclipAI", "Paperclip", "v1.0")).toBe("paperclipai/paperclip@v1.0");
  });

  it("validateAuthConfig treats a lone private-key binding as a partial App setup", () => {
    const partial: Pick<UpstreamConfig, "tokenSecretRef" | "appId" | "installationId" | "appPrivateKeySecretRef"> = {
      tokenSecretRef: null,
      appId: "",
      installationId: "",
      appPrivateKeySecretRef: KEY_REF,
    };
    expect(validateAuthConfig(partial)).toContain("incomplete GitHub App auth");
  });
});
