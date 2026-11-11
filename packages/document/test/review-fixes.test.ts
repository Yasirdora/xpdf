import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { LayoutDocument } from '../src/document.js';
import { FontRegistry, Measurer } from '../src/measurer.js';
import { ParagraphBlock, ImageBlock, PageBreakBlock } from '../src/blocks.js';
import { TableBlock, type ResolvedTableStyle } from '../src/table.js';
import { breakLines, tokenize, type StyledRun } from '../src/line-break.js';
import { paginate, type PageGeometry, type PaginationContext } from '../src/paginator.js';
import type { BlockProps, PageLayout, ResolvedParagraphStyle, Slice } from '../src/types.js';

const latin1 = (u: Uint8Array) => [...u].map((b) => String.fromCharCode(b)).join('');

function inflatedText(bytes: Uint8Array): string {
  const str = latin1(bytes);
  const out: string[] = [];
  const re = /<<\s*\/Filter \/FlateDecode \/Length (\d+)[^\n]*?>>\nstream\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str))) {
    const raw = bytes.subarray(m.index + m[0].length, m.index + m[0].length + Number(m[1]));
    out.push(latin1(new Uint8Array(inflateSync(raw))));
  }
  return out.join('\n');
}

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
    expect(pageText(pages[0]!)).not.toContain('Heading');
    expect(pageText(pages[1]!)).toContain('Heading');
    expect(pageText(pages[1]!)).toContain('line0');
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
});

describe('web addresses with more than one scheme', () => {
  const archive = 'https://web.archive.org/web/2024/https://example.org/a/long/path';
  const redirect = 'www.example.com/redirect?url=https://example.org/a/very/long/path';

  function pieces(word: string): string[] {
    return tokenize([run(word)], measurer).map((t) => t.text);
  }

  it('protects every :// and still breaks a www address before a later scheme', () => {
    const archived = pieces(archive);
    expect(archived.join('')).toBe(archive);
    expect(archived[0]).toBe('https://');
    for (let i = 0; i < archived.length - 1; i++) {
      expect(archived[i]!.endsWith(':') && archived[i + 1]!.startsWith('//')).toBe(false);
    }
    expect(archived.filter((p) => p === 'https://')).toHaveLength(2);

    const redirected = pieces(redirect);
    expect(redirected.join('')).toBe(redirect);
    expect(redirected[0]).toBe('www.');
    expect(redirected.length).toBeGreaterThan(4);
    expect(redirected).toContain('https://');
    const schemeAt = redirected.indexOf('https://');
    expect(schemeAt).toBeGreaterThan(0);
  });
});

describe('line endings and glue the font cannot draw', () => {
  it('treats CR and CRLF as one line break', () => {
    const lines = breakLines([run('a\r\nb\rc')], measurer, opts(400));
    expect(lines.map((l) => l.runs.map((r) => r.text).join(''))).toEqual(['a', 'b', 'c']);
  });

  it('draws a tab and an em space as U+0020', () => {
    const lines = breakLines([run('a\tb\u2003c')], measurer, opts(400));
    expect(lines[0]!.runs.map((r) => r.text).join('')).toBe('a b c');
    const doc = new LayoutDocument({});
    doc.paragraph('a\tb\u2003c');
    expect(inflatedText(doc.build())).toContain('(a b c)');
  });

  it('keeps the measured width of an embedded glue character the font lacks', () => {
    const fixture = fileURLToPath(new URL('../../core/test/fixtures/Ubuntu-R.ttf', import.meta.url));
    const fonts = new FontRegistry();
    fonts.register('ubuntu', new Uint8Array(readFileSync(fixture)));
    const embedded = new Measurer(fonts);
    const em = embedded.width('ubuntu', '\u2003', 12);
    const space = embedded.width('ubuntu', ' ', 12);
    expect(em).not.toBeCloseTo(space);
    const lines = breakLines([run('a\u2003b', { font: 'ubuntu' })], embedded, opts(400));
    expect(lines[0]!.runs.map((r) => r.text)).toEqual(['a', ' ', 'b']);
    expect(lines[0]!.runs[2]!.x).toBeCloseTo(lines[0]!.runs[0]!.width + em);
    expect(lines[0]!.width).toBeCloseTo(
      embedded.width('ubuntu', 'a', 12) + em + embedded.width('ubuntu', 'b', 12),
    );
  });
});

