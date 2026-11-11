# xpdf

**The universal structured-document PDF engine.** Zero runtime dependencies, byte-deterministic output, and every generated PDF carries its own editable source — download it, drag it back, keep editing.

```
npm install @xpdf/core        # the writer
npm install @xpdf/document    # + layout engine (paragraphs, tables, footnotes, TTF fonts)
npm install @xpdf/einvoice    # + EN 16931 e-invoicing (Factur-X / ZUGFeRD)
npm install @xpdf/templates   # + invoice, CV, report, letter, paper, screenplay
```

## Why xpdf

| | |
|---|---|
| **Zero dependencies** | Nothing between you and the bytes. Runs unchanged in Node 18+, browsers, edge workers, embedded JS. |
| **Byte-deterministic** | Own fixed-Huffman DEFLATE, no timestamps, no random IDs, no ICU. Same input → same bytes, forever. Diffable, signable, cacheable. |
| **Living PDFs** | Every document embeds its source as `document.json`. Drag a generated file back into any xpdf tool and it is editable again — the file *is* the project file. |
| **Legally real e-invoicing** | EN 16931 model + Factur-X/ZUGFeRD CII XML + PDF/A-3B container, in one call. |
| **Real typography** | Embedded TrueType fonts with subsetting and ToUnicode maps; footnotes fixpoint-resolved by the paginator. |
| **A screenplay engine** | Full Fountain import with industry-standard layout: `(MORE)`/`(CONT'D)`, dual dialogue, scene-heading orphan rules. Nobody else in JS does this. |

## Quickstart

### An invoice that is also a legal e-invoice

```ts
import { invoiceDocument } from '@xpdf/templates';
import { applyFacturX } from '@xpdf/einvoice';
import { readFileSync, writeFileSync } from 'node:fs';

const invoice = {
  number: 'INV-2026-0042',
  issueDate: '2026-08-12',
  currency: 'EUR',
  seller: { name: 'Atelier Lovelace SAS', country: 'FR', vatId: 'FR12345678901' },
  buyer:  { name: 'Babbage Instruments Ltd', country: 'GB' },
  lines: [
    { description: 'Analytical engine calibration', quantity: 2, unitPrice: 450, vatRate: 20 },
    { description: 'Documentation pack', quantity: 1, unitPrice: 120, vatRate: 5.5 },
  ],
};

// PDF/A-3 requires an embedded font (base-14 fonts are rejected with a clear error)
const theme = {
  font: new Uint8Array(readFileSync('Ubuntu-R.ttf')),
  boldFont: new Uint8Array(readFileSync('Ubuntu-B.ttf')),
  pdfa: '3B' as const,
};

const { doc, totals } = invoiceDocument(invoice, theme);
applyFacturX(doc, invoice);              // attaches factur-x.xml; totals shared with the visual layer
writeFileSync('invoice.pdf', doc.build());
// → PDF/A-3B + factur-x.xml + document.json, totals guaranteed identical everywhere
```

### A screenplay from Fountain source

```ts
import { screenplayDocument } from '@xpdf/templates';

const { doc } = screenplayDocument(`
INT. BABBAGE'S WORKSHOP - DAY

ADA
(reading a card)
Your mill drops a carry on the ninth digit.

CHARLES ^
Then let us argue about music instead.
`);
writeFileSync('screenplay.pdf', doc.build());
// → US Letter, Courier geometry, dual dialogue side by side,
//   (MORE)/(CONT'D) when dialogue crosses a page
```

### The low-level writer

```ts
import { Document } from '@xpdf/core';

const pdf = new Document({ title: 'Hello' });
const page = pdf.addPage(595.28, 841.89);
page.text('Hello, deterministic world', 72, 72, { size: 24 });
const bytes = pdf.build(); // Uint8Array — same input, same bytes, every time
```

## Packages

| Package | What it is |
|---|---|
| [`@xpdf/core`](packages/core) | PDF writer: objects, streams, deterministic deflate, base-14 + embedded TTF fonts (subset, ToUnicode), JPEG, links, outlines, attachments, XMP, PDF/A-3, incremental reader (`extractAttachment`). |
| [`@xpdf/document`](packages/document) | Layout engine: paragraphs with mixed runs, tables, images, keep/orphan/widow rules, footnotes (fixpoint pagination), headers/footers, convergence paginator. |
| [`@xpdf/einvoice`](packages/einvoice) | EN 16931 invoice model, decimal-exact totals, Factur-X/ZUGFeRD CII XML (EN16931 profile), one-call `applyFacturX`. |
| [`@xpdf/templates`](packages/templates) | Ready documents: **invoice, CV, report, letter, academic paper, screenplay** (with a complete Fountain parser). Each embeds its living `document.json` payload. |
| [`apps/studio`](apps/studio) | xpdf Studio — browser playground: edit data, live-preview, download, drag the PDF back and keep editing. `npm run dev -w @xpdf/studio`. |

## The living-PDF idea

Every file xpdf writes embeds its own source document (`document.json`, AFRelationship `/Source`, PDF/A-3 safe):

```ts
import { extractAttachment } from '@xpdf/core';

const json = extractAttachment(pdfBytes, 'document.json');
// → the exact invoice / CV / report / letter / paper data,
//   or the screenplay's Fountain source — rebuild, edit, regenerate
```

Send one file instead of "the PDF" plus "the editable version". The archive copy stays regenerable. The screenplay round-trips as *text*.

## Determinism you can rely on

- own DEFLATE (fixed-Huffman), no zlib version drift
- no timestamps, no document IDs, no random anything
- hand-rolled number formatting (no ICU/Intl anywhere)
- decimal-string money math — IEEE 754 never touches your totals
- every template test includes a byte-identical rebuild assertion

## Status and roadmap

**0.1.0** — everything above is implemented and tested (179 tests green across the monorepo; external validation via pypdf for every example file).

Honest caveats:

- Factur-X output is *structurally* conformant (XMP, OutputIntent, well-formed CII in schema order); CI against official validators (veraPDF, Mustang) is the next hardening step — treat as pre-certification.
- Single-column layout (sidebars and two-column need multi-flow layout — planned).
- TrueType (glyf) only; OTF/CFF and complex-script shaping are plugin-phase work.

Planned: hyphenation (TeX patterns), tagged PDF/UA, digital signatures, OTF/CFF, harfbuzz-wasm shaping.

## Development

```bash
npm install
npm run build       # all packages
npm test            # 179 tests across 4 packages
npm run typecheck
npm run dev -w @xpdf/studio   # the playground
```

Monorepo (npm workspaces). Each package builds ESM + CJS + types with tsup. Example PDFs are generated artifacts (`packages/*/examples/`, gitignored); external validation scripts live in `scripts/`.

## License

[MIT](LICENSE) © 2026 Yasirdora
