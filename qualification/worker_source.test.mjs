import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifySource, witnessWorkerSource } from './worker_source.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('compiled source must match the archive digest and be lossless UTF-8', () => {
  const path = 'dist/github.js';
  const bytes = Buffer.from('export {};\n');
  const inventory = { [path]: digest(bytes) };
  verifySource(path, inventory, bytes, bytes.toString());
  assert.throws(() => verifySource(path, {}, bytes, bytes.toString()), /absent from archive/);
  assert.throws(() => verifySource(path, inventory, Buffer.from([0xff]), '�'), /not lossless UTF-8/);
  assert.throws(() => verifySource(path, inventory, bytes, 'different'), /Compiled source differs/);
  assert.throws(() => verifySource(path, inventory, Buffer.from('changed'), 'changed'), /Module digest differs/);
});

test('inspector target, PID, source and required module are verified', async t => {
  const root = mkdtempSync(join(tmpdir(), 'worker-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'dist'));
  const path = join(root, 'dist/github.js');
  const bytes = Buffer.from('export {};\n');
  writeFileSync(path, bytes);
  const worker = join(root, 'dist/worker.js');
  writeFileSync(worker, bytes);
  const inventory = { 'dist/github.js': digest(bytes), 'dist/worker.js': digest(bytes) };
  t.mock.method(process, 'kill', () => {});
  let target = 'ws://example.com:9229/id';
  let pid = 123;
  let scripts = [pathToFileURL(path).href, pathToFileURL(worker).href];
  let source = bytes.toString();
  let closed = 0;
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => [{ webSocketDebuggerUrl: target }] }));
  class Socket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(data) {
      const { id, method } = JSON.parse(data);
      const message = payload => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }));
      queueMicrotask(() => {
        if (method === 'Debugger.enable') for (const script of scripts) message({ method: 'Debugger.scriptParsed', params: { url: script, scriptId: '1' } });
        const result = method === 'Runtime.evaluate' ? { result: { value: pid } } : method === 'Debugger.getScriptSource' ? { scriptSource: source } : {};
        message({ id, result });
      });
    }
    close() { closed++; }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => { globalThis.WebSocket = original; });
  await assert.rejects(witnessWorkerSource(123, root, inventory), /127\.0\.0\.1/);
  target = 'ws://127.0.0.1:9229/id';
  pid = 456;
  await assert.rejects(witnessWorkerSource(123, root, inventory), /not the selected worker/);
  pid = 123;
  const witness = await witnessWorkerSource(123, root, inventory);
  assert.deepEqual(witness.modules, ['dist/github.js', 'dist/worker.js']);
  scripts = [pathToFileURL(path).href];
  await assert.rejects(witnessWorkerSource(123, root, inventory), /dist\/worker\.js/);
  scripts.push(pathToFileURL(worker).href);
  source = 'different';
  await assert.rejects(witnessWorkerSource(123, root, inventory), /Compiled source differs/);
  source = bytes.toString();
  writeFileSync(path, 'tampered');
  source = 'tampered';
  await assert.rejects(witnessWorkerSource(123, root, inventory), /Module digest differs/);
  rmSync(path);
  assert.equal(spawnSync('mkfifo', [path]).status, 0);
  await assert.rejects(witnessWorkerSource(123, root, inventory), /Invalid module file/);
  scripts = [];
  await assert.rejects(witnessWorkerSource(123, root, inventory), /not observed compiled/);
  assert.equal(closed, 7);
});
