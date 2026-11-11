/**
 * xpdf document API: pages, text, shapes, JPEG images, link annotations,
 * outline bookmarks, file attachments, and metadata — assembled into a
 * deterministic, valid PDF 1.7 file.
 *
 * Coordinate system: top-left origin, y grows downward (converted internally
 * to PDF's bottom-left space). All sizes in PostScript points (1/72 inch).
 */
import { PdfWriter, ascii, concatBytes, fx } from './writer.js';
import { encodePdfString, encodePdfStringUtf16, encodeWinAnsi } from './encoding/winansi.js';
import { buildSrgbIccProfile } from './pdfa/icc.js';
import { getFontMetrics, STANDARD_FONTS, type StandardFontName } from './fonts/standard.js';
import { EmbeddedFont } from './fonts/embedded.js';

export type FontRef = StandardFontName | EmbeddedFont;

export interface DocumentMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  creator?: string;
  producer?: string;
  /**
   * Opt-in timestamps. Omit (default) for deterministic output — the same
   * document built twice yields identical bytes.
   */
  creationDate?: Date;
  modDate?: Date;
}

export interface DocumentOptions extends DocumentMetadata {
  /** Compress content streams (default true, deterministic deflate). */
  compress?: boolean;
  /**
   * PDF/A-3 mode: '3B' (basic) or '3U' (B + Unicode mapping). Adds an sRGB
   * OutputIntent, pdfaid XMP, and requires ALL fonts embedded — base-14
   * usage throws at build time (register a TTF instead).
   */
  pdfa?: '3B' | '3U';
  /**
   * Raw XML fragments appended to the XMP rdf:Description (extension
   * schemas — e.g. the Factur-X fx: block). Must be well-formed.
   */
  xmpExtensions?: string[];
  /**
   * Natural language of the text (BCP 47, e.g. 'en'), written as the
   * catalog /Lang for screen readers and text-to-speech.
   */
  lang?: string;
}

export interface TextOptions {
  font?: FontRef;
  size?: number;
  color?: string;
  /** Horizontal alignment against `width` (requires width). Default left. */
  align?: 'left' | 'center' | 'right';
  /** Reference width for alignment, in points. */
  width?: number;
  charSpacing?: number;
  /**
   * Retained for callers. Text is drawn with Tj, which does not kern, so
   * measurement never applies AFM kern pairs either.
   */
  kern?: boolean;
}

export interface OutlineItem {
  title: string;
  page: Page;
  /** Vertical position (top-left coords) the bookmark jumps to; default = top of page. */
  y?: number;
  children?: OutlineItem[];
}

interface ImageRef {
  objNum: number;
  index: number; // 1-based /ImN resource index
  width: number;
  height: number;
  /** PDF colour space from the SOF component count: 1 → DeviceGray, 3 → DeviceRGB. */
  colorSpace: 'DeviceGray' | 'DeviceRGB';
  bytes: Uint8Array;
}

interface LinkAnnot {
  x: number;
  y: number;
  w: number;
  h: number;
  url: string;
}

const DEFAULT_PRODUCER = 'xpdf';

export class Document {
  private pages: Page[] = [];
  private fonts = new Map<StandardFontName, string>(); // base-14 name -> resource key (F1…)
  private embeddedFonts = new Map<EmbeddedFont, string>(); // font -> resource key
  private images: ImageRef[] = [];
  private outlines: OutlineItem[] = [];
  private attachments: Array<{ name: string; data: Uint8Array; mime?: string; description?: string; afRelationship?: string }> = [];
  private meta: DocumentMetadata;
  private compress: boolean;
  private pdfa?: '3B' | '3U';
  private xmpExtensions: string[];
  private lang?: string;

  constructor(opts?: DocumentOptions) {
    const { compress, pdfa, xmpExtensions, lang, ...meta } = opts ?? {};
    this.meta = meta;
    this.lang = lang;
    this.compress = compress ?? true;
    this.pdfa = pdfa;
    this.xmpExtensions = xmpExtensions ?? [];
  }

