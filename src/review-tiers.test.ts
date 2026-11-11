import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyPath,
  matchGlob,
  needsSecurityReview,
  parseReviewTierMap,
  TIER_MAP_PATH,
  tierForPaths,
} from "./review-tiers.js";

const MAP = {
  low: ["**/*.md", "LICENSE"],
  ordinary: ["src/ui/**", "src/*.test.ts"],
  sensitive: ["src/auth/**", ".github/workflows/**", "package*.json"],
};

describe("parseReviewTierMap", () => {
  it("accepts the canonical v1 schema including empty tiers", () => {
    expect(parseReviewTierMap(`version: 1
default_tier: sensitive # default
tiers:
  low: ["docs/**"]
  ordinary: [] # audited modules
  sensitive:
    - "src/auth/**"
`)).toEqual({ low: ["docs/**"], ordinary: [], sensitive: ["src/auth/**"] });
    expect(parseReviewTierMap("version: 1\ndefault_tier: sensitive\ntiers:\n  low: []\n  ordinary: []\n  sensitive: []\n")).toEqual({ low: [], ordinary: [], sensitive: [] });
  });

  it("rejects unknown versions and ambiguous or incomplete schemas", () => {
    const valid = "version: 1\ndefault_tier: sensitive\ntiers:\n  low: []\n  ordinary: []\n  sensitive: []\n";
    for (const invalid of [valid.replace("version: 1", "version: 2"), valid.replace("sensitive\ntiers", "low\ntiers"), valid.replace("  low: []\n", ""), valid + "low: []\n", valid.replace("  low: []", "  low: []\n    - docs/**"), "low: [docs/**]\n  - src/**\n", "low: [null]\n", "low:\n  - \"bad\n"]) {
      expect(() => parseReviewTierMap(invalid)).toThrow();
    }
  });
  it("parses block lists and inline lists", () => {
    const text = `# tiers
low:
  - "docs/**"
  - LICENSE # house license
ordinary: ["src/ui/**", 'src/*.test.ts']
sensitive:
  - "src/auth/**"
`;
    expect(parseReviewTierMap(text)).toEqual({
      low: ["docs/**", "LICENSE"],
      ordinary: ["src/ui/**", "src/*.test.ts"],
      sensitive: ["src/auth/**"],
    });
  });

  it("rejects unknown keys, duplicates, scalars and empty maps (fail closed)", () => {
    expect(() => parseReviewTierMap("unknown:\n  - a\n")).toThrow(/unknown key/);
    expect(() => parseReviewTierMap("low:\n  - a\nlow:\n  - b\n")).toThrow(/duplicate key/);
    expect(() => parseReviewTierMap("low: docs/**\n")).toThrow(/expected a list/);
    expect(() => parseReviewTierMap("low:\n")).toThrow(/no patterns/);
    expect(() => parseReviewTierMap("")).toThrow(/no patterns/);
    expect(() => parseReviewTierMap("low:\n  - ../escape\n")).toThrow(/unsafe pattern/);
    expect(() => parseReviewTierMap("low:\n- a\n")).toThrow(/invalid tier map line/);
  });
});

describe("matchGlob", () => {
  it("keeps * inside one segment and lets ** cross directories", () => {
    expect(matchGlob("src/*.test.ts", "src/x.test.ts")).toBe(true);
    expect(matchGlob("src/*.test.ts", "src/ui/x.test.ts")).toBe(false);
    expect(matchGlob("**/*.md", "a/b/c.md")).toBe(true);
    expect(matchGlob("**/*.md", "README.md")).toBe(true);
    expect(matchGlob("docs/**", "docs/a/b.md")).toBe(true);
    expect(matchGlob("docs/**", "src/docs/a.md")).toBe(false);
    expect(matchGlob("src/auth/**", "src/auth/login.ts")).toBe(true);
  });

  it("matches glob-free patterns exactly or as a directory prefix", () => {
    expect(matchGlob("LICENSE", "LICENSE")).toBe(true);
    expect(matchGlob("LICENSE", "LICENSE.md")).toBe(false);
    expect(matchGlob("docs", "docs/a.md")).toBe(true);
    expect(matchGlob("docs", "src/docs")).toBe(false);
  });
});

