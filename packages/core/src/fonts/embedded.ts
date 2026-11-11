/**
 * Embedded TrueType font: subset + Type0/CIDFontType2 PDF representation.
 *
 * Text is encoded as Identity-H (2-byte CIDs). CIDs are assigned in ascending
 * code-point order, starting at 1, when the document is built — not in the
 * order characters were first drawn — so the same set of characters always
 * produces the same CIDs. CID 0 is unused. A /CIDToGIDMap stream points each
 * CID at the renumbered glyph (several code points may share a glyph, and a
 * code point the font lacks points at glyph 0). ToUnicode has one entry per
 * CID, so every code point extracts; a missing character extracts as U+FFFD.
 */
import { parseTtf, subsetTtf, type TtfFont } from './ttf.js';
import { ascii, fx, type PdfWriter } from '../writer.js';

/** Deterministic 6-letter subset tag (FNV-1a over name + sorted codepoints). */
function subsetTag(psName: string, codepoints: number[]): string {
  let h = 0x811c9dc5;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  feed(psName);
  for (const cp of codepoints) feed(String(cp) + ',');
  let tag = '';
  for (let i = 0; i < 6; i++) {
    tag = String.fromCharCode(65 + (h % 26)) + tag;
    h = Math.floor(h / 26);
  }
  return tag;
}

export class EmbeddedFont {
  /** @internal */ readonly font: TtfFont;
  /** @internal */ readonly usedCodepoints = new Set<number>();
  /** CID by code point. Null until assignCids(); CID 0 is never used. */
  private cidOfCp: Map<number, number> | null = null;

  constructor(ttfBytes: Uint8Array) {
    this.font = parseTtf(ttfBytes);
  }

  /** Advance in 1000-em units — the same integer written into /W. */
  private advance1000(cp: number): number {
    const gid = this.font.mapCodepoint(cp);
    return Math.round(((this.font.advances[gid] ?? 0) * 1000) / this.font.unitsPerEm);
  }

  get postscriptName(): string {
    return this.font.postscriptName.replace(/[^A-Za-z0-9-]/g, '');
  }

  get unitsPerEm(): number {
    return this.font.unitsPerEm;
  }

  /** Ascender in 1000-em units (AFM convention), for baseline math. */
  get ascender(): number {
    return Math.round((this.font.ascender * 1000) / this.font.unitsPerEm);
  }

  /** Descender in 1000-em units (negative). */
  get descender(): number {
    return Math.round((this.font.descender * 1000) / this.font.unitsPerEm);
  }

  /** Cap height in 1000-em units. */
  get capHeight(): number {
    return Math.round((this.font.capHeight * 1000) / this.font.unitsPerEm);
  }

  /** Width of a string at `size` pt, using the same 1000-em advances as /W. */
  widthAt(text: string, size: number): number {
    let total = 0;
    for (const ch of text) total += this.advance1000(ch.codePointAt(0)!);
    return (total * size) / 1000;
  }

