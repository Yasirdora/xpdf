/**
 * Font registry + measurer: the single measurement API the whole layout
 * engine uses. Font metrics shape dictates layout quality, so every width
 * and baseline in the engine flows through here (design doc §3).
 *
 * Base-14 fonts measure through Adobe AFM data without kerning, because text
 * is painted with Tj (no kerning). Embedded TTFs measure through their real
 * hmtx advances. Both expose 1000-em ascent/descent for baseline alignment.
 */
import {
  EmbeddedFont,
  encodeWinAnsi,
  getFontMetrics,
  type FontMetrics,
  type StandardFontName,
} from '@omnipdf/core';

export type FontSource = StandardFontName | Uint8Array | EmbeddedFont;

export interface ResolvedFont {
  /** For rendering: the base-14 name, or the EmbeddedFont instance. */
  ref: StandardFontName | EmbeddedFont;
  embedded: boolean;
}

export class FontRegistry {
  private readonly fonts = new Map<string, ResolvedFont>();

  register(name: string, source: FontSource): this {
    if (this.fonts.has(name)) throw new Error(`font "${name}" is already registered`);
    if (typeof source === 'string') {
      getFontMetrics(source); // validates the base-14 name eagerly
      this.fonts.set(name, { ref: source, embedded: false });
    } else if (source instanceof EmbeddedFont) {
      this.fonts.set(name, { ref: source, embedded: true });
    } else {
      this.fonts.set(name, { ref: new EmbeddedFont(source), embedded: true });
    }
    return this;
  }

  resolve(name: string): ResolvedFont {
    let f = this.fonts.get(name);
    if (!f) {
      // ergonomic fallback: base-14 names work without explicit registration
      try {
        getFontMetrics(name as StandardFontName);
        f = { ref: name as StandardFontName, embedded: false };
        this.fonts.set(name, f);
      } catch {
        throw new Error(
          `Unknown font "${name}". Register it with doc.font("${name}", 'Helvetica-Bold' | ttfBytes).`,
        );
      }
    }
    return f;
  }

  has(name: string): boolean {
    return this.fonts.has(name);
  }

  entries(): IterableIterator<[string, ResolvedFont]> {
    return this.fonts.entries();
  }
}

export class Measurer {
  constructor(private readonly registry: FontRegistry) {}

  private metrics(name: string): FontMetrics | EmbeddedFont {
    const f = this.registry.resolve(name);
    return f.embedded ? (f.ref as EmbeddedFont) : getFontMetrics(f.ref as StandardFontName);
  }

  /** Text width in pt at the given size. */
  width(fontName: string, text: string, size: number): number {
    const m = this.metrics(fontName);
    if (m instanceof EmbeddedFont) return m.widthAt(text, size);
    return m.widthAt(text, size, { kern: false });
  }

  /** Whether every character can be drawn in this font (not .notdef, not a WinAnsi miss). */
  supports(fontName: string, text: string): boolean {
    const m = this.metrics(fontName);
    if (m instanceof EmbeddedFont) return m.supports(text);
    try {
      encodeWinAnsi(text);
      return true;
    } catch {
      return false;
    }
  }

  /** Ascent above the baseline in pt at the given size. */
  ascent(fontName: string, size: number): number {
    return (this.metrics(fontName).ascender / 1000) * size;
  }

  /** Descent below the baseline in pt (positive number). */
  descent(fontName: string, size: number): number {
    return (-this.metrics(fontName).descender / 1000) * size;
  }
}
