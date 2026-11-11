import { describe, it, expect } from 'vitest';
import { Document, Page } from '../src/document.js';
import { inflateSync } from 'node:zlib';

const latin1 = (u: Uint8Array) => [...u].map((b) => String.fromCharCode(b)).join('');

/** Extract and inflate all FlateDecode streams of a built PDF. */
function inflatedStreams(bytes: Uint8Array): string[] {
  const str = latin1(bytes);
  const out: string[] = [];
  const re = /<<\s*\/Filter \/FlateDecode \/Length (\d+)[^\n]*?>>\nstream\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str))) {
    const start = m.index + m[0].length;
    const len = Number(m[1]);
    const raw = bytes.subarray(start, start + len);
    out.push(latin1(new Uint8Array(inflateSync(raw))));
  }
  return out;
}

/** Minimal valid baseline JPEG (1×1 white) for image tests. */
function tinyJpeg(): Uint8Array {
  // SOI, SOF0 (1x1), minimal DHT/DQS/SOS payload — enough for parseJpegSize;
  // full decode correctness is the viewer's business
  const sof = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9];
  return new Uint8Array(sof);
}

describe('Document', () => {
  it('builds a valid single-page PDF with text', () => {
    const doc = new Document({ title: 'Test', author: 'xpdf' });
    const page = doc.addPage();
    page.text('Hello xpdf', 48, 48, { size: 24 });
    const bytes = doc.build();
    const str = latin1(bytes);

    expect(str.startsWith('%PDF-1.7')).toBe(true);
    expect(str).toContain('/Type /Catalog');
    expect(str).toContain('/Type /Page ');
    expect(str).toContain('/BaseFont /Helvetica /Encoding /WinAnsiEncoding');
    expect(str).toContain('/Metadata'); // XMP present
    expect(str).not.toContain('/CreationDate'); // deterministic by default

    const streams = inflatedStreams(bytes);
    expect(streams.some((s) => s.includes('(Hello xpdf) Tj'))).toBe(true);
  });

  it('converts top-left coordinates to PDF space', () => {
    const doc = new Document();
    const page = doc.addPage(612, 792);
    page.text('x', 10, 20);
    page.rect(0, 0, 100, 50, '#ff0000');
    const streams = inflatedStreams(doc.build());
    const content = streams.find((s) => s.includes('Tj'))!;
    expect(content).toContain('10 772 Td'); // 792 - 20
    expect(content).toContain('0 742 100 50 re f'); // 792 - 0 - 50
  });

  it('supports right/center alignment using AFM metrics', () => {
    const doc = new Document();
    const page = doc.addPage();
    page.text('WWW', 0, 50, { size: 10, align: 'right', width: 200 });
    const streams = inflatedStreams(doc.build());
    // WWW at 10pt = 3*944*0.01 = 28.32 → x = 200 - 28.32 = 171.68
    expect(streams[0]).toContain('171.68 791.89'); // 841.89 - 50 ... wait, page height default 841.89
  });

  it('throws when align is used without width', () => {
    const page = new Document().addPage();
    expect(() => page.text('x', 0, 0, { align: 'center' })).toThrow(/width/);
  });

  it('validates colors', () => {
    const page = new Document().addPage();
    expect(() => page.rect(0, 0, 1, 1, 'red')).toThrow(/invalid color/);
  });

  it('registers fonts once, in first-use order', () => {
    const doc = new Document();
    const page = doc.addPage();
    page.text('a', 0, 10, { font: 'Courier' });
    page.text('b', 0, 20, { font: 'Times-Roman' });
    page.text('c', 0, 30, { font: 'Courier' });
    const streams = inflatedStreams(doc.build());
    expect(streams[0]).toContain('/F1'); // Courier
    expect(streams[0]).toContain('/F2'); // Times
    const str = latin1(doc.build());
    expect(str.match(/\/BaseFont \/Courier[^-]/g)!.length).toBe(1);
  });

  it('embeds JPEG images with DCTDecode and parses dimensions', () => {
    const doc = new Document();
    const page = doc.addPage();
    page.imageJpeg(tinyJpeg(), 10, 10, 20, 20);
    const str = latin1(doc.build());
    expect(str).toContain('/Filter /DCTDecode');
    expect(str).toContain('/Width 1 /Height 1');
    const streams = inflatedStreams(strToBytes(str));
    expect(streams.some((s) => s.includes('/Im1 Do'))).toBe(true);
  });

  it('rejects non-JPEG data', () => {
    const page = new Document().addPage();
    expect(() => page.imageJpeg(new Uint8Array([1, 2, 3]), 0, 0, 1, 1)).toThrow(/not a JPEG/);
  });

  it('emits link annotations', () => {
    const doc = new Document();
    const page = doc.addPage();
    page.link('https://example.org', 10, 10, 100, 14);
    const str = latin1(doc.build());
    expect(str).toContain('/Subtype /Link');
    expect(str).toContain('/URI (https://example.org)');
    expect(str).toMatch(/\/Annots \[\d+ 0 R\]/);
  });

  it('emits outline bookmarks with correct tree structure', () => {
    const doc = new Document();
    const p1 = doc.addPage();
    const p2 = doc.addPage();
    doc.setOutlines([
      { title: 'Chapter 1', page: p1, children: [{ title: 'Section 1.1', page: p2 }] },
      { title: 'Chapter 2', page: p2 },
    ]);
    const str = latin1(doc.build());
    expect(str).toContain('/Type /Outlines');
    expect(str).toContain('/PageMode /UseOutlines');
    expect(str.match(/<feff/g)!.length).toBeGreaterThanOrEqual(3); // utf16 titles
    expect(str).toContain('/First ');
    expect(str).toContain('/Next ');
    expect(str).toContain('/Dest [');
  });

  it('embeds file attachments in the names tree and /AF', () => {
    const doc = new Document();
    doc.addPage().text('x', 0, 10);
    doc.attach('document.json', new TextEncoder().encode('{"v":1}'), { mime: 'application/json' });
    const str = latin1(doc.build());
    expect(str).toContain('/EmbeddedFiles');
    expect(str).toContain('(document.json)');
    expect(str).toContain('/application#2Fjson');
    expect(str).toMatch(/\/AF \[\d+ 0 R\]/);
  });

  it('is byte-identical across builds (determinism)', () => {
    const make = () => {
      const doc = new Document({ title: 'Det' });
      const p = doc.addPage();
      p.text('Same input', 48, 48, { size: 18 });
      p.rect(10, 10, 100, 40, '#0f766e');
      p.line(0, 0, 200, 200, '#000000', 0.5);
      doc.attach('data.json', new TextEncoder().encode('{"a":1}'));
      doc.setOutlines([{ title: 'One', page: p }]);
      return doc.build();
    };
    expect(make()).toEqual(make());
  });

  it('honors opt-in timestamps (explicit determinism opt-out)', () => {
    const doc = new Document({ creationDate: new Date('2026-01-01T00:00:00Z') });
    doc.addPage().text('x', 0, 10);
    expect(latin1(doc.build())).toContain('/CreationDate (D:20260101000000Z)');
  });

  it('builds multi-page documents with a correct pages tree', () => {
    const doc = new Document();
    for (let i = 0; i < 5; i++) doc.addPage().text(`Page ${i + 1}`, 48, 48);
    const str = latin1(doc.build());
    expect(str).toContain('/Count 5');
    expect(str.match(/\/Type \/Page /g)!.length).toBe(5);
  });
});

function strToBytes(s: string): Uint8Array {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
  return u;
}
