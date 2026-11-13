import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseBoundedJson } from './bounded-json.mjs';

// All examples are synthetic; none represents a compiled candidate manifest.
const parse = (text) => parseBoundedJson(Buffer.from(text));

test('parses bounded JSON without executing it', () => {
  assert.deepEqual(parse('{"name":"synthetic","nested":[true,null,3]}'),
    { name: 'synthetic', nested: [true, null, 3] });
  assert.deepEqual(parse('{"a":{"x":1},"b":{"x":2}}'), { a: { x: 1 }, b: { x: 2 } });
  assert.equal(parseBoundedJson(runInNewContext('new Uint8Array([49])')), 1);
  assert.throws(() => parseBoundedJson(runInNewContext('new Uint16Array([49])')), /expected JSON bytes/);
});

test('rejects duplicate decoded keys at any depth', () => {
  for (const text of ['{"a":1,"a":2}', '{"x":{"a":1,"\\u0061":2}}', '{"__proto__":1,"__proto__":2}']) {
    assert.throws(() => parse(text), /duplicate JSON key/);
  }
});

test('rejects malformed, trailing and non-finite input', () => {
  for (const text of ['', '{"a":1,}', '[1,]', '01', 'true false', '"\\x41"', '"\n"', '﻿{}']) {
    assert.throws(() => parse(text), /invalid JSON/);
  }
  assert.throws(() => parse('1e400'), /non-finite JSON number/);
  assert.throws(() => parseBoundedJson(Uint8Array.of(0xff)), /invalid UTF-8/);
  assert.throws(() => parseBoundedJson(Uint8Array.of(0x22, 0xe2, 0x82)), /invalid UTF-8/);
  assert.throws(() => parse('{"😀":1,"\\ud83d\\ude00":2}'), /duplicate JSON key/);
  assert.throws(() => parseBoundedJson('{}'), /expected JSON bytes/);
});

test('enforces byte, nesting and node limits', () => {
  assert.equal(parse('0' + ' '.repeat(256 * 1024 - 1)), 0);
  assert.throws(() => parse(' '.repeat(256 * 1024 + 1)), /JSON byte limit/);
  const oversized = Buffer.from('0' + ' '.repeat(256 * 1024));
  Object.defineProperty(oversized, 'byteLength', { value: 1 });
  assert.throws(() => parseBoundedJson(oversized), /JSON byte limit/);
  const shared = new Uint8Array(new SharedArrayBuffer(1, { maxByteLength: 256 * 1024 + 1 }));
  shared[0] = 49;
  Object.defineProperty(shared, 'buffer', { value: new ArrayBuffer(1) });
  assert.throws(() => parseBoundedJson(shared), /shared JSON bytes/);
  assert.throws(() => parseBoundedJson(runInNewContext('new Uint8Array(new SharedArrayBuffer(1))')), /shared JSON bytes/);
  assert.doesNotThrow(() => parse('['.repeat(64) + ']'.repeat(64)));
  assert.doesNotThrow(() => parse('['.repeat(64) + '0' + ']'.repeat(64)));
  assert.throws(() => parse('['.repeat(65) + ']'.repeat(65)), /JSON depth limit/);
  assert.throws(() => parse('{"a":'.repeat(65) + '0' + '}'.repeat(65)), /JSON depth limit/);
  assert.throws(() => parse('['.repeat(65) + '0' + ']'.repeat(65)), /JSON depth limit/);
  assert.doesNotThrow(() => parse('[' + Array(19999).fill('0').join(',') + ']'));
  assert.throws(() => parse('[' + Array(20000).fill('0').join(',') + ']'), /JSON node limit/);
});
