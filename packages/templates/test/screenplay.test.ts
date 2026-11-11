import { describe, it, expect } from 'vitest';
import { inflateZlib, extractAttachment } from '@xpdf/core';
import { parseFountain } from '../src/fountain.js';
import { screenplayDocument, wrapMono, SP } from '../src/screenplay.js';

const latin1 = (u: Uint8Array) => [...u].map((b) => String.fromCharCode(b)).join('');

/** Inflate all page content streams (in page order) for text assertions. */
function contentStreams(pdf: Uint8Array): string[] {
  const s = latin1(pdf);
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    let end = s.indexOf('endstream', start);
    while (end > start && (s[end - 1] === '\n' || s[end - 1] === '\r')) end--;
    const bytes = Uint8Array.from(s.slice(start, end), (c) => c.charCodeAt(0));
    try {
      const text = new TextDecoder('latin1').decode(inflateZlib(bytes));
      if (text.includes('BT')) out.push(text); // text-bearing content streams only
    } catch { /* binary stream (font, image) */ }
  }
  return out;
}

const pageCount = (u: Uint8Array) => (latin1(u).match(/\/Type \/Page[^s]/g) ?? []).length;

// ---------------------------------------------------------------------------
// Fountain parser
// ---------------------------------------------------------------------------

describe('parseFountain', () => {
  it('parses the title page', () => {
    const s = parseFountain('Title: The Engine\nAuthor: Ada Lovelace\nDraft date: 2026-08-12\n\nINT. LAB - DAY\n\nHello.');
    expect(s.titlePage['title']).toEqual(['The Engine']);
    expect(s.titlePage['author']).toEqual(['Ada Lovelace']);
    expect(s.titlePage['draft date']).toEqual(['2026-08-12']);
    expect(s.elements[0]).toMatchObject({ type: 'scene', text: 'INT. LAB - DAY' });
  });

  it('parses scenes, action, dialogue, parentheticals, transitions', () => {
    const src = [
      'INT. LAB - NIGHT',
      '',
      'The gears turn slowly.',
      '',
      'ADA',
      '(checking the mill)',
      'We are ahead of schedule.',
      '',
      'CUT TO:',
      '',
      'EXT. STREET - DAY',
      '',
      'Rain.',
    ].join('\n');
    const s = parseFountain(src);
    const types = s.elements.map((e) => e.type);
    expect(types).toEqual(['scene', 'action', 'dialogue', 'transition', 'scene', 'action']);
    const dlg = s.elements[2];
    expect(dlg).toMatchObject({
      character: 'ADA',
      parts: [
        { type: 'parenthetical', text: '(checking the mill)' },
        { type: 'line', text: 'We are ahead of schedule.' },
      ],
    });
  });

  it('detects dual dialogue via ^ and pairs are marked', () => {
    const s = parseFountain('ADA\nLine one.\n\nCHARLES ^\nLine two.\n');
    expect(s.elements[0]).toMatchObject({ type: 'dialogue', character: 'ADA', dual: false });
    expect(s.elements[1]).toMatchObject({ type: 'dialogue', character: 'CHARLES', dual: true });
  });

  it('strips notes, boneyard and emphasis; honors forced markers', () => {
    const src = '.A quiet room [[fix this later]]\n\n@McVoy\nSPEAKS.\n\n/* whole scene cut */\nThe *very* **last** _word_.\n';
    const s = parseFountain(src);
    expect(s.elements[0]).toMatchObject({ type: 'scene', text: 'A quiet room' });
    expect(s.elements[1]).toMatchObject({ type: 'dialogue', character: 'McVoy' });
    expect(s.elements[2]).toMatchObject({ type: 'action', text: 'The very last word.' });
    expect(s.elements).toHaveLength(3);
  });

  it('parses scene numbers and page breaks', () => {
    const s = parseFountain('INT. A - DAY #12#\n\nX.\n\n===\n\nINT. B - DAY\n\nY.\n');
    expect(s.elements[0]).toMatchObject({ type: 'scene', text: 'INT. A - DAY', sceneNumber: '12' });
    expect(s.elements.some((e) => e.type === 'pageBreak')).toBe(true);
  });

  it('keeps hard line breaks in action', () => {
    const s = parseFountain('First line.  \nSecond line.\n');
    expect(s.elements[0]).toMatchObject({ type: 'action', text: 'First line.\nSecond line.' });
  });
});

