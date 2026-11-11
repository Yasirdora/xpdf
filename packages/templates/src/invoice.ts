/**
 * Invoice template: Invoice (EN 16931 model) → LayoutDocument.
 *
 * A template is a function from data to blocks — the invoice type is data,
 * not code. Totals come from computeTotals() via applyFacturX() or directly,
 * so the visual document and the CII XML can never disagree.
 *
 * Every invoice carries a document.json payload attachment — the living
 * PDF: drag the file back into any xpdf tool and it is editable again.
 */
import { LayoutDocument, type FontSource } from '@xpdf/document';
import { computeTotals, validateInvoice, type Invoice, type InvoiceTotals } from '@xpdf/einvoice';

export interface InvoiceTheme {  /** Brand accent for the title, rules, and table header fill. */
  accent?: string;
  /** Body font: base-14 name or TTF bytes (required for PDF/A). */
  font?: FontSource;
  /** Bold/emphasis font. */
  boldFont?: FontSource;
  /** ISO date → display string hook (default: ISO unchanged). */
  dateFormat?: (iso: string) => string;
  /** PDF/A-3 mode ('3B' | '3U') — required for Factur-X output. */
  pdfa?: '3B' | '3U';
}

export interface InvoiceDocumentResult {
  doc: LayoutDocument;
  totals: InvoiceTotals;
}

/**
 * Deterministic money format: thousands ',', decimals '.'; symbol placement
 * per currency convention — "2,483.96 €", "$2,483.96", "2,483.96 CHF".
 * (No Intl.NumberFormat: ICU version drift would break byte determinism.)
 */
export function fmtMoney(v: number, currency: string): string {
  const fixed = Math.abs(v).toFixed(2);
  const [int, dec] = fixed.split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = v < 0 ? '-' : '';
  const amount = `${sign}${grouped}.${dec}`;
  if (currency === 'EUR') return `${amount} €`;
  if (currency === 'USD') return `$${amount}`;
  if (currency === 'GBP') return `£${amount}`;
  return `${amount} ${currency}`;
}

function partyLines(p: { name: string; street?: string; city?: string; zip?: string; country: string; vatId?: string; email?: string }): string[] {
  const lines: string[] = [];
  if (p.street) lines.push(p.street);
  const cityLine = [p.zip, p.city].filter(Boolean).join(' ');
  if (cityLine) lines.push(cityLine);
  lines.push(p.country);
  if (p.vatId) lines.push(`VAT ${p.vatId}`);
  if (p.email) lines.push(p.email);
  return lines;
}

