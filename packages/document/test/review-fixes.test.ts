import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LayoutDocument } from '../src/document.js';
import { FontRegistry, Measurer } from '../src/measurer.js';
import { ParagraphBlock, ImageBlock } from '../src/blocks.js';
import { breakLines, tokenize, type StyledRun } from '../src/line-break.js';
import { paginate, type PageGeometry, type PaginationContext } from '../src/paginator.js';
import type { BlockProps, ResolvedParagraphStyle } from '../src/types.js';

const latin1 = (u: Uint8Array) => [...u].map((b) => String.fromCharCode(b)).join('');

const registry = new FontRegistry();
const measurer = new Measurer(registry);

const run = (text: string, over: Partial<StyledRun> = {}): StyledRun => ({
  text,
  font: 'Helvetica',
  size: 12,
  color: '#000',
  ...over,
});

const opts = (width: number, align: 'left' | 'justify' = 'left') => ({
  widthAt: () => width,
  align,
  lineHeight: 1.25,
  fallback: { font: 'Helvetica', size: 12 },
});

/** A 1×1 RGB JPEG header: enough for the image block's size parsing. */
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03,
  0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
]);

describe('inline links', () => {
  it('carries href onto every word and space of the run', () => {
    const lines = breakLines(
      [run('See '), run('the long source title', { href: 'https://example.org/a' }), run(' here.')],
      measurer,
      opts(90),
    );
    const linked = lines.flatMap((l) => l.runs).filter((r) => r.href === 'https://example.org/a');
    const linkedText = linked.map((r) => r.text.trim()).join(' ');
    expect(linkedText).toBe('the long source title');
    // the link wraps, so more than one line has a linked fragment
    expect(lines.filter((l) => l.runs.some((r) => r.href)).length).toBeGreaterThan(1);
  });

  it('does not merge a linked run with plain text next to it', () => {
    const [line] = breakLines([run('plain '), run('linked', { href: 'https://example.org/' })], measurer, opts(500));
    expect(line!.runs.map((r) => [r.text, r.href])).toEqual([
      ['plain ', undefined],
      ['linked', 'https://example.org/'],
    ]);
  });

  it('writes one /URI annotation per line fragment', () => {
    const doc = new LayoutDocument({ margins: 200 });
    doc.paragraph([
      { text: 'Read ' },
      { text: 'the report from the standards body', href: 'https://example.org/report' },
      { text: ' for details.' },
    ]);
    const pdf = latin1(doc.build());
    const annots = pdf.split('/URI (https://example.org/report)').length - 1;
    expect(annots).toBeGreaterThan(1);
  });
});

describe('words made of several runs', () => {
  it('moves a link and the full stop after it to the next line together', () => {
    const width = measurer.width('Helvetica', 'aaa bbb', 12) + 0.5;
    const lines = breakLines(
      [run('aaa '), run('bbb', { href: 'https://example.org/' }), run('.')],
      measurer,
      opts(width),
    );
    expect(lines.map((l) => l.runs.map((r) => r.text).join(''))).toEqual(['aaa', 'bbb.']);
  });

  it('keeps a source number with the word it follows', () => {
    const width = measurer.width('Helvetica', 'see the list', 12) + 0.5;
    const lines = breakLines(
      [run('see the '), run('list', { href: 'https://example.org/' }), run(' [3]')],
      measurer,
      opts(width),
    );
    expect(lines.map((l) => l.runs.map((r) => r.text).join(''))).toEqual(['see the', 'list [3]']);
  });

  it('still breaks when one glued word is wider than the line', () => {
    const lines = breakLines([run('abcdefgh'), run('ijklmnop', { href: 'https://example.org/' })], measurer, opts(40));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.map((l) => l.runs.map((r) => r.text).join('')).join('')).toBe('abcdefghijklmnop');
  });
});

describe('long web addresses', () => {
  const url = 'https://www.example.org/reports/2026/annual-review/appendix-b.html?section=methods&lang=en';

  it('breaks after / - . ? & = and never inside the scheme', () => {
    const words = tokenize([run(url)], measurer).filter((t) => !t.glue).map((t) => t.text);
    expect(words.join('')).toBe(url);
    expect(words[0]).toBe('https://');
    expect(words.length).toBeGreaterThan(5);
  });

  it('wraps a long address across lines without losing characters', () => {
    const lines = breakLines([run(url)], measurer, opts(120));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.map((l) => l.runs.map((r) => r.text).join('')).join('')).toBe(url);
    for (const line of lines) expect(line.width).toBeLessThanOrEqual(120 + 1e-6);
  });

  it('leaves ordinary words with dots and hyphens whole', () => {
    const words = tokenize([run('e.g. well-known')], measurer).filter((t) => !t.glue).map((t) => t.text);
    expect(words).toEqual(['e.g.', 'well-known']);
  });
});

describe('footnote ids', () => {
  it('sits on the marker only, not on every word of the run', () => {
    const tokens = tokenize([run('alpha beta', { noteId: 1 })], measurer);
    const withId = tokens.filter((t) => t.noteId === 1);
    expect(withId.length).toBe(1);
    expect(withId[0]!.text).not.toBe('alpha');
    expect(withId[0]!.text).not.toBe('beta');
  });
});

