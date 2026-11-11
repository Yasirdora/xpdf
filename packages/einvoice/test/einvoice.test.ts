import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LayoutDocument } from '@xpdf/document';
import { computeTotals, round2, validateInvoice, type Invoice } from '../src/model.js';
import { invoiceToCiiXml } from '../src/cii.js';
import { applyFacturX, facturXXmpFragments } from '../src/facturx.js';

const latin1 = (u: Uint8Array) => [...u].map((b) => String.fromCharCode(b)).join('');

export function sampleInvoice(): Invoice {
  return {
    number: 'INV-2026-0042',
    issueDate: '2026-08-12',
    dueDate: '2026-09-11',
    currency: 'EUR',
    seller: {
      name: 'Atelier Lovelace SAS',
      street: '12 rue des Algorithmes',
      city: 'Paris',
      zip: '75011',
      country: 'FR',
      vatId: 'FR12345678901',
      email: 'billing@lovelace.example',
    },
    buyer: {
      name: 'Babbage Instruments Ltd',
      street: '5 Analytical Way',
      city: 'London',
      zip: 'EC1A 1BB',
      country: 'GB',
      vatId: 'GB987654321',
    },
    iban: 'FR7630006000011234567890189',
    buyerReference: 'PO-2026-118',
    notes: 'Thank you for your business.',
    paymentTerms: '30 days net',
    lines: [
      { description: 'Analytical engine calibration', quantity: 2, unitPrice: 450, vatRate: 20 },
      { description: 'Difference gears (set of 12)', quantity: 3, unitPrice: 89.99, vatRate: 20 },
      { description: 'Operator training (day)', quantity: 1.5, unitPrice: 600, vatRate: 20 },
    ],
  };
}

describe('computeTotals', () => {
  it('rounds lines, sums net, and computes VAT per rate', () => {
    const t = computeTotals(sampleInvoice());
    expect(t.lineAmounts).toEqual([900, 269.97, 900]);
    expect(t.net).toBe(2069.97);
    expect(t.vat).toEqual([{ rate: 20, basis: 2069.97, tax: 413.99 }]);
    expect(t.tax).toBe(413.99);
    expect(t.gross).toBe(2483.96);
  });

  it('splits VAT by rate', () => {
    const inv = sampleInvoice();
    inv.lines.push({ description: 'Books', quantity: 2, unitPrice: 25, vatRate: 5.5 });
    const t = computeTotals(inv);
    expect(t.vat.length).toBe(2);
    expect(t.vat[0]).toEqual({ rate: 5.5, basis: 50, tax: 2.75 });
    expect(t.gross).toBe(round2(t.net + t.tax));
  });

  it('rounds half away from zero', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(-1.005)).toBe(-1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(0.995)).toBe(1);
  });
});

describe('validateInvoice', () => {
  it('accepts the sample invoice', () => {
    expect(validateInvoice(sampleInvoice())).toEqual([]);
  });

  it('catches missing mandatory fields', () => {
    const inv = sampleInvoice();
    inv.number = '';
    inv.issueDate = '12/08/2026';
    inv.lines = [];
    const errors = validateInvoice(inv);
    expect(errors.some((e) => e.includes('BT-1'))).toBe(true);
    expect(errors.some((e) => e.includes('BT-2'))).toBe(true);
    expect(errors.some((e) => e.includes('BG-25'))).toBe(true);
  });
});