  /** Add a page. Defaults to A4 (595.28 × 841.89 pt). */
  addPage(width = 595.28, height = 841.89): Page {
    const page = new Page(this, width, height);
    this.pages.push(page);
    return page;
  }

  /** Register (idempotently) a base-14 font; returns its resource key. */
  registerFont(name: StandardFontName): string {
    let key = this.fonts.get(name);
    if (!key) {
      if (!STANDARD_FONTS.includes(name)) throw new Error(`Unknown base-14 font: ${name}`);
      key = `F${this.fonts.size + this.embeddedFonts.size + 1}`;
      this.fonts.set(name, key);
      getFontMetrics(name); // validates eagerly
    }
    return key;
  }

  /**
   * Embed a TrueType font (glyf outlines). Accepts raw bytes or a pre-parsed
   * EmbeddedFont (e.g. one already used for measuring). Returns a font usable
   * in text().
   */
  embedFont(input: Uint8Array | EmbeddedFont): EmbeddedFont {
    const font = input instanceof EmbeddedFont ? input : new EmbeddedFont(input);
    const existing = this.embeddedFonts.get(font);
    if (existing) return font;
    const key = `F${this.fonts.size + this.embeddedFonts.size + 1}`;
    this.embeddedFonts.set(font, key);
    return font;
  }

  /** @internal — resource key for an embedded font (registered on first use). */
  registerEmbedded(font: EmbeddedFont): string {
    let key = this.embeddedFonts.get(font);
    if (!key) {
      key = `F${this.fonts.size + this.embeddedFonts.size + 1}`;
      this.embeddedFonts.set(font, key);
    }
    return key;
  }

  /** Register a JPEG image; returns an internal reference. */
  registerJpeg(bytes: Uint8Array): ImageRef {
    const { width, height, components } = parseJpegSize(bytes);
    if (components !== 1 && components !== 3) {
      throw new Error(`unsupported JPEG: ${components} colour components (only greyscale and RGB are supported)`);
    }
    const colorSpace = components === 1 ? 'DeviceGray' : 'DeviceRGB';
    const ref: ImageRef = { objNum: -1, index: this.images.length + 1, width, height, colorSpace, bytes: new Uint8Array(bytes) };
    this.images.push(ref);
    return ref;
  }

  /** Attach an arbitrary file (round-trip payloads, source data, CSVs…). */
  attach(name: string, data: Uint8Array, opts?: { mime?: string; description?: string; afRelationship?: 'Data' | 'Source' | 'Alternative' | 'Supplement' | 'Unspecified' }): void {
    this.attachments.push({ name, data: new Uint8Array(data), mime: opts?.mime, description: opts?.description, afRelationship: opts?.afRelationship });
  }

  /** Set the document outline (bookmarks sidebar). */
  setOutlines(items: OutlineItem[]): void {
    this.outlines = items;
  }

