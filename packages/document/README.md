# @xpdf/document

Layout engine for xpdf: styled text, tables, images and footnotes, paginated by convergence.

```bash
npm install @xpdf/document
```

```ts
import { LayoutDocument } from '@xpdf/document';

const doc = new LayoutDocument({
  pageSize: 'A4',
  margins: { top: 64, bottom: 64, left: 64, right: 64 },
  title: 'Report',
  defaultStyle: { font: 'body', size: 10.5, lineHeight: 1.4 },
  footer: (page, ctx) => page.text(`Page ${ctx.page} of ${ctx.pages}`, 0, 820, {
    font: ctx.font('body'), size: 8, align: 'center', width: page.width,
  }),
});
doc.font('body', 'Helvetica');
doc.paragraph([
  { text: 'Wear rates were nominal' },
  { text: ', with one exception.', note: 'Train 17 replaced 2026-08-19.' }, // ← real footnote
]);
doc.table({ columns: ['*', 'auto'], header: 1, rows: [['Metric', 'Q3'], ['Outliers', '1']] });
const bytes = doc.build();
```

## What's inside

- Paragraphs with mixed runs (font/size/color), justification, indents, spacing collapse.
- Tables: column solving (`*`/`auto`/fixed), repeated headers, row chunking across pages.
- Footnotes typeset at the bottom of the page the marker lands on — resolved by a pagination fixpoint.
- keepTogether / keepWithNext / orphans / widows.
- Header/footer furniture with resolved fonts and total page count.
- Embedded TTF fonts via `@xpdf/core`; PDF/A-3 passthrough.

Part of [xpdf](https://github.com/Yasirdora/xpdf). MIT © 2026 Yasirdora.
