/**
 * Greedy line breaker over styled runs.
 *
 * Deliberately greedy (not Knuth–Plass) for v1: the measurement API is
 * centralized in Measurer, so an optimal-fit breaker can replace this
 * without touching blocks or the paginator. Guarantees that matter here:
 *
 * - forward progress on pathological input (overlong words are hard-split
 *   at code-point boundaries, so narrow table cells can never wedge the
 *   paginator);
 * - footnote markers stay glued to the word they follow;
 * - justification distributes slack over inter-word glue only.
 */
import type { LayoutLine, PositionedRun } from './types.js';
import type { Measurer } from './measurer.js';

/** A text run with style fully resolved and footnote id pre-assigned. */
export interface StyledRun {
  text: string;
  font: string;
  size: number;
  color: string;
  noteId?: number;
  /** Raised baseline (superscript note markers). */
  dy?: number;
  /** Link target carried through to the positioned runs. */
  href?: string;
}

interface Token {
  text: string;
  font: string;
  size: number;
  color: string;
  dy: number;
  width: number;
  /** Inter-word glue: breakable, stretchable under justification. */
  glue: boolean;
  noteId?: number;
  forcedBreak?: boolean;
  href?: string;
  /** A line may break before this piece though no space precedes it: a break point inside a web address. */
  breakBefore?: boolean;
}

const NBSP = 0x00a0;

function isSpace(cp: number): boolean {
  // Unicode White_Space, minus NBSP (which glues words together)
  return cp === 0x20 || cp === 0x09 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x3000;
}

export interface BreakOptions {
  /** Available width per line (line 0 may differ via firstLineIndent). */
  widthAt: (lineIndex: number) => number;
  align: 'left' | 'right' | 'center' | 'justify';
  lineHeight: number; // multiple of run size
  /** Style used for the line box when a line has no tokens (empty paragraph). */
  fallback: { font: string; size: number };
}

/** Characters a web address may break after, so it can wrap across lines. */
const URL_BREAK_AFTER = new Set(['/', '-', '.', '?', '&', '=', '_', '#', '~']);

