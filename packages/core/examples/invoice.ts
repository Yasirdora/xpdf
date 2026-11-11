/**
 * Example: a professional invoice PDF with @xpdf/core.
 *
 * Demonstrates: styled text (AFM-aligned), shapes, links, outline bookmarks,
 * XMP metadata, and an embedded machine-readable payload — the "living PDF"
 * primitive: this PDF carries its own source data.
 *
 * Run: npm run example   →   writes examples/invoice.pdf
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Document, getFontMetrics } from '../src/index.js';

const ACCENT = '#0f766e';
const INK = '#1d2733';
const MUTED = '#5e6b78';
const FAINT = '#e4e8ec';

const invoice = {
  number: 'INV-2026-0042',
  issueDate: '2026-08-11',
  dueDate: '2026-09-10',
  from: {
    name: 'xpdf Studio',
    details: 'Keizersgracht 221\n1016 DV Amsterdam\nNetherlands\nVAT NL865432100B01',
  },
  to: {
    name: 'Acme Corporation',
    details: '123 Business Street\nNew York, NY 10001\nUnited States',
  },
  currency: 'EUR',
  items: [
    { description: 'Document engine integration — Phase 0', qty: 1, rate: 4800 },
    { description: 'PDF/A-3 compliance consulting (hours)', qty: 12, rate: 165 },
    { description: 'Font subsetting review (hours)', qty: 6.5, rate: 165 },
    { description: 'Factur-X validation workshop', qty: 2, rate: 450 },
  ],
  tax: 21,
  notes: 'Payment by bank transfer within 30 days. IBAN NL91 ABNA 0417 1643 00. Please reference the invoice number.',
};

const money = (n: number) =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: invoice.currency }).format(n);

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const subtotal = round2(invoice.items.reduce((s, it) => s + it.qty * it.rate, 0));
const taxAmt = round2(subtotal * (invoice.tax / 100));
const total = round2(subtotal + taxAmt);

const doc = new Document({
  title: `Invoice ${invoice.number}`,
  author: invoice.from.name,
  subject: `Invoice ${invoice.number} — ${invoice.to.name}`,
  keywords: ['invoice', invoice.number, 'xpdf'],
});

const page = doc.addPage(); // A4
const M = 48;
const W = 595.28;
const R = W - M;

let y = M + 20;

// business block (left)
page.text(invoice.from.name, M, y, { font: 'Times-Bold', size: 18, color: INK });
y += 16;
for (const line of invoice.from.details.split('\n')) {
  page.text(line, M, y, { size: 9.5, color: MUTED });
  y += 13;
}

// INVOICE title (right)
page.text('INVOICE', M, M + 24, { font: 'Times-Bold', size: 24, color: INK, align: 'right', width: R - M });
page.text(`No. ${invoice.number}`, M, M + 44, { font: 'Courier', size: 9.5, color: MUTED, align: 'right', width: R - M });

y = Math.max(y, M + 70) + 26;
page.line(M, y, R, y, ACCENT, 2.5);
y += 28;

// dates + amount-due chip
page.text('ISSUED', M, y, { font: 'Helvetica-Bold', size: 7.5, color: MUTED, charSpacing: 0.6 });
page.text('DUE', M + 150, y, { font: 'Helvetica-Bold', size: 7.5, color: MUTED, charSpacing: 0.6 });
page.text('AMOUNT DUE', M, y, { font: 'Helvetica-Bold', size: 7.5, color: MUTED, align: 'right', width: R - M, charSpacing: 0.6 });
page.text(invoice.issueDate, M, y + 15, { size: 10.5, color: INK });
page.text(invoice.dueDate, M + 150, y + 15, { size: 10.5, color: INK });

const chipTxt = money(total);
const chipW = getFontMetrics('Courier').widthAt(chipTxt, 12) + 24;
page.rect(R - chipW, y + 2, chipW, 25, '#f0fdfa');
page.text(chipTxt, R - 12 - (chipW - 24), y + 19, { font: 'Courier-Bold', size: 12, color: ACCENT, align: 'right', width: chipW - 24 });
y += 55;

// billed to
page.text('BILLED TO', M, y, { font: 'Helvetica-Bold', size: 7.5, color: MUTED, charSpacing: 0.6 });
y += 15;
page.text(invoice.to.name, M, y, { font: 'Helvetica-Bold', size: 10.5, color: INK });
for (const line of invoice.to.details.split('\n')) {
  y += 13;
  page.text(line, M, y, { size: 9.5, color: MUTED });
}
y += 30;

// items table
const qR = M + 320, rR = M + 405;
const tableHead = () => {
  page.text('DESCRIPTION', M, y, { font: 'Helvetica-Bold', size: 7.5, color: MUTED, charSpacing: 0.6 });
  page.text('QTY', M, y, { font: 'Helvetica-Bold', size: 7.5, color: MUTED, align: 'right', width: qR - M, charSpacing: 0.6 });
  page.text('RATE', M, y, { font: 'Helvetica-Bold', size: 7.5, color: MUTED, align: 'right', width: rR - M, charSpacing: 0.6 });
  page.text('AMOUNT', M, y, { font: 'Helvetica-Bold', size: 7.5, color: MUTED, align: 'right', width: R - M, charSpacing: 0.6 });
  page.line(M, y + 7, R, y + 7, INK, 1.2);
  y += 24;
};
tableHead();
for (const it of invoice.items) {
  page.text(it.description, M, y, { size: 9.5, color: INK });
  page.text(String(it.qty), M, y, { font: 'Courier', size: 9, color: INK, align: 'right', width: qR - M });
  page.text(money(it.rate), M, y, { font: 'Courier', size: 9, color: INK, align: 'right', width: rR - M });
  page.text(money(round2(it.qty * it.rate)), M, y, { font: 'Courier', size: 9, color: INK, align: 'right', width: R - M });
  page.line(M, y + 9, R, y + 9, FAINT, 0.5);
  y += 25;
}

// totals
y += 10;
const tx0 = R - 200;
page.text('Subtotal', tx0, y, { size: 9.5, color: INK });
page.text(money(subtotal), M, y, { font: 'Courier', size: 9, color: INK, align: 'right', width: R - M });
y += 17;
page.text(`Tax (${invoice.tax}%)`, tx0, y, { size: 9.5, color: INK });
page.text(money(taxAmt), M, y, { font: 'Courier', size: 9, color: INK, align: 'right', width: R - M });
y += 17;
page.line(tx0, y - 6, R, y - 6, INK, 1.2);
y += 8;
page.text('Total due', tx0, y, { font: 'Helvetica-Bold', size: 11, color: INK });
page.text(money(total), M, y, { font: 'Courier-Bold', size: 10.5, color: INK, align: 'right', width: R - M });

// notes
y += 34;
page.line(M, y - 16, R, y - 16, FAINT, 0.5);
page.text('NOTES', M, y, { font: 'Helvetica-Bold', size: 7.5, color: MUTED, charSpacing: 0.6 });
y += 15;
page.text(invoice.notes, M, y, { size: 9.5, color: MUTED });

// a link in the footer
page.text('Generated with @xpdf/core —', M, 800, { size: 8, color: MUTED });
const label = 'zero-dependency deterministic PDFs';
const labelX = M + getFontMetrics('Helvetica').widthAt('Generated with @xpdf/core — ', 8);
page.text(label, labelX, 800, { size: 8, color: '#0066cc' });
page.link('https://github.com/Yasirdora/xpdf', labelX, 792, getFontMetrics('Helvetica').widthAt(label, 8), 10, { underline: '#0066cc' });

// bookmarks
doc.setOutlines([
  { title: `Invoice ${invoice.number}`, page, y: 0 },
  { title: 'Line items', page, y: 300 },
  { title: 'Totals', page, y: 560 },
]);

// the living payload: this PDF carries its own source
doc.attach(
  'document.json',
  new TextEncoder().encode(JSON.stringify({ spec: 'xpdf:1', type: 'invoice', data: invoice }, null, 2)),
  { mime: 'application/json', description: 'xpdf source document' },
);

const out = join(dirname(fileURLToPath(import.meta.url)), 'invoice.pdf');
writeFileSync(out, doc.build());
console.log(`Wrote ${out}`);
