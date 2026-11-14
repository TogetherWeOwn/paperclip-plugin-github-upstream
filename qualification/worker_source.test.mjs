import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySource } from './worker_source.mjs';

test('compiled source must be inventoried, lossless UTF-8, and equal', () => {
  const path = 'dist/github.js';
  const inventory = { [path]: 'digest' };
  const bytes = Buffer.from('export {};\n');
  verifySource(path, inventory, bytes, bytes.toString());
  assert.throws(() => verifySource(path, {}, bytes, bytes.toString()), /absent from archive/);
  assert.throws(() => verifySource(path, inventory, Buffer.from([0xff]), '�'), /not lossless UTF-8/);
  assert.throws(() => verifySource(path, inventory, bytes, 'different'), /Compiled source differs/);
});
