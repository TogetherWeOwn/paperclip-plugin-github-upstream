import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { withWorkerLifetime } from './worker_lifetime.mjs';

function stat(state = 'S', start = '123') {
  return `42 (worker ) name) ${[state, ...Array(18).fill('0'), start].join(' ')}\n`;
}

function fixture(values = [stat(), stat()]) {
  let closed = false;
  const openStat = async () => ({
    read: async buffer => {
      const value = values.shift();
      if (value instanceof Error) throw value;
      const bytesRead = buffer.write(value);
      return { bytesRead };
    },
    close: async () => { closed = true; },
  });
  return { openStat, isClosed: () => closed };
}

test('rejects a real process exit while the descriptor is held', { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))']);
  const exited = once(child, 'exit');
  let entered = false;
  try {
    await assert.rejects(withWorkerLifetime(async () => child.pid, async () => {
      entered = true;
      child.stdin.end();
      await exited;
    }), error => error.code === 'ESRCH' || error.code === 'ENOENT' || error.message === 'Worker exited');
    assert(entered, 'Operation was not entered');
  } finally {
    child.stdin.end();
    await exited;
  }
});

test('holds one process across source and dispatch', async () => {
  const f = fixture();
  const result = await withWorkerLifetime(async () => 42, async pid => {
    assert.equal(pid, 42);
    return 'dispatch complete';
  }, f.openStat);
  assert.equal(result, 'dispatch complete');
  assert(f.isClosed());
});

test('fails closed on exited, replaced, or malformed workers', async () => {
  for (const [values, pattern] of [
    [[stat(), Object.assign(new Error('gone'), { code: 'ESRCH' })], /gone/],
    [[stat(), stat('Z')], /Worker exited/],
    [[stat(), stat('S', '456')], /identity changed/],
    [['not stat'], /Invalid worker stat/],
  ]) {
    const f = fixture(values);
    await assert.rejects(withWorkerLifetime(async () => 42, async () => {}, f.openStat), pattern);
    assert(f.isClosed());
  }
  const f = fixture();
  let calls = 0;
  await assert.rejects(withWorkerLifetime(async () => ++calls < 3 ? 42 : 43, async () => {}, f.openStat), /replaced during dispatch/);
  assert(f.isClosed());
});

test('closes the process handle if the operation fails', async () => {
  const f = fixture();
  await assert.rejects(withWorkerLifetime(async () => 42, async () => { throw new Error('dispatch failed'); }, f.openStat), /dispatch failed/);
  assert(f.isClosed());
});
