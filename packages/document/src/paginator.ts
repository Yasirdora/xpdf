/**
 * The paginator: a convergence engine, not "measure then place".
 *
 * - Packs block slices into pages, honoring keepTogether / keepWithNext /
 *   widow / orphan rules.
 * - Resolves footnotes to a fixpoint per page: adding a note can push its
 *   reference line to the next page (which takes the note with it). The
 *   available height only ever *shrinks* during a page's iteration
 *   (monotone regime) — termination is guaranteed, at the documented cost
 *   of occasionally breaking a page slightly early. A hard iteration cap
 *   with an explicit NonConvergenceError guards the residue.
 * - Repeats table header rows on continuation pages.
 * - "Page X of Y" needs no layout pass here: furniture draws in the margins
 *   and cannot change pagination, so totals are injected at render time.
 */
import { breakLines, type StyledRun } from './line-break.js';
import { ParagraphBlock, type Block, type LayoutContext } from './blocks.js';
import { NonConvergenceError } from './types.js';
import type { PageLayout, Placement, Slice } from './types.js';

export interface PageGeometry {
  pageWidth: number;
  pageHeight: number;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
}

export interface PaginationContext extends LayoutContext {
  /** Footnote id → note text (allocated by LayoutDocument in input order). */
  notes: ReadonlyMap<number, string>;
  noteStyle: { font: string; size: number; lineHeight: number; color: string };
}

interface StreamState {
  bi: number;
  si: number;
  /** Header slices to repeat at page top when a table continues. */
  pendingHeaders: Slice[] | null;
}

interface PlacedItem {
  placement: Placement;
  block: Block;
  blockIndex: number;
  /** Index of the slice within its block's slice list; -1 = repeated header. */
  sliceIndex: number;
}

const EPS = 1e-6;
const MAX_FIXPOINT_ITERATIONS = 10;

export function paginate(blocks: Block[], ctx: PaginationContext, geom: PageGeometry): PageLayout[] {
  const pages: PageLayout[] = [];
  let state: StreamState = { bi: 0, si: 0, pendingHeaders: null };
  const cache = new Map<Block, Slice[]>();

  while (state.bi < blocks.length || state.pendingHeaders) {
    const result = layoutPage(blocks, state, ctx, geom, cache, pages.length + 1);
    const next = result.endState;
    if (
      result.layout.placements.length === 0 &&
      next.bi === state.bi &&
      next.si === state.si &&
      next.pendingHeaders === state.pendingHeaders
    ) {
      // an empty page that leaves the stream where it was would repeat forever
      throw new Error(`Pagination made no progress on page ${pages.length + 1} (block ${state.bi}).`);
    }
    // A forced break or a header-only attempt can advance the stream without
    // placing anything. That is not a page.
    if (result.layout.placements.length === 0) {
      state = next;
      if (state.bi >= blocks.length && state.pendingHeaders) {
        state = { ...state, pendingHeaders: null };
      }
      continue;
    }
    pages.push(result.layout);
    state = next;
    // defensive: headers pending with no rows left behind them
    if (state.bi >= blocks.length && state.pendingHeaders) {
      state = { ...state, pendingHeaders: null };
    }
  }
  return pages;
}

function layoutPage(
  blocks: Block[],
  start: StreamState,
  ctx: PaginationContext,
  geom: PageGeometry,
  cache: Map<Block, Slice[]>,
  pageIndex: number,
): { layout: PageLayout; endState: StreamState } {
  const contentH = geom.pageHeight - geom.marginTop - geom.marginBottom;
  let availH = contentH;
  let prevNoteKey = '';
  let items: PlacedItem[] = [];
  let endState: StreamState = start;
  let noteSlices: Slice[] = [];

  for (let iter = 1; iter <= MAX_FIXPOINT_ITERATIONS; iter++) {
    const packed = pack(blocks, start, availH, ctx, geom, cache);
    items = packed.items;
    endState = packed.endState;

    const noteIds = noteIdsOn(items);
    noteSlices = buildNoteSlices(noteIds, ctx, geom);
    const notesH = noteSlices.reduce((a, s) => a + s.height, 0);
    const newAvail = contentH - notesH;
    const key = noteIds.join(',');

    if (key === prevNoteKey || newAvail >= availH - EPS) {
      // converged: same note set, or notes shrank (monotone rule keeps the
      // smaller availH — the page may break slightly early, never loops)
      break;
    }
    if (iter === MAX_FIXPOINT_ITERATIONS) throw new NonConvergenceError(pageIndex, iter);
    prevNoteKey = key;
    availH = newAvail;
  }

  // anchor notes to the bottom of the content box
  const notesH = noteSlices.reduce((a, s) => a + s.height, 0);
  const notes: Placement[] = [];
  let ny = contentH - notesH;
  for (const s of noteSlices) {
    notes.push({ slice: s, x: 0, y: ny });
    ny += s.height;
  }

  return {
    layout: { index: pageIndex, placements: items.map((i) => i.placement), notes },
    endState,
  };
}

