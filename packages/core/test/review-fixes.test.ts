import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { Document, asciiUri, parseJpegSize } from '../src/document.js';

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

describe('embedded font maps', () => {
  it('writes each glyph once in /W and ToUnicode', () => {
    const fixture = fileURLToPath(new URL('./fixtures/Ubuntu-R.ttf', import.meta.url));
    const doc = new Document({});
    const font = doc.embedFont(new Uint8Array(readFileSync(fixture)));
    // NBSP, hyphen and soft hyphen often share a glyph with another character.
    doc.addPage().text('a b c - d­ e ‑ f', 10, 20, { font, size: 12 });
    const streams = inflatedStreams(doc.build());
    const cmap = streams.find((s) => s.includes('begincmap'))!;
    const pairs = [...cmap.matchAll(/beginbfchar\n([^]*?)\nendbfchar/g)].flatMap((m) => m[1]!.split('\n'));
    const sources = pairs.map((line) => /^<([0-9a-f]{4})>/.exec(line)![1]);
    expect(sources.length).toBeGreaterThan(0);
    expect(new Set(sources).size).toBe(sources.length);
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