/** Whether a word looks like a web address (and may break inside). */
function isUrlLike(word: string): boolean {
  return /^[([<"']*(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(word);
}

/**
 * Pieces of a web address, each ending after a break character, so the
 * greedy breaker can wrap it like words without glue. Never splits inside
 * the "://" after the scheme.
 */
function urlPieces(word: string): string[] {
  const schemeEnd = word.indexOf('://');
  const protectedEnd = schemeEnd === -1 ? 0 : schemeEnd + 3;
  const pieces: string[] = [];
  let piece = '';
  let index = 0;
  for (const ch of word) {
    piece += ch;
    index += ch.length;
    // The last "/" of "://" ends exactly at protectedEnd: a break after it
    // is allowed, a break inside the "://" is not.
    if (index >= protectedEnd && URL_BREAK_AFTER.has(ch)) {
      pieces.push(piece);
      piece = '';
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/** Split styled runs into tokens (words, glue, forced breaks, note markers). */
export function tokenize(runs: StyledRun[], measurer: Measurer): Token[] {
  const tokens: Token[] = [];
  for (const run of runs) {
    let word = '';
    const link = run.href !== undefined ? { href: run.href } : {};
    const flushWord = () => {
      if (!word) return;
      // The footnote id lives only on the marker token: a word carrying it
      // would claim the note for every line the run spans.
      const pieces = isUrlLike(word) ? urlPieces(word) : [word];
      pieces.forEach((piece, i) => {
        tokens.push({
          text: piece,
          font: run.font,
          size: run.size,
          color: run.color,
          dy: run.dy ?? 0,
          width: measurer.width(run.font, piece, run.size),
          glue: false,
          ...(i > 0 ? { breakBefore: true } : {}),
          ...link,
        });
      });
      word = '';
    };
    for (const ch of run.text) {
      const cp = ch.codePointAt(0)!;
      if (ch === '\n') {
        flushWord();
        tokens.push({
          text: '', font: run.font, size: run.size, color: run.color, dy: 0, width: 0,
          glue: false, forcedBreak: true,
        });
      } else if (isSpace(cp)) {
        flushWord();
        const prev = tokens[tokens.length - 1];
        if (prev?.glue && prev.font === run.font && prev.size === run.size && prev.href === run.href) {
          prev.text += ch;
          prev.width += measurer.width(run.font, ch, run.size);
        } else {
          tokens.push({
            text: ch, font: run.font, size: run.size, color: run.color, dy: 0,
            width: measurer.width(run.font, ch, run.size), glue: true, ...link,
          });
        }
      } else {
        word += ch;
      }
    }
    flushWord();
    // footnote marker: superscript number glued AFTER the run's last word
    if (run.noteId !== undefined) {
      const markerSize = run.size * 0.7;
      const text = String(run.noteId);
      tokens.push({
        text,
        font: run.font,
        size: markerSize,
        color: run.color,
        dy: run.size * 0.35,
        width: measurer.width(run.font, text, markerSize),
        glue: false,
        noteId: run.noteId,
        ...link,
      });
    }
  }
  return tokens;
}

/** Hard-split an overlong token so it fits `maxWidth` (or overflows by one char). */
function splitToken(token: Token, maxWidth: number, measurer: Measurer): [Token, Token | null] {
  let acc = '';
  let w = 0;
  for (const ch of token.text) {
    const cw = measurer.width(token.font, ch, token.size);
    if (acc && w + cw > maxWidth) {
      const head: Token = { ...token, text: acc, width: w };
      const rest: Token = { ...token, text: token.text.slice(acc.length), width: token.width - w };
      return [head, rest];
    }
    acc += ch;
    w += cw;
  }
  return [token, null];
}

/**
 * How many tokens at the end of `line` are glued to `next`, with no space and
 * no address break point between them: the pieces of one word whose style or
 * link changes part-way, such as a link and the full stop after it.
 */
function gluedTail(line: Token[], next: Token): number {
  let count = 0;
  let after = next;
  for (let i = line.length - 1; i >= 0; i--) {
    const t = line[i]!;
    if (t.glue || t.forcedBreak || after.breakBefore) break;
    count++;
    after = t;
  }
  return count;
}

/** Greedy break of styled runs into positioned lines. */
export function breakLines(runs: StyledRun[], measurer: Measurer, opts: BreakOptions): LayoutLine[] {
  const lines: LayoutLine[] = [];
  const pending = tokenize(runs, measurer);
  let next = 0;
  let current: Token[] = [];
  let currentWidth = 0;
  let lineIndex = 0;

  const emit = (isLast: boolean) => {
    // drop trailing glue
    while (current.length && current[current.length - 1]!.glue) {
      currentWidth -= current.pop()!.width;
    }
    lines.push(positionLine(current, currentWidth, lineIndex, measurer, opts, isLast));
    current = [];
    currentWidth = 0;
    lineIndex++;
  };

  while (next < pending.length) {
    const token = pending[next++]!;
    if (token.forcedBreak) {
      emit(true);
      continue;
    }
    const maxWidth = opts.widthAt(lineIndex);
    if (token.glue && current.length === 0) continue; // no leading glue
    if (current.length && currentWidth + token.width > maxWidth) {
      if (!token.glue) {
        // The start of the word may already sit on this line in another
        // style: carry it down too, then place the token again after it.
        const carry = gluedTail(current, token);
        if (carry > 0 && carry < current.length) {
          const moved = current.splice(current.length - carry);
          const movedWidth = moved.reduce((sum, t) => sum + t.width, 0);
          currentWidth -= movedWidth;
          emit(false);
          current = moved;
          currentWidth = movedWidth;
          next--;
          continue;
        }
        // word doesn't fit: emit current, place word on next line (split if needed)
        emit(false);
        let t: Token | null = token;
        while (t && t.width > opts.widthAt(lineIndex)) {
          const [head, rest] = splitToken(t, opts.widthAt(lineIndex), measurer);
          if (rest === null) break;
          current = [head];
          currentWidth = head.width;
          emit(false);
          t = rest;
        }
        if (t) {
          current = [t];
          currentWidth = t.width;
        }
      } else {
        emit(false); // glue at break point vanishes
      }
    } else if (!current.length && !token.glue && token.width > maxWidth) {
      // single overlong word on an empty line: hard-split
      let t: Token | null = token;
      while (t && t.width > opts.widthAt(lineIndex)) {
        const [head, rest] = splitToken(t, opts.widthAt(lineIndex), measurer);
        if (rest === null) break;
        current = [head];
        currentWidth = head.width;
        emit(false);
        t = rest;
      }
      if (t) {
        current = [t];
        currentWidth = t.width;
      }
    } else {
      current.push(token);
      currentWidth += token.width;
    }
  }
  if (current.length) emit(true);
  if (!lines.length) {
    // empty paragraph still occupies one (empty) line box
    lines.push(positionLine([], 0, 0, measurer, opts, true));
  }
  return lines;
}

function positionLine(
  tokens: Token[],
  naturalWidth: number,
  lineIndex: number,
  measurer: Measurer,
  opts: BreakOptions,
  isLast: boolean,
): LayoutLine {
  const maxWidth = opts.widthAt(lineIndex);

  // line box: max over runs of ascent(+raise)/descent and lineHeight
  let maxRaise = 0;
  let maxDescent = 0;
  let maxLH = 0;
  if (tokens.length === 0) {
    maxRaise = measurer.ascent(opts.fallback.font, opts.fallback.size);
    maxDescent = measurer.descent(opts.fallback.font, opts.fallback.size);
    maxLH = opts.fallback.size * opts.lineHeight;
  }
  for (const t of tokens) {
    maxRaise = Math.max(maxRaise, measurer.ascent(t.font, t.size) + t.dy);
    maxDescent = Math.max(maxDescent, measurer.descent(t.font, t.size));
    maxLH = Math.max(maxLH, t.size * opts.lineHeight);
  }
  const height = Math.max(maxLH, maxRaise + maxDescent);
  const baseline = maxRaise + (height - maxRaise - maxDescent) / 2;

  // alignment / justification
  let extraPerGlue = 0;
  let shiftX = 0;
  const glueCount = tokens.filter((t) => t.glue).length;
  if (opts.align === 'justify' && !isLast && glueCount > 0) {
    extraPerGlue = Math.max(0, maxWidth - naturalWidth) / glueCount;
  } else if (opts.align === 'right') {
    shiftX = maxWidth - naturalWidth;
  } else if (opts.align === 'center') {
    shiftX = (maxWidth - naturalWidth) / 2;
  } else if (opts.align === 'justify') {
    shiftX = 0;
  }

  const runs: PositionedRun[] = [];
  const noteIds: number[] = [];
  let x = shiftX;
  // Under justification the stretch lives in positioning only: each space is
  // still painted at its natural width, so copy, search and screen readers
  // keep the word breaks, and the next word starts a new run after the gap.
  for (const t of tokens) {
    const w = t.width + (t.glue ? extraPerGlue : 0);
    const drawn = t.glue ? t.width : w;
    const prev = runs[runs.length - 1];
    const mergeable =
      prev && prev.font === t.font && prev.size === t.size && prev.color === t.color &&
      prev.dy === t.dy && prev.href === t.href && prev.x + prev.width === x;
    if (mergeable) {
      // one Tj per styled segment keeps extraction clean and streams small
      prev.text += t.text;
      prev.width += drawn;
    } else {
      runs.push({
        text: t.text, font: t.font, size: t.size, color: t.color, x, width: drawn, dy: t.dy,
        ...(t.href !== undefined ? { href: t.href } : {}),
      });
    }
    if (!t.glue && t.noteId !== undefined && !noteIds.includes(t.noteId)) noteIds.push(t.noteId);
    x += w;
  }

  return { runs, x: 0, width: naturalWidth, height, baseline, noteIds };
}
