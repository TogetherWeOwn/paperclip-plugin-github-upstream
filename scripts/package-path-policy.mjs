import assert from "node:assert/strict";

// This policy only checks inventory names. It does not inspect an archive or
// approve a package; callers must perform the remaining validation separately.
const required = ["package.json", "README.md", "LICENSE", "bin/github-upstream-dryrun.mjs",
  "dist/index.js", "dist/index.d.ts", "dist/manifest.js", "dist/worker.js", "dist/ui/index.js"];
const distFile = /^dist\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:js|js\.map|d\.ts|d\.ts\.map)(?![\s\S])/;

export function validatePaths(paths) {
  assert(Array.isArray(paths) && paths.length > 0 && paths.length <= 200, "Unexpected package file count");
  assert(paths.every((path) => typeof path === "string"), "Invalid package member type");
  assert.equal(new Set(paths).size, paths.length, "Duplicate package member");
  for (const path of paths) {
    assert(required.includes(path) || distFile.test(path), `Unexpected package member: ${path}`);
  }
  for (const path of required) {
    assert(paths.includes(path), `Missing package member: ${path}`);
  }
}
