/**
 * Round-trip reader: extract embedded files from an xpdf-produced PDF.
 *
 * Scope, stated plainly: this scans for the deterministic structures our own
 * writer emits (Filespec dicts and EmbeddedFile streams, in matching order).
 * It is the living-PDF restore path, not a general-purpose PDF parser — a
 * full xref-based reader is a separate, later component.
 */
import { inflateZlib } from './inflate.js';

export interface ExtractedFile {
  name: string;
  data: Uint8Array;
}

const latin1 = (u: Uint8Array): string => {
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return s;
};

/** Unescape a PDF literal string body (handles \( \) \\ \n \r \t and octal). */
function unescapePdfString(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const next = s[++i]!;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next >= '0' && next <= '7') {
      let oct = next;
      while (oct.length < 3 && s[i + 1]! >= '0' && s[i + 1]! <= '7') oct += s[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else out += next; // ( ) \ and line-continuation
  }
  return out;
}

export function extractEmbeddedFiles(bytes: Uint8Array): ExtractedFile[] {
  const str = latin1(bytes);

  const names: string[] = [];
  const nameRe = /\/Type \/Filespec \/F \(((?:[^()\\]|\\.)*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = nameRe.exec(str))) names.push(unescapePdfString(m[1]!));

  const out: ExtractedFile[] = [];
  const streamRe = /<<\s*(\/Filter \/FlateDecode )?\/Length (\d+) \/Type \/EmbeddedFile[^\n]*?>>\nstream\n/g;
  let i = 0;
  while ((m = streamRe.exec(str))) {
    const compressed = m[1] !== undefined;
    const len = Number(m[2]);
    const start = m.index + m[0].length;
    const raw = bytes.subarray(start, start + len);
    const data = compressed ? inflateZlib(raw) : new Uint8Array(raw);
    out.push({ name: names[i] ?? `attachment-${i + 1}`, data });
    i++;
  }
  return out;
}

/** Restore a named attachment's bytes (e.g. document.json), or null. */
export function extractAttachment(bytes: Uint8Array, name: string): Uint8Array | null {
  const file = extractEmbeddedFiles(bytes).find((f) => f.name === name);
  return file ? file.data : null;
}
