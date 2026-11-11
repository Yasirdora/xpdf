# @xpdf/core

Zero-dependency, byte-deterministic PDF writer — the foundation of the xpdf document engine.

```bash
npm install @xpdf/core
```

```ts
import { Document } from '@xpdf/core';

const pdf = new Document({ title: 'Hello' });
const page = pdf.addPage(595.28, 841.89); // A4
page.text('Hello, deterministic world', 72, 72, { size: 24 });
const bytes: Uint8Array = pdf.build(); // same input → same bytes, every time
```

## What's inside

- **Deterministic by construction**: own fixed-Huffman DEFLATE, no timestamps, no random IDs. Diffable, signable, cacheable output.
- **Fonts**: base-14 with AFM metrics and WinAnsi; embedded TrueType with parsing, subsetting, Type0/Identity-H and ToUnicode maps.
- **Features**: JPEG, links, outlines, attachments, XMP metadata.
- **PDF/A-3**: sRGB OutputIntent, pdfaid XMP, AFRelationship attachments; base-14 usage throws a clear build-time error in PDF/A mode.
- **Reader**: `extractEmbeddedFiles` / `extractAttachment` for the living-payload round-trip.
- **Zero dependencies**, ESM + CJS + types, Node 18+ and browsers.

Part of [xpdf](https://github.com/Yasirdora/xpdf). MIT © 2026 Yasirdora.
