/**
 * Renderer: placements → @xpdf/core drawing calls.
 *
 * Pure function of the paginator's output — the same PageLayout[] always
 * produces the same bytes (core build is deterministic: own deflate, no
 * timestamps, no random ids).
 */
import {
  Document as CoreDocument,
  Page as CorePage,
  type DocumentOptions,
  type FontRef,
  type OutlineItem,
} from '@xpdf/core';
import type { FontRegistry } from './measurer.js';
import type { PageGeometry } from './paginator.js';
import type { LayoutLine, PageLayout, Placement, Slice } from './types.js';

export interface FurnitureContext {
  /** 1-based page number. */
  page: number;
  /** Total page count (known at render time — furniture can't change layout). */
  pages: number;
  /** Resolve a LayoutDocument font name to a core font ref for furniture text. */
  font: (name: string) => FontRef;
}

export type FurnitureFn = (page: CorePage, ctx: FurnitureContext) => void;

export interface RenderOptions {
  metadata?: DocumentOptions;
  attachments?: Array<{
    name: string;
    data: Uint8Array;
    opts?: { mime?: string; description?: string; afRelationship?: 'Data' | 'Source' | 'Alternative' | 'Supplement' | 'Unspecified' };
  }>;
  header?: FurnitureFn;
  footer?: FurnitureFn;
  /** Build bookmarks from the headings' outline marks, nested by level. */
  outline?: boolean;
}

export function renderPages(
  pages: PageLayout[],
  fonts: FontRegistry,
  geom: PageGeometry,
  opts: RenderOptions = {},
): Uint8Array {
  const doc = new CoreDocument(opts.metadata);

  // Embedded faces join the core document on first use (page.text registers
  // the measurer's own EmbeddedFont instance), so a face that was registered
  // but never drawn adds nothing to the file.
  for (const a of opts.attachments ?? []) doc.attach(a.name, a.data, a.opts);

  const total = pages.length;
  const outline = new OutlineBuilder();
  for (const layout of pages) {
    const page = doc.addPage(geom.pageWidth, geom.pageHeight);
    const ctx: FurnitureContext = { page: layout.index, pages: total, font: (name) => fonts.resolve(name).ref };
    opts.header?.(page, ctx);
    for (const p of layout.placements) {
      drawPlacement(page, p, fonts, geom);
      if (opts.outline && p.slice.kind === 'text' && p.slice.outline) {
        outline.add(p.slice.outline, page, geom.marginTop + p.y);
      }
    }
    for (const p of layout.notes) drawPlacement(page, p, fonts, geom);
    opts.footer?.(page, ctx);
  }
  if (outline.items.length) doc.setOutlines(outline.items);
  return doc.build();
}

/** Nests heading bookmarks: each one goes under the nearest shallower heading. */
class OutlineBuilder {
  readonly items: OutlineItem[] = [];
  private readonly stack: Array<{ level: number; item: OutlineItem }> = [];

  add(mark: { title: string; level: number }, page: CorePage, y: number): void {
    const item: OutlineItem = { title: mark.title, page, y };
    while (this.stack.length && this.stack[this.stack.length - 1]!.level >= mark.level) this.stack.pop();
    const parent = this.stack[this.stack.length - 1]?.item;
    if (parent) (parent.children ??= []).push(item);
    else this.items.push(item);
    this.stack.push({ level: mark.level, item });
  }
}

function drawPlacement(
  page: CorePage,
  p: Placement,
  fonts: FontRegistry,
  geom: PageGeometry,
): void {
  const x = geom.marginLeft + p.x;
  const y = geom.marginTop + p.y;
  drawSlice(page, p.slice, x, y, fonts, geom);
}

function drawSlice(
  page: CorePage,
  slice: Slice,
  x: number,
  y: number,
  fonts: FontRegistry,
  geom: PageGeometry,
): void {
  switch (slice.kind) {
    case 'space':
      return;
    case 'text': {
      let lineY = y;
      for (const line of slice.lines) {
        drawLine(page, line, x, lineY, fonts);
        lineY += line.height;
      }
      return;
    }
    case 'image':
      page.imageJpeg(slice.bytes, x + slice.dx, y, slice.width, slice.height);
      return;
    case 'rule': {
      const contentW = geom.pageWidth - geom.marginLeft - geom.marginRight;
      const w = slice.widthFraction * contentW;
      page.line(x, y + slice.height * 0.6, x + w, y + slice.height * 0.6, slice.color, slice.strokeWidth);
      return;
    }
    case 'table-row': {
      const tableW = slice.colWidths.reduce((a, b) => a + b, 0);
      if (slice.fill) page.rect(x, y, tableW, slice.height, slice.fill);
      let cellX = x;
      for (let c = 0; c < slice.cells.length; c++) {
        const cell = slice.cells[c]!;
        let lineY = y + slice.padding;
        for (const line of cell.lines) {
          drawLine(page, line, cellX + slice.padding, lineY, fonts);
          lineY += line.height;
        }
        if (slice.borders === 'all') {
          page.strokeRect(cellX, y, slice.colWidths[c]!, slice.height, slice.borderColor, 0.5);
        }
        cellX += slice.colWidths[c]!;
      }
      if (slice.borders === 'horizontal') {
        if (slice.header) {
          page.line(x, y, x + tableW, y, slice.borderColor, 0.7);
          page.line(x, y + slice.height, x + tableW, y + slice.height, slice.borderColor, 0.7);
        } else {
          page.line(x, y + slice.height, x + tableW, y + slice.height, slice.borderColor, 0.4);
        }
      }
      return;
    }
  }
}

function drawLine(page: CorePage, line: LayoutLine, x: number, y: number, fonts: FontRegistry): void {
  for (const run of line.runs) {
    const resolved = fonts.resolve(run.font);
    page.text(run.text, x + line.x + run.x, y + line.baseline - run.dy, {
      font: resolved.ref,
      size: run.size,
      color: run.color,
    });
    // y is the line box top, so the link covers the whole line height
    if (run.href !== undefined) page.link(run.href, x + line.x + run.x, y, run.width, line.height);
  }
}