describe("classifyPath / tierForPaths", () => {
  it("classifies each tier and unknown for unmapped paths", () => {
    expect(classifyPath(MAP, "README.md")).toBe("low");
    expect(classifyPath(MAP, "src/ui/index.tsx")).toBe("ordinary");
    expect(classifyPath(MAP, "src/auth/login.ts")).toBe("sensitive");
    expect(classifyPath(MAP, "src/unknown/file.ts")).toBe("unknown");
    expect(classifyPath(MAP, "/etc/passwd")).toBe("unknown");
  });

  it("lets sensitive win over ordinary over low", () => {
    const overlap = { low: ["src/**"], ordinary: ["src/ui/**"], sensitive: ["src/auth/**"] };
    expect(tierForPaths({ low: ["src/**"], ordinary: ["src/ui/**"], sensitive: ["src/auth/**"] }, ["src/ui/x.tsx"]).tier).toBe("ordinary");
    expect(tierForPaths({ low: ["src/**"], ordinary: ["src/ui/**"], sensitive: ["src/auth/**"] }, ["src/other/x.ts", "src/auth/x.ts"]).tier).toBe("sensitive");
    expect(overlap).toBeDefined();
  });

  it("tiers the max across paths and surfaces unmatched ones", () => {
    const mixed = tierForPaths(MAP, ["README.md", "src/auth/login.ts", "src/new/tool.ts"]);
    expect(mixed.tier).toBe("unknown");
    expect(mixed.unmatchedPaths).toEqual(["src/new/tool.ts"]);
    expect(tierForPaths(MAP, ["README.md", "src/ui/a.tsx"]).tier).toBe("ordinary");
    expect(tierForPaths(MAP, ["README.md"]).tier).toBe("low");
    // Empty diff is absence of evidence, not low risk (fail closed).
    expect(tierForPaths(MAP, []).tier).toBe("sensitive");
  });

  it("always tiers an edit to the tier map itself as sensitive", () => {
    expect(tierForPaths({ low: ["**/*"], ordinary: [], sensitive: [] }, [TIER_MAP_PATH]).tier).toBe("sensitive");
  });

  it("requires security only for sensitive and unknown", () => {
    expect(needsSecurityReview("sensitive")).toBe(true);
    expect(needsSecurityReview("unknown")).toBe(true);
    expect(needsSecurityReview("ordinary")).toBe(false);
    expect(needsSecurityReview("low")).toBe(false);
  });
});

// --- resolveReviewTier against a real temp git repo -----------------------

const git = (dir: string, args: string[]): string =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

/**
 * A repo with one committed base file on `main`, then a `feature` branch the
 * callers commit changes onto — the diff under test is merge-base(main, HEAD)
 * vs HEAD, so commits must land off `main`. `includeMap` commits the tier
 * map into the base, so the map itself is never part of the diff (adding the
 * map would force Sensitive, like any map edit).
 */
