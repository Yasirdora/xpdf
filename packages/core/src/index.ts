/**
 * @xpdf/core — zero-dependency, deterministic PDF writer.
 *
 * Public API surface. Everything here runs identically in Node, browsers,
 * Deno, and Web Workers: no DOM, no platform APIs, just Uint8Array.
 */
export { Document, Page, hexToRgb, pdfColor, parseJpegSize } from './document.js';
export type {
  DocumentMetadata,
  DocumentOptions,
  TextOptions,
  OutlineItem,
} from './document.js';
export { PdfWriter, ascii, concatBytes, fx } from './writer.js';
export { deflate } from './deflate.js';
export { inflate, inflateZlib, adler32 } from './inflate.js';
export { extractEmbeddedFiles, extractAttachment } from './reader.js';
export type { ExtractedFile } from './reader.js';
export {
  encodeWinAnsi,
  encodePdfString,
  encodePdfStringUtf16,
  UnsupportedCharacterError,
} from './encoding/winansi.js';
export {
  getFontMetrics,
  STANDARD_FONTS,
  LATIN_FONTS,
} from './fonts/standard.js';
export type { StandardFontName, FontMetrics } from './fonts/standard.js';
export { EmbeddedFont } from './fonts/embedded.js';
export { parseTtf, subsetTtf, glyphClosure } from './fonts/ttf.js';
export type { TtfFont, SubsetResult } from './fonts/ttf.js';
export type { FontRef } from './document.js';
export { buildSrgbIccProfile } from './pdfa/icc.js';
