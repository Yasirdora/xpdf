/**
 * EN 16931 semantic invoice model — the single source of truth for both the
 * human-readable PDF (via @xpdf/templates) and the machine-readable
 * Factur-X CII XML. Totals are computed once here so the two can never drift.
 */

export interface Party {
  name: string;
  street?: string;
  city?: string;
  zip?: string;
  /** ISO 3166-1 alpha-2, e.g. 'FR', 'DE'. */
  country: string;
  /** VAT identifier incl. country prefix, e.g. 'FR12345678901'. */
  vatId?: string;
  email?: string;
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  /** Net price per unit. */
  unitPrice: number;
  /** VAT rate in percent, e.g. 20 for French standard rate. */
  vatRate: number;
  /** UN/ECE Rec 20 unit code; default 'C62' (piece/one). */
  unitCode?: string;
}

export interface Invoice {
  number: string;
  /** YYYY-MM-DD. */
  issueDate: string;
  /** YYYY-MM-DD. */
  dueDate?: string;
  /** ISO 4217, e.g. 'EUR'. */
  currency: string;
  seller: Party;
  buyer: Party;
  lines: InvoiceLine[];
  /** Free-text note printed on the document and embedded in the XML. */
  notes?: string;
  paymentTerms?: string;
  /** Seller IBAN for SEPA credit transfer (payment means type 58). */
  iban?: string;
  /** Buyer reference required by some jurisdictions (BT-10). */
  buyerReference?: string;
}

export interface VatBreakdown {
  rate: number;
  basis: number;
  tax: number;
}

export interface InvoiceTotals {
  /** Per-line net amounts (rounded), aligned with lines[]. */
  lineAmounts: number[];
  net: number;
  vat: VatBreakdown[];
  tax: number;
  gross: number;
}

/**
 * Round half away from zero to 2 decimals (EN 16931 business rule:
 * rounding happens at line level, VAT is computed on the summed basis
 * per rate). Scaling goes through the decimal string representation —
 * 1.005 * 100 is 100.49999… in IEEE-754, but Number('1.005e2') is exactly
 * 100.5, so monetary edge cases round the way accountants expect.
 */
export function round2(v: number): number {
  const sign = v < 0 ? -1 : 1;
  const abs = Math.abs(v);
  return sign * Number(Math.round(Number(abs + 'e2')) + 'e-2');
}

/** Compute all totals from invoice lines — the one place money is calculated. */
export function computeTotals(inv: Invoice): InvoiceTotals {
  const lineAmounts = inv.lines.map((l) => round2(l.quantity * l.unitPrice));
  const net = round2(lineAmounts.reduce((a, b) => a + b, 0));

  const byRate = new Map<number, number>();
  inv.lines.forEach((l, i) => {
    byRate.set(l.vatRate, (byRate.get(l.vatRate) ?? 0) + lineAmounts[i]!);
  });
  const vat: VatBreakdown[] = [...byRate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rate, basis]) => {
      const b = round2(basis);
      return { rate, basis: b, tax: round2((b * rate) / 100) };
    });
  const tax = round2(vat.reduce((a, v) => a + v.tax, 0));
  return { lineAmounts, net, vat, tax, gross: round2(net + tax) };
}

/** Validate the semantic minimum before rendering/serializing. */
export function validateInvoice(inv: Invoice): string[] {
  const errors: string[] = [];
  if (!inv.number) errors.push('invoice number is required (BT-1)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inv.issueDate)) errors.push('issueDate must be YYYY-MM-DD (BT-2)');
  if (inv.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(inv.dueDate)) errors.push('dueDate must be YYYY-MM-DD (BT-9)');
  if (!/^[A-Z]{3}$/.test(inv.currency)) errors.push('currency must be ISO 4217, e.g. EUR (BT-5)');
  if (!inv.seller.name) errors.push('seller.name is required (BT-27)');
  if (!inv.seller.country) errors.push('seller.country is required (BT-40)');
  if (!inv.buyer.name) errors.push('buyer.name is required (BT-44)');
  if (!inv.buyer.country) errors.push('buyer.country is required (BT-55)');
  if (!inv.lines.length) errors.push('at least one invoice line is required (BG-25)');
  inv.lines.forEach((l, i) => {
    if (!l.description) errors.push(`line ${i + 1}: description required (BT-153)`);
    if (!(l.quantity > 0)) errors.push(`line ${i + 1}: quantity must be > 0 (BT-129)`);
    if (!Number.isFinite(l.unitPrice)) errors.push(`line ${i + 1}: unitPrice must be finite (BT-146)`);
    if (!Number.isFinite(l.vatRate) || l.vatRate < 0) errors.push(`line ${i + 1}: vatRate invalid (BT-152)`);
  });
  return errors;
}
