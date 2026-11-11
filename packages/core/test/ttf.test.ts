import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseTtf, subsetTtf, glyphClosure } from '../src/fonts/ttf.js';

const fixturePath = fileURLToPath(new URL('./fixtures/Ubuntu-R.ttf', import.meta.url));
const fontBytes = new Uint8Array(readFileSync(fixturePath));

function tableMap(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = view.getUint16(4, false);
  const map = new Map<string, Uint8Array>();
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(bytes[rec]!, bytes[rec + 1]!, bytes[rec + 2]!, bytes[rec + 3]!);
    const off = view.getUint32(rec + 8, false);
    const len = view.getUint32(rec + 12, false);
    map.set(tag, bytes.subarray(off, off + len));
  }
  return map;
}

function u16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, false);
}

/** Component glyph ids of one composite glyph in a long-loca glyf table. */
function componentGids(glyf: Uint8Array, loca: Uint8Array, gid: number): number[] {
  const lv = new DataView(loca.buffer, loca.byteOffset, loca.byteLength);
  const start = lv.getUint32(gid * 4, false);
  const end = lv.getUint32((gid + 1) * 4, false);
  const g = glyf.subarray(start, end);
  if (g.length < 10) return [];
  const gv = new DataView(g.buffer, g.byteOffset, g.byteLength);
  if (gv.getInt16(0, false) !== -1) return [];
  const ids: number[] = [];
  let o = 10;
  let flags = 0;
  do {
    flags = gv.getUint16(o, false);
    ids.push(gv.getUint16(o + 2, false));
    o += 4;
    o += flags & 0x0001 ? 4 : 2;
    if (flags & 0x0008) o += 2;
    else if (flags & 0x0040) o += 4;
    else if (flags & 0x0080) o += 8;
  } while (flags & 0x0020);
  return ids;
}

/** Table-directory checksum per the TrueType spec (big-endian uint32 sum). */
function tableChecksum(data: Uint8Array): number {
  let sum = 0;
  const padded = data.length + ((4 - (data.length % 4)) % 4);
  for (let i = 0; i < padded; i += 4) {
    const b0 = data[i] ?? 0, b1 = data[i + 1] ?? 0, b2 = data[i + 2] ?? 0, b3 = data[i + 3] ?? 0;
    sum = (sum + ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3)) >>> 0;
  }
  return sum >>> 0;
}

describe('parseTtf', () => {
  const font = parseTtf(fontBytes);

  it('parses head/hhea/OS2 metrics', () => {
    expect(font.unitsPerEm).toBe(1000);
    expect(font.numGlyphs).toBeGreaterThan(1000);
    expect(font.ascender).toBeGreaterThan(0);
    expect(font.descender).toBeLessThan(0);
    expect(font.bbox.xMax).toBeGreaterThan(font.bbox.xMin);
  });

  it('extracts names', () => {
    // This fixture is the 2010-era beta Ubuntu font: its nameID 6 is "Ubuntu".
    expect(font.postscriptName).toBe('Ubuntu');
    expect(font.familyName).toMatch(/Ubuntu/);
  });

  it('maps codepoints through cmap (format 4 or 12)', () => {
    expect([4, 12]).toContain(font.cmapFormat);
    expect(font.mapCodepoint(0x41)).toBeGreaterThan(0); // 'A'
    expect(font.mapCodepoint(0x20)).toBeGreaterThan(0); // space
    // Cyrillic and Greek coverage is the reason we embed this fixture
    expect(font.mapCodepoint(0x41f)).toBeGreaterThan(0); // 'П'
    expect(font.mapCodepoint(0x393)).toBeGreaterThan(0); // 'Γ'
    // not in font -> .notdef
    expect(font.mapCodepoint(0x10fffe)).toBe(0);
  });

  it('returns per-glyph advances and raw glyf data', () => {
    const gid = font.mapCodepoint(0x41);
    expect(font.advances[gid]).toBeGreaterThan(0);
    expect(font.glyphData(gid).length).toBeGreaterThan(0);
    // space glyph exists but may have empty outlines; advance must be set
    expect(font.advances[font.mapCodepoint(0x20)]).toBeGreaterThan(0);
  });

  it('rejects OTF/CFF and TTC with clear errors', () => {
    const otto = fontBytes.slice(); otto.set([0x4f, 0x54, 0x54, 0x4f]);
    expect(() => parseTtf(otto)).toThrow(/OTF\/CFF/);
    const ttc = fontBytes.slice(); ttc.set([0x74, 0x74, 0x63, 0x66]);
    expect(() => parseTtf(ttc)).toThrow(/TTC/);
  });
});

