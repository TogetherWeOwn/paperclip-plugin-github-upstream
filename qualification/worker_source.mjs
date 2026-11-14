import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function verifySource(relative, inventory, bytes, source) {
  assert(Object.hasOwn(inventory, relative), `Compiled module absent from archive inventory: ${relative}`);
  const text = bytes.toString('utf8');
  assert(Buffer.from(text, 'utf8').equals(bytes), `Module is not lossless UTF-8: ${relative}`);
  assert.equal(source, text, `Compiled source differs: ${relative}`);
}

// Attach only to the worker in the network-isolated disposable host. This is a
// compiled-source witness, not evidence that every function was executed.
export async function witnessWorkerSource(pid, root, inventory) {
  assert(Number.isInteger(pid) && pid > 1);
  process.kill(pid, 'SIGUSR1');
  let targets;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(1000) });
      if (response.ok) { targets = await response.json(); break; }
    } catch { /* The inspector may still be starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(Array.isArray(targets) && targets.length === 1, 'Expected exactly one inspector target');
  const url = new URL(targets[0].webSocketDebuggerUrl);
  assert.equal(url.protocol, 'ws:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '9229');
  const socket = new WebSocket(url);
  const pending = new Map();
  const scripts = [];
  let nextId = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Debugger.scriptParsed') scripts.push(message.params);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`Inspector ${message.error.message}`));
      else resolve(message.result);
    }
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const bounded = promise => Promise.race([promise, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Inspector deadline exceeded')), 10_000);
    timer.unref();
  })]);
  const call = (method, params = {}) => bounded(new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  }));
  try {
    await bounded(opened);
    const identity = await call('Runtime.evaluate', { expression: 'process.pid', returnByValue: true });
    assert.equal(identity.result.value, pid, 'Inspector target is not the selected worker');
    await call('Debugger.enable');
    const matched = new Set();
    for (const script of scripts) {
      if (!script.url.startsWith('file:')) continue;
      const path = fileURLToPath(script.url);
      if (!path.startsWith(`${root}/`)) continue;
      const relative = path.slice(root.length + 1);
      const bytes = readFileSync(path);
      const source = await call('Debugger.getScriptSource', { scriptId: script.scriptId });
      verifySource(relative, inventory, bytes, source.scriptSource);
      matched.add(relative);
    }
    assert(matched.has('dist/github.js'), 'Distinctive artifact module was not observed compiled');
    console.log(JSON.stringify({ stage: 'worker-source-verified', pid, root, modules: [...matched].sort() }));
  } finally {
    socket.close();
  }
}