describe('invoiceToCiiXml', () => {
  const inv = sampleInvoice();
  const totals = computeTotals(inv);
  const xml = invoiceToCiiXml(inv, totals);

  it('emits the Factur-X guideline and root namespaces', () => {
    expect(xml).toContain('urn:factur-x.eu:1p0:en16931');
    expect(xml).toContain('urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100');
  });

  it('carries header data with format-102 dates', () => {
    expect(xml).toContain('<ram:ID>INV-2026-0042</ram:ID>');
    expect(xml).toContain('<ram:TypeCode>380</ram:TypeCode>');
    expect(xml).toContain('format="102">20260812<');
    expect(xml).toContain('format="102">20260911<');
  });

  it('keeps XSD sequence order in critical aggregates', () => {
    // header monetary summation: LineTotal before TaxBasis before Tax before Grand before DuePayable
    const seq = [
      '<ram:LineTotalAmount>2069.97</ram:LineTotalAmount>',
      '<ram:TaxBasisTotalAmount>2069.97</ram:TaxBasisTotalAmount>',
      '<ram:TaxTotalAmount currencyID="EUR">413.99</ram:TaxTotalAmount>',
      '<ram:GrandTotalAmount>2483.96</ram:GrandTotalAmount>',
      '<ram:DuePayableAmount>2483.96</ram:DuePayableAmount>',
    ];
    let last = -1;
    for (const s of seq) {
      const idx = xml.indexOf(s);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
  });

  it('serializes all lines with matching totals', () => {
    expect(xml.split('IncludedSupplyChainTradeLineItem').length - 1).toBe(6); // 3 open + 3 close
    expect(xml).toContain('<ram:LineTotalAmount>269.97</ram:LineTotalAmount>');
    expect(xml).toContain('<ram:ChargeAmount>89.99</ram:ChargeAmount>');
    expect(xml).toContain('unitCode="C62"');
  });

  it('escapes XML special characters', () => {
    const evil = sampleInvoice();
    evil.seller.name = 'A&B <Export> "Ltd"';
    const out = invoiceToCiiXml(evil, computeTotals(evil));
    expect(out).toContain('A&amp;B &lt;Export&gt; &quot;Ltd&quot;');
  });

  it('includes seller VAT registration and IBAN payment means', () => {
    expect(xml).toContain('<ram:ID schemeID="VA">FR12345678901</ram:ID>');
    expect(xml).toContain('<ram:IBANID>FR7630006000011234567890189</ram:IBANID>');
    expect(xml).toContain('<ram:TypeCode>58</ram:TypeCode>');
  });
});

describe('applyFacturX', () => {
  const fixture = new Uint8Array(
    readFileSync(fileURLToPath(new URL('../../core/test/fixtures/Ubuntu-R.ttf', import.meta.url))),
  );

  function buildPdfaInvoice(): { bytes: Uint8Array; xml: string } {
    const doc = new LayoutDocument({ pdfa: '3B', title: 'Invoice INV-2026-0042' });
    doc.font('body', fixture);
    const { xml } = applyFacturX(doc, sampleInvoice());
    doc.paragraph('Invoice INV-2026-0042 — Atelier Lovelace SAS', { font: 'body' });
    return { bytes: doc.build(), xml };
  }

  it('attaches factur-x.xml with /Alternative relationship', () => {
    const { bytes } = buildPdfaInvoice();
    const pdf = latin1(bytes);
    expect(pdf).toContain('(factur-x.xml)');
    expect(pdf).toContain('/AFRelationship /Alternative');
    expect(pdf).toContain('/Subtype /text#2Fxml');
  });

  it('stamps the Factur-X XMP extension schema', () => {
    const { bytes } = buildPdfaInvoice();
    const pdf = latin1(bytes);
    for (const fragment of facturXXmpFragments()) {
      // XMP is stored uncompressed — fragments appear verbatim
      expect(pdf).toContain(fragment.slice(0, 60));
    }
    expect(pdf).toContain('<pdfaid:part>3</pdfaid:part>');
    expect(pdf).toContain('/OutputIntents [');
  });

  it('rejects invalid invoices before touching the document', () => {
    const doc = new LayoutDocument({ pdfa: '3B' });
    doc.font('body', fixture);
    const bad = sampleInvoice();
    bad.number = '';
    expect(() => applyFacturX(doc, bad)).toThrow(/EN 16931/);
  });

  it('is byte-deterministic end to end', () => {
    const a = buildPdfaInvoice().bytes;
    const b = buildPdfaInvoice().bytes;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
