import { parseBoundedJson } from './bounded-json.mjs';

// This exact metadata snapshot is only a standalone comparison, not package,
// manifest, build-provenance, capability, or release acceptance.
const expected = {
  name: '@togetherweown/paperclip-plugin-github-upstream',
  version: '0.1.0',
  description: 'Paperclip plugin that notices upstream GitHub changes deterministically (ETag sync, zero LLM) and wakes the owning Paperclip card.',
  license: 'MIT',
  type: 'module',
  homepage: 'https://github.com/TogetherWeOwn/paperclip-plugin-github-upstream',
  repository: { type: 'git', url: 'https://github.com/TogetherWeOwn/paperclip-plugin-github-upstream' },
  exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
  main: './dist/index.js',
  types: './dist/index.d.ts',
  bin: { 'paperclip-github-upstream-dryrun': './bin/github-upstream-dryrun.mjs' },
  files: ['bin', 'dist', 'README.md', 'LICENSE'],
  paperclipPlugin: { manifest: './dist/manifest.js', worker: './dist/worker.js' },
  keywords: ['paperclip', 'plugin', 'github', 'upstream', 'releases'],
  scripts: {
    build: 'npm run build:worker && npm run build:ui',
    'build:worker': 'rm -rf dist && tsc -p tsconfig.build.json',
    'build:ui': 'node scripts/build-ui.mjs',
    prepack: 'npm run build',
    typecheck: 'tsc -p tsconfig.json --noEmit',
    test: 'vitest run',
    check: 'npm run typecheck && npm test && npm run build',
  },
  peerDependencies: { '@paperclipai/plugin-sdk': '*' },
  devDependencies: {
    '@paperclipai/plugin-sdk': '2026.1023.0',
    '@paperclipai/shared': '2026.1023.0',
    '@types/node': '24.19.2',
    '@types/react': '^19.3.0',
    '@types/react-dom': '^19.3.0',
    esbuild: '^0.28.2',
    react: '^19.3.1',
    'react-dom': '^19.3.1',
    typescript: '5.9.3',
    vitest: '4.1.12',
  },
  engines: { node: '>=24' },
};

function matches(actual, reference) {
  if (actual === null || reference === null || typeof actual !== 'object' || typeof reference !== 'object') {
    return actual === reference;
  }
  if (Array.isArray(actual) !== Array.isArray(reference)) return false;
  const keys = Object.keys(reference);
  const actualKeys = Object.keys(actual);
  // Conditional export keys are ordered by Node's resolver. Conservatively
  // preserve key order everywhere rather than guessing which objects matter.
  return actualKeys.length === keys.length &&
    keys.every((key, index) => actualKeys[index] === key && matches(actual[key], reference[key]));
}

export function assertPackageMetadata(bytes) {
  if (!matches(parseBoundedJson(bytes), expected)) throw new Error('package metadata mismatch');
}
