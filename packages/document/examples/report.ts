/**
 * Example: a multi-page research-style report exercising the whole engine —
 * justified rich text, headings with keep-with-next, a cross-page table with
 * repeated headers, footnotes resolved to a fixpoint, an embedded TTF for
 * non-Latin text, and running footers with page totals.
 *
 * Run: npx tsx examples/report.ts  →  writes examples/report.pdf
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LayoutDocument } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const ubuntu = new Uint8Array(readFileSync(join(here, '../../core/test/fixtures/Ubuntu-R.ttf')));

const doc = new LayoutDocument({
  pageSize: 'A4',
  margins: { top: 64, bottom: 72, left: 64, right: 64 },
  title: 'xpdf engine report',
  author: 'xpdf',
  defaultStyle: { font: 'body', size: 10.5, lineHeight: 1.35 },
  footer: (page, ctx) => {
    page.line(64, 812, 531, 812, '#e5e7eb', 0.5);
    page.text('xpdf — engine report', 64, 822, { size: 8.5, color: '#9ca3af' });
    page.text(`Page ${ctx.page} of ${ctx.pages}`, 64, 822, {
      size: 8.5, color: '#9ca3af', align: 'right', width: 467,
    });
  },
});

doc.font('body', ubuntu);
doc.font('body-bold', 'Helvetica-Bold');

doc.heading('Deterministic Document Layout at Zero Dependencies', 1);
doc.paragraph([
  { text: 'An evaluation of the xpdf convergence paginator', font: 'body-bold' },
  { text: ' — measuring how far a strict block model, real font metrics, and a fixpoint footnote algorithm take a dependency-free engine.' },
], { color: '#4b5563', spaceAfter: 14 });

doc.heading('1. Introduction', 2);
doc.paragraph(
  'Programmatic PDF generation splits into two camps: writers that place glyphs at absolute ' +
  'coordinates, and layout engines that flow structured content across pages. The former are ' +
  'simple and predictable; the latter are where documents actually live. This report describes ' +
  'a paginator that treats page composition as a convergence problem rather than a single-pass ' +
  'measure-and-place sweep' +
  '.',
  { align: 'justify' },
);
doc.paragraph([
  { text: 'The central observation is that footnotes, table headers, and keep rules are ' },
  { text: 'coupled constraints', font: 'body-bold' },
  {
    text: ': adding a footnote can push its own reference across a page boundary, at which point ' +
      'the note must move too',
    note: 'This is the classic fixpoint of document layout; TeX solves it with multiple passes, Word with a similar iterative scheme.',
  },
  { text: '. A monotone iteration with an explicit non-convergence error resolves it in bounded time.' },
], { align: 'justify' });

doc.heading('2. Results', 2);
doc.paragraph(
  'The table below spans multiple pages; its header repeats automatically on every ' +
  'continuation page, and no row ever splits across a boundary.',
  { align: 'justify' },
);
doc.table({
  columns: ['*', 100, 100, 80],
  header: 1,
  keepTogether: false,
  rows: [
    ['Engine property', 'Single-pass', 'Convergence', 'Delta'],
    ...Array.from({ length: 42 }, (_, i) => [
      `Property ${i + 1} — measured across the full corpus of documents`,
      `${(80 + ((i * 7) % 19))}%`,
      `${(97 + ((i * 5) % 3))}%`,
      `+${(i * 3) % 17}pt`,
    ]),
  ],
  style: { size: 9.5, padding: 5 },
});

doc.heading('3. Unicode through embedded fonts', 2);
doc.paragraph([
  { text: 'Base-14 fonts cover Western Europe. Everything else travels through embedded, ' },
  { text: 'subsetted TrueType', font: 'body-bold' },
  { text: ': Русский текст, Ελληνικά, and English share one measurer, one paginator, one renderer.' },
], { align: 'justify' });

doc.paragraph([
  { text: 'Reproduction: ' },
  { text: 'npx tsx examples/report.ts', font: 'Courier' },
  { text: '. The bytes you get are the bytes everyone gets', note: 'Determinism is asserted in CI: the same document model must produce byte-identical output on every platform.' },
  { text: '.' },
], { spaceBefore: 10 });

const out = join(here, 'report.pdf');
writeFileSync(out, doc.build());
console.log(`wrote ${out}`);
