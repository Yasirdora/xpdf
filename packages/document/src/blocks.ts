/**
 * Block model: the indivisible-unit producers the paginator packs.
 *
 * Every block turns content into `Slice[]` at a given width. Slices are the
 * atomic units of pagination — the paginator never looks inside one, it only
 * decides whether a slice fits in the space the footnote fixpoint leaves.
 */
import { parseJpegSize } from '@xpdf/core';
import { breakLines, tokenize, type StyledRun } from './line-break.js';
import type { Measurer } from './measurer.js';
import type {
  Align,
  BlockProps,
  LayoutLine,
  ResolvedParagraphStyle,
  Role,
  Slice,
} from './types.js';

export interface LayoutContext {
  measurer: Measurer;
  /** Full content-box height — used to chunk pathologically tall table rows. */
  contentHeight: number;
  defaultStyle: ResolvedParagraphStyle;
}

export interface Block {
  readonly role: Role;
  readonly props: BlockProps;
  /** Force a page break before this block. */
  readonly forceBreakBefore?: boolean;
  /** Lay out at `width` pt → indivisible slices in vertical order. */
  layout(width: number, ctx: LayoutContext): Slice[];
}

// ---------------------------------------------------------------------------
// Paragraph
// ---------------------------------------------------------------------------

export class ParagraphBlock implements Block {
  constructor(
    readonly runs: StyledRun[],
    readonly style: ResolvedParagraphStyle,
    readonly props: BlockProps = {},
    readonly role: Role = 'P',
  ) {}

  private linesAt(width: number, ctx: LayoutContext): LayoutLine[] {
    const s = this.style;
    return breakLines(this.runs, ctx.measurer, {
      widthAt: (i) => Math.max(24, width - s.indent - (i === 0 ? s.firstLineIndent : 0)),
      align: s.align,
      lineHeight: s.lineHeight,
      fallback: { font: s.font, size: s.size },
    });
  }

  layout(width: number, ctx: LayoutContext): Slice[] {
    const s = this.style;
    const slices: Slice[] = [];
    if (s.spaceBefore > 0) slices.push({ kind: 'space', height: s.spaceBefore });
    const lines = this.linesAt(width, ctx);
    const level = /^H([1-6])$/.exec(this.role)?.[1];
    const title = this.runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
    for (let i = 0; i < lines.length; i++) {
      lines[i]!.x = s.indent + (i === 0 ? s.firstLineIndent : 0);
      slices.push({
        kind: 'text',
        height: lines[i]!.height,
        lines: [lines[i]!],
        role: this.role,
        ...(i === 0 && level && title ? { outline: { title, level: Number(level) } } : {}),
      });
    }
    if (s.spaceAfter > 0) slices.push({ kind: 'space', height: s.spaceAfter });
    return slices;
  }
}

// ---------------------------------------------------------------------------
// Spacer / page break / image
// ---------------------------------------------------------------------------

export class SpacerBlock implements Block {
  readonly role: Role = 'P';
  readonly props: BlockProps = {};
  constructor(private readonly height: number) {}
  layout(): Slice[] {
    return [{ kind: 'space', height: this.height }];
  }
}

export class PageBreakBlock implements Block {
  readonly role: Role = 'P';
  readonly props: BlockProps = {};
  readonly forceBreakBefore = true;
  layout(): Slice[] {
    return [];
  }
}

export interface ImageBlockOpts extends BlockProps {
  /** Display width in pt. Height derives from the JPEG aspect ratio. */
  width: number;
  /** Explicit display height; default keeps aspect ratio. */
  height?: number;
  align?: Exclude<Align, 'justify'>;
}

export class ImageBlock implements Block {
  readonly role: Role = 'Figure';
  constructor(
    private readonly bytes: Uint8Array,
    private readonly opts: ImageBlockOpts,
  ) {
    this.props = opts;
  }
  readonly props: BlockProps;

  layout(width: number): Slice[] {
    const natural = parseJpegSize(this.bytes);
    const w = this.opts.width;
    const h = this.opts.height ?? (w * natural.height) / natural.width;
    const align = this.opts.align ?? 'left';
    const dx = align === 'center' ? (width - w) / 2 : align === 'right' ? width - w : 0;
    return [{ kind: 'image', height: h, width: w, dx, bytes: this.bytes, role: 'Figure' }];
  }
}
