import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { Document, asciiUri, parseJpegSize } from '../src/document.js';
import { getFontMetrics } from '../src/fonts/standard.js';
import { parseTtf } from '../src/fonts/ttf.js';

const latin1 = (u: Uint8Array) => [...u].map((b) => String.fromCharCode(b)).join('');

function inflatedStreams(bytes: Uint8Array): string[] {
  const str = latin1(bytes);
  const out: string[] = [];
  const re = /<<\s*\/Filter \/FlateDecode \/Length (\d+)[^\n]*?>>\nstream\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str))) {
    const start = m.index + m[0].length;
    out.push(latin1(new Uint8Array(inflateSync(bytes.subarray(start, start + Number(m[1]))))));
  }
  return out;
}

/** A 1×1 baseline JPEG header with `components` colour components. */
function jpegWith(components: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, components,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ]);
}

describe('catalog', () => {
  it('writes /Lang and asks viewers to show the title', () => {
    const doc = new Document({ title: 'Report', lang: 'en-GB' });
    doc.addPage();
    const pdf = latin1(doc.build());
    expect(pdf).toContain('/Lang (en-GB)');
    expect(pdf).toContain('/ViewerPreferences << /DisplayDocTitle true >>');
  });

  it('leaves both out when neither is given', () => {
    const doc = new Document({});
    doc.addPage();
    const pdf = latin1(doc.build());
    expect(pdf).not.toContain('/Lang');
    expect(pdf).not.toContain('/DisplayDocTitle');
  });
});

describe('link annotations', () => {
  it('percent-encodes non-ASCII web addresses instead of failing', () => {
    expect(asciiUri('https://example.org/café?q=ü')).toBe('https://example.org/caf%C3%A9?q=%C3%BC');
    expect(asciiUri('https://example.org/a b')).toBe('https://example.org/a%20b');
    expect(asciiUri('https://example.org/(x)')).toBe('https://example.org/(x)');
    const doc = new Document({});
    doc.addPage().link('https://example.org/café', 10, 10, 50, 12);
    const pdf = latin1(doc.build());
    expect(pdf).toContain('/URI (https://example.org/caf%C3%A9)');
  });

  it('draws no border in any viewer', () => {
    const doc = new Document({});
    doc.addPage().link('https://example.org/', 10, 10, 50, 12);
    expect(latin1(doc.build())).toContain('/Border [0 0 0] /BS << /W 0 >>');
  });
});

describe('text state', () => {
  it('resets character spacing so it cannot leak into later text', () => {
    const doc = new Document({ compress: true });
    const page = doc.addPage();
    page.text('spaced', 10, 20, { charSpacing: 2 });
    page.text('plain', 10, 40);
    const content = inflatedStreams(doc.build()).find((s) => s.includes('(spaced)'))!;
    expect(content).toMatch(/2 Tc[^]*\(spaced\) Tj 0 Tc ET/);
  });
});

function codePoints(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) out.push(ch.codePointAt(0)!);
  return out;
}

function utf16Hex(cp: number): string {
  const s = String.fromCodePoint(cp);
  let hex = '';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0');
  return hex;
}

/** CID hex -> Unicode hex from a ToUnicode CMap. */
function toUnicodeMap(cmap: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of cmap.matchAll(/beginbfchar\n([^]*?)\nendbfchar/g)) {
    for (const line of block[1]!.split('\n')) {
      const m = /^<([0-9a-fA-F]+)> <([0-9a-fA-F]+)>$/.exec(line.trim());
      if (m) map.set(m[1]!.toLowerCase(), m[2]!.toLowerCase());
    }
  }
  return map;
}

