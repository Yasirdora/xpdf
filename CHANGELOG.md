# Changelog

All notable changes to xpdf are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

- Renamed from OmniPDF to xpdf: packages are now `@xpdf/core`, `@xpdf/document`,
  `@xpdf/einvoice` and `@xpdf/templates`, and PDFs carry the producer `xpdf`.
- One CID per used code point with a CIDToGIDMap; compact font subsets without
  hinting; URL, widow, table-header and forced-break fixes from the second review.

## [0.1.0] — 2026-08-12

First public release.

### @xpdf/core
- Deterministic PDF writer: object allocator, xref/trailer, streams.
- Own fixed-Huffman DEFLATE (RFC 1950 zlib format) and INFLATE with
  header/adler32 verification — zero dependencies.
- Base-14 fonts with AFM metrics + WinAnsi encoding; embedded TrueType
  (glyf) parser, subsetter, Type0/Identity-H with ToUnicode maps.
- JPEG embedding, link annotations, document outlines, file attachments,
  XMP metadata (UTF-8 with BOM).
- PDF/A-3: sRGB OutputIntent, pdfaid XMP, AFRelationship; base-14 fonts
  rejected at build time with a clear error.
- Reader: `extractEmbeddedFiles` / `extractAttachment` (living-payload
  round-trip).

### @xpdf/document
- Layout engine: paragraphs with mixed styled runs, tables (column
  solving, repeated headers, row chunking), images, spacers, page breaks.
- Pagination: keepTogether/keepWithNext, orphans/widows, convergence
  fixpoint for footnotes (NonConvergenceError diagnostics).
- Render furniture: page header/footer callbacks with font resolution
  (`FurnitureContext.font`) and total page count.

### @xpdf/einvoice
- EN 16931 invoice model with validation and decimal-exact totals
  (decimal-string scaling; shared by XML and visual layer).
- Factur-X / ZUGFeRD CII XML (D16B, EN16931 profile, XSD sequence order).
- `applyFacturX`: attaches factur-x.xml + fx: XMP extension in one call.

### @xpdf/templates
- Invoice (single source of truth for totals; branded theme).
- CV, business letter, report (title page, numbered sections, rich
  blocks, "Page X of Y"), academic paper (abstract, hanging-indent
  references, footnotes).
- Screenplay: complete Fountain parser + self-paginating Courier layout
  with (MORE)/(CONT'D), dual dialogue, scene-heading orphan rules,
  furniture-drawn title page.
- Every template embeds its source as `document.json` (living payload);
  screenplay round-trips its Fountain text.

### apps/studio
- xpdf Studio playground (React + Vite): six template tabs, live
  preview, download, drag-back restore from document.json.

### Validation
- 179 tests across the monorepo; every template byte-determinism-tested.
- External validation scripts (pypdf, xml.dom) for Factur-X and all
  template examples: `scripts/validate-facturx.py`,
  `scripts/validate-phase3.py`, `apps/studio/scripts/validate-studio.ts`.

### Known limitations
- Factur-X structural conformance verified; official validator CI
  (veraPDF, Mustang) pending — treat as pre-certification.
- Single-column layout; TrueType (glyf) fonts only; Latin scripts only.

[0.1.0]: https://github.com/Yasirdora/xpdf/releases/tag/v0.1.0
