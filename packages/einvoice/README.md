# @xpdf/einvoice

EN 16931 e-invoicing for xpdf: validated invoice model, decimal-exact totals, Factur-X / ZUGFeRD output.

```bash
npm install @xpdf/einvoice
```

```ts
import { applyFacturX, computeTotals, validateInvoice, type Invoice } from '@xpdf/einvoice';
import { LayoutDocument } from '@xpdf/document';

const invoice: Invoice = { /* number, dates, seller, buyer, lines… */ };

const errors = validateInvoice(invoice);   // EN 16931 required fields
const totals = computeTotals(invoice);     // decimal-string math — no IEEE 754 surprises

const doc = new LayoutDocument({ /* …pdfa: '3B'… */ });
// …render the visual invoice from the SAME invoice object + totals…
applyFacturX(doc, invoice);                // attaches factur-x.xml + fx: XMP
const bytes = doc.build();                 // PDF/A-3B + CII XML inside
```

## What's inside

- **EN 16931 model** with validation (seller, buyer, dates, lines, VAT rates…).
- **Decimal-exact totals**: decimal-string scaling; the same totals feed the XML and the visual layer — they can never disagree.
- **Factur-X / ZUGFeRD CII XML** (D16B, EN16931 profile, XSD sequence order), attached as `factur-x.xml` with `/Alternative` + the `fx:` XMP extension schema.
- Composes with any `@xpdf/document` layout — bring your own design or use `@xpdf/templates`.

Note: output is structurally conformant (XMP, OutputIntent, well-formed CII); run it through official validators (veraPDF, Mustang) before filing. MIT © 2026 Yasirdora — part of [xpdf](https://github.com/Yasirdora/xpdf).