describe('embedded font maps', () => {
  const fixture = fileURLToPath(new URL('./fixtures/Ubuntu-R.ttf', import.meta.url));
  const fontBytes = new Uint8Array(readFileSync(fixture));

  it('writes each glyph once in /W and ToUnicode', () => {
    const doc = new Document({});
    const font = doc.embedFont(fontBytes);
    // NBSP, hyphen and soft hyphen often share a glyph with another character.
    // U+2011 is missing from this face: it must still extract, as U+FFFD.
    const text = 'a b c - d­ e ‑ f';
    doc.addPage().text(text, 10, 20, { font, size: 12 });
    const built = doc.build();
    const pdf = latin1(built);
    const cmap = inflatedStreams(built).find((s) => s.includes('begincmap'))!;
    const pairs = toUnicodeMap(cmap);
    const sources = [...pairs.keys()];
    expect(sources.length).toBeGreaterThan(0);
    expect(new Set(sources).size).toBe(sources.length);

    const face = parseTtf(fontBytes);
    const used = [...new Set(codePoints(text))].sort((a, b) => a - b);
    expect(pairs.size).toBe(used.length);
    for (const cp of used) {
      const want = face.mapCodepoint(cp) === 0 ? 0xfffd : cp;
      expect([...pairs.values()]).toContain(utf16Hex(want));
    }
    // one /W width per used code point, equal to the advance layout uses
    const wBody = /\/W \[([^\]]*)\]/.exec(pdf)![1]!;
    const widths = wBody.replace(/^\d+\s*\[/, '').replace(/\]$/, '').trim().split(/\s+/).map(Number);
    expect(widths).toHaveLength(used.length);
    const upem = face.unitsPerEm;
    used.forEach((cp, i) => {
      const gid = face.mapCodepoint(cp);
      const advance = Math.round(((face.advances[gid] ?? 0) * 1000) / upem);
      expect(widths[i]).toBe(advance);
      expect(font.widthAt(String.fromCodePoint(cp), 1000)).toBe(advance);
    });
  });

  it('gives two code points that share a glyph their own CIDs and extractable text', () => {
    // Ubuntu maps U+0000 and U+0008 to the same glyph.
    const doc = new Document({});
    const font = doc.embedFont(fontBytes);
    doc.addPage().text('A\u0000B\u0008', 10, 20, { font, size: 12 });
    const cmap = inflatedStreams(doc.build()).find((s) => s.includes('begincmap'))!;
    const pairs = toUnicodeMap(cmap);
    const nullCid = [...pairs.entries()].find(([, u]) => u === '0000')![0];
    const backspaceCid = [...pairs.entries()].find(([, u]) => u === '0008')![0];
    expect(nullCid).not.toBe(backspaceCid);
    expect(pairs.get(nullCid)).toBe('0000');
    expect(pairs.get(backspaceCid)).toBe('0008');
    expect(pairs.get([...pairs.keys()].find((k) => pairs.get(k) === '0041')!)).toBe('0041');
  });

  it('encodes a missing character as .notdef width and extracts U+FFFD', () => {
    const doc = new Document({});
    const font = doc.embedFont(fontBytes);
    const face = parseTtf(fontBytes);
    expect(face.mapCodepoint(0x00ad)).toBeGreaterThan(0); // this face has a soft hyphen
    expect(face.mapCodepoint(0x1f600)).toBe(0);
    expect(face.mapCodepoint(0x2010)).toBe(0);
    doc.addPage().text('x\u2010\u{1F600}', 10, 20, { font, size: 12 });
    const built = doc.build();
    const pairs = toUnicodeMap(inflatedStreams(built).find((s) => s.includes('begincmap'))!);
    const values = [...pairs.values()];
    expect(values.filter((v) => v === 'fffd')).toHaveLength(2);
    expect(values).toContain('0078');
    const notdef = Math.round(((face.advances[0] ?? 0) * 1000) / face.unitsPerEm);
    expect(font.widthAt('\u2010', 1000)).toBe(notdef);
    expect(font.widthAt('\u{1F600}', 1000)).toBe(notdef);
    const widths = /\/W \[([^\]]*)\]/.exec(latin1(built))![1]!
      .replace(/^\d+\s*\[/, '').replace(/\]$/, '').trim().split(/\s+/).map(Number);
    expect(widths.filter((w) => w === notdef)).toHaveLength(2);
  });

  it('sets nonsymbolic flags, plus italic when the italic angle is not zero', () => {
    const upright = new Document({});
    const uprightFont = upright.embedFont(fontBytes);
    upright.addPage().text('A', 10, 20, { font: uprightFont, size: 12 });
    expect(latin1(upright.build())).toContain('/Flags 32 ');
    expect(latin1(upright.build())).not.toContain('/Flags 4 ');

    const bytes = new Uint8Array(fontBytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = view.getUint16(4, false);
    for (let i = 0; i < n; i++) {
      const rec = 12 + i * 16;
      const tag = String.fromCharCode(bytes[rec]!, bytes[rec + 1]!, bytes[rec + 2]!, bytes[rec + 3]!);
      if (tag === 'post') {
        view.setInt32(view.getUint32(rec + 8, false) + 4, -12 * 65536, false);
        break;
      }
    }
    const italic = new Document({});
    const face = italic.embedFont(bytes);
    italic.addPage().text('A', 10, 20, { font: face, size: 12 });
    expect(latin1(italic.build())).toContain('/Flags 96 ');
  });
});