function pack(
  blocks: Block[],
  start: StreamState,
  availH: number,
  ctx: PaginationContext,
  geom: PageGeometry,
  cache: Map<Block, Slice[]>,
): { items: PlacedItem[]; endState: StreamState } {
  const contentW = geom.pageWidth - geom.marginLeft - geom.marginRight;
  const items: PlacedItem[] = [];
  let y = 0;
  let bi = start.bi;
  let si = start.si;

  const layoutOf = (b: Block): Slice[] => {
    let s = cache.get(b);
    if (!s) {
      s = b.layout(contentW, ctx);
      cache.set(b, s);
    }
    return s;
  };

  // repeated table headers carried over from the previous page
  if (start.pendingHeaders) {
    for (const h of start.pendingHeaders) {
      if (y + h.height > availH + EPS) {
        throw new Error('Table header is taller than the available page height.');
      }
      items.push({ placement: { slice: h, x: 0, y }, block: blocks[start.bi]!, blockIndex: start.bi, sliceIndex: -1 });
      y += h.height;
    }
  }

  while (bi < blocks.length) {
    const block = blocks[bi]!;

    if (block.forceBreakBefore && si === 0 && items.length > 0) {
      // Break before this block starts, then lay it out on the next page.
      // Do not rewind a keep-with-next heading across the forced break, and
      // do not skip the block. A block already started (si > 0) keeps going.
      return { items, endState: { bi, si: 0, pendingHeaders: null } };
    }

    const slices = layoutOf(block);

    // keepTogether: push the whole block if it can't fit complete (and the
    // page isn't empty — a block taller than a page splits best-effort)
    if (si === 0 && block.props.keepTogether && slices.length) {
      const totalH = slices.reduce((a, s) => a + s.height, 0);
      if (totalH > availH - y + EPS && y > EPS) {
        return finishPage(items, { bi, si: 0, pendingHeaders: null }, blocks.length);
      }
    }

    while (si < slices.length) {
      const s = slices[si]!;

      // spaces vanish at page top and collapse against the previous space
      if (s.kind === 'space') {
        if (items.length === 0) {
          si++;
          continue;
        }
        const last = items[items.length - 1]!;
        if (last.placement.slice.kind === 'space') {
          if (s.height > last.placement.slice.height) {
            y += s.height - last.placement.slice.height;
            last.placement = { slice: s, x: 0, y: last.placement.y };
          }
          si++;
          continue;
        }
      }

      if (y + s.height <= availH + EPS) {
        items.push({ placement: { slice: s, x: 0, y }, block, blockIndex: bi, sliceIndex: si });
        y += s.height;
        si++;
        continue;
      }

      // ---- overflow ----
      if (s.kind === 'space') {
        // a gap that does not fit simply ends the page; it would vanish at
        // the next page top anyway, and it must not trigger widow rules
        return finishPage(items, { bi, si: si + 1, pendingHeaders: null }, blocks.length);
      }

      if (items.length === 0) {
        // nothing on the page yet and the slice is taller than the page:
        // place it overflowing rather than loop on an empty page
        items.push({ placement: { slice: s, x: 0, y }, block, blockIndex: bi, sliceIndex: si });
        y += s.height;
        si++;
        continue;
      }

      // ---- widow/orphan rules, then break ----
      if (block instanceof ParagraphBlock) {
        const placedHere = items.filter(
          (it) => it.block === block && it.placement.slice.kind === 'text',
        ).length;
        const orphans = block.props.orphans ?? 2;
        const widows = block.props.widows ?? 2;
        // Lines from this slice onward, not "total minus lines on this page":
        // lines already placed on earlier pages are not still remaining.
        let remainingText = 0;
        for (let k = si; k < slices.length; k++) {
          if (slices[k]!.kind === 'text') remainingText++;
        }
        let rewind = 0;
        if (placedHere > 0 && placedHere < orphans) {
          rewind = placedHere; // too few lines at the bottom: move them all
        } else if (placedHere > 0 && remainingText < widows) {
          const need = widows - remainingText;
          rewind = placedHere - need >= orphans ? need : placedHere;
        }
        if (rewind > 0 && rewind < items.length) {
          let removed = 0;
          while (removed < rewind && items.length) {
            const last = items[items.length - 1]!;
            if (last.block !== block || last.placement.slice.kind !== 'text') break;
            y -= last.placement.slice.height;
            items.pop();
            removed++;
          }
          return finishPage(items, { bi, si: si - removed, pendingHeaders: null }, blocks.length);
        }
      }

      // Repeated headers fit but the next row does not. A page of only
      // headers would be blank. Drop them and place the row here; headers
      // stay with a row when the two fit together on a normal break.
      if (
        start.pendingHeaders !== null &&
        items.length > 0 &&
        items.every((it) => it.sliceIndex === -1)
      ) {
        items.length = 0;
        y = 0;
        items.push({ placement: { slice: s, x: 0, y }, block, blockIndex: bi, sliceIndex: si });
        y += s.height;
        si++;
        continue;
      }

      return finishPage(items, { bi, si, pendingHeaders: headerSlicesOf(block, slices, si) }, blocks.length);
    }

    si = 0;
    bi++;
  }
  return finishPage(items, { bi, si: 0, pendingHeaders: null }, blocks.length);
}

