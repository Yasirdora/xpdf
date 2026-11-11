/**
 * Example: Unicode text with an embedded, subsetted TrueType font.
 *
 * Base-14 fonts cover WinAnsi (Western Europe) only. For anything else —
 * Cyrillic, Greek, CJK, Vietnamese, emoji-less symbol sets — embed a TTF.
 * xpdf subsets it (only used glyphs ship), assigns Identity-H encoding,
 * and writes a ToUnicode CMap so the text stays copyable and searchable.
 *
 * Run: npx tsx examples/unicode.ts  →  writes examples/unicode.pdf
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Document } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));

// Any .ttf works. We use the OFL-licensed Ubuntu font from our test fixtures.
// (OTF/CFF and TTC collections are rejected with clear errors — v1 is glyf-only.)
const fontBytes = new Uint8Array(readFileSync(join(here, '../test/fixtures/Ubuntu-R.ttf')));

const doc = new Document({ title: 'xpdf — Unicode showcase', author: 'xpdf' });
const ubuntu = doc.embedFont(fontBytes);

const page = doc.addPage(); // A4

const lines: Array<[string, string]> = [
  ['English', 'The quick brown fox jumps over the lazy dog.'],
  ['Русский', 'Съешь же ещё этих мягких французских булок, да выпей чаю.'],
  ['Ελληνικά', 'Ξεσκεπάζω την ψυχοφθόρα βδελυγμία.'],
  ['Deutsch', 'Falsches Üben von Xylophonmusik quält jeden größeren Zwerg.'],
  ['Français', 'Portez ce vieux whisky au juge blond qui fume.'],
  ['Symbols', 'µ ≠ π · ∑ ± √∞ — em–dash… «quotes» € £ ¥'],
];

page.text('xpdf — one embedded font, six scripts', 50, 50, { font: ubuntu, size: 20, color: '#1e40af' });
page.line(50, 62, 545, 62, '#e5e7eb', 1);

let y = 100;
for (const [label, text] of lines) {
  page.text(label, 50, y, { font: ubuntu, size: 9, color: '#6b7280' });
  page.text(text, 50, y + 16, { font: ubuntu, size: 13 });
  y += 52;
}

// Alignment uses the embedded font's real hmtx advances
page.text('right-aligned: Привет, мир!', 50, y + 20, { font: ubuntu, size: 12, align: 'right', width: 495 });

const out = join(here, 'unicode.pdf');
writeFileSync(out, doc.build());
console.log(`wrote ${out}`);
