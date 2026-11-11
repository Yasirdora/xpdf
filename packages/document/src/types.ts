/**
 * Shared vocabulary for the xpdf layout engine: text runs, styles,
 * block properties, and the typed placement/slice model the paginator
 * produces and the renderer consumes.
 *
 * Design notes:
 * - Slices are *data*, not closures — placements stay JSON-inspectable,
 *   which is what our semantic golden tests assert against.
 * - Every block carries a semantic role (P, H1..H6, Table, Note, …).
 *   StructTree emission consumes these roles; they exist from day one
 *   because retrofitting structure is miserable (design doc §7).
 */

/** PDF tag roles, mirroring the standard structure element names. */
export type Role =
  | 'P'
  | 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6'
  | 'Table' | 'TR' | 'TH' | 'TD'
  | 'Figure'
  | 'Note'
  | 'L' | 'LI';

/** A run of text sharing one font/size/color. */
export interface TextRun {
  text: string;
  /** Registered font name (LayoutDocument.font). Overrides paragraph style. */
  font?: string;
  size?: number;
  color?: string;
  /**
   * Attach a footnote to this run. A superscript marker is appended after
   * the run's last word and `note` is typeset at the bottom of the page
   * the marker lands on (fixpoint-resolved by the paginator).
   */
  note?: string;
  /**
   * Make this run a link: every line fragment of the run gets a clickable
   * /URI annotation over the words it covers.
   */
  href?: string;
}

export type Align = 'left' | 'right' | 'center' | 'justify';

export interface ParagraphStyle {
  font?: string;
  size?: number;
  /** Multiple of font size → line box height. Default 1.25. */
  lineHeight?: number;
  color?: string;
  align?: Align;
  /** Vertical spacing around the block. Adjacent gaps collapse to max. */
  spaceBefore?: number;
  spaceAfter?: number;
  /** Left indent (pt) applied to every line. */
  indent?: number;
  /** Extra indent (pt) on the first line only. */
  firstLineIndent?: number;
}

/** Pagination behavior shared by all blocks. */
export interface BlockProps {
  /** Never split this block across pages; push it whole to the next page. */
  keepTogether?: boolean;
  /** Keep on the same page as the first fragment of the next block. */
  keepWithNext?: boolean;
  /** Min lines of a paragraph left at the bottom of a page (default 2). */
  orphans?: number;
  /** Min lines of a paragraph carried to the top of the next page (default 2). */
  widows?: number;
}

export interface ResolvedParagraphStyle {
  font: string;
  size: number;
  lineHeight: number;
  color: string;
  align: Align;
  spaceBefore: number;
  spaceAfter: number;
  indent: number;
  firstLineIndent: number;
}

// ---------------------------------------------------------------------------
// Layout output model
// ---------------------------------------------------------------------------

/** A run of text positioned inside a line (x relative to line origin). */
export interface PositionedRun {
  text: string;
  font: string;
  size: number;
  color: string;
  x: number;
  width: number;
  /** Baseline shift (pt, positive = raised) for superscript note markers. */
  dy: number;
  /** Link target; the renderer adds a /URI annotation over the run. */
  href?: string;
}

export interface LayoutLine {
  runs: PositionedRun[];
  /** Line origin x within the container (indent + first-line indent). */
  x: number;
  /** Natural width excluding trailing spaces. */
  width: number;
  /** Line box height. */
  height: number;
  /** Distance from line-box top to baseline. */
  baseline: number;
  /** Footnote ids referenced by markers in this line. */
  noteIds: number[];
}

/** A table cell laid out at its resolved column width. */
export interface CellLayout {
  lines: LayoutLine[];
  height: number; // content height incl. padding
  header: boolean;
}

/** Indivisible vertical unit produced by blocks and packed by the paginator. */
export type Slice =
  | {
      kind: 'text';
      height: number;
      lines: LayoutLine[];
      role: Role;
      /** Set on a heading's first line: the renderer can build bookmarks from it. */
      outline?: { title: string; level: number };
    }
  | { kind: 'space'; height: number }
  | { kind: 'image'; height: number; width: number; dx: number; bytes: Uint8Array; role: Role }
  | {
      kind: 'table-row';
      height: number;
      cells: CellLayout[];
      colWidths: number[];
      padding: number;
      borders: 'all' | 'horizontal' | 'none';
      borderColor: string;
      /** Repeated at the top of each page the table continues onto. */
      header: boolean;
      /** Background fill (e.g. header shading). */
      fill?: string;
      role: Role;
    }
  | { kind: 'rule'; height: number; color: string; strokeWidth: number; widthFraction: number };

/** A slice placed on a page (x/y relative to page top-left, pt). */
export interface Placement {
  slice: Slice;
  x: number;
  y: number;
}

export interface PageLayout {
  /** 1-based page number. */
  index: number;
  placements: Placement[];
  /** Footnote-area placements (below content, above bottom margin). */
  notes: Placement[];
}

/** Thrown when the footnote fixpoint does not converge. */
export class NonConvergenceError extends Error {
  constructor(page: number, iterations: number) {
    super(
      `Pagination did not converge on page ${page} after ${iterations} iterations. ` +
        'This usually means a footnote and its reference straddle a page boundary; ' +
        'shorten the note or move the reference.',
    );
    this.name = 'NonConvergenceError';
  }
}