describe('base-14 kerning', () => {
  it('measures without kern pairs so the width matches Tj', () => {
    const pair = measurer.width('Helvetica', 'AV', 1000);
    const sum = measurer.width('Helvetica', 'A', 1000) + measurer.width('Helvetica', 'V', 1000);
    expect(pair).toBe(sum);
  });
});

function pageText(page: PageLayout): string {
  return page.placements.map((p) => sliceText(p.slice)).join('');
}

function sliceText(slice: Slice): string {
  if (slice.kind === 'text') return slice.lines.map((l) => l.runs.map((r) => r.text).join('')).join('');
  if (slice.kind === 'table-row') {
    return slice.cells.map((c) => c.lines.map((l) => l.runs.map((r) => r.text).join('')).join('')).join('');
  }
  return '';
}

describe('widows across earlier pages', () => {
  const geom: PageGeometry = {
    pageWidth: 200, pageHeight: 200, marginTop: 10, marginRight: 10, marginBottom: 10, marginLeft: 10,
  };
  const style: ResolvedParagraphStyle = {
    font: 'Helvetica', size: 12, lineHeight: 1.25, color: '#000', align: 'left',
    spaceBefore: 0, spaceAfter: 0, indent: 0, firstLineIndent: 0,
  };
  const ctx: PaginationContext = {
    measurer, contentHeight: 180, defaultStyle: style, notes: new Map(),
    noteStyle: { font: 'Helvetica', size: 8.5, lineHeight: 1.25, color: '#000' },
  };
  const para = (n: number) =>
    new ParagraphBlock(
      Array.from({ length: n }, (_, i) => run(i < n - 1 ? `L${i}\n` : `L${n - 1}`)),
      style, { widows: 2, orphans: 2 }, 'P',
    );

  it('does not leave a single line of a three-page paragraph', () => {
    const pages = paginate([para(25)], ctx, geom);
    const counts = pages.map((p) => p.placements.filter((x) => x.slice.kind === 'text').length);
    expect(pages.length).toBe(3);
    expect(counts).toEqual([12, 11, 2]);
    expect(pageText(pages[2]!)).toContain('L23');
    expect(pageText(pages[2]!)).toContain('L24');
    expect(pageText(pages[2]!)).not.toContain('L22');
  });
});

describe('tables, breaks, and overlong glue', () => {
  const geom: PageGeometry = {
    pageWidth: 200, pageHeight: 200, marginTop: 10, marginRight: 10, marginBottom: 10, marginLeft: 10,
  };
  const style: ResolvedParagraphStyle = {
    font: 'Helvetica', size: 12, lineHeight: 1.25, color: '#000', align: 'left',
    spaceBefore: 0, spaceAfter: 0, indent: 0, firstLineIndent: 0,
  };
  const ctx: PaginationContext = {
    measurer, contentHeight: 180, defaultStyle: style, notes: new Map(),
    noteStyle: { font: 'Helvetica', size: 8.5, lineHeight: 1.25, color: '#000' },
  };
  const tableStyle: ResolvedTableStyle = {
    font: 'Helvetica', size: 10, lineHeight: 1.25, color: '#000', padding: 4,
    borders: 'horizontal', borderColor: '#ccc', headerFont: 'Helvetica-Bold',
    headerColor: '#000', headerFill: '#eee',
  };

  it('does not emit a blank page when a repeated header fits and the row does not', () => {
    const body = Array.from({ length: 13 }, () => 'word').join('\n');
    const cell = (text: string): StyledRun[] => [{ text, font: 'Helvetica', size: 10, color: '#000' }];
    const table = new TableBlock({
      columns: [80],
      header: 1,
      rows: [[cell('Head')], [cell(body)]],
      style: tableStyle,
    });
    const pages = paginate([table], ctx, geom);
    expect(pages.every((p) => p.placements.length > 0)).toBe(true);
    expect(pages.length).toBe(2);
    expect(pageText(pages[0]!)).toContain('Head');
    expect(pageText(pages[1]!)).toContain('word');
    expect(pages.map(pageText).join('').match(/word/g)).toHaveLength(13);
  });

  it('collects a footnote attached to a table cell', () => {
    const cell = (text: string, noteId?: number): StyledRun[] => [{
      text, font: 'Helvetica', size: 10, color: '#000', ...(noteId !== undefined ? { noteId } : {}),
    }];
    const table = new TableBlock({
      columns: ['*'],
      rows: [[cell('Head')], [cell('body', 4)]],
      style: tableStyle,
    });
    const noted: PaginationContext = { ...ctx, notes: new Map([[4, 'Cell note text.']]) };
    const pages = paginate([table], noted, geom);
    const noteText = pages.flatMap((p) => p.notes).map((n) => sliceText(n.slice)).join('');
    expect(noteText).toContain('Cell note text.');
  });

  it('does not rewind a keep-with-next heading across a forced page break', () => {
    const before = new ParagraphBlock([run('before')], style, {}, 'P');
    const heading = new ParagraphBlock([run('Stay')], style, { keepWithNext: true }, 'H2');
    const after = new ParagraphBlock([run('after-break')], style, {}, 'P');
    const pages = paginate([before, heading, new PageBreakBlock(), after], ctx, geom);
    expect(pages.length).toBe(2);
    expect(pageText(pages[0]!)).toContain('Stay');
    expect(pageText(pages[0]!)).toContain('before');
    expect(pageText(pages[1]!)).toBe('after-break');
  });

  it('lays out a content block that asks for a break before it', () => {
    const first = new ParagraphBlock([run('alpha')], style, {}, 'P');
    const second = new ParagraphBlock([run('bravo')], style, {}, 'P');
    Object.assign(second, { forceBreakBefore: true });
    const pages = paginate([first, second], ctx, geom);
    expect(pages.length).toBe(2);
    expect(pageText(pages[0]!)).toBe('alpha');
    expect(pageText(pages[1]!)).toBe('bravo');
  });

  it('hard-splits a glued tail that is wider than the next line', () => {
    const wide = measurer.width('Helvetica', 'aa BBBB', 12);
    const narrow = measurer.width('Helvetica', 'BB', 12);
    const lines = breakLines(
      [run('aa '), run('BBBB'), run('CCCC')],
      measurer,
      { widthAt: (i) => (i === 0 ? wide + 0.5 : narrow), align: 'left', lineHeight: 1.25, fallback: { font: 'Helvetica', size: 12 } },
    );
    const painted = lines.map((l) => l.runs.map((r) => r.text).join(''));
    // The space after "aa" is the line break, so it is not painted. The carried tail is split.
    expect(painted[0]).toBe('aa');
    expect(painted.slice(1).join('')).toBe('BBBBCCCC');
    lines.forEach((line, i) => {
      const limit = i === 0 ? wide + 0.5 : narrow;
      expect(line.width).toBeLessThanOrEqual(limit + 1e-6);
    });
  });
});