describe('wrapMono', () => {
  it('wraps greedily at the character width', () => {
    expect(wrapMono('aa bb cc', 5)).toEqual(['aa bb', 'cc']);
    expect(wrapMono('one\ntwo', 10)).toEqual(['one', 'two']);
  });
  it('chunks over-long words', () => {
    expect(wrapMono('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });
});

// ---------------------------------------------------------------------------
// Screenplay layout
// ---------------------------------------------------------------------------

const SIMPLE = `Title: Gears
Author: A. Lovelace

INT. LAB - DAY

The engine hums.

ADA
It begins.

CUT TO:

EXT. STREET - NIGHT

Rain again.`;

describe('screenplayDocument', () => {
  it('renders title page + body on US Letter with Courier geometry', () => {
    const { doc, script } = screenplayDocument(SIMPLE);
    expect(script.titlePage['title']).toEqual(['Gears']);
    const pdf = doc.build();
    expect(pageCount(pdf)).toBe(2);
    expect(latin1(pdf)).toContain('/MediaBox [0 0 612 792]');
    const streams = contentStreams(pdf);
    expect(streams[0]).toContain('GEARS'); // furniture title page
    expect(streams[1]).toContain('INT. LAB - DAY');
    expect(streams[1]).toContain('It begins.');
    expect(streams[1]).toContain('CUT TO:');
  });

  it('splits long dialogue with (MORE) and (CONT\'D)', () => {
    const actions = Array.from({ length: 24 }, (_, i) => `Action beat ${i + 1}.`).join('\n\n');
    const speech = Array.from({ length: 10 }, (_, i) => `Speech line ${i + 1}.`).join('\n');
    const src = `${actions}\n\nADA\n${speech}\n`;
    const { doc } = screenplayDocument(src);
    const pdf = doc.build();
    expect(pageCount(pdf)).toBe(2);
    const streams = contentStreams(pdf);
    expect(streams[0]).toContain('MORE');
    expect(streams[0]).not.toContain("CONT'D");
    expect(streams[1]).toContain("CONT'D");
    expect(streams[1]).toContain('Speech line 5.');
  });

  it('never strands a scene heading at a page bottom', () => {
    const actions = Array.from({ length: 27 }, (_, i) => `Beat ${i + 1}.`).join('\n\n');
    const longAction = 'Gears mesh and turn '.repeat(8).trim(); // wraps to 2+ lines
    const src = `${actions}\n\nINT. OBSERVATORY - DAWN\n\n${longAction}\n`;
    const { doc } = screenplayDocument(src);
    const pdf = doc.build();
    expect(pageCount(pdf)).toBe(2);
    const streams = contentStreams(pdf);
    expect(streams[0]).not.toContain('OBSERVATORY');
    expect(streams[1]).toContain('INT. OBSERVATORY - DAWN');
  });

  it('sets dual dialogue side by side', () => {
    const src = 'ADA\nThe left channel.\n\nCHARLES ^\nThe right channel.\n';
    const { doc } = screenplayDocument(src);
    const pdf = doc.build();
    expect(pageCount(pdf)).toBe(1);
    const streams = contentStreams(pdf);
    expect(streams[0]).toContain('ADA');
    expect(streams[0]).toContain('CHARLES');
    expect(streams[0]).toContain('The left channel.');
    expect(streams[0]).toContain('The right channel.');
  });

  it('attaches the Fountain source as the living payload', () => {
    const { doc } = screenplayDocument(SIMPLE);
    const restored = extractAttachment(doc.build(), 'document.json');
    const payload = JSON.parse(new TextDecoder().decode(restored!));
    expect(payload.type).toBe('screenplay');
    expect(payload.data.fountain).toBe(SIMPLE);
  });

  it('is byte-deterministic', () => {
    const a = screenplayDocument(SIMPLE).doc.build();
    const b = screenplayDocument(SIMPLE).doc.build();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('geometry constants follow the industry standard', () => {
    expect(SP.pageLines * SP.lineH).toBe(648); // 9 inches of text
    expect(SP.dialogueChars * SP.charW + SP.dialogueIndent).toBeCloseTo(324, 1); // 2.5"→6.0"
  });
});
