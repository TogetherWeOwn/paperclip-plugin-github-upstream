import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePaths } from "./package-path-policy.mjs";

const files = ["package.json", "README.md", "LICENSE", "bin/github-upstream-dryrun.mjs",
  "dist/index.js", "dist/index.d.ts", "dist/manifest.js", "dist/worker.js", "dist/ui/index.js"];

test("accepts allowed inventory names", () => {
  assert.doesNotThrow(() => validatePaths([...files, "dist/ui/index.js.map", "dist/index.d.ts.map"]));
});

test("rejects invalid inventory size and types", () => {
  assert.throws(() => validatePaths([]), /Unexpected package file count/);
  assert.throws(() => validatePaths(Array(201).fill("dist/a.js")), /Unexpected package file count/);
  assert.throws(() => validatePaths([...files, null]), /Invalid package member type/);
});

test("rejects duplicate, unexpected and missing names for the right reason", () => {
  assert.throws(() => validatePaths([...files, "dist/index.js"]), /Duplicate package member/);
  for (const path of ["dist/../package.json", "/dist/x.js", "dist/x.js\n", "dist/a\\b.js", "dist/x.json"]) {
    assert.throws(() => validatePaths([...files, path]), /Unexpected package member/);
  }
  for (const missing of ["dist/index.js", "dist/index.d.ts", "dist/manifest.js", "dist/worker.js", "dist/ui/index.js"]) {
    assert.throws(() => validatePaths(files.filter((path) => path !== missing)),
      (error) => error.message === `Missing package member: ${missing}`);
  }
});
