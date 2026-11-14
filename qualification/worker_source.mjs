import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve, relative as relativePath, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIMIT = 10_000;
const MAX_SOURCE = 8 * 1024 * 1024;
const MAX_SCRIPTS = 10_000;

export function verifySource(relative, inventory, bytes, source) {
  assert(Object.hasOwn(inventory, relative), `Compiled module absent from archive inventory: ${relative}`);
  const text = bytes.toString('utf8');
  assert(Buffer.from(text, 'utf8').equals(bytes), `Module is not lossless UTF-8: ${relative}`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), inventory[relative], `Module digest differs: ${relative}`);
  assert.equal(source, text, `Compiled source differs: ${relative}`);
}

// A compiled-source witness for a disposable, network-isolated host; it does
// not show that functions ran. The caller owns worker and inspector teardown.
export async function witnessWorkerSource(pid, root, inventory) {
  assert(Number.isSafeInteger(pid) && pid > 1);
  assert(isAbsolute(root), 'Artifact root must be absolute');
  root = resolve(root);
  const deadline = Date.now() + LIMIT;
  const bounded = async promise => {
    const remaining = deadline - Date.now();
    assert(remaining > 0, 'Inspector deadline exceeded');
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Inspector deadline exceeded')), remaining);
      })]);
    } finally { clearTimeout(timer); }
  };
  process.kill(pid, 'SIGUSR1');
  let targets;
  while (Date.now() < deadline) {
    try {
      const response = await bounded(fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(1000) }));
      if (response.ok) { targets = await bounded(response.json()); break; }
    } catch { /* The inspector may still be starting. */ }
    await bounded(new Promise(resolve => setTimeout(resolve, 100)));
  }
  assert(Array.isArray(targets) && targets.length === 1, 'Expected exactly one inspector target');
  const url = new URL(targets[0].webSocketDebuggerUrl);
  assert.equal(url.protocol, 'ws:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '9229');
  assert(!url.username && !url.password, 'Inspector URL must not contain credentials');
  const socket = new WebSocket(url);
  const pending = new Map();
  const scripts = [];
  let nextId = 0;
  let failure;
  const fail = error => {
    failure = error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  socket.addEventListener('message', event => {
    try {
      assert(typeof event.data === 'string' && event.data.length <= MAX_SOURCE * 2, 'Inspector message too large');
      const message = JSON.parse(event.data);
      if (message.method === 'Debugger.scriptParsed') {
        assert(scripts.length < MAX_SCRIPTS, 'Too many inspector scripts');
        scripts.push(message.params);
      }
      if (pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(`Inspector ${message.error.message}`));
        else resolve(message.result);
      }
    } catch (error) { fail(error); }
  });
  socket.addEventListener('close', () => fail(new Error('Inspector socket closed')));
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Inspector connection failed')), { once: true });
  });
  const call = (method, params = {}) => bounded(new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    try { socket.send(JSON.stringify({ id, method, params })); } catch (error) { pending.delete(id); reject(error); }
  }));
  try {
    await bounded(opened);
    const identity = await call('Runtime.evaluate', { expression: 'process.pid', returnByValue: true });
    assert.equal(identity?.result?.value, pid, 'Inspector target is not the selected worker');
    await call('Debugger.enable');
    const matched = new Set();
    for (const script of scripts) {
      if (typeof script.url !== 'string' || !script.url.startsWith('file:')) continue;
      const path = fileURLToPath(script.url);
      const relative = relativePath(root, path);
      if (!relative || relative === '..' || relative.startsWith('../') || isAbsolute(relative)) continue;
      const handle = await bounded(open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW));
      let bytes;
      try {
        const stat = await bounded(handle.stat());
        assert(stat.isFile() && stat.size <= MAX_SOURCE, `Invalid module file: ${relative}`);
        const buffer = Buffer.alloc(MAX_SOURCE + 1);
        const { bytesRead } = await bounded(handle.read(buffer, 0, buffer.length, 0));
        assert(bytesRead <= MAX_SOURCE, `Module too large: ${relative}`);
        bytes = buffer.subarray(0, bytesRead);
      } finally { await handle.close(); }
      const source = await call('Debugger.getScriptSource', { scriptId: script.scriptId });
      verifySource(relative, inventory, bytes, source.scriptSource);
      matched.add(relative);
    }
    for (const required of ['dist/github.js', 'dist/worker.js']) {
      assert(matched.has(required), `Required artifact module was not observed compiled: ${required}`);
    }
    return { stage: 'worker-source-verified', pid, root, modules: [...matched].sort() };
  } finally {
    socket.close();
  }
}
