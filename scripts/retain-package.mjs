// Adapted from TogetherWeOwn/paperclip-plugin-pr-doer-wake at d6bcc9d3.
// Build evidence only: release, host compatibility and installation are separate gates.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePaths } from "./package-path-policy.mjs";

const SOURCE = "35a0c2ed0148c6cdfecd3c38c0cef726862294ae";
const capabilities = ["companies.read", "issues.read", "issue.subtree.read", "issues.create",
  "issues.update", "issue.comments.create", "issues.wakeup", "jobs.schedule", "http.outbound",
  "secrets.read-ref", "plugin.state.read", "plugin.state.write", "events.subscribe",
  "agent.tools.register", "ui.page.register", "project.workspaces.read", "execution.workspaces.read",
  "issue.relations.read", "issue.comments.read", "agents.invoke"];
const run = (command, args, options = {}) => execFileSync(command, args, {
  encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, ...options,
}).trim();
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = (dir, name, data) => writeFileSync(join(dir, name), `${JSON.stringify(data, null, 2)}\n`);

export function validateManifest(pkg, manifest, paths) {
  assert.equal(pkg.name, "@togetherweown/paperclip-plugin-github-upstream");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(manifest.id, "togetherweown.github-upstream");
  assert.equal(manifest.apiVersion, 1);
  assert.equal(manifest.version, pkg.version);
  assert.deepEqual([...manifest.capabilities].sort(), [...capabilities].sort());
  assert.deepEqual(pkg.files, ["bin", "dist", "README.md", "LICENSE"]);
  assert.equal(pkg.paperclipPlugin.manifest, "./dist/manifest.js");
  assert.equal(pkg.paperclipPlugin.worker, "./dist/worker.js");
  assert.equal(manifest.entrypoints.worker, pkg.paperclipPlugin.worker);
  assert.equal(manifest.entrypoints.ui, "./dist/ui");
  for (const path of [pkg.main, pkg.types, pkg.exports?.["."]?.import, pkg.exports?.["."]?.types,
    pkg.paperclipPlugin.manifest, pkg.paperclipPlugin.worker, "./dist/ui/index.js"]) {
    assert(typeof path === "string" && path.startsWith("./dist/") && paths.includes(path.slice(2)),
      `Missing or invalid entrypoint: ${path}`);
  }
}

export function validateInventory(paths, packedFiles, expectedPaths) {
  validatePaths(expectedPaths);
  assert.deepEqual([...paths].sort(), packedFiles.map((file) => file.path).sort());
  assert.deepEqual([...paths].sort(), [...expectedPaths].sort(), "Archive differs from rebuilt package inventory");
}

export async function retainPackage(source, candidate, output) {
  const env = process.env;
  for (const name of ["SOURCE_SHA", "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT",
    "GITHUB_SERVER_URL", "GITHUB_WORKFLOW_REF", "GITHUB_WORKFLOW_SHA", "GITHUB_JOB"]) {
    assert(env[name], `Missing Actions context: ${name}`);
  }
  assert.equal(env.SOURCE_SHA, SOURCE);
  assert.notEqual(env.GITHUB_WORKFLOW_SHA, SOURCE, "Tooling and source must differ");
  assert.equal(run("git", ["-C", source, "rev-parse", "HEAD"]), SOURCE);
  run("git", ["-C", source, "diff", "--exit-code", "HEAD", "--", "."]);
  const pack = json(join(candidate, "pack.json"));
  assert(Array.isArray(pack) && pack.length === 1, "Expected one npm pack result");
  const [packed] = pack;
  assert(typeof packed.filename === "string" && /^[a-z0-9.-]+\.tgz$/.test(packed.filename), "Invalid tarball filename");
  const tarball = join(candidate, packed.filename);
  const members = run("tar", ["-tzf", tarball]).split("\n");
  assert(members.every((path) => path.startsWith("package/")), "Invalid archive prefix");
  const paths = members.map((path) => path.slice("package/".length));
  validatePaths(paths);
  const modes = run("tar", ["-tvzf", tarball]).split("\n");
  assert.equal(modes.length, paths.length);
  assert(modes.every((line) => line.startsWith("-")), "Non-regular archive member");
  assert(Array.isArray(packed.files), "Missing npm pack file list");
  const rebuiltPack = JSON.parse(run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { cwd: source }));
  assert(Array.isArray(rebuiltPack) && rebuiltPack.length === 1 && Array.isArray(rebuiltPack[0].files),
    "Expected one rebuilt npm pack inventory");
  validateInventory(paths, packed.files, rebuiltPack[0].files.map((file) => file.path));
  // Place the extracted package under the source checkout for locked SDK resolution.
  const inspection = mkdtempSync(join(source, ".package-inspection-"));
  try {
    run("tar", ["-xzf", tarball, "--no-same-owner", "--no-same-permissions", "-C", inspection]);
    const packageDir = join(inspection, "package");
    const inventory = [...paths].sort().map((path) => {
      const bytes = readFileSync(join(packageDir, path));
      assert.deepEqual(bytes, readFileSync(join(source, path)), `Packed bytes differ: ${path}`);
      return { path, size: bytes.length, sha256: sha256(bytes) };
    });
    const pkg = json(join(packageDir, "package.json"));
    const { default: manifest } = await import(pathToFileURL(join(packageDir, "dist/manifest.js")).href);
    validateManifest(pkg, manifest, paths);
    const sdk = json(join(source, "node_modules/@paperclipai/plugin-sdk/package.json"));
    const bytes = readFileSync(tarball);
    mkdirSync(output);
    copyFileSync(tarball, join(output, packed.filename));
    save(output, "package-files.json", inventory);
    save(output, "validation.json", { result: "passed", manifestId: manifest.id, version: manifest.version,
      capabilities: manifest.capabilities, limits: "Rebuild comparison and reviewed manifest only; no host or release approval." });
    save(output, "provenance.json", {
      sourceSha: SOURCE, workflowSha: env.GITHUB_WORKFLOW_SHA, workflowRef: env.GITHUB_WORKFLOW_REF,
      repository: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
      runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
      job: env.GITHUB_JOB, node: process.version, npm: run("npm", ["--version"]), sdk: sdk.version,
      lockfileSha256: sha256(readFileSync(join(source, "package-lock.json"))),
      tarball: { filename: packed.filename, size: bytes.length, sha256: sha256(bytes) },
      qualification: "Artifact service digest and actual expiry must be recorded from the Actions API after successful completion.",
    });
    const files = [packed.filename, "package-files.json", "validation.json", "provenance.json"];
    writeFileSync(join(output, "SHA256SUMS"), files.map((name) => `${sha256(readFileSync(join(output, name)))}  ${name}\n`).join(""));
  } finally {
    rmSync(inspection, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 5, "Usage: node retain-package.mjs <source> <candidate> <new-output>");
  await retainPackage(...process.argv.slice(2).map((path) => resolve(path)));
}
