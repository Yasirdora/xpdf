/**
 * LayoutDocument: the public face of @omnipdf/document.
 *
 * Structured content in (paragraphs, tables, images, footnotes), paginated
 * PDF bytes out. Templates (CV, invoice, report, screenplay, paper) compile
 * down to these calls — document types are data, not code.
 */
import { ImageBlock, PageBreakBlock, ParagraphBlock, SpacerBlock, type Block } from './blocks.js';
import { FontRegistry, Measurer, type FontSource } from './measurer.js';
import { paginate, type PageGeometry, type PaginationContext } from './paginator.js';
import { renderPages, type FurnitureFn } from './render.js';
import { TableBlock, type ColumnSpec, type ResolvedTableStyle } from './table.js';
import type { StyledRun } from './line-break.js';
import type { BlockProps, ParagraphStyle, ResolvedParagraphStyle, TextRun } from './types.js';

export interface PageMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type PageSize = 'A4' | 'LETTER' | 'A5' | { width: number; height: number };

const PAGE_SIZES: Record<string, { width: number; height: number }> = {
  A4: { width: 595.28, height: 841.89 },
  LETTER: { width: 612, height: 792 },
  A5: { width: 419.53, height: 595.28 },
};

export interface LayoutDocumentOptions {
  pageSize?: PageSize;
  /** Pt, or per-side overrides. Default 56.7pt (20mm) everywhere. */
  margins?: number | Partial<PageMargins>;
  defaultStyle?: ParagraphStyle;
  noteStyle?: { font?: string; size?: number; lineHeight?: number; color?: string };
  /** Drawn on every page, inside the margins — page numbers, running heads. */
  header?: FurnitureFn;
  footer?: FurnitureFn;
  /** PDF/A-3 archival mode ('3B' | '3U'). Requires all-embedded fonts. */
  pdfa?: '3B' | '3U';
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  /** Natural language of the text (BCP 47, e.g. 'en'), written as the catalog /Lang. */
  lang?: string;
  /** Build the bookmarks sidebar from the headings (nested by level). Default false. */
  outline?: boolean;
}

export interface TableDef extends BlockProps {
  columns: ColumnSpec[];
  rows: Array<Array<string | TextRun[]>>;
  /** Leading rows repeated on every page the table continues onto. */
  header?: number;
  /** Per-column horizontal alignment (numbers right, text left — e.g. ['left','right','right']). */
  columnAlign?: Array<'left' | 'right' | 'center'>;
  style?: {
    font?: string;
    size?: number;
    lineHeight?: number;
    color?: string;
    padding?: number;
    borders?: 'all' | 'horizontal' | 'none';
    borderColor?: string;
    headerFont?: string;
    headerColor?: string;
    /** Header row background; default '#f3f4f6'. */
    headerFill?: string | null;
  };
}

const HEADING_SIZES = [20, 16, 13.5, 12, 11, 10.5];

export class LayoutDocument {
  private readonly geom: PageGeometry;
  private readonly registry = new FontRegistry();
  private readonly measurer = new Measurer(this.registry);
  private readonly blocks: Block[] = [];
  private readonly notes = new Map<number, string>();
  private readonly attachments: Array<{ name: string; data: Uint8Array; opts?: { mime?: string; description?: string; afRelationship?: 'Data' | 'Source' | 'Alternative' | 'Supplement' | 'Unspecified' } }> = [];
  private readonly xmpExtensions: string[] = [];
  private noteCounter = 0;
  private readonly defaultStyle: ResolvedParagraphStyle;
  private readonly noteStyle: { font: string; size: number; lineHeight: number; color: string };
  private readonly opts: LayoutDocumentOptions;

