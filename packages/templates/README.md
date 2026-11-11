# @xpdf/templates

Ready-made documents on the xpdf engine: **invoice, CV, report, letter, academic paper, screenplay** — every one a living PDF that carries its own editable source.

```bash
npm install @xpdf/templates
```

```ts
import { cvDocument, letterDocument, screenplayDocument } from '@xpdf/templates';

const cv  = cvDocument({ name: 'Ada Lovelace', experience: [/*…*/] });
const fx  = screenplayDocument(`INT. WORKSHOP - DAY\n\nADA\nIt begins.\n`);
cv.doc.build();  // CV.pdf + embedded document.json
fx.doc.build();  // US Letter screenplay + embedded Fountain source
```

## Templates

| | |
|---|---|
| `invoiceDocument` | Branded EN 16931 invoice; totals from `@xpdf/einvoice` — pair with `applyFacturX` for Factur-X. |
| `cvDocument` | Classic résumé; roles never strand at page bottoms. |
| `reportDocument` | Title page, auto-numbered sections, lists/tables/quotes/images, footnotes, "Page X of Y". |
| `letterDocument` | International business-letter block layout with signature gap. |
| `paperDocument` | Abstract, keywords, numbered sections, hanging-indent references, real footnotes. |
| `screenplayDocument` | Fountain → industry-standard Courier layout: `(MORE)`/`(CONT'D)`, dual dialogue, scene-heading orphan rules, title page. |
| `parseFountain` | The complete Fountain parser, standalone. |

## Living payloads

Every template embeds `document.json` (`/Source` relationship, PDF/A-3 safe). Restore with `extractAttachment` from `@xpdf/core` — the file you sent is the file you edit.

All themes accept `accent`, custom fonts (base-14 or TTF), and `pdfa: '3B' | '3U'`. Part of [xpdf](https://github.com/Yasirdora/xpdf). MIT © 2026 Yasirdora.
