/**
 * Example: a complete Factur-X (EN 16931) invoice.
 *
 * One Invoice object produces both faces of the file:
 *   - the human-readable PDF/A-3B invoice (template + embedded font), and
 *   - the machine-readable CII XML attached as factur-x.xml,
 * plus the living document.json round-trip payload.
 *
 * Run: npx tsx examples/facturx-invoice.ts  →  writes examples/facturx-invoice.pdf
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyFacturX, type Invoice } from '@xpdf/einvoice';
import { invoiceDocument } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const ubuntu = new Uint8Array(readFileSync(join(here, '../../core/test/fixtures/Ubuntu-R.ttf')));
const ubuntuBold = new Uint8Array(readFileSync(join(here, '../../core/test/fixtures/Ubuntu-B.ttf')));

const invoice: Invoice = {
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
  notes: 'Merci pour votre confiance — thank you for your business.',
  paymentTerms: '30 days net',
  lines: [
    { description: 'Analytical engine calibration — on site', quantity: 2, unitPrice: 450, vatRate: 20 },
    { description: 'Difference gears (set of 12), hardened steel', quantity: 3, unitPrice: 89.99, vatRate: 20 },
    { description: 'Operator training, full day incl. materials', quantity: 1.5, unitPrice: 600, vatRate: 20 },
    { description: 'Documentation pack (PDF, perpetual updates)', quantity: 1, unitPrice: 120, vatRate: 5.5 },
  ],
};

const { doc } = invoiceDocument(invoice, { font: ubuntu, boldFont: ubuntuBold, accent: '#0f766e', pdfa: '3B' });
applyFacturX(doc, invoice);

const out = join(here, 'facturx-invoice.pdf');
writeFileSync(out, doc.build());
console.log(`wrote ${out}`);
