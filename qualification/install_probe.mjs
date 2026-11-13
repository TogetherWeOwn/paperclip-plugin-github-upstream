import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const base = 'http://127.0.0.1:3100';
const candidate = '/qualification/candidate';

async function api(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  assert(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}

async function ready() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const health = await api('/api/health');
      if (health.status === 'ok') return health;
    } catch { /* Host may still be starting. */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Stock host readiness deadline exceeded');
}

const health = await ready();
assert.equal(health.deploymentMode, 'local_trusted');
assert.equal(health.deploymentExposure, 'private');
assert.equal(process.env.PAPERCLIP_BUILD_VERSION, 'v2026.1106.0-0-gd69631b01b');
const witness = createHash('sha256').update(readFileSync(`${candidate}/dist/github.js`)).digest('hex');
assert.equal(witness, '15437fba205928e4491c7d859e70f25896747214f003844327507f64cf7fbc04');
const rollbackWitness = createHash('sha256').update(readFileSync('/qualification/rollback/dist/github.js')).digest('hex');
assert.equal(rollbackWitness, 'b7e0a4f3ae621d299da249a0db02b9496cd243ccdd421a60bdc536cdaf460a8f');
assert.notEqual(witness, rollbackWitness);
let plugin = await api('/api/plugins/install', { packageName: candidate, isLocalPath: true });
if (plugin.plugin) plugin = plugin.plugin;
assert.equal(plugin.pluginKey, 'togetherweown.github-upstream');
assert.equal(plugin.status, 'ready');
assert.equal(plugin.packagePath, candidate);
const worker = await api(`/api/plugins/${plugin.id}/health`);
assert.equal(worker.healthy, true);
console.log(JSON.stringify({ stage: 'candidate-install-only', pluginId: plugin.id, witness, status: worker.status }));
