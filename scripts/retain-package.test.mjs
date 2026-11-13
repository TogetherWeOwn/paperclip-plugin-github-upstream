import assert from "node:assert/strict";
import { test } from "node:test";
import { validateManifest } from "./retain-package.mjs";

const paths = ["dist/index.js", "dist/index.d.ts", "dist/manifest.js", "dist/worker.js", "dist/ui/index.js"];
const pkg = {
  name: "@togetherweown/paperclip-plugin-github-upstream", version: "0.1.0",
  files: ["bin", "dist", "README.md", "LICENSE"], main: "./dist/index.js", types: "./dist/index.d.ts",
  exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
  paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js" },
};
const manifest = {
  id: "togetherweown.github-upstream", apiVersion: 1, version: "0.1.0",
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  capabilities: ["companies.read", "issues.read", "issue.subtree.read", "issues.create", "issues.update",
    "issue.comments.create", "issues.wakeup", "jobs.schedule", "http.outbound", "secrets.read-ref",
    "plugin.state.read", "plugin.state.write", "events.subscribe", "agent.tools.register", "ui.page.register",
    "project.workspaces.read", "execution.workspaces.read", "issue.relations.read", "issue.comments.read", "agents.invoke"],
};

test("validates reviewed identity, entrypoints, and exact capability multiset", () => {
  validateManifest(pkg, manifest, paths);
  assert.throws(() => validateManifest(pkg, { ...manifest, id: "other" }, paths));
  assert.throws(() => validateManifest(pkg, { ...manifest, version: "0.2.0" }, paths));
  assert.throws(() => validateManifest(pkg, { ...manifest, capabilities: manifest.capabilities.filter((c) => c !== "agent.tools.register") }, paths));
  assert.throws(() => validateManifest(pkg, { ...manifest, capabilities: [...manifest.capabilities, "secrets.read-ref"] }, paths));
  assert.throws(() => validateManifest(pkg, manifest, paths.filter((p) => p !== "dist/worker.js")));
  assert.throws(() => validateManifest({ ...pkg, files: [...pkg.files, "src"] }, manifest, paths));
});