  constructor(opts: LayoutDocumentOptions = {}) {
    this.opts = opts;
    const size =
      typeof opts.pageSize === 'object' && opts.pageSize !== null
        ? opts.pageSize
        : PAGE_SIZES[typeof opts.pageSize === 'string' ? opts.pageSize : 'A4']!;
    const m = opts.margins;
    const margins: PageMargins =
      typeof m === 'number'
        ? { top: m, right: m, bottom: m, left: m }
        : { top: m?.top ?? 56.7, right: m?.right ?? 56.7, bottom: m?.bottom ?? 56.7, left: m?.left ?? 56.7 };
    this.geom = {
      pageWidth: size.width,
      pageHeight: size.height,
      marginTop: margins.top,
      marginRight: margins.right,
      marginBottom: margins.bottom,
      marginLeft: margins.left,
    };
    this.defaultStyle = resolveStyle(opts.defaultStyle, {
      font: 'Helvetica',
      size: 11,
      lineHeight: 1.25,
      color: '#000000',
      align: 'left',
      spaceBefore: 0,
      spaceAfter: 6,
      indent: 0,
      firstLineIndent: 0,
    });
    this.noteStyle = {
      font: opts.noteStyle?.font ?? this.defaultStyle.font,
      size: opts.noteStyle?.size ?? 8.5,
      lineHeight: opts.noteStyle?.lineHeight ?? 1.25,
      color: opts.noteStyle?.color ?? this.defaultStyle.color,
    };
  }

  /** Register a font: base-14 name, TTF bytes, or a pre-parsed EmbeddedFont. */
  font(name: string, source: FontSource): this {
    this.registry.register(name, source);
    return this;
  }

  /**
   * Attach a file to the PDF (living-payload document.json, Factur-X XML,
   * source CSVs). Rendered into every build() deterministically.
   */
  attach(
    name: string,
    data: Uint8Array,
    opts?: { mime?: string; description?: string; afRelationship?: 'Data' | 'Source' | 'Alternative' | 'Supplement' | 'Unspecified' },
  ): this {
    this.attachments.push({ name, data, opts });
    return this;
  }

  /** Append a raw XMP extension fragment (e.g. the Factur-X fx: schema block). */
  xmpExtension(xml: string): this {
    this.xmpExtensions.push(xml);
    return this;
  }

  paragraph(text: string | TextRun[], style: ParagraphStyle & BlockProps = {}): this {
    const resolved = resolveStyle(style, this.defaultStyle);
    const runs = this.stylize(text, resolved);
    this.blocks.push(
      new ParagraphBlock(runs, resolved, pickBlockProps(style), 'P'),
    );
    return this;
  }

  heading(text: string | TextRun[], level: 1 | 2 | 3 | 4 | 5 | 6, style: ParagraphStyle & BlockProps = {}): this {
    const size = HEADING_SIZES[level - 1]!;
    const resolved = resolveStyle(
      { size, spaceBefore: 16, spaceAfter: 6, ...style },
      this.defaultStyle,
    );
    const runs = this.stylize(text, resolved);
    this.blocks.push(
      new ParagraphBlock(runs, resolved, { keepWithNext: true, ...pickBlockProps(style) }, `H${level}` as const),
    );
    return this;
  }

  spacer(height: number): this {
    this.blocks.push(new SpacerBlock(height));
    return this;
  }

  pageBreak(): this {
    this.blocks.push(new PageBreakBlock());
    return this;
  }

  image(jpeg: Uint8Array, opts: { width: number; height?: number; align?: 'left' | 'right' | 'center' } & BlockProps): this {
    this.blocks.push(new ImageBlock(jpeg, opts));
    return this;
  }

  table(def: TableDef): this {
    const base = this.defaultStyle;
    const st = def.style ?? {};
    const style: ResolvedTableStyle = {
      font: st.font ?? base.font,
      size: st.size ?? base.size,
      lineHeight: st.lineHeight ?? base.lineHeight,
      color: st.color ?? base.color,
      padding: st.padding ?? 4,
      borders: st.borders ?? 'horizontal',
      borderColor: st.borderColor ?? '#d1d5db',
      headerFont: st.headerFont ?? st.font ?? base.font,
      headerColor: st.headerColor ?? st.color ?? base.color,
      headerFill: st.headerFill === undefined ? '#f3f4f6' : st.headerFill,
    };
    const headerCount = def.header ?? 0;
    const rows = def.rows.map((row, r) =>
      row.map((cell) => {
        const cellStyle: ResolvedParagraphStyle = {
          ...base,
          font: r < headerCount ? style.headerFont : style.font,
          color: r < headerCount ? style.headerColor : style.color,
          size: style.size,
          lineHeight: style.lineHeight,
          align: 'left',
          spaceBefore: 0,
          spaceAfter: 0,
          indent: 0,
          firstLineIndent: 0,
        };
        return this.stylize(cell, cellStyle);
      }),
    );
    this.blocks.push(
      new TableBlock({
        columns: def.columns,
        rows,
        ...(headerCount ? { header: headerCount } : {}),
        ...(def.columnAlign ? { columnAlign: def.columnAlign } : {}),
        style,
        ...pickBlockProps(def),
      }),
    );
    return this;
  }

