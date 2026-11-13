import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPackageMetadata } from './package-metadata-policy.mjs';

// Synthetic policy example, not bytes observed in a package or source checkout.
const fixtureBytes = Buffer.from(`{
  "name": "@togetherweown/paperclip-plugin-github-upstream",
  "version": "0.1.0",
  "description": "Paperclip plugin that notices upstream GitHub changes deterministically (ETag sync, zero LLM) and wakes the owning Paperclip card.",
  "license": "MIT",
  "type": "module",
  "homepage": "https://github.com/TogetherWeOwn/paperclip-plugin-github-upstream",
  "repository": { "type": "git", "url": "https://github.com/TogetherWeOwn/paperclip-plugin-github-upstream" },
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": { "paperclip-github-upstream-dryrun": "./bin/github-upstream-dryrun.mjs" },
  "files": ["bin", "dist", "README.md", "LICENSE"],
  "paperclipPlugin": { "manifest": "./dist/manifest.js", "worker": "./dist/worker.js" },
  "keywords": ["paperclip", "plugin", "github", "upstream", "releases"],
  "scripts": {
    "build": "npm run build:worker && npm run build:ui",
    "build:worker": "rm -rf dist && tsc -p tsconfig.build.json",
    "build:ui": "node scripts/build-ui.mjs",
    "prepack": "npm run build",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "check": "npm run typecheck && npm test && npm run build"
  },
  "peerDependencies": { "@paperclipai/plugin-sdk": "*" },
  "devDependencies": {
    "@paperclipai/plugin-sdk": "2026.1023.0",
    "@paperclipai/shared": "2026.1023.0",
    "@types/node": "24.19.2",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "esbuild": "^0.28.2",
    "react": "^19.3.1",
    "react-dom": "^19.3.1",
    "typescript": "5.9.3",
    "vitest": "4.1.12"
  },
  "engines": { "node": ">=24" }
}`);
const fixture = JSON.parse(fixtureBytes);
const bytes = (value) => Buffer.from(JSON.stringify(value));

test('accepts raw synthetic reference bytes', () => {
  assert.doesNotThrow(() => assertPackageMetadata(fixtureBytes));
});

test('rejects synthetic identity, entrypoint, script and shape changes', () => {
  const cases = [
    (x) => { x.name = 'other'; },
    (x) => { x.version = '0.1.1'; },
    (x) => { x.exports['.'].import = './other.js'; },
    (x) => { x.exports['.'] = { import: './dist/index.js', types: './dist/index.d.ts' }; },
    (x) => { delete x.paperclipPlugin.worker; },
    (x) => { x.scripts.install = 'unexpected'; },
    (x) => { x.scripts.build = 'unexpected'; },
    (x) => { x.devDependencies.typescript = '0.0.0'; },
    (x) => { x.peerDependencies['@paperclipai/plugin-sdk'] = '0.0.0'; },
    (x) => { x.files.reverse(); },
    (x) => { x.extra = true; },
    (x) => { x.repository = null; },
    (x) => { x.engines = []; },
    (x) => { Object.defineProperty(x, '__proto__', { value: {}, enumerable: true }); },
  ];
  for (const change of cases) {
    const candidate = structuredClone(fixture);
    change(candidate);
    assert.throws(() => assertPackageMetadata(bytes(candidate)), /package metadata mismatch/);
  }
  for (const candidate of [null, [], 42, 'package']) {
    assert.throws(() => assertPackageMetadata(bytes(candidate)), /package metadata mismatch/);
  }
});

test('propagates bounded parser refusals before comparison', () => {
  const duplicate = Buffer.from(fixtureBytes.toString().replace('"version": "0.1.0",', '"version": "0.1.0", "version": "0.1.0",'));
  assert.throws(() => assertPackageMetadata(duplicate), /duplicate JSON key/);
  const escapedDuplicate = Buffer.from(fixtureBytes.toString().replace('"version": "0.1.0",', '"version": "0.1.0", "\\u0076ersion": "0.1.0",'));
  assert.throws(() => assertPackageMetadata(escapedDuplicate), /duplicate JSON key/);
  assert.throws(() => assertPackageMetadata(Buffer.from('{')), /invalid JSON/);
  assert.throws(() => assertPackageMetadata(Buffer.alloc(256 * 1024 + 1)), /JSON byte limit exceeded/);
});