describe('subset size of a two-page article', () => {
  it('keeps the embedded faces far smaller than the full font tables', () => {
    const regular = new Uint8Array(readFileSync(fileURLToPath(new URL('../../core/test/fixtures/Ubuntu-R.ttf', import.meta.url))));
    const bold = new Uint8Array(readFileSync(fileURLToPath(new URL('../../core/test/fixtures/Ubuntu-B.ttf', import.meta.url))));
    const doc = new LayoutDocument({
      pageSize: 'A4',
      margins: { top: 64, bottom: 72, left: 64, right: 64 },
      title: 'Article',
      defaultStyle: { font: 'body', size: 11, lineHeight: 1.35 },
    });
    doc.font('body', regular);
    doc.font('bold', bold);
    const para = 'The quick brown fox jumps over the lazy dog. Measurements stay stable across machines, and every line uses the embedded face. '.repeat(12);
    doc.heading('A short article about fonts', 1);
    doc.paragraph([{ text: 'Summary. ', font: 'bold' }, { text: para }]);
    doc.heading('Second section', 2);
    doc.paragraph(para);
    doc.paragraph('Soft hyphen \u00ad, emoji \u{1F600}, missing dash \u2011, and a second address https://web.archive.org/web/2024/https://example.org/a/long/path in the body. ' + para);
    const bytes = doc.build();
    const pdf = latin1(bytes);
    expect((pdf.match(/\/Type \/Page /g) ?? []).length).toBe(2);
    const fonts: number[] = [];
    const re = /<< \/Filter \/FlateDecode \/Length (\d+) \/Length1 (\d+)>>\nstream\n/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(pdf))) fonts.push(Number(m[2]));
    // Before compaction this document carried 39244 + 30432 bytes of font data.
    expect(fonts.length).toBe(2);
    expect(fonts.reduce((a, b) => a + b, 0)).toBeLessThan(25000);
  });
});

describe('catalog language', () => {
  it('passes the language to the catalog', () => {
    const doc = new LayoutDocument({ title: 'T', lang: 'en' });
    doc.paragraph('Hello.');
    const pdf = latin1(doc.build());
    expect(pdf).toContain('/Lang (en)');
    expect(pdf).toContain('/DisplayDocTitle true');
  });
});