describe('link characters outside RFC 3986', () => {
  it('percent-encodes delimiters and does not double-encode %XX', () => {
    expect(asciiUri('https://example.org/a"b<c>d{e}f|g^h`i\\j')).toBe(
      'https://example.org/a%22b%3Cc%3Ed%7Be%7Df%7Cg%5Eh%60i%5Cj',
    );
    expect(asciiUri('https://example.org/a%20b')).toBe('https://example.org/a%20b');
    expect(asciiUri('https://example.org/100%')).toBe('https://example.org/100%25');
    expect(asciiUri('https://example.org/a b')).toBe('https://example.org/a%20b');
  });
});

describe('attachment name tree', () => {
  it('sorts EmbeddedFiles names by string bytes, not attachment order', () => {
    const doc = new Document({});
    doc.addPage();
    doc.attach('z.dat', new Uint8Array([1]));
    doc.attach('a.dat', new Uint8Array([2]));
    doc.attach('m.dat', new Uint8Array([3]));
    const pdf = latin1(doc.build());
    const names = /\/EmbeddedFiles << \/Names \[([^\]]+)\] >>/.exec(pdf)![1]!;
    const keys = [...names.matchAll(/\((?:\\.|[^)])*\)/g)].map((m) => m[0]);
    expect(keys).toEqual(['(a.dat)', '(m.dat)', '(z.dat)']);
  });
});

describe('JPEG markers without a length', () => {
  function sof(components = 1): number[] {
    return [0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, components, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  }

  it('skips 0xFF fill and stand-alone RST and TEM markers', () => {
    const expectSize = (bytes: number[]) =>
      expect(parseJpegSize(new Uint8Array(bytes))).toEqual({ width: 3, height: 2, components: 1 });
    expectSize([0xff, 0xd8, 0xff, 0xff, ...sof(), 0xff, 0xd9]);
    expectSize([0xff, 0xd8, 0xff, 0xd0, ...sof(), 0xff, 0xd9]);
    expectSize([0xff, 0xd8, 0xff, 0x01, ...sof(), 0xff, 0xd9]);
    expectSize([0xff, 0xd8, 0xff, 0xff, 0xd7, ...sof(), 0xff, 0xd9]);
  });
});

describe('base-14 measurement matches Tj', () => {
  it('aligns text with the unkerned width that Tj paints', () => {
    const unkerned = getFontMetrics('Helvetica').widthAt('AV', 10, { kern: false });
    const doc = new Document({ compress: false });
    doc.addPage(200, 200).text('AV', 0, 50, { size: 10, align: 'right', width: 200 });
    const pdf = latin1(doc.build());
    expect(pdf).toContain(`${200 - unkerned} 150 Td`);
  });
});

describe('JPEG colour space', () => {
  it('reads the component count', () => {
    expect(parseJpegSize(jpegWith(1))).toEqual({ width: 1, height: 1, components: 1 });
    expect(parseJpegSize(jpegWith(3)).components).toBe(3);
  });

  it('uses DeviceGray for greyscale and DeviceRGB for colour', () => {
    const grey = new Document({});
    grey.addPage().imageJpeg(jpegWith(1), 0, 0, 10, 10);
    expect(latin1(grey.build())).toContain('/ColorSpace /DeviceGray');
    const rgb = new Document({});
    rgb.addPage().imageJpeg(jpegWith(3), 0, 0, 10, 10);
    expect(latin1(rgb.build())).toContain('/ColorSpace /DeviceRGB /BitsPerComponent 8');
  });

  it('refuses CMYK instead of drawing wrong colours', () => {
    const doc = new Document({});
    expect(() => doc.addPage().imageJpeg(jpegWith(4), 0, 0, 10, 10)).toThrow(/4 colour components/);
  });
});
