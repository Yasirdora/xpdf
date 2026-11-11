import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractAttachment } from '@xpdf/core';
import { applyFacturX, type Invoice } from '@xpdf/einvoice';
import { invoiceDocument, fmtMoney } from '../src/invoice.js';

const latin1 = (u: Uint8Array) => [...u].map((b) => String.fromCharCode(b)).join('');

const fixture = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../core/test/fixtures/Ubuntu-R.ttf', import.meta.url))),
);

export function sampleInvoice(): Invoice {
  return {
    number: 'INV-2026-0042',
    issueDate: '2026-08-12',
    dueDate: '2026-09-11',
    currency: 'EUR',
    seller: {
      name: 'Atelier Lovelace SAS', street: '12 rue des Algorithmes', city: 'Paris',
      zip: '75011', country: 'FR', vatId: 'FR12345678901', email: 'billing@lovelace.example',
    },
    buyer: {
      name: 'Babbage Instruments Ltd', street: '5 Analytical Way', city: 'London',
      zip: 'EC1A 1BB', country: 'GB', vatId: 'GB987654321',
    },
    iban: 'FR7630006000011234567890189',
    notes: 'Thank you for your business.',
    paymentTerms: '30 days net',
    lines: [
      { description: 'Analytical engine calibration', quantity: 2, unitPrice: 450, vatRate: 20 },
      { description: 'Difference gears (set of 12)', quantity: 3, unitPrice: 89.99, vatRate: 20 },
      { description: 'Operator training (day)', quantity: 1.5, unitPrice: 600, vatRate: 20 },
    ],
  };
}

describe('fmtMoney', () => {
  it('formats per currency convention, deterministically', () => {
    expect(fmtMoney(2483.96, 'EUR')).toBe('2,483.96 €');
    expect(fmtMoney(1200, 'USD')).toBe('$1,200.00');
    expect(fmtMoney(99.5, 'GBP')).toBe('£99.50');
    expect(fmtMoney(1500, 'CHF')).toBe('1,500.00 CHF');
    expect(fmtMoney(-42.1, 'EUR')).toBe('-42.10 €');
  });
});

describe('invoiceDocument', () => {
  it('rejects invalid invoices', () => {
    const bad = sampleInvoice();
    bad.lines = [];
    expect(() => invoiceDocument(bad)).toThrow(/invalid invoice/);
  });

  it('renders a branded invoice PDF with the computed totals', () => {
    const { doc, totals } = invoiceDocument(sampleInvoice(), { font: fixture, accent: '#0f766e' });
    expect(totals.gross).toBe(2483.96);
    const pdf = latin1(doc.build());
    expect(pdf.startsWith('%PDF-1.7')).toBe(true);
  });

  it('attaches the living document.json payload (restorable)', () => {
    const inv = sampleInvoice();
    const { doc } = invoiceDocument(inv, { font: fixture });
    const restored = extractAttachment(doc.build(), 'document.json');
    expect(restored).not.toBeNull();
    const payload = JSON.parse(new TextDecoder().decode(restored!));
    expect(payload.type).toBe('invoice');
    expect(payload.version).toBe(1);
    expect(payload.data).toEqual(inv); // full round-trip fidelity
  });

  it('composes with applyFacturX into a full Factur-X file', () => {
    const inv = sampleInvoice();
    const { doc, totals } = invoiceDocument(inv, { font: fixture });
    const fx = applyFacturX(doc, inv);
    expect(fx.totals.gross).toBe(totals.gross); // single source of truth
    const pdf = latin1(doc.build());
    expect(pdf).toContain('(factur-x.xml)');
    expect(pdf).toContain('(document.json)');
  });

  it('is byte-deterministic', () => {
    const inv = sampleInvoice();
    const a = invoiceDocument(inv, { font: fixture }).doc.build();
    const b = invoiceDocument(inv, { font: fixture }).doc.build();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
