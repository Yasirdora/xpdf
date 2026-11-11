import { describe, it, expect } from 'vitest';
import { extractAttachment } from '@xpdf/core';
import { reportDocument, validateReport, type Report } from '../src/report.js';

const latin1 = (u: Uint8Array) => [...u].map((b) => String.fromCharCode(b)).join('');
const pageCount = (u: Uint8Array) => (latin1(u).match(/\/Type \/Page[^s]/g) ?? []).length;

export function sampleReport(): Report {
  return {
    title: 'Quarterly Engine Telemetry',
    subtitle: 'Analytical Engine Division — Q3 2026',
    author: 'A. Lovelace',
    affiliation: 'Babbage Instruments Ltd',
    date: '2026-09-30',
    abstract: 'Gear-wear telemetry remained nominal; one gear train exceeded tolerance and was replaced.',
    sections: [
      {
        heading: 'Scope',
        blocks: [
          { type: 'paragraph', text: 'This report summarises telemetry from 42 gear trains over Q3.' },
          {
            type: 'list', ordered: true, items: [
              'Collection and validation of revolution counters',
              'Wear-model comparison against Q2 baselines',
            ],
          },
        ],
      },
      {
        heading: 'Findings',
        blocks: [
          { type: 'paragraph', text: [{ text: 'Wear rates were nominal' }, { text: ' except train 17.', note: 'Train 17 was replaced on 2026-08-19; downtime 3h.' }] },
          {
            type: 'table',
            columns: ['*', 'auto', 'auto'],
            header: 1,
            rows: [
              ['Metric', 'Q2', 'Q3'],
              ['Mean wear (mm)', '0.11', '0.10'],
              ['Outliers', '0', '1'],
            ],
          },
          { type: 'quote', text: 'The engine seldom lies; our models often do.', source: 'Field manual, 3rd ed.' },
        ],
      },
      {
        heading: 'Recommendations', level: 2 as const,
        blocks: [{ type: 'paragraph', text: 'Increase sampling cadence to weekly for trains older than five years.' }],
      },
    ],
  };
}

describe('validateReport', () => {
  it('requires title and sections', () => {
    expect(validateReport({ title: '', sections: [] })).toEqual(
      expect.arrayContaining(['title is required', 'at least one section is required']),
    );
  });
});

describe('reportDocument', () => {
  it('rejects invalid reports', () => {
    expect(() => reportDocument({ title: '', sections: [] })).toThrow(/invalid report/);
  });

  it('renders a report PDF with a title page + body (2+ pages)', () => {
    const { doc } = reportDocument(sampleReport());
    const pdf = doc.build();
    expect(latin1(pdf).startsWith('%PDF-1.7')).toBe(true);
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(2);
  });

  it('attaches the living document.json payload (full round-trip)', () => {
    const report = sampleReport();
    const { doc } = reportDocument(report);
    const restored = extractAttachment(doc.build(), 'document.json');
    const payload = JSON.parse(new TextDecoder().decode(restored!));
    expect(payload.type).toBe('report');
    expect(payload.data).toEqual(report);
  });

  it('is byte-deterministic', () => {
    const a = reportDocument(sampleReport()).doc.build();
    const b = reportDocument(sampleReport()).doc.build();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
