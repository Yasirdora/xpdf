import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Document } from '../src/document.js';
import { EmbeddedFont } from '../src/fonts/embedded.js';
import { inflateSync } from 'node:zlib';

const fixturePath = fileURLToPath(new URL('./fixtures/Ubuntu-R.ttf', import.meta.url));
const fontBytes = new Uint8Array(readFileSync(fixturePath));

const latin1 = (u: Uint8Array) => [...u].map((b) => String.fromCharCode(b)).join('');

/** Extract and inflate all FlateDecode streams of a built PDF. */
function inflatedStreams(bytes: Uint8Array): string[] {
  const str = latin1(bytes);
  const out: string[] = [];
  const re = /<<\s*\/Filter \/FlateDecode \/Length (\d+)[^\n]*?>>\nstream\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str))) {
    const start = m.index + m[0].length;
    const raw = bytes.subarray(start, start + Number(m[1]));
    out.push(latin1(new Uint8Array(inflateSync(raw))));
  }
  return out;
}

function buildDoc(): { bytes: Uint8Array; font: EmbeddedFont } {
  const doc = new Document({ title: 'Unicode test' });
  const font = doc.embedFont(fontBytes);
  const page = doc.addPage();
  page.text('Привет, мир!', 50, 60, { font, size: 18 }); // Russian
  page.text('Γειά σου, κόσμε!', 50, 90, { font, size: 18 }); // Greek
  page.text('Hello µ- world — mixed', 50, 120, { font, size: 12 });
  page.text('Aligned Cyrillic: Привет', 50, 150, { font, size: 12, align: 'right', width: 400 });
  return { bytes: doc.build(), font };
}

describe('embedded TrueType fonts in Document', () => {
  it('embeds Type0/CIDFontType2 with Identity-H and ToUnicode', () => {
    const { bytes } = buildDoc();
    const pdf = latin1(bytes);
    expect(pdf).toContain('/Subtype /Type0');
    expect(pdf).toContain('/Encoding /Identity-H');
    expect(pdf).toContain('/Subtype /CIDFontType2');
    expect(pdf).toContain('/ToUnicode');
    expect(pdf).toContain('/FontFile2');
    // CIDs are not glyph ids. A stream maps them; /Identity would collapse shared glyphs.
    expect(pdf).not.toContain('/CIDToGIDMap /Identity');
    expect(pdf).toMatch(/\/CIDToGIDMap \d+ 0 R/);
    expect(pdf).toContain('/FontDescriptor');
    // regression: the Type0 font must be wired into /Resources, not just emitted
    expect(pdf).toMatch(/\/Font << \/F\d+ \d+ 0 R >>/);
  });

  it('uses a subset tag in the font name (ABCDEF+Name)', () => {
    const { bytes } = buildDoc();
    const pdf = latin1(bytes);
    expect(pdf).toMatch(/\/BaseFont \/[A-Z]{6}\+Ubuntu\b/);
  });

  it('embeds a subset much smaller than the full font', () => {
    const { bytes } = buildDoc();
    // whole PDF (incl. font) should be far below the 353KB source font
    expect(bytes.length).toBeLessThan(fontBytes.length / 4);
  });

  it('measures text for alignment without throwing', () => {
    // the aligned text() call in buildDoc already exercises widthAt + encodeHex;
    // reaching build() proves the path works end to end
    const { font } = buildDoc();
    expect(font.widthAt('Привет', 18)).toBeGreaterThan(0);
    expect(font.supports('Привет µ Γειά')).toBe(true);
    expect(font.supports('日本語')).toBe(false); // Ubuntu has no CJK
  });

  it('is byte-deterministic across builds', () => {
    const a = buildDoc().bytes;
    const b = buildDoc().bytes;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('encodes the only used code point as CID 1, not its original glyph id', () => {
    const doc = new Document();
    const font = doc.embedFont(fontBytes);
    const page = doc.addPage();
    page.text('A', 50, 60, { font, size: 18 });
    const bytes = doc.build();
    const streams = inflatedStreams(bytes);
    // Sorted code points: 'A' is CID 1. Its TrueType gid is 36 (0x0024), which must not be the operand.
    expect(streams.some((s) => s.includes('<0001> Tj'))).toBe(true);
    expect(streams.some((s) => s.includes('<0024> Tj'))).toBe(false);
    const cmap = streams.find((s) => s.includes('begincmap'));
    expect(cmap).toContain('<0001> <0041>');
    // Closure is .notdef then A, so CID 1's map entry is the renumbered gid 1.
    const map = streams.find(
      (s) => s.length === 4 && s.charCodeAt(0) === 0 && s.charCodeAt(1) === 0 && s.charCodeAt(2) === 0 && s.charCodeAt(3) === 1,
    );
    expect(map).toBeDefined();
  });
});
