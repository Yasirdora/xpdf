/**
 * Screenplay template: Fountain source → industry-standard layout.
 *
 * Screenplay layout is the one place where monospace determinism shines:
 * Courier 12pt advances exactly 7.2pt per character and every line box is
 * exactly 12pt, so this template paginates itself (54 lines per page) and
 * the general paginator simply agrees with it. That self-pagination is what
 * makes true screenplay conventions possible:
 *
 *   - dialogue split across a page boundary gets "(MORE)" at the bottom and
 *     "CHARACTER (CONT'D)" at the top of the next page;
 *   - scene headings never strand at a page bottom (moved unless 2 lines of
 *     the following element fit);
 *   - dual dialogue ('^' in Fountain) sets side by side.
 *
 * Geometry (US Letter, industry standard):
 *   left margin 1.5" (108pt), right 1" (72pt), top/bottom 1" (72pt)
 *   text column 6.0" = 60 Courier characters; 54 lines per page
 *   character cue at 3.7", dialogue 2.5"–6.0" (35 chars), parenthetical 3.1"
 */
import { LayoutDocument } from '@xpdf/document';
import { parseFountain, type FountainElement, type FountainScript } from './fountain.js';
import { attachPayload, type TemplateTheme } from './payload.js';

export const SP = {
  pageW: 612, pageH: 792,
  marginLeft: 108, marginRight: 72, marginTop: 72, marginBottom: 72,
  lineH: 12, pageLines: 54, charW: 7.2,
  actionChars: 60,
  dialogueChars: 35, dialogueIndent: 72,     // 10 chars
  cueIndent: 158.4,                          // 22 chars (3.7" from paper edge)
  parenChars: 24, parenIndent: 115.2,        // 16 chars
  dualChars: 28,                             // pre-wrap width inside dual cells
} as const;

export interface ScreenplayOptions extends TemplateTheme {
  /** Render a title page from the Fountain title block (default true). */
  titlePage?: boolean;
}

export interface ScreenplayDocumentResult {
  doc: LayoutDocument;
  script: FountainScript;
}

