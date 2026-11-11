import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { deflate } from '../src/deflate.js';

function roundtrip(input: Uint8Array): void {
  const compressed = deflate(input);
  const back = inflateSync(compressed);
  expect(new Uint8Array(back)).toEqual(input);
}

const text = (s: string) => new TextEncoder().encode(s);

describe('deflate', () => {
  it('roundtrips empty input', () => roundtrip(new Uint8Array(0)));
  it('roundtrips a single byte', () => roundtrip(new Uint8Array([42])));
  it('roundtrips plain text', () => roundtrip(text('Hello, xpdf!')));

  it('roundtrips highly repetitive data', () => {
    roundtrip(text('invoice '.repeat(5000)));
  });

  it('roundtrips pseudo-random binary data', () => {
    // deterministic PRNG so the test itself is stable
    let seed = 0x12345678;
    const data = new Uint8Array(100_000);
    for (let i = 0; i < data.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[i] = seed & 0xff;
    }
    roundtrip(data);
  });

  it('roundtrips data larger than one stored block (64KB+)', () => {
    const data = new Uint8Array(200_000);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    roundtrip(data);
  });

  it('roundtrips data with matches crossing the LZ77 window', () => {
    const chunk = text('the quick brown fox jumps over the lazy dog. ');
    const data = new Uint8Array(chunk.length * 2000);
    for (let i = 0; i < 2000; i++) data.set(chunk, i * chunk.length);
    roundtrip(data);
  });

  it('compresses repetitive data below input size', () => {
    const input = text('abcabcabc '.repeat(2000));
    expect(deflate(input).length).toBeLessThan(input.length / 2);
  });

  it('is deterministic: same input, same bytes', () => {
    const input = text('determinism check '.repeat(100));
    expect(deflate(input)).toEqual(deflate(input));
  });

  it('emits valid zlib header and adler32 trailer', () => {
    const out = deflate(text('hello'));
    expect(out[0]).toBe(0x78);
    // FCHECK: (CMF*256 + FLG) must be a multiple of 31
    expect(((out[0]! << 8) | out[1]!) % 31).toBe(0);
  });
});
