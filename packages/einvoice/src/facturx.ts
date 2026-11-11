/**
 * Factur-X assembly: take a validated invoice, compute its totals once,
 * attach the CII XML to the PDF/A-3 document, and stamp the XMP with the
 * Factur-X extension schema. After applyFacturX(), doc.build() produces a
 * Factur-X (EN 16931 profile) file.
 */
import type { LayoutDocument } from '@xpdf/document';
import { invoiceToCiiXml } from './cii.js';
import { computeTotals, validateInvoice, type Invoice, type InvoiceTotals } from './model.js';

const FX_NS = 'urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#';

export const FACTURX_FILENAME = 'factur-x.xml';
export const FACTURX_VERSION = '1.0';
export const FACTURX_CONFORMANCE = 'EN 16931';

/** The four required Factur-X XMP extension properties. */
export function facturXXmpFragments(): string[] {
  return [
    `<fx:DocumentType xmlns:fx="${FX_NS}">INVOICE</fx:DocumentType>`,
    `<fx:DocumentFileName xmlns:fx="${FX_NS}">${FACTURX_FILENAME}</fx:DocumentFileName>`,
    `<fx:Version xmlns:fx="${FX_NS}">${FACTURX_VERSION}</fx:Version>`,
    `<fx:ConformanceLevel xmlns:fx="${FX_NS}">${FACTURX_CONFORMANCE}</fx:ConformanceLevel>`,
  ];
}

export interface FacturXResult {
  /** Totals as embedded in the XML — reuse them for the visual invoice. */
  totals: InvoiceTotals;
  /** The CII XML that was attached. */
  xml: string;
}

/**
 * Validate the invoice, attach its CII XML, and add the Factur-X XMP
 * extension. The document must be in PDF/A-3 mode (Factur-X requires it);
 * pass pdfa: '3B' | '3U' to LayoutDocumentOptions.
 */
export function applyFacturX(doc: LayoutDocument, invoice: Invoice): FacturXResult {
  const errors = validateInvoice(invoice);
  if (errors.length) {
    throw new Error(`invoice fails EN 16931 validation:\n  - ${errors.join('\n  - ')}`);
  }
  const totals = computeTotals(invoice);
  const xml = invoiceToCiiXml(invoice, totals);
  doc.attach(FACTURX_FILENAME, new TextEncoder().encode(xml), {
    mime: 'text/xml',
    description: 'Factur-X XML invoice (EN 16931, CII D16B)',
    afRelationship: 'Alternative',
  });
  for (const fragment of facturXXmpFragments()) doc.xmpExtension(fragment);
  return { totals, xml };
}