/** Monospace greedy wrap: every emitted line is guaranteed ≤ width chars. */
export function wrapMono(text: string, width: number): string[] {
  const out: string[] = [];
  for (const hard of text.split('\n')) {
    let line = '';
    for (const word of hard.split(' ')) {
      if (!line) {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += ' ' + word;
      } else {
        out.push(line);
        line = word;
      }
      // pathological over-long word: hard-chunk it
      while (line.length > width) {
        out.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    out.push(line);
  }
  return out;
}

interface BodyLine { text: string; indent: number }

type DualElement = { type: 'dual'; left: Extract<FountainElement, { type: 'dialogue' }>; right: Extract<FountainElement, { type: 'dialogue' }> };
type LayoutEl = FountainElement | DualElement;

function dialogueBodyLines(parts: Array<{ type: 'line' | 'parenthetical'; text: string }>): BodyLine[] {
  const out: BodyLine[] = [];
  for (const p of parts) {
    if (p.type === 'parenthetical') {
      for (const l of wrapMono(p.text, SP.parenChars)) out.push({ text: l, indent: SP.parenIndent });
    } else {
      for (const l of wrapMono(p.text, SP.dialogueChars)) out.push({ text: l, indent: SP.dialogueIndent });
    }
  }
  return out;
}

/** Pair dual-dialogue markers with their preceding dialogue element. */
function pairDuals(elements: FountainElement[]): LayoutEl[] {
  const out: LayoutEl[] = [];
  for (const el of elements) {
    const prev = out[out.length - 1];
    if (el.type === 'dialogue' && el.dual && prev?.type === 'dialogue') {
      out[out.length - 1] = { type: 'dual', left: prev, right: el };
    } else {
      out.push(el);
    }
  }
  return out;
}

export function screenplayDocument(source: string, opts: ScreenplayOptions = {}): ScreenplayDocumentResult {
  const script = parseFountain(source);
  const wantTitlePage = opts.titlePage ?? true;
  const tp = script.titlePage;

  const doc = new LayoutDocument({
    pageSize: 'LETTER',
    margins: { top: SP.marginTop, bottom: SP.marginBottom, left: SP.marginLeft, right: SP.marginRight },
    title: tp['title']?.[0] ?? 'Screenplay',
    ...(tp['author']?.[0] !== undefined ? { author: tp['author'][0] } : {}),
    defaultStyle: { font: 'sp', size: 12, lineHeight: 1.0 },
    ...(opts.pdfa !== undefined ? { pdfa: opts.pdfa } : {}),
    ...(wantTitlePage && tp['title']
      ? {
          header: (page, ctx) => {
            if (ctx.page !== 1) return;
            const cx = { align: 'center' as const, width: page.width };
            page.text((tp['title']?.[0] ?? '').toUpperCase(), 0, 300, { font: ctx.font('sp-bold'), size: 14, ...cx });
            page.text(tp['credit']?.[0] ?? 'written by', 0, 336, { font: ctx.font('sp'), size: 12, ...cx });
            let y = 360;
            for (const a of tp['author'] ?? []) { page.text(a, 0, y, { font: ctx.font('sp'), size: 12, ...cx }); y += 14; }
            const contact = [...(tp['contact'] ?? []), ...(tp['draft date'] ?? [])];
            if (contact.length) {
              page.text(contact.join('  ·  '), SP.marginLeft, 730, { font: ctx.font('sp'), size: 10, color: '#444444' });
            }
          },
        }
      : {}),
  });
  doc.font('sp', opts.font ?? 'Courier');
  doc.font('sp-bold', opts.boldFont ?? 'Courier-Bold');

  let line = 0; // 12pt lines used on the current page (self-pagination)

  const brk = () => { doc.pageBreak(); line = 0; };
  /** One blank separator line; vanishes at a page top like screenplay spacing does. */
  const sep = () => {
    if (line === 0) return;
    doc.spacer(SP.lineH);
    line += 1;
    if (line > SP.pageLines) line = 0; // spacer overflowed → vanished at next page top
  };

  const para = (text: string, lines: number, style: { indent?: number; align?: 'left' | 'right' | 'center'; bold?: boolean } = {}) => {
    doc.paragraph(text, {
      font: style.bold ? 'sp-bold' : 'sp',
      size: 12, lineHeight: 1.0,
      ...(style.indent !== undefined ? { indent: style.indent } : {}),
      ...(style.align !== undefined ? { align: style.align } : {}),
      spaceBefore: 0, spaceAfter: 0,
      orphans: 1, widows: 1,
    });
    line += lines;
  };

  /** Action/centered lines, splitting freely across pages (widow/orphan ≥ 2). */
  const emitFlow = (lines: BodyLine[], align?: 'center') => {
    let rest = lines;
    while (rest.length) {
      const avail = SP.pageLines - line;
      if (rest.length <= avail) {
        para(rest.map((l) => l.text).join('\n'), rest.length, { ...(align !== undefined ? { align } : {}) });
        return;
      }
      if (avail >= 2 && rest.length - avail >= 2) {
        const head = rest.slice(0, avail);
        para(head.map((l) => l.text).join('\n'), head.length, { ...(align !== undefined ? { align } : {}) });
        brk();
        rest = rest.slice(avail);
      } else {
        brk(); // try again on a fresh page (a >54-line block loops and splits)
      }
    }
  };

  /** Dialogue with MORE/CONT'D splitting — the screenplay signature feature. */
  const emitDialogue = (cueText: string, body: BodyLine[]) => {
    let cue = cueText;
    let rest = body;
    for (;;) {
      const avail = SP.pageLines - line;
      if (1 + rest.length <= avail) {
        para(cue, 1, { indent: SP.cueIndent });
        for (const l of rest) para(l.text, 1, { indent: l.indent });
        return;
      }
      if (avail >= 4) {
        // cue + k body lines + (MORE), next page re-cues with (CONT'D)
        const k = avail - 2;
        para(cue, 1, { indent: SP.cueIndent });
        for (const l of rest.slice(0, k)) para(l.text, 1, { indent: l.indent });
        para('(MORE)', 1, { indent: SP.dialogueIndent });
        brk();
        cue = `${cue} (CONT'D)`;
        rest = rest.slice(k);
      } else {
        brk();
      }
    }
  };

  const elements = pairDuals(script.elements);
  const contentLinesOf = (el: LayoutEl): number => {
    switch (el.type) {
      case 'scene': case 'transition': case 'centered': return 1;
      case 'action': return wrapMono(el.text, SP.actionChars).length;
      case 'dialogue': return 1 + dialogueBodyLines(el.parts).length;
      case 'dual': {
        const l = 1 + dialogueBodyLines(el.left.parts).length;
        const r = 1 + dialogueBodyLines(el.right.parts).length;
        return Math.max(l, r);
      }
      default: return 0;
    }
  };

  // Body starts on page 2 when a title page exists: zero-height paragraph at
  // the page top, then a forced break (a bare pageBreak is a no-op at top).
  if (wantTitlePage && tp['title']) {
    para('', 0);
    brk();
  }

  let first = true;
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]!;
    switch (el.type) {
      case 'section': case 'synopsis':
        break; // structural: not typeset
      case 'pageBreak':
        if (line > 0) brk();
        first = true;
        break;
      case 'scene': {
        // orphan rule: move the heading unless 2 lines of the next element fit
        const next = elements.slice(i + 1).find((e) => e.type !== 'section' && e.type !== 'synopsis' && e.type !== 'pageBreak');
        const following = next ? Math.min(2, contentLinesOf(next)) : 0;
        const need = (first ? 0 : 1) + 1 + following;
        if (line + need > SP.pageLines) brk();
        sep();
        para(el.text + (el.sceneNumber ? `  #${el.sceneNumber}#` : ''), 1, { bold: true });
        first = false;
        break;
      }
      case 'action': {
        const lines = wrapMono(el.text, SP.actionChars).map((text) => ({ text, indent: 0 }));
        if (!first) sep();
        emitFlow(lines);
        first = false;
        break;
      }
      case 'centered': {
        if (!first) sep();
        emitFlow(wrapMono(el.text, SP.actionChars).map((text) => ({ text, indent: 0 })), 'center');
        first = false;
        break;
      }
      case 'dialogue': {
        if (!first) sep();
        emitDialogue(el.character, dialogueBodyLines(el.parts));
        first = false;
        break;
      }
      case 'dual': {
        if (!first) sep();
        // dual cells are flat by convention: cue first, parts wrapped at cell width
        const cellFor = (d: Extract<FountainElement, { type: 'dialogue' }>) => {
          const flat = [d.character];
          for (const p of d.parts) for (const l of wrapMono(p.text, SP.dualChars)) flat.push(l);
          return flat.join('\n');
        };
        const lt = cellFor(el.left);
        const rt = cellFor(el.right);
        const h = Math.max(lt.split('\n').length, rt.split('\n').length);
        if (line + h > SP.pageLines) brk(); // dual dialogue never splits
        doc.table({
          columns: ['*', '*'],
          rows: [[lt, rt]],
          style: {
            font: 'sp', size: 12, lineHeight: 1.0, padding: 0,
            borders: 'none', headerFill: null,
          },
          keepTogether: true,
        });
        line += h;
        first = false;
        break;
      }
      case 'transition': {
        if (!first) sep();
        if (line + 1 > SP.pageLines) brk();
        para(el.text, 1, { align: 'right' });
        first = false;
        break;
      }
    }
  }

  attachPayload(doc, 'screenplay', 1, { fountain: source });
  return { doc, script };
}