describe('glyphClosure', () => {
  const font = parseTtf(fontBytes);

  it('always includes .notdef (gid 0)', () => {
    expect(glyphClosure(font, [0x41]).has(0)).toBe(true);
  });

  it('pulls in composite components (accented letters)', () => {
    // 'Ä' (U+00C4) is typically a composite of 'A' + dieresis
    const closure = glyphClosure(font, [0xc4]);
    const gidA = font.mapCodepoint(0x41);
    expect(closure.has(font.mapCodepoint(0xc4))).toBe(true);
    expect(closure.has(gidA)).toBe(true);
  });

  it('skips codepoints absent from the cmap', () => {
    const closure = glyphClosure(font, [0x10fffe]);
    expect(closure.size).toBe(1); // only .notdef
  });
});

describe('subsetTtf', () => {
  const font = parseTtf(fontBytes);
  const cps = [0x20, 0x41, 0x42, 0x41f, 0x440, 0x393, 0xb5]; // Latin + Cyrillic + Greek + µ
  const { bytes, glyphs } = subsetTtf(font, cps);

  it('shrinks the font dramatically', () => {
    expect(bytes.length).toBeLessThan(fontBytes.length / 4);
  });

  it('renumbers glyphs compactly and drops tables a CID font does not need', () => {
    // parseTtf still requires cmap and name. The subset drops both, so it is not re-parsed here.
    const tables = tableMap(bytes);
    expect([...tables.keys()].sort()).toEqual(['glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'post']);
    const post = tables.get('post')!;
    expect(post.length).toBe(32);
    expect(new DataView(post.buffer, post.byteOffset, post.byteLength).getUint32(0, false)).toBe(0x00030000);

    const closure = glyphClosure(font, cps);
    const numGlyphs = u16(tables.get('maxp')!, 4);
    expect(numGlyphs).toBe(closure.size);
    expect(numGlyphs).toBeLessThan(font.numGlyphs);

    const oldGids = [...closure].sort((a, b) => a - b);
    for (const cp of cps) {
      const old = font.mapCodepoint(cp);
      expect(glyphs.get(cp)).toBe(old === 0 ? 0 : oldGids.indexOf(old));
    }

    const hmtx = tables.get('hmtx')!;
    const hv = new DataView(hmtx.buffer, hmtx.byteOffset, hmtx.byteLength);
    const newA = glyphs.get(0x41)!;
    expect(newA).toBeGreaterThan(0);
    expect(hv.getUint16(newA * 4, false)).toBe(font.advances[font.mapCodepoint(0x41)]);
    expect(hv.getUint16(0, false)).toBe(font.advances[0]);

    const missing = subsetTtf(font, [0x41, 0x1f600]);
    expect(missing.glyphs.get(0x1f600)).toBe(0);
    expect(missing.glyphs.get(0x41)).toBeGreaterThan(0);
  });

  it('retargets composite component ids when glyphs are renumbered', () => {
    // U+00C4 is a composite of A (gid 36) and a dieresis. Those ids must be rewritten.
    const sub = subsetTtf(font, [0x00c4]);
    const tables = tableMap(sub.bytes);
    const oldGids = [...glyphClosure(font, [0x00c4])].sort((a, b) => a - b);
    const newA = oldGids.indexOf(font.mapCodepoint(0x41));
    const newAuml = sub.glyphs.get(0x00c4)!;
    const comps = componentGids(tables.get('glyf')!, tables.get('loca')!, newAuml);
    const numGlyphs = u16(tables.get('maxp')!, 4);
    expect(numGlyphs).toBe(oldGids.length);
    expect(font.mapCodepoint(0x41)).toBeGreaterThanOrEqual(numGlyphs);
    expect(newA).toBeGreaterThan(0);
    expect(comps).toContain(newA);
    for (const id of comps) expect(id).toBeLessThan(numGlyphs);
  });

  it('drops hinting instructions, since fpgm, prep and cvt are not in the subset', () => {
    // Ubuntu is hinted: the source glyph for "A" carries instructions.
    const sourceA = font.glyphData(font.mapCodepoint(0x41));
    const sv = new DataView(sourceA.buffer, sourceA.byteOffset, sourceA.byteLength);
    expect(sv.getUint16(10 + sv.getInt16(0, false) * 2, false)).toBeGreaterThan(0);

    const sub = subsetTtf(font, [0x41, 0x00c4]); // a simple glyph and a composite
    const tables = tableMap(sub.bytes);
    const glyf = tables.get('glyf')!;
    const loca = tables.get('loca')!;
    const lv = new DataView(loca.buffer, loca.byteOffset, loca.byteLength);
    const gv = new DataView(glyf.buffer, glyf.byteOffset, glyf.byteLength);
    let composites = 0;
    for (let g = 0; g < u16(tables.get('maxp')!, 4); g++) {
      const start = lv.getUint32(g * 4, false);
      const end = lv.getUint32(g * 4 + 4, false);
      if (end - start < 10) continue;
      const contours = gv.getInt16(start, false);
      if (contours >= 0) {
        expect(gv.getUint16(start + 10 + contours * 2, false)).toBe(0);
        continue;
      }
      composites++;
      let o = start + 10;
      let flags: number;
      do {
        flags = gv.getUint16(o, false);
        expect(flags & 0x0100).toBe(0); // WE_HAVE_INSTRUCTIONS
        o += 4 + (flags & 0x0001 ? 4 : 2) + (flags & 0x0008 ? 2 : flags & 0x0040 ? 4 : flags & 0x0080 ? 8 : 0);
      } while (flags & 0x0020);
      expect(end - o).toBeLessThan(4); // only padding after the last component
    }
    expect(composites).toBeGreaterThan(0);
    expect(u16(tables.get('maxp')!, 20)).toBe(0); // maxFunctionDefs
    expect(u16(tables.get('maxp')!, 26)).toBe(0); // maxSizeOfInstructions
  });

  it('writes correct table checksums and checkSumAdjustment', () => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const numTables = view.getUint16(4, false);
    let headOff = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      const tag = String.fromCharCode(bytes[rec]!, bytes[rec + 1]!, bytes[rec + 2]!, bytes[rec + 3]!);
      const check = view.getUint32(rec + 4, false);
      const off = view.getUint32(rec + 8, false);
      const len = view.getUint32(rec + 12, false);
      const data = bytes.subarray(off, off + len);
      if (tag === 'head') { headOff = off; continue; } // head is special-cased below
      expect(tableChecksum(data)).toBe(check);
    }
    // Whole-file checksum must equal 0xB1B0AFBA when head.checkSumAdjustment is included
    expect(headOff).toBeGreaterThan(-1);
    expect(view.getUint32(headOff + 8, false)).not.toBe(0); // adjustment written back
    expect(tableChecksum(bytes)).toBe(0xb1b0afba);
  });

  it('is deterministic for identical input', () => {
    const again = subsetTtf(font, cps);
    expect(Buffer.from(again.bytes).equals(Buffer.from(bytes))).toBe(true);
  });
});