export function invoiceDocument(inv: Invoice, theme: InvoiceTheme = {}): InvoiceDocumentResult {
  const errors = validateInvoice(inv);
  if (errors.length) throw new Error(`invalid invoice:\n  - ${errors.join('\n  - ')}`);
  const totals = computeTotals(inv);
  const accent = theme.accent ?? '#1e40af';
  const df = theme.dateFormat ?? ((iso: string) => iso);

  const doc = new LayoutDocument({
    pageSize: 'A4',
    margins: { top: 52, bottom: 56, left: 56, right: 56 },
    title: `Invoice ${inv.number}`,
    author: inv.seller.name,
    subject: `Invoice ${inv.number} — ${inv.seller.name} → ${inv.buyer.name}`,
    defaultStyle: { font: 'invoice-body', size: 10, lineHeight: 1.35 },
    ...(theme.pdfa !== undefined ? { pdfa: theme.pdfa } : {}),
  });
  doc.font('invoice-body', theme.font ?? 'Helvetica');
  doc.font('invoice-bold', theme.boldFont ?? 'Helvetica-Bold');

  // --- header: seller block (left) + title/meta (right) ---
  doc.paragraph(inv.seller.name, { font: 'invoice-bold', size: 16, color: accent, spaceAfter: 2 });
  for (const line of partyLines(inv.seller)) {
    doc.paragraph(line, { size: 9, color: '#4b5563', spaceAfter: 0 });
  }
  doc.spacer(6);
  doc.paragraph('INVOICE', {
    font: 'invoice-bold', size: 24, color: accent, align: 'right', spaceBefore: 0, spaceAfter: 4,
  });
  doc.table({
    columns: ['*', 'auto'],
    columnAlign: ['left', 'right'],
    rows: [
      ['Invoice number', inv.number],
      ['Issue date', df(inv.issueDate)],
      ...(inv.dueDate ? [['Due date', df(inv.dueDate)] as string[]] : []),
      ['Currency', inv.currency],
      ...(inv.buyerReference ? [['Buyer reference', inv.buyerReference] as string[]] : []),
    ],
    style: { size: 9, borders: 'none', padding: 1.5, headerFill: null },
  });

  // --- buyer ---
  doc.paragraph('BILLED TO', { font: 'invoice-bold', size: 8, color: '#9ca3af', spaceBefore: 12, spaceAfter: 2, keepWithNext: true });
  doc.paragraph(inv.buyer.name, { font: 'invoice-bold', size: 11, spaceAfter: 1 });
  for (const line of partyLines(inv.buyer)) {
    doc.paragraph(line, { size: 9, color: '#4b5563', spaceAfter: 0 });
  }

  // --- lines ---
  doc.table({
    columns: ['*', 44, 84, 52, 88],
    columnAlign: ['left', 'right', 'right', 'right', 'right'],
    header: 1,
    rows: [
      ['Description', 'Qty', 'Rate', 'VAT %', 'Amount'],
      ...inv.lines.map((l, i) => [
        l.description,
        String(l.quantity),
        fmtMoney(l.unitPrice, inv.currency),
        `${l.vatRate}%`,
        fmtMoney(totals.lineAmounts[i]!, inv.currency),
      ]),
    ],
    style: {
      size: 9.5,
      padding: 5,
      borders: 'horizontal',
      headerFont: 'invoice-bold',
      headerFill: '#f3f4f6',
      borderColor: '#e5e7eb',
    },
  });

  // --- totals (right-aligned block) ---
  const totalRows: Array<[string, string, string]> = [
    ['', 'Net total', fmtMoney(totals.net, inv.currency)],
    ...totals.vat.map((v): [string, string, string] => ['', `VAT ${v.rate}% on ${fmtMoney(v.basis, inv.currency)}`, fmtMoney(v.tax, inv.currency)]),
  ];
  doc.table({
    columns: ['*', 'auto', 110],
    columnAlign: ['left', 'right', 'right'],
    rows: totalRows,
    style: { size: 9.5, borders: 'none', padding: 2.5, headerFill: null },
    keepTogether: true,
  });
  doc.table({
    columns: ['*', 'auto', 110],
    columnAlign: ['left', 'right', 'right'],
    header: 1,
    rows: [['', 'Total due', fmtMoney(totals.gross, inv.currency)]],
    style: {
      size: 11,
      borders: 'horizontal',
      borderColor: accent,
      headerFont: 'invoice-bold',
      headerColor: accent,
      headerFill: null,
      padding: 4,
    },
    keepTogether: true,
  });

  // --- notes & payment ---
  if (inv.notes) {
    doc.paragraph('NOTES', { font: 'invoice-bold', size: 8, color: '#9ca3af', spaceBefore: 14, spaceAfter: 2, keepWithNext: true });
    doc.paragraph(inv.notes, { size: 9, color: '#4b5563' });
  }
  if (inv.paymentTerms || inv.iban) {
    doc.paragraph('PAYMENT', { font: 'invoice-bold', size: 8, color: '#9ca3af', spaceBefore: 10, spaceAfter: 2, keepWithNext: true });
    const parts = [inv.paymentTerms, inv.iban ? `IBAN ${inv.iban}` : undefined].filter(Boolean);
    doc.paragraph(parts.join(' — '), { size: 9, color: '#4b5563' });
  }

  // --- living payload: the document is its own editable source ---
  doc.attach('document.json', new TextEncoder().encode(JSON.stringify({ type: 'invoice', version: 1, data: inv }, null, 2)), {
    mime: 'application/json',
    description: 'xpdf source document (round-trip payload)',
    afRelationship: 'Source',
  });

  return { doc, totals };
}