function makeRepo(includeMap = false): string {
  const dir = mkdtempSync(join(tmpdir(), "review-tiers-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "base.txt"), "base\n");
  if (includeMap) withTierFile(dir);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  git(dir, ["checkout", "-q", "-b", "feature"]);
  return dir;
}

const TIER_FILE = `low:
  - "**/*.md"
ordinary:
  - "src/ui/**"
sensitive:
  - "src/auth/**"
  - ".github/workflows/**"
`;

function withTierFile(dir: string, text = TIER_FILE): void {
  mkdirSync(join(dir, ".github"), { recursive: true });
  writeFileSync(join(dir, TIER_MAP_PATH), text);
}

function commitFile(dir: string, relpath: string, contents: string): void {
  mkdirSync(join(dir, ...relpath.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(dir, relpath), contents);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", `change ${relpath}`]);
}

import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "./manifest.js";
import plugin from "./plugin.js";
import { resolveReviewTier } from "./review-tiers.js";
import type { Issue } from "@paperclipai/shared";

const COMPANY = "c-1";
const PROJECT = "p-1";
const WORKSPACE = "w-1";

const tierForIssue = async (harness: ReturnType<typeof createTestHarness>, issue: Record<string, unknown>, checkout: string) => {
  harness.seed({
    companies: [{ id: COMPANY, name: "TWO", issuePrefix: "TWO" } as never],
    projects: [{ id: PROJECT, companyId: COMPANY } as never],
    projectWorkspaces: [
      { id: WORKSPACE, projectId: PROJECT, name: "repo", path: checkout, repoUrl: null, repoRef: null, defaultRef: "main", isPrimary: true, createdAt: "", updatedAt: "" } as never,
    ],
    issues: [issue as never],
  });
  await plugin.definition.setup(harness.ctx);
  return resolveReviewTier(harness.ctx, COMPANY, issue as unknown as Issue);
};

const newHarness = () => createTestHarness({ manifest, config: {} });

describe("resolveReviewTier (real git checkout)", () => {
  it.each([
    ["endpoint and input parsing", "export const parseRequest = (s) => JSON.parse(s);"],
    ["auth and session", "export const authorize = () => true;"],
    ["crypto and keys", "export const key = 'key';"],
    ["credentials", "export const credential = 'placeholder';"],
    ["permissions", "export const permit = () => true;"],
    ["tenant and personal data", "export const tenant = { personalData: true };"],
    ["schema and migrations", "ALTER TABLE users ADD COLUMN name TEXT;"],
    ["dependencies", "dependencies: new-package"],
    ["CI and workflows", "workflow: deploy"],
    ["weakened tests", "// removed assertions and snapshots"],
    ["no recognizable keywords", "const x = 1;"],
  ])("fails closed for %s on low and ordinary paths", async (_category, contents) => {
    const repo = makeRepo(true);
    try {
      const harness = newHarness();
      const issue = { id: "i-1", companyId: COMPANY, projectId: PROJECT, projectWorkspaceId: WORKSPACE, status: "in_review" };
      commitFile(repo, "README.md", contents);
      expect((await tierForIssue(harness, issue, repo)).tier).toBe("sensitive");
      git(repo, ["reset", "--hard", "main"]);
      commitFile(repo, "src/ui/change.ts", contents);
      expect((await tierForIssue(harness, issue, repo)).tier).toBe("sensitive");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
  it("fails closed for a docs-only change and preserves a sensitive auth change", async () => {
    const repo = makeRepo(true);
    try {
      const harness = newHarness();
      const issue = { id: "i-1", companyId: COMPANY, projectId: PROJECT, projectWorkspaceId: WORKSPACE, status: "in_review" };
      // Empty diff (HEAD == merge-base) fails closed: absence of evidence is
      // not low risk (a creation-time stamp must never be QA-only for want
      // of a real diff).
      const empty = await tierForIssue(harness, issue, repo);
      expect(empty.tier).toBe("sensitive");
      expect(empty.reason).toContain("empty diff");
      commitFile(repo, "README.md", "# docs\n");
      const docs = await tierForIssue(harness, issue, repo);
      expect(docs.tier).toBe("sensitive");
      expect(docs.reason).toContain("content triggers");
      commitFile(repo, "src/auth/login.ts", "export {};\n");
      const sensitive = await tierForIssue(harness, issue, repo);
      expect(sensitive.tier).toBe("sensitive");
      expect(sensitive.reason).toContain("src/auth/login.ts");
      expect(sensitive.headSha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("surfaces the source side of a rename: moving sensitive code into a low path still tiers sensitive", async () => {
    // Base (main) already contains the sensitive file; the feature branch
    // renames it, so the diff vs the merge-base is a delete+add pair.
    const repo = mkdtempSync(join(tmpdir(), "review-tiers-rename-"));
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    withTierFile(repo);
    mkdirSync(join(repo, "src", "auth"), { recursive: true });
    writeFileSync(join(repo, "src", "auth", "login.ts"), "export {};\n");
    writeFileSync(join(repo, "base.txt"), "base\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "base"]);
    git(repo, ["checkout", "-q", "-b", "feature"]);
    mkdirSync(join(repo, "docs"), { recursive: true });
    git(repo, ["mv", "src/auth/login.ts", "docs/auth.md"]);
    git(repo, ["commit", "-qm", "rename auth to docs"]);
    try {
      const harness = newHarness();
      const issue = { id: "i-1", companyId: COMPANY, projectId: PROJECT, projectWorkspaceId: WORKSPACE, status: "in_review" };
      // With rename detection plain `--name-only` would list only the
      // Low destination; the diff must expose the sensitive source path.
      const renamed = await tierForIssue(harness, issue, repo);
      expect(renamed.tier).toBe("sensitive");
      expect(renamed.changedPaths).toContain("src/auth/login.ts");
      expect(renamed.changedPaths).toContain("docs/auth.md");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not execute git config from the checkout (planted core.fsmonitor stays inert)", async () => {
    const repo = makeRepo(true);
    // The hook script lives outside the repo so it is not itself an
    // (unmatched) untracked path in the diff under test.
    const hookDir = mkdtempSync(join(tmpdir(), "fsmonitor-"));
    try {
      const harness = newHarness();
      const issue = { id: "i-1", companyId: COMPANY, projectId: PROJECT, projectWorkspaceId: WORKSPACE, status: "in_review" };
      commitFile(repo, "README.md", "# docs\n");
      const marker = join(hookDir, "fsmonitor-ran");
      const hook = join(hookDir, "fsmonitor.sh");
      writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`);
      chmodSync(hook, 0o755);
      // Planted last, after all setup commits, so only the guard's own
      // read-only invocations could trigger it.
      git(repo, ["config", "core.fsmonitor", hook]);
      const result = await tierForIssue(harness, issue, repo);
      expect(result.tier).toBe("sensitive");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(hookDir, { recursive: true, force: true });
    }
  });

  it("fails closed on a missing map", async () => {
    const repo = makeRepo();
    try {
      const harness = newHarness();
      const issue = { id: "i-1", companyId: COMPANY, projectId: PROJECT, projectWorkspaceId: WORKSPACE, status: "in_review" };
      const missing = await tierForIssue(harness, issue, repo);
      expect(missing.tier).toBe("sensitive");
      expect(missing.reason).toContain("missing .github/review-tiers.yml");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails closed on unmatched paths", async () => {
    const repo = makeRepo(true);
    try {
      const harness = newHarness();
      const issue = { id: "i-1", companyId: COMPANY, projectId: PROJECT, projectWorkspaceId: WORKSPACE, status: "in_review" };
      commitFile(repo, "vendor/newthing.ts", "export {};\n");
      const unmatched = await tierForIssue(harness, issue, repo);
      expect(unmatched.tier).toBe("unknown");
      expect(unmatched.reason).toContain("vendor/newthing.ts");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("tiers an edit to the tier map itself as sensitive, even to a map that classifies everything low", async () => {
    const repo = makeRepo(true);
    try {
      const harness = newHarness();
      const issue = { id: "i-1", companyId: COMPANY, projectId: PROJECT, projectWorkspaceId: WORKSPACE, status: "in_review" };
      // Uncommitted map edit: the working-tree map is read and its own path
      // in the diff forces Sensitive, whatever its patterns say.
      writeFileSync(join(repo, TIER_MAP_PATH), `low:\n  - "**/*"\n`);
      expect((await tierForIssue(harness, issue, repo)).tier).toBe("sensitive");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails closed on a malformed map", async () => {
    const repo = makeRepo(true);
    try {
      const harness = newHarness();
      const issue = { id: "i-1", companyId: COMPANY, projectId: PROJECT, projectWorkspaceId: WORKSPACE, status: "in_review" };
      writeFileSync(join(repo, TIER_MAP_PATH), "bogus:\n  - x\n");
      const badMap = await tierForIssue(harness, issue, repo);
      expect(badMap.tier).toBe("sensitive");
      expect(badMap.reason).toContain("unreadable tier map");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails closed with no workspace checkout", async () => {
    const harness = newHarness();
    const issue = { id: "i-1", companyId: COMPANY, projectId: PROJECT, projectWorkspaceId: WORKSPACE, status: "in_review", executionWorkspaceId: null };
    harness.seed({ companies: [{ id: COMPANY, name: "TWO", issuePrefix: "TWO" } as never], issues: [issue as never] });
    await plugin.definition.setup(harness.ctx);
    const result = await resolveReviewTier(harness.ctx, COMPANY, issue as unknown as Issue);
    expect(result.tier).toBe("sensitive");
    expect(result.reason).toContain("no workspace checkout");
  });
});