  /** Paginate and render. Pure: call as often as you like, bytes are identical. */
  build(): Uint8Array {
    const ctx: PaginationContext = {
      measurer: this.measurer,
      contentHeight: this.geom.pageHeight - this.geom.marginTop - this.geom.marginBottom,
      defaultStyle: this.defaultStyle,
      notes: this.notes,
      noteStyle: this.noteStyle,
    };
    const pages = paginate(this.blocks, ctx, this.geom);
    return renderPages(pages, this.registry, this.geom, {
      metadata: {
        ...(this.opts.title !== undefined ? { title: this.opts.title } : {}),
        ...(this.opts.author !== undefined ? { author: this.opts.author } : {}),
        ...(this.opts.subject !== undefined ? { subject: this.opts.subject } : {}),
        ...(this.opts.keywords !== undefined ? { keywords: this.opts.keywords } : {}),
        ...(this.opts.lang !== undefined ? { lang: this.opts.lang } : {}),
        ...(this.opts.pdfa !== undefined ? { pdfa: this.opts.pdfa } : {}),
        ...(this.xmpExtensions.length ? { xmpExtensions: [...this.xmpExtensions] } : {}),
      },
      attachments: this.attachments.map((a) => ({ name: a.name, data: a.data, ...(a.opts ? { opts: a.opts } : {}) })),
      ...(this.opts.header ? { header: this.opts.header } : {}),
      ...(this.opts.footer ? { footer: this.opts.footer } : {}),
      ...(this.opts.outline ? { outline: true } : {}),
    });
  }

  /** Resolve public runs to styled runs; allocate footnote ids in input order. */
  private stylize(text: string | TextRun[], style: ResolvedParagraphStyle): StyledRun[] {
    const input: TextRun[] = typeof text === 'string' ? [{ text }] : text;
    return input.map((run) => {
      let noteId: number | undefined;
      if (run.note !== undefined) {
        noteId = ++this.noteCounter;
        this.notes.set(noteId, run.note);
      }
      return {
        text: run.text,
        font: run.font ?? style.font,
        size: run.size ?? style.size,
        color: run.color ?? style.color,
        ...(noteId !== undefined ? { noteId } : {}),
        ...(run.href !== undefined ? { href: run.href } : {}),
      };
    });
  }
}

function resolveStyle(
  over: ParagraphStyle | undefined,
  base: ResolvedParagraphStyle,
): ResolvedParagraphStyle {
  return {
    font: over?.font ?? base.font,
    size: over?.size ?? base.size,
    lineHeight: over?.lineHeight ?? base.lineHeight,
    color: over?.color ?? base.color,
    align: over?.align ?? base.align,
    spaceBefore: over?.spaceBefore ?? base.spaceBefore,
    spaceAfter: over?.spaceAfter ?? base.spaceAfter,
    indent: over?.indent ?? base.indent,
    firstLineIndent: over?.firstLineIndent ?? base.firstLineIndent,
  };
}

function pickBlockProps(p: BlockProps): BlockProps {
  return {
    ...(p.keepTogether !== undefined ? { keepTogether: p.keepTogether } : {}),
    ...(p.keepWithNext !== undefined ? { keepWithNext: p.keepWithNext } : {}),
    ...(p.orphans !== undefined ? { orphans: p.orphans } : {}),
    ...(p.widows !== undefined ? { widows: p.widows } : {}),
  };
}