  /** Serialize to a deterministic Uint8Array. Safe to call multiple times. */
  build(): Uint8Array {
    if (this.pdfa && this.fonts.size > 0) {
      throw new Error(
        `PDF/A-${this.pdfa} requires every font to be embedded, but base-14 fonts ` +
          `(${[...this.fonts.keys()].join(', ')}) are not embeddable. Register a TTF ` +
          'with doc.embedFont() and use it instead.',
      );
    }
    const w = new PdfWriter();

    // --- allocate core objects in a fixed order ---
    const catalogObj = w.allocate();
    const pagesObj = w.allocate();
    const infoObj = w.allocate();
    const xmpObj = w.allocate();

    // PDF/A: OutputIntent (dict + embedded sRGB ICC profile)
    const outputIntentObj = this.pdfa ? w.allocate() : 0;
    const iccObj = this.pdfa ? w.allocate() : 0;

    const fontObjs = new Map<string, number>();
    for (const key of this.fonts.values()) fontObjs.set(key, w.allocate());

    // embedded fonts: 6 objects each (Type0, CIDFont, Descriptor, FontFile2, ToUnicode, CIDToGIDMap)
    const embeddedObjs = new Map<string, { type0: number; cid: number; descriptor: number; fontFile: number; toUnicode: number; cidToGid: number }>();
    for (const [font, key] of this.embeddedFonts) {
      font.assignCids();
      const objs = {
        type0: w.allocate(),
        cid: w.allocate(),
        descriptor: w.allocate(),
        fontFile: w.allocate(),
        toUnicode: w.allocate(),
        cidToGid: w.allocate(),
      };
      embeddedObjs.set(key, objs);
      fontObjs.set(key, objs.type0);
    }

    for (const img of this.images) img.objNum = w.allocate();

    const contentObjs: number[] = [];
    const pageObjs: number[] = [];
    const annotObjNums: number[][] = [];
    for (const page of this.pages) {
      pageObjs.push(w.allocate());
      contentObjs.push(w.allocate());
      annotObjNums.push(page.links.map(() => w.allocate()));
    }

    const outlineRoot = this.outlines.length > 0 ? w.allocate() : 0;
    const outlineObjs: number[] = [];
    if (outlineRoot) {
      const flatCount = countOutlines(this.outlines);
      for (let i = 0; i < flatCount; i++) outlineObjs.push(w.allocate());
    }

    const namesObj = this.attachments.length > 0 ? w.allocate() : 0;
    const attachmentObjs = this.attachments.map(() => w.allocate()); // EmbeddedFile streams
    const filespecObjs = this.attachments.map(() => w.allocate()); // Filespec dicts referencing them

    // --- shared resource dictionary ---
    // fontObjs covers base-14 AND embedded fonts (Type0 objNums); iterate both maps
    const allFontKeys = [...this.fonts.values(), ...this.embeddedFonts.values()];
    const fontRes = allFontKeys.map((key) => `/${key} ${fontObjs.get(key)} 0 R`).join(' ');
    const imgRes = this.images
      .map((img, i) => `/Im${i + 1} ${img.objNum} 0 R`)
      .join(' ');
    const resources =
      `<<${fontRes ? ` /Font << ${fontRes} >>` : ''}${imgRes ? ` /XObject << ${imgRes} >>` : ''} >>`;

    // --- catalog / pages tree ---
    const namesPart = namesObj ? ` /Names ${namesObj} 0 R /AF [${filespecObjs.map((n) => `${n} 0 R`).join(' ')}]` : '';
    const outlinePart = outlineRoot ? ` /Outlines ${outlineRoot} 0 R /PageMode /UseOutlines` : '';
    const outputIntentsPart = this.pdfa ? ` /OutputIntents [${outputIntentObj} 0 R]` : '';
    const langPart = this.lang ? ` /Lang ${encodePdfString(this.lang)}` : '';
    // show the document title, not the file name, in the viewer's title bar
    const viewerPart = this.meta.title ? ' /ViewerPreferences << /DisplayDocTitle true >>' : '';
    w.setObject(
      catalogObj,
      `<< /Type /Catalog /Pages ${pagesObj} 0 R /Metadata ${xmpObj} 0 R${outlinePart}${namesPart}${outputIntentsPart}${langPart}${viewerPart} >>`,
    );
    w.setObject(
      pagesObj,
      `<< /Type /Pages /Kids [${pageObjs.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageObjs.length} >>`,
    );

    // --- PDF/A OutputIntent with embedded sRGB ICC profile ---
    if (this.pdfa) {
      const icc = buildSrgbIccProfile();
      w.setStreamObject(iccObj, ` /N 3 /Alternate /DeviceRGB`, icc, { compress: this.compress });
      w.setObject(
        outputIntentObj,
        `<< /Type /OutputIntent /S /GTS_PDFA1 /OutputConditionIdentifier (sRGB) ` +
          `/Info (sRGB IEC 61966-2-1) /DestOutputProfile ${iccObj} 0 R >>`,
      );
    }

    // --- info + XMP ---
    w.setObject(infoObj, buildInfoDict(this.meta));
    w.setStreamObject(xmpObj, ' /Type /Metadata /Subtype /XML', new TextEncoder().encode(buildXmp(this.meta, this.pdfa, this.xmpExtensions)), { compress: false });

    // --- fonts ---
    for (const [name, key] of this.fonts.entries()) {
      const encoding = getFontMetrics(name).isLatin ? ' /Encoding /WinAnsiEncoding' : '';
      w.setObject(fontObjs.get(key)!, `<< /Type /Font /Subtype /Type1 /BaseFont /${name}${encoding} >>`);
    }
    for (const [font, key] of this.embeddedFonts) {
      font.emit(w, embeddedObjs.get(key)!);
    }

    // --- images (JPEG streams keep their native DCT encoding) ---
    this.images.forEach((img) => {
      w.setStreamObject(
        img.objNum,
        ` /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /${img.colorSpace} /BitsPerComponent 8`,
        img.bytes,
        { compress: false, rawFilter: 'DCTDecode' },
      );
    });

    // --- pages & content ---
    this.pages.forEach((page, i) => {
      const annots = annotObjNums[i]!;
      const annotPart = annots.length ? ` /Annots [${annots.map((n) => `${n} 0 R`).join(' ')}]` : '';
      w.setObject(
        pageObjs[i]!,
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${fx(page.width)} ${fx(page.height)}] /Resources ${resources} /Contents ${contentObjs[i]} 0 R${annotPart} >>`,
      );
      w.setStreamObject(contentObjs[i]!, '', ascii(page.contents()), { compress: this.compress });

      page.links.forEach((link, j) => {
        const x1 = link.x;
        const y1 = page.height - link.y - link.h;
        const x2 = link.x + link.w;
        const y2 = page.height - link.y;
        w.setObject(
          annots[j]!,
          `<< /Type /Annot /Subtype /Link /Rect [${fx(x1)} ${fx(y1)} ${fx(x2)} ${fx(y2)}] /F 4 /Border [0 0 0] /BS << /W 0 >> /A << /S /URI /URI ${encodePdfString(asciiUri(link.url))} >> >>`,
        );
      });
    });

    // --- outlines ---
    if (outlineRoot) {
      const flat = flattenOutlines(this.outlines, pageObjs, this.pages);
      flat.forEach((node, idx) => {
        const parts: string[] = [
          `/Title ${encodePdfStringUtf16(node.title)}`,
          `/Parent ${node.parent === -1 ? outlineRoot : outlineObjs[node.parent]} 0 R`,
        ];
        if (node.prev >= 0) parts.push(`/Prev ${outlineObjs[node.prev]} 0 R`);
        if (node.next >= 0) parts.push(`/Next ${outlineObjs[node.next]} 0 R`);
        if (node.children.length > 0) {
          const descendants = subtreeSize(flat, idx) - 1;
          parts.push(
            `/First ${outlineObjs[node.children[0]!]} 0 R /Last ${outlineObjs[node.children[node.children.length - 1]!]} 0 R /Count ${descendants}`,
          );
        }
        parts.push(`/Dest [${node.pageObj} 0 R /XYZ null ${fx(node.destY)} null]`);
        w.setObject(outlineObjs[idx]!, `<< ${parts.join(' ')} >>`);
      });
      const tops = flat.map((_, i) => i).filter((i) => flat[i]!.parent === -1);
      w.setObject(
        outlineRoot,
        `<< /Type /Outlines /First ${outlineObjs[tops[0]!]} 0 R /Last ${outlineObjs[tops[tops.length - 1]!]} 0 R /Count ${flat.length} >>`,
      );
    }

    // --- attachments ---
    if (namesObj) {
      // Name-tree keys are compared as PDF string bytes, so the order is the
      // WinAnsi byte order of the names, not the order attach() was called.
      const order = this.attachments
        .map((_, i) => i)
        .sort((i, j) => comparePdfName(this.attachments[i]!.name, this.attachments[j]!.name));
      const entries = order
        .map((i) => `${encodePdfString(this.attachments[i]!.name)} ${filespecObjs[i]} 0 R`)
        .join(' ');
      w.setObject(namesObj, `<< /EmbeddedFiles << /Names [${entries}] >> >>`);
      this.attachments.forEach((a, i) => {
        const mime = a.mime ? ` /Subtype /${a.mime.replace('/', '#2F')}` : '';
        const params = ` /Params << /Size ${a.data.length} >>`;
        const desc = a.description ? ` /Desc ${encodePdfString(a.description)}` : '';
        const afRel = a.afRelationship ? ` /AFRelationship /${a.afRelationship}` : '';
        w.setObject(
          filespecObjs[i]!,
          `<< /Type /Filespec /F ${encodePdfString(a.name)} /UF ${encodePdfStringUtf16(a.name)}${desc}${afRel} /EF << /F ${attachmentObjs[i]} 0 R /UF ${attachmentObjs[i]} 0 R >> >>`,
        );
        w.setStreamObject(attachmentObjs[i]!, ` /Type /EmbeddedFile${mime}${params}`, a.data, { compress: this.compress });
      });
    }

    return w.build(catalogObj, infoObj);
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface ContentSeg {
  /** Literal content, or the text around an embedded-font hex string filled in at build. */
  before: string;
  after: string;
  font: EmbeddedFont | null;
  text: string;
}

export class Page {
  readonly width: number;
  readonly height: number;
  /** @internal */ private readonly segs: ContentSeg[] = [];
  /** @internal */ readonly links: LinkAnnot[] = [];
  private doc: Document;

  /** Content stream. Embedded-font CIDs are encoded now, after assignCids(). */
  contents(): string {
    return this.segs
      .map((seg) => seg.before + (seg.font ? seg.font.encodeHex(seg.text) : seg.text) + seg.after)
      .join('\n');
  }

  constructor(doc: Document, width: number, height: number) {
    this.doc = doc;
    this.width = width;
    this.height = height;
  }

  /** Draw text. y is the baseline, measured from the top of the page. */
  text(str: string, x: number, y: number, opts?: TextOptions): this {
    const size = opts?.size ?? 12;
    const color = opts?.color ?? '#000000';
    const fontRef = opts?.font;
    const isEmbedded = fontRef instanceof EmbeddedFont;
    const fontName: StandardFontName = !isEmbedded && fontRef ? fontRef : 'Helvetica';

    const key = isEmbedded ? this.doc.registerEmbedded(fontRef) : this.doc.registerFont(fontName);

    const widthAt = (s: string): number =>
      isEmbedded
        ? fontRef.widthAt(s, size) + (opts?.charSpacing ?? 0) * [...s].length
        : getFontMetrics(fontName).widthAt(s, size, { kern: false, charSpacing: opts?.charSpacing ?? 0 });

    let tx = x;
    const align = opts?.align ?? 'left';
    if (align !== 'left') {
      if (opts?.width === undefined) throw new Error('text align requires a width');
      const tw = widthAt(str);
      tx = align === 'right' ? x + opts.width - tw : x + (opts.width - tw) / 2;
    }

    // Tc is text state, which outlives ET: reset it so it cannot leak into
    // the next text() call. Embedded CIDs are filled in at build, once every
    // code point has been seen and sorted.
    const cs = opts?.charSpacing ? `${fx(opts.charSpacing)} Tc ` : '';
    const csReset = opts?.charSpacing ? ' 0 Tc' : '';
    const before = `BT /${key} ${fx(size)} Tf ${pdfColor(color)} rg ${cs}${fx(tx)} ${fx(this.height - y)} Td `;
    const after = ` Tj${csReset} ET`;
    if (isEmbedded) {
      fontRef.note(str);
      this.segs.push({ before, after, font: fontRef, text: str });
    } else {
      this.segs.push({ before, after, font: null, text: encodePdfString(str) });
    }
    return this;
  }

  /** Filled rectangle (top-left coords). */
  rect(x: number, y: number, w: number, h: number, fill: string): this {
    this.segs.push({ before: `${pdfColor(fill)} rg ${fx(x)} ${fx(this.height - y - h)} ${fx(w)} ${fx(h)} re f`, after: '', font: null, text: '' });
    return this;
  }

  /** Stroked rectangle outline (top-left coords). */
  strokeRect(x: number, y: number, w: number, h: number, stroke: string, width = 1): this {
    this.segs.push({
      before: `${pdfColor(stroke)} RG ${fx(width)} w ${fx(x)} ${fx(this.height - y - h)} ${fx(w)} ${fx(h)} re S`,
      after: '', font: null, text: '',
    });
    return this;
  }

  /** Stroked line. */
  line(x1: number, y1: number, x2: number, y2: number, stroke: string, width = 1): this {
    this.segs.push({
      before: `${pdfColor(stroke)} RG ${fx(width)} w ${fx(x1)} ${fx(this.height - y1)} m ${fx(x2)} ${fx(this.height - y2)} l S`,
      after: '', font: null, text: '',
    });
    return this;
  }

  /** Place a JPEG image (natural size read from the file; scaled to w × h). */
  imageJpeg(bytes: Uint8Array, x: number, y: number, w: number, h: number): this {
    const ref = this.doc.registerJpeg(bytes);
    this.segs.push({
      before: `q ${fx(w)} 0 0 ${fx(h)} ${fx(x)} ${fx(this.height - y - h)} cm /Im${ref.index} Do Q`,
      after: '', font: null, text: '',
    });
    return this;
  }

  /** Clickable link rectangle (top-left coords). Optional visual underline. */
  link(url: string, x: number, y: number, w: number, h: number, opts?: { underline?: string }): this {
    this.links.push({ url, x, y, w, h });
    if (opts?.underline) this.line(x, y + h, x + w, y + h, opts.underline, 0.7);
    return this;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * A /URI action holds a 7-bit ASCII URI (PDF 32000-1 §12.6.4.7).
 * Percent-encode every octet outside the RFC 3986 unreserved and reserved
 * sets. An existing %XX is left as-is so we never double-encode.
 */
const URI_ALLOWED = /[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=]/;

export function asciiUri(url: string): string {
  let out = '';
  for (let i = 0; i < url.length; ) {
    if (url.charCodeAt(i) === 0x25 && /^%[0-9A-Fa-f]{2}/.test(url.slice(i, i + 3))) {
      out += url.slice(i, i + 3);
      i += 3;
      continue;
    }
    const cp = url.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    out += URI_ALLOWED.test(ch) ? ch : encodeURIComponent(ch);
    i += ch.length;
  }
  return out;
}

/** Byte-wise order of two PDF name-tree keys (WinAnsi string values). */
function comparePdfName(a: string, b: string): number {
  const ab = encodeWinAnsi(a);
  const bb = encodeWinAnsi(b);
  const n = Math.min(ab.length, bb.length);
  for (let i = 0; i < n; i++) if (ab[i] !== bb[i]) return ab[i]! - bb[i]!;
  return ab.length - bb.length;
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) throw new Error(`invalid color ${JSON.stringify(hex)} — expected #rrggbb`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function pdfColor(hex: string): string {
  return hexToRgb(hex)
    .map((v) => fx(v / 255))
    .join(' ');
}

/** Parse JPEG SOF marker for intrinsic dimensions and the colour component count. */
export function parseJpegSize(bytes: Uint8Array): { width: number; height: number; components: number } {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG (missing SOI)');
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    // 0xFF fill bytes may precede a marker. The last 0xFF starts the marker.
    while (i < bytes.length && bytes[i] === 0xff) i++;
    if (i >= bytes.length) break;
    const marker = bytes[i++]!;
    // No length field: stuffed FF/00, TEM, RST0–RST7, SOI, EOI.
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      if (marker === 0xd9) break;
      continue;
    }
    if (i + 1 >= bytes.length) break;
    const len = (bytes[i]! << 8) | bytes[i + 1]!;
    if (len < 2) break;
    // SOF0–SOF15 except DHT(0xC4), JPG(0xC8), DAC(0xCC). i points at the length.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 7 >= bytes.length) break;
      const height = (bytes[i + 3]! << 8) | bytes[i + 4]!;
      const width = (bytes[i + 5]! << 8) | bytes[i + 6]!;
      const components = bytes[i + 7]!;
      return { width, height, components };
    }
    i += len;
  }
  throw new Error('not a JPEG (no SOF marker found)');
}