  /** Remember code points so the subset and the CID map include them. */
  note(text: string): void {
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (!this.usedCodepoints.has(cp)) {
        this.usedCodepoints.add(cp);
        this.cidOfCp = null;
      }
    }
  }

  /**
   * Assign CID 1..n in ascending code-point order. Called from Document.build
   * before any content stream is encoded, so every CID is known up front.
   */
  assignCids(): Map<number, number> {
    const cps = [...this.usedCodepoints].sort((a, b) => a - b);
    this.cidOfCp = new Map(cps.map((cp, i) => [cp, i + 1]));
    return this.cidOfCp;
  }

  /**
   * Encode text as a PDF hex string of CIDs (<0001…>).
   * Registers used code points. A character the font lacks still gets a CID;
   * that CID maps to glyph 0 and extracts as U+FFFD.
   */
  encodeHex(text: string): string {
    this.note(text);
    const cids = this.cidOfCp ?? this.assignCids();
    let hex = '';
    for (const ch of text) {
      const cid = cids.get(ch.codePointAt(0)!);
      if (cid === undefined) throw new Error('embedded font CID map is missing a code point');
      hex += cid.toString(16).padStart(4, '0');
    }
    return `<${hex}>`;
  }

  /** Whether every character of `text` has a glyph in this font. */
  supports(text: string): boolean {
    for (const ch of text) {
      if (this.font.mapCodepoint(ch.codePointAt(0)!) === 0) return false;
    }
    return true;
  }

  /**
   * Emit all PDF objects for this font. Called by Document.build() exactly
   * once, after all text has been encoded (so the subset is complete).
   * @internal
   */
  emit(
    w: PdfWriter,
    objs: { type0: number; cid: number; descriptor: number; fontFile: number; toUnicode: number; cidToGid: number },
  ): void {
    const cids = this.assignCids();
    const { bytes: subsetBytes, glyphs } = subsetTtf(this.font, this.usedCodepoints);
    const name = `${subsetTag(this.postscriptName, [...this.usedCodepoints].sort((a, b) => a - b))}+${this.postscriptName}`;
    const upem = this.font.unitsPerEm;
    const scale = (v: number) => Math.round((v * 1000) / upem);

    // One CID per used code point, already 1..n in ascending code-point order.
    const entries = [...cids.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([cp, cid]) => {
        const sourceGid = this.font.mapCodepoint(cp);
        return { cp, cid, gid: glyphs.get(cp) ?? 0, sourceGid, w: this.advance1000(cp) };
      });
    const wParts = entries.length ? [`1 [${entries.map((e) => e.w).join(' ')}]`] : [];

    const mapBytes = new Uint8Array((entries.length + 1) * 2);
    for (const e of entries) {
      mapBytes[e.cid * 2] = (e.gid >> 8) & 0xff;
      mapBytes[e.cid * 2 + 1] = e.gid & 0xff;
    }

    // ToUnicode: one bfchar per CID. A code point with no glyph extracts as U+FFFD.
    const bfEntries = entries.map(({ cp, cid, sourceGid }) => {
      const unicode = sourceGid === 0 ? 0xfffd : cp;
      const utf16 = String.fromCodePoint(unicode);
      let hexU = '';
      for (let k = 0; k < utf16.length; k++) hexU += utf16.charCodeAt(k).toString(16).padStart(4, '0');
      return `<${cid.toString(16).padStart(4, '0')}> <${hexU}>`;
    });
    const toUnicode = [
      '/CIDInit /ProcSet findresource begin',
      '12 dict begin',
      'begincmap',
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
      '/CMapName /Adobe-Identity-UCS def',
      '/CMapType 2 def',
      '1 begincodespacerange',
      '<0000> <FFFF>',
      'endcodespacerange',
      ...chunk(bfEntries, 100).map(
        (group) => `${group.length} beginbfchar\n${group.join('\n')}\nendbfchar`,
      ),
      'endcmap',
      'CMapName currentdict /CMap defineresource pop',
      'end',
      'end',
    ].join('\n');

    const bbox = this.font.bbox;
    // 32 = Nonsymbolic. 64 = Italic, only when the face is actually oblique.
    const flags = 32 | (this.font.italicAngle !== 0 ? 64 : 0);
    w.setStreamObject(objs.fontFile, ` /Length1 ${subsetBytes.length}`, subsetBytes, { compress: true });
    w.setStreamObject(objs.cidToGid, '', mapBytes, { compress: true });
    w.setObject(
      objs.descriptor,
      `<< /Type /FontDescriptor /FontName /${name} /Flags ${flags} ` +
        `/FontBBox [${scale(bbox.xMin)} ${scale(bbox.yMin)} ${scale(bbox.xMax)} ${scale(bbox.yMax)}] ` +
        `/ItalicAngle ${fx(this.font.italicAngle)} /Ascent ${scale(this.font.ascender)} ` +
        `/Descent ${scale(this.font.descender)} /CapHeight ${scale(this.font.capHeight)} ` +
        `/StemV 80 /FontFile2 ${objs.fontFile} 0 R >>`,
    );
    w.setObject(
      objs.cid,
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} ` +
        `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
        `/FontDescriptor ${objs.descriptor} 0 R /W [${wParts.join(' ')}] /CIDToGIDMap ${objs.cidToGid} 0 R >>`,
    );
    w.setStreamObject(objs.toUnicode, '', ascii(toUnicode), { compress: true });
    w.setObject(
      objs.type0,
      `<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H ` +
        `/DescendantFonts [${objs.cid} 0 R] /ToUnicode ${objs.toUnicode} 0 R >>`,
    );
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