describe('justified text', () => {
  it('still paints the spaces, so copied text keeps its word breaks', () => {
    const text = 'the quick brown fox jumps over the lazy dog and runs far away from here';
    const lines = breakLines([run(text)], measurer, opts(140, 'justify'));
    expect(lines.length).toBeGreaterThan(2);
    const joined = lines.map((l) => l.runs.map((r) => r.text).join('')).join(' ');
    expect(joined).toBe(text);
    for (const line of lines.slice(0, -1)) {
      const last = line.runs[line.runs.length - 1]!;
      expect(last.x + last.width).toBeCloseTo(140, 0);
    }
  });
});

describe('paginator guards', () => {
  // 12 lines of 15 pt per page (content height 180).
  const geom: PageGeometry = {
    pageWidth: 200, pageHeight: 200, marginTop: 10, marginRight: 10, marginBottom: 10, marginLeft: 10,
  };
  const style: ResolvedParagraphStyle = {
    font: 'Helvetica', size: 12, lineHeight: 1.25, color: '#000', align: 'left',
    spaceBefore: 0, spaceAfter: 0, indent: 0, firstLineIndent: 0,
  };
  const ctx: PaginationContext = {
    measurer,
    contentHeight: 180,
    defaultStyle: style,
    notes: new Map(),
    noteStyle: { font: 'Helvetica', size: 8.5, lineHeight: 1.25, color: '#000' },
  };
  const para = (n: number, props: BlockProps = {}, over: Partial<ResolvedParagraphStyle> = {}) =>
    new ParagraphBlock(
      Array.from({ length: n }, (_, i) => run(i < n - 1 ? `line${i}\n` : `line${n - 1}`)),
      { ...style, ...over },
      props,
      'P',
    );
  const heading = () =>
    new ParagraphBlock([run('Heading', { font: 'Helvetica-Bold' })], style, { keepWithNext: true }, 'H2');
  const textCount = (p: { placements: { slice: { kind: string } }[] }) =>
    p.placements.filter((x) => x.slice.kind === 'text').length;

  it('places an image taller than the page instead of looping', () => {
    const tall = new ImageBlock(JPEG, { width: 100, height: 500 });
    const pages = paginate([para(2), tall, para(2)], ctx, geom);
    expect(pages.length).toBeLessThanOrEqual(3);
    expect(pages.some((p) => p.placements.some((x) => x.slice.kind === 'image'))).toBe(true);
  });

  it('keeps a heading at the very end of the document on its page', () => {
    const pages = paginate([para(11), heading()], ctx, geom);
    expect(pages.length).toBe(1);
    expect(textCount(pages[0]!)).toBe(12);
  });

  it('still moves a heading at the foot of a page to the next block', () => {
    const pages = paginate([para(11), heading(), para(3)], ctx, geom);
    expect(pages.length).toBe(2);
    expect(textCount(pages[0]!)).toBe(11);
  });

  it('does not loop when a heading is followed by a block taller than a page', () => {
    const tall = new ImageBlock(JPEG, { width: 100, height: 500 });
    const pages = paginate([heading(), tall], ctx, geom);
    expect(pages.length).toBeLessThanOrEqual(2);
  });

  it('ends the page on a space that does not fit, without pulling lines back', () => {
    const pages = paginate([para(11), para(1, {}, { spaceAfter: 20 }), para(1)], ctx, geom);
    expect(pages.length).toBe(2);
    expect(textCount(pages[0]!)).toBe(12);
  });
});

describe('document metadata', () => {
  it('writes bookmarks for headings only when asked', () => {
    const build = (outline: boolean) => {
      const doc = new LayoutDocument({ title: 'T', outline });
      doc.heading('Introduction', 1).paragraph('Body text.').heading('Method', 2).paragraph('More.');
      return latin1(doc.build());
    };
    const utf16 = (t: string) => `<feff${[...t].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('')}>`;
    const withOutline = build(true);
    expect(withOutline).toContain('/Outlines');
    expect(withOutline).toContain(`/Title ${utf16('Introduction')}`);
    expect(withOutline).toContain(`/Title ${utf16('Method')}`);
    const without = build(false);
    expect(without).not.toContain('/Outlines');
    expect(without).not.toContain(`/Title ${utf16('Method')}`);
  });

  it('leaves out a registered face that is never drawn', () => {
    const fixture = fileURLToPath(new URL('../../core/test/fixtures/Ubuntu-R.ttf', import.meta.url));
    const make = (useIt: boolean) => {
      const doc = new LayoutDocument({});
      doc.font('ubuntu', new Uint8Array(readFileSync(fixture)));
      doc.paragraph('Only base-14 text here.', useIt ? { font: 'ubuntu' } : {});
      return latin1(doc.build());
    };
    expect(make(false)).not.toContain('/FontFile2');
    expect(make(true)).toContain('/FontFile2');
  });

  it('passes the language to the catalog', () => {
    const doc = new LayoutDocument({ title: 'T', lang: 'en' });
    doc.paragraph('Hello.');
    const pdf = latin1(doc.build());
    expect(pdf).toContain('/Lang (en)');
    expect(pdf).toContain('/DisplayDocTitle true');
  });
});