function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `(D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z)`;
}

function buildInfoDict(meta: DocumentMetadata): string {
  const parts: string[] = [];
  if (meta.title) parts.push(`/Title ${encodePdfStringUtf16(meta.title)}`);
  if (meta.author) parts.push(`/Author ${encodePdfStringUtf16(meta.author)}`);
  if (meta.subject) parts.push(`/Subject ${encodePdfStringUtf16(meta.subject)}`);
  if (meta.keywords?.length) parts.push(`/Keywords ${encodePdfStringUtf16(meta.keywords.join(', '))}`);
  if (meta.creator) parts.push(`/Creator ${encodePdfStringUtf16(meta.creator)}`);
  parts.push(`/Producer ${encodePdfStringUtf16(meta.producer ?? DEFAULT_PRODUCER)}`);
  if (meta.creationDate) parts.push(`/CreationDate ${pdfDate(meta.creationDate)}`);
  if (meta.modDate) parts.push(`/ModDate ${pdfDate(meta.modDate)}`);
  return `<< ${parts.join(' ')} >>`;
}

function xmpEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildXmp(meta: DocumentMetadata, pdfa?: '3B' | '3U', extensions: string[] = []): string {
  const rows: string[] = [];
  if (meta.title) rows.push(`<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmpEscape(meta.title)}</rdf:li></rdf:Alt></dc:title>`);
  if (meta.author) rows.push(`<dc:creator><rdf:Seq><rdf:li>${xmpEscape(meta.author)}</rdf:li></rdf:Seq></dc:creator>`);
  if (meta.subject) rows.push(`<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmpEscape(meta.subject)}</rdf:li></rdf:Alt></dc:description>`);
  if (meta.creator) rows.push(`<xmp:CreatorTool>${xmpEscape(meta.creator)}</xmp:CreatorTool>`);
  rows.push(`<pdf:Producer>${xmpEscape(meta.producer ?? DEFAULT_PRODUCER)}</pdf:Producer>`);
  if (pdfa) {
    rows.push(`<pdfaid:part>3</pdfaid:part>`);
    rows.push(`<pdfaid:conformance>${pdfa === '3U' ? 'U' : 'B'}</pdfaid:conformance>`);
  }
  rows.push(...extensions);
  const pdfaidNs = pdfa ? ' xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"' : '';
  return [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/"${pdfaidNs}>`,
    rows.join('\n'),
    '</rdf:Description>',
    '</rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// outline flattening
// ---------------------------------------------------------------------------

interface FlatOutline {
  title: string;
  pageObj: number;
  destY: number;
  /** Index of parent node, or -1 for top level. */
  parent: number;
  /** Indices of direct children. */
  children: number[];
  /** Index of previous/next sibling, or -1. */
  prev: number;
  next: number;
}

function subtreeSize(flat: FlatOutline[], idx: number): number {
  let size = 1;
  for (const c of flat[idx]!.children) size += subtreeSize(flat, c);
  return size;
}

function countOutlines(items: OutlineItem[]): number {
  return items.reduce((s, it) => s + 1 + (it.children ? countOutlines(it.children) : 0), 0);
}

function flattenOutlines(items: OutlineItem[], pageObjs: number[], pages: Page[]): FlatOutline[] {
  const out: FlatOutline[] = [];

  const walk = (list: OutlineItem[], parent: number): number[] => {
    const indices: number[] = [];
    for (const item of list) {
      const pageIndex = pages.indexOf(item.page);
      if (pageIndex < 0) throw new Error(`outline ${JSON.stringify(item.title)} references a page not in this document`);
      const idx = out.length;
      out.push({
        title: item.title,
        pageObj: pageObjs[pageIndex]!,
        destY: item.page.height - (item.y ?? 0),
        parent,
        children: [],
        prev: -1,
        next: -1,
      });
      indices.push(idx);
      out[idx]!.children = item.children?.length ? walk(item.children, idx) : [];
    }
    indices.forEach((idx, i) => {
      out[idx]!.prev = i > 0 ? indices[i - 1]! : -1;
      out[idx]!.next = i < indices.length - 1 ? indices[i + 1]! : -1;
    });
    return indices;
  };

  walk(items, -1);
  return out;
}
