import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractAttachment } from '@xpdf/core';
import { cvDocument, validateCv, type Cv } from '../src/cv.js';

const latin1 = (u: Uint8Array) => [...u].map((b) => String.fromCharCode(b)).join('');

const fontR = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../core/test/fixtures/Ubuntu-R.ttf', import.meta.url))),
);
const fontB = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../core/test/fixtures/Ubuntu-B.ttf', import.meta.url))),
);

export function sampleCv(): Cv {
  return {
    name: 'Ada Lovelace',
    title: 'Analytical Engine Programmer',
    contact: {
      email: 'ada@analytical.example', phone: '+44 20 7946 0001', location: 'London, UK',
      links: [{ label: 'github.com/alovelace' }],
    },
    summary: 'First computer programmer. Wrote the world\'s first algorithm intended for a machine.',
    experience: [
      {
        role: 'Senior Notes Author', org: 'Babbage & Co.', location: 'London',
        start: '1842', end: '1843',
        highlights: [
          'Translated Menabrea\'s memoir on the Analytical Engine',
          'Added Note G: the first published computer program (Bernoulli numbers)',
        ],
      },
      {
        role: 'Mathematical Correspondent', org: 'Independent', start: '1835', end: '1842',
        highlights: ['Studied symbolic logic and computational machinery'],
      },
    ],
    education: [
      { degree: 'Private tuition in mathematics', institution: 'Mary Somerville circle', end: '1835' },
    ],
    skills: [
      { category: 'Engines', items: ['Analytical Engine', 'Difference Engine'] },
      { category: 'Mathematics', items: ['Symbolic logic', 'Bernoulli numbers'] },
    ],
    languages: [
      { name: 'English', level: 'native' }, { name: 'French', level: 'fluent' },
    ],
  };
}

describe('validateCv', () => {
  it('requires a name', () => {
    expect(validateCv({ name: '' })).toContain('name is required');
  });
  it('flags incomplete experience entries', () => {
    const errors = validateCv({ name: 'X', experience: [{ role: '', org: '', start: '' }] });
    expect(errors).toContain('experience[0]: role is required');
    expect(errors).toContain('experience[0]: org is required');
    expect(errors).toContain('experience[0]: start is required');
  });
});

describe('cvDocument', () => {
  it('rejects invalid CVs', () => {
    expect(() => cvDocument({ name: '' })).toThrow(/invalid CV/);
  });

  it('renders a CV PDF', () => {
    const { doc } = cvDocument(sampleCv());
    const pdf = latin1(doc.build());
    expect(pdf.startsWith('%PDF-1.7')).toBe(true);
  });

  it('attaches the living document.json payload (full round-trip)', () => {
    const cv = sampleCv();
    const { doc } = cvDocument(cv);
    const restored = extractAttachment(doc.build(), 'document.json');
    expect(restored).not.toBeNull();
    const payload = JSON.parse(new TextDecoder().decode(restored!));
    expect(payload.type).toBe('cv');
    expect(payload.version).toBe(1);
    expect(payload.data).toEqual(cv);
  });

  it('is byte-deterministic', () => {
    const a = cvDocument(sampleCv()).doc.build();
    const b = cvDocument(sampleCv()).doc.build();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('supports PDF/A-3 archival mode with an embedded font', () => {
    const { doc } = cvDocument(sampleCv(), { font: fontR, boldFont: fontB, pdfa: '3B' });
    const pdf = latin1(doc.build());
    expect(pdf).toContain('pdfaid:part');
  });
});
