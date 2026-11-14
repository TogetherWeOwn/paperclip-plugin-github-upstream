import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';

// Linux procfs descriptors remain bound to the original process, even if its
// numeric PID is reused. The caller must bound and await source verification
// and the complete dispatch, and select the host's worker in getPid. This
// alone does not prove routing, exclude exec, or detect a switch away and back.
export async function withWorkerLifetime(getPid, operation, openStat = open) {
  const pid = await getPid();
  assert(Number.isSafeInteger(pid) && pid > 1, 'Missing worker PID');
  const handle = await openStat(`/proc/${pid}/stat`, 'r');
  try {
    const readIdentity = async () => {
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      const end = text.lastIndexOf(')');
      assert(end > 0 && text.startsWith(`${pid} (`), 'Invalid worker stat');
      const fields = text.slice(end + 2).trim().split(/\s+/);
      assert(fields.length >= 20 && /^[0-9]+$/.test(fields[19]), 'Invalid worker start time');
      assert(!['Z', 'X', 'x'].includes(fields[0]), 'Worker exited');
      return fields[19];
    };
    const start = await readIdentity();
    assert.equal(await getPid(), pid, 'Worker replaced before witness');
    const result = await operation(pid);
    assert.equal(await getPid(), pid, 'Worker replaced during dispatch');
    assert.equal(await readIdentity(), start, 'Worker identity changed during dispatch');
    return result;
  } finally {
    await handle.close();
  }
}
