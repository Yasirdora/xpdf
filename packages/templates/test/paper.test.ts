import { describe, it, expect } from 'vitest';
import { extractAttachment } from '@xpdf/core';
import { paperDocument, validatePaper, type Paper } from '../src/paper.js';

const latin1 = (u: Uint8Array) => [...u].map((b) => String.fromCharCode(b)).join('');

export function samplePaper(): Paper {
  return {
    title: 'On the Mechanical Computation of Bernoulli Numbers',
    authors: [
      { name: 'A. Lovelace', affiliation: 'Babbage Instruments Ltd', email: 'ada@analytical.example' },
      { name: 'C. Babbage', affiliation: 'Babbage Instruments Ltd' },
    ],
    abstract: 'We describe an algorithm for the Analytical Engine that computes Bernoulli numbers via chained operations, and we analyse its operation-card complexity.',
    keywords: ['Analytical Engine', 'Bernoulli numbers', 'operation cards'],
    sections: [
      {
        heading: 'Introduction',
        paragraphs: [
          'The Analytical Engine weaves algebraic patterns, much as the Jacquard loom weaves flowers and leaves [1].',
          [{ text: 'We assume familiarity with the store and the mill' }, { text: '.', note: 'See [2] for a full mechanical description of the mill barrel and its reducing gears.' }],
        ],
      },
      {
        heading: 'Method',
        paragraphs: [
          'The computation proceeds in cycles of variable clearances, each governed by an operation card.',
        ],
      },
      {
        heading: 'Complexity', level: 2 as const,
        paragraphs: ['Card count grows linearly with the index of the desired Bernoulli number.'],
      },
    ],
    acknowledgements: 'The authors thank the workshop for precise gear cutting.',
    references: [
      'L. F. Menabrea, "Sketch of the Analytical Engine," Bibliothèque Universelle de Genève, 1842.',
      'C. Babbage, "Passages from the Life of a Philosopher," Longman, 1864.',
    ],
  };
}

describe('validatePaper', () => {
  it('requires title, authors, abstract and sections', () => {
    const errors = validatePaper({ title: '', authors: [], abstract: '', sections: [] });
    expect(errors).toEqual(expect.arrayContaining([
      'title is required', 'at least one author is required',
      'abstract is required', 'at least one section is required',
    ]));
  });
});

describe('paperDocument', () => {
  it('rejects invalid papers', () => {
    expect(() => paperDocument({ title: '', authors: [], abstract: '', sections: [] })).toThrow(/invalid paper/);
  });

  it('renders a paper PDF', () => {
    const { doc } = paperDocument(samplePaper());
    expect(latin1(doc.build()).startsWith('%PDF-1.7')).toBe(true);
  });

  it('attaches the living document.json payload (full round-trip)', () => {
    const paper = samplePaper();
    const { doc } = paperDocument(paper);
    const restored = extractAttachment(doc.build(), 'document.json');
    const payload = JSON.parse(new TextDecoder().decode(restored!));
    expect(payload.type).toBe('paper');
    expect(payload.data).toEqual(paper);
  });

  it('is byte-deterministic', () => {
    const a = paperDocument(samplePaper()).doc.build();
    const b = paperDocument(samplePaper()).doc.build();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