/**
 * Rewind trailing keep-with-next blocks stranded at the page end (a heading
 * whose paragraph starts on the next page must move with it; chains of
 * keep-with-next blocks rewind together). Nothing rewinds when the document
 * has ended (there is no next block to keep with) or when the rewind would
 * leave the page empty (the next page would start in the same place).
 */
function finishPage(
  items: PlacedItem[],
  end: StreamState,
  blockCount: number,
): { items: PlacedItem[]; endState: StreamState } {
  if (end.bi >= blockCount) return { items, endState: end };
  for (;;) {
    const last = items[items.length - 1];
    if (!last || !last.block.props.keepWithNext) break;
    // the whole block must live on this page for a clean rewind
    let firstIdx = items.length - 1;
    while (firstIdx > 0 && items[firstIdx - 1]!.block === last.block) firstIdx--;
    const startsHere = items[firstIdx]!.sliceIndex === 0;
    if (!startsHere || firstIdx === 0) break;
    items.length = firstIdx;
    end = { bi: last.blockIndex, si: 0, pendingHeaders: null };
  }
  return { items, endState: end };
}

/** Footnote ids referenced by text lines and by lines inside table cells. */
function noteIdsOn(items: PlacedItem[]): number[] {
  const noteIds: number[] = [];
  const add = (id: number) => {
    if (!noteIds.includes(id)) noteIds.push(id);
  };
  for (const it of items) {
    const slice = it.placement.slice;
    if (slice.kind === 'text') {
      for (const line of slice.lines) for (const id of line.noteIds) add(id);
    } else if (slice.kind === 'table-row') {
      for (const cell of slice.cells) for (const line of cell.lines) for (const id of line.noteIds) add(id);
    }
  }
  return noteIds;
}

function headerSlicesOf(block: Block, slices: Slice[], cursor: number): Slice[] | null {
  if (block.role !== 'Table') return null;
  const headers: Slice[] = [];
  for (let i = 0; i < Math.min(cursor, slices.length); i++) {
    const s = slices[i]!;
    if (s.kind === 'table-row' && s.header) headers.push(s);
  }
  return headers.length ? headers : null;
}

/** Layout the footnote area: separator rule + one atomic slice per note. */
function buildNoteSlices(ids: number[], ctx: PaginationContext, geom: PageGeometry): Slice[] {
  if (!ids.length) return [];
  const contentW = geom.pageWidth - geom.marginLeft - geom.marginRight;
  const contentH = geom.pageHeight - geom.marginTop - geom.marginBottom;
  const st = ctx.noteStyle;
  const slices: Slice[] = [
    { kind: 'rule', height: 14, color: '#9ca3af', strokeWidth: 0.5, widthFraction: 0.35 },
  ];
  for (const id of ids) {
    const text = ctx.notes.get(id);
    if (text === undefined) throw new Error(`footnote #${id} has no text (internal ordering bug)`);
    const runs: StyledRun[] = [
      { text: `${id} `, font: st.font, size: st.size, color: st.color, dy: st.size * 0.3 },
      { text, font: st.font, size: st.size, color: st.color },
    ];
    const lines = breakLines(runs, ctx.measurer, {
      widthAt: () => contentW,
      align: 'left',
      lineHeight: st.lineHeight,
      fallback: { font: st.font, size: st.size },
    });
    const height = lines.reduce((a, l) => a + l.height, 0) + 2;
    if (height > contentH * 0.8) {
      throw new Error(
        `Footnote #${id} is ${Math.round(height)}pt tall — over 80% of a page. ` +
          'Shorten it or move the content into an appendix.',
      );
    }
    slices.push({ kind: 'text', height, lines, role: 'Note' });
  }
  return slices;
}
