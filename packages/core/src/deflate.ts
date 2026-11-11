/**
 * Deterministic DEFLATE (RFC 1951) + zlib wrapper (RFC 1950).
 *
 * Why our own? Platform zlib implementations (Chromium, Node, Deno) produce
 * different — equally valid — byte streams for identical input, which breaks
 * xpdf's byte-identity guarantee. This encoder is a greedy LZ77 with fixed
 * Huffman coding: fully specified, so it emits identical bytes on every
 * runtime, forever. Compression ratio is slightly below `zlib -6`; for
 * document streams that trade is worth determinism.
 *
 * If compression would not shrink the data, a stored block is emitted instead
 * (also deterministic).
 */

const MIN_MATCH = 3;
const MAX_MATCH = 258;
const WINDOW = 32768;
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const MAX_CHAIN = 128;

/** Length code table: [baseLength, extraBits, code] for codes 257..285. */
const LENGTH_TABLE: ReadonlyArray<readonly [number, number, number]> = [
  [3, 0, 257], [4, 0, 258], [5, 0, 259], [6, 0, 260], [7, 0, 261], [8, 0, 262],
  [9, 0, 263], [10, 0, 264], [11, 1, 265], [13, 1, 266], [15, 1, 267], [17, 1, 268],
  [19, 2, 269], [23, 2, 270], [27, 2, 271], [31, 2, 272], [35, 3, 273], [43, 3, 274],
  [51, 3, 275], [59, 3, 276], [67, 4, 277], [83, 4, 278], [99, 4, 279], [115, 4, 280],
  [131, 5, 281], [163, 5, 282], [195, 5, 283], [227, 5, 284], [258, 0, 285],
];

/** Distance code table: [baseDist, extraBits, code] for codes 0..29. */
const DIST_TABLE: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0], [2, 0, 1], [3, 0, 2], [4, 0, 3], [5, 1, 4], [7, 1, 5], [9, 2, 6],
  [13, 2, 7], [17, 3, 8], [25, 3, 9], [33, 4, 10], [49, 4, 11], [65, 5, 12],
  [97, 5, 13], [129, 6, 14], [193, 6, 15], [257, 7, 16], [385, 7, 17],
  [513, 8, 18], [769, 8, 19], [1025, 9, 20], [1537, 9, 21], [2049, 10, 22],
  [3073, 10, 23], [4097, 11, 24], [6145, 11, 25], [8193, 12, 26],
  [12289, 12, 27], [16385, 13, 28], [24577, 13, 29],
];

class BitWriter {
  private bytes: number[] = [];
  private bitBuf = 0;
  private bitCount = 0;

  /** Write `count` bits of `value`, LSB-first (used for extra bits & stored headers). */
  writeBits(value: number, count: number): void {
    this.bitBuf |= (value & ((1 << count) - 1)) << this.bitCount;
    this.bitCount += count;
    while (this.bitCount >= 8) {
      this.bytes.push(this.bitBuf & 0xff);
      this.bitBuf >>>= 8;
      this.bitCount -= 8;
    }
  }

  /** Write a Huffman code: bits are emitted MSB-first per RFC 1951 §3.1.1. */
  writeHuffman(code: number, count: number): void {
    for (let i = count - 1; i >= 0; i--) {
      this.writeBits((code >>> i) & 1, 1);
    }
  }

  /** Pad to byte boundary with zero bits. */
  align(): void {
    if (this.bitCount > 0) {
      this.bytes.push(this.bitBuf & 0xff);
      this.bitBuf = 0;
      this.bitCount = 0;
    }
  }

  get length(): number {
    return this.bytes.length + (this.bitCount > 0 ? 1 : 0);
  }

  toUint8Array(): Uint8Array {
    this.align();
    return new Uint8Array(this.bytes);
  }
}

/** Fixed Huffman literal/length code for a symbol 0..287 → [code, bitCount]. */
function fixedLiteralCode(sym: number): readonly [number, number] {
  if (sym <= 143) return [0x30 + sym, 8];
  if (sym <= 255) return [0x190 + (sym - 144), 9];
  if (sym <= 279) return [sym - 256, 7];
  return [0xc0 + (sym - 280), 8];
}

function lengthCodeFor(len: number): readonly [number, number, number, number] {
  // binary search would be overkill at 29 entries; linear from the top is fine
  for (let i = LENGTH_TABLE.length - 1; i >= 0; i--) {
    const row = LENGTH_TABLE[i]!;
    if (len >= row[0]) return [row[2], len - row[0], row[1], row[0]];
  }
  throw new Error(`invalid match length ${len}`);
}

