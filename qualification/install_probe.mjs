import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const base = 'http://127.0.0.1:3100';
const candidate = '/qualification/candidate';

async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${base}${path}`, {
    method,
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
console.log(JSON.stringify({ stage: 'candidate-installed', pluginId: plugin.id, witness, status: worker.status }));

const pluginId = plugin.id;
const company = await api('/api/companies', { name: 'Disposable lifecycle probe' });
assert.equal(typeof company.id, 'string');
const config = { dryRun: true, releaseRepos: ['example/fixture'], maxCreatesPerTick: 0, maxWakesPerTick: 0 };
const configPath = `/api/plugins/${pluginId}/config`;
await api(configPath, { companyId: company.id, configJson: config });
async function assertConfig() {
  const stored = await api(`${configPath}?companyId=${encodeURIComponent(company.id)}`);
  assert.equal(stored.companyId, company.id);
  assert.deepEqual(stored.configJson, config);
}
await assertConfig();
console.log(JSON.stringify({ stage: 'synthetic-config-saved', pluginId, companyId: company.id }));

// Connect only to this disposable container's embedded database, never a configured external database.
assert.equal(process.env.DATABASE_URL, undefined);
const dbDir = '/paperclip/instances/default/db';
const pidFile = readFileSync(`${dbDir}/postmaster.pid`, 'utf8').split('\n');
assert.equal(pidFile[1], dbDir);
const port = Number(pidFile[3]);
assert(Number.isInteger(port) && port > 0 && port < 65536);
const postgres = createRequire('/app/packages/db/package.json')('postgres');
const db = postgres({ host: '127.0.0.1', port, database: 'paperclip', username: 'paperclip', password: 'paperclip', max: 1, connect_timeout: 5 });
async function readRuns() {
  return db.begin('read only', async sql => {
    const rows = await sql`select value_json from plugin_state where plugin_id = ${pluginId} and scope_kind = 'company' and scope_id = ${company.id} and namespace = 'default' and state_key = 'runs'`;
    assert(rows.length <= 1);
    return rows[0]?.value_json ?? null;
  });
}
try {
  const before = await readRuns();
  assert(before === null || Array.isArray(before));
  const jobs = await api(`/api/plugins/${pluginId}/jobs`);
  const matches = jobs.filter(job => job.jobKey === 'item-scan');
  assert.equal(matches.length, 1);
  const jobId = matches[0].id;
  const jobPath = `/api/plugins/${pluginId}/jobs/${jobId}`;
  const triggered = await api(`${jobPath}/trigger`, {});
  assert.equal(triggered.jobId, jobId);
  assert.equal(typeof triggered.runId, 'string');
  let run;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    run = (await api(`${jobPath}/runs?limit=100`)).find(entry => entry.id === triggered.runId);
    if (run && ['succeeded', 'failed'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(run?.status, 'succeeded', 'Specific triggered job did not succeed');
  const saved = await readRuns();
  assert(Array.isArray(saved) && saved.length > 0);
  assert.notDeepEqual(saved, before, 'Job did not produce new state');
  assert.equal(saved.at(-1).job, 'item-scan');
  assert(saved.at(-1).errors > 0, 'Expected credential-free scan error witness');
  console.log(JSON.stringify({ stage: 'nonempty-state-saved', pluginId, companyId: company.id, runId: triggered.runId }));
  const assertRetainedState = async () => assert.deepEqual(await readRuns(), saved);

const removed = await api(`/api/plugins/${pluginId}`, undefined, 'DELETE');
assert.equal(removed.id, pluginId);
console.log(JSON.stringify({ stage: 'soft-uninstall', pluginId, status: removed.status }));
plugin = await api('/api/plugins/install', { packageName: candidate, isLocalPath: true });
if (plugin.plugin) plugin = plugin.plugin;
assert.equal(plugin.id, pluginId);
assert.equal(plugin.pluginKey, 'togetherweown.github-upstream');
assert.equal(plugin.packagePath, candidate);
assert.equal(plugin.status, 'ready');
assert.equal((await api(`/api/plugins/${pluginId}/health`)).healthy, true);
await assertConfig();
await assertRetainedState();
console.log(JSON.stringify({ stage: 'candidate-reinstalled', pluginId, status: plugin.status }));

const removedAgain = await api(`/api/plugins/${pluginId}`, undefined, 'DELETE');
assert.equal(removedAgain.id, pluginId);
plugin = await api('/api/plugins/install', { packageName: '/qualification/rollback', isLocalPath: true });
if (plugin.plugin) plugin = plugin.plugin;
assert.equal(plugin.id, pluginId);
assert.equal(plugin.pluginKey, 'togetherweown.github-upstream');
assert.equal(plugin.packagePath, '/qualification/rollback');
assert.equal(plugin.status, 'ready');
assert.equal((await api(`/api/plugins/${pluginId}/health`)).healthy, true);
await assertConfig();
await assertRetainedState();
console.log(JSON.stringify({ stage: 'rollback-installed', pluginId, status: plugin.status, rollbackWitness }));
} finally {
  await db.end({ timeout: 5 });
}
