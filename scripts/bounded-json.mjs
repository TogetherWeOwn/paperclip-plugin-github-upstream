import { types } from 'node:util';

// Standalone syntax guard for untrusted JSON bytes. This does not validate a
// package, authenticate its source, or authorize interpreting a manifest.
const MAX_BYTES = 256 * 1024;
const MAX_DEPTH = 64;
const MAX_NODES = 20000;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const buffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;

export function parseBoundedJson(bytes) {
  if (!types.isUint8Array(bytes)) throw new Error('expected JSON bytes');
  if (types.isSharedArrayBuffer(buffer.call(bytes))) throw new Error('shared JSON bytes are not supported');
  if (byteLength.call(bytes) > MAX_BYTES) throw new Error('JSON byte limit exceeded');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error('invalid UTF-8');
  }
  let pos = 0;
  let nodes = 0;
  const fail = () => { throw new Error('invalid JSON'); };
  const whitespace = () => { while (' \t\n\r'.includes(text[pos]) && pos < text.length) pos++; };
  const string = () => {
    const start = pos++;
    while (pos < text.length) {
      const c = text[pos++];
      if (c === '"') {
        try { return JSON.parse(text.slice(start, pos)); } catch { return fail(); }
      }
      if (c === '\\') pos++;
    }
    return fail();
  };
  const value = (depth) => {
    if (depth > MAX_DEPTH) throw new Error('JSON depth limit exceeded');
    if (++nodes > MAX_NODES) throw new Error('JSON node limit exceeded');
    whitespace();
    const c = text[pos];
    // The root container counts as level one, including when it is empty.
    if (depth >= MAX_DEPTH && (c === '[' || c === '{')) throw new Error('JSON depth limit exceeded');
    if (c === '"') { string(); return; }
    if (c === '{') {
      pos++;
      const keys = new Set();
      whitespace();
      if (text[pos] === '}') { pos++; return; }
      for (;;) {
        whitespace();
        if (text[pos] !== '"') return fail();
        const key = string();
        if (keys.has(key)) throw new Error('duplicate JSON key');
        keys.add(key);
        whitespace();
        if (text[pos++] !== ':') return fail();
        value(depth + 1);
        whitespace();
        if (text[pos] === '}') { pos++; return; }
        if (text[pos++] !== ',') return fail();
      }
    }
    if (c === '[') {
      pos++;
      whitespace();
      if (text[pos] === ']') { pos++; return; }
      for (;;) {
        value(depth + 1);
        whitespace();
        if (text[pos] === ']') { pos++; return; }
        if (text[pos++] !== ',') return fail();
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(pos));
    if (!match) return fail();
    pos += match[0].length;
    if (/^-?[0-9]/.test(match[0]) && !Number.isFinite(Number(match[0]))) throw new Error('non-finite JSON number');
  };
  value(0);
  whitespace();
  if (pos !== text.length) fail();
  return JSON.parse(text);
}