function distCodeFor(dist: number): readonly [number, number, number] {
  for (let i = DIST_TABLE.length - 1; i >= 0; i--) {
    const row = DIST_TABLE[i]!;
    if (dist >= row[0]) return [row[2], dist - row[0], row[1]];
  }
  throw new Error(`invalid match distance ${dist}`);
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  // process in chunks to defer the modulo
  const CHUNK = 5552;
  for (let i = 0; i < data.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, data.length);
    for (let j = i; j < end; j++) {
      a += data[j]!;
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/** Raw deflate of `input` into a single fixed-Huffman block (final). */
function deflateFixed(input: Uint8Array): Uint8Array {
  const w = new BitWriter();
  w.writeBits(1, 1); // BFINAL
  w.writeBits(1, 2); // BTYPE = 01 (fixed Huffman)

  const n = input.length;
  // hash chains over 3-byte sequences
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);

  const hashAt = (i: number): number =>
    (((input[i]! << 10) ^ (input[i + 1]! << 5) ^ input[i + 2]!) * 0x9e3779b1) >>> (32 - HASH_BITS);

  const emitLiteral = (b: number): void => {
    const [code, bits] = fixedLiteralCode(b);
    w.writeHuffman(code, bits);
  };

  const emitMatch = (len: number, dist: number): void => {
    const [lcode, lextra, lextraBits] = lengthCodeFor(len);
    const [lc, lbits] = fixedLiteralCode(lcode);
    w.writeHuffman(lc, lbits);
    if (lextraBits > 0) w.writeBits(lextra, lextraBits);
    const [dcode, dextra, dextraBits] = distCodeFor(dist);
    w.writeHuffman(dcode, 5); // distance codes are 5-bit fixed
    if (dextraBits > 0) w.writeBits(dextra, dextraBits);
  };

  let i = 0;
  while (i < n) {
    let bestLen = 0;
    let bestDist = 0;

    if (i + MIN_MATCH <= n) {
      const h = hashAt(i);
      let cand = head[h]!;
      const limit = Math.max(0, i - WINDOW);
      let chain = MAX_CHAIN;
      while (cand >= limit && chain-- > 0) {
        // quick reject: compare the byte that would extend the current best
        const check = i + bestLen;
        if (bestLen === 0 || (check < n && input[cand + bestLen] === input[check])) {
          let len = 0;
          const maxLen = Math.min(MAX_MATCH, n - i);
          while (len < maxLen && input[cand + len] === input[i + len]) len++;
          if (len > bestLen) {
            bestLen = len;
            bestDist = i - cand;
            if (len >= maxLen) break;
          }
        }
        cand = prev[cand]!;
      }
      // insert current position into the chain
      prev[i] = head[h]!;
      head[h] = i;
    }

    if (bestLen >= MIN_MATCH) {
      emitMatch(bestLen, bestDist);
      // insert skipped positions so later matches can reference them
      const end = i + bestLen;
      for (let j = i + 1; j < end && j + MIN_MATCH <= n; j++) {
        const h = hashAt(j);
        prev[j] = head[h]!;
        head[h] = j;
      }
      i = end;
    } else {
      emitLiteral(input[i]!);
      i++;
    }
  }

  const [endCode, endBits] = fixedLiteralCode(256);
  w.writeHuffman(endCode, endBits);
  return w.toUint8Array();
}

/** Raw deflate as stored (uncompressed) blocks. Handles inputs > 65535 bytes. */
function deflateStored(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let offset = 0;
  do {
    const chunk = Math.min(65535, input.length - offset);
    const final = offset + chunk >= input.length ? 1 : 0;
    out.push(final); // BFINAL + BTYPE=00, already byte-aligned
    out.push(chunk & 0xff, (chunk >>> 8) & 0xff);
    out.push(~chunk & 0xff, (~chunk >>> 8) & 0xff);
    for (let i = 0; i < chunk; i++) out.push(input[offset + i]!);
    offset += chunk;
  } while (offset < input.length);
  return new Uint8Array(out);
}

/**
 * Compress `input` as a zlib stream (RFC 1950) suitable for PDF /FlateDecode.
 * Chooses the smaller of fixed-Huffman vs stored output; both deterministic.
 */
export function deflate(input: Uint8Array): Uint8Array {
  const compressed = deflateFixed(input);
  const stored = deflateStored(input);
  const payload = compressed.length < stored.length ? compressed : stored;

  const out = new Uint8Array(2 + payload.length + 4);
  out[0] = 0x78; // CMF: deflate, 32K window
  out[1] = 0x01; // FLG: check bits valid for 0x7801, no dict, fastest
  out.set(payload, 2);
  const sum = adler32(input);
  out[out.length - 4] = (sum >>> 24) & 0xff;
  out[out.length - 3] = (sum >>> 16) & 0xff;
  out[out.length - 2] = (sum >>> 8) & 0xff;
  out[out.length - 1] = sum & 0xff;
  return out;
}
