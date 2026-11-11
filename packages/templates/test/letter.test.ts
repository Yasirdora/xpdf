import { describe, it, expect } from 'vitest';
import { extractAttachment } from '@xpdf/core';
import { letterDocument, validateLetter, type Letter } from '../src/letter.js';

const latin1 = (u: Uint8Array) => [...u].map((b) => String.fromCharCode(b)).join('');

export function sampleLetter(): Letter {
  return {
    sender: {
      name: 'Atelier Lovelace SAS',
      lines: ['12 rue des Algorithmes', '75011 Paris', 'France'],
      email: 'hello@lovelace.example',
    },
    recipient: {
      name: 'Babbage Instruments Ltd',
      lines: ['5 Analytical Way', 'London EC1A 1BB', 'United Kingdom'],
    },
    date: '2026-08-12',
    place: 'Paris',
    subject: 'Maintenance contract renewal — Analytical Engine No. 7',
    salutation: 'Dear Dr. Babbage,',
    body: [
      'Your maintenance contract for Analytical Engine No. 7 expires on 30 September 2026. We would be pleased to renew it under the same terms for a further twelve months.',
      'Please return the enclosed countersigned copy at your earliest convenience. As always, our workshop remains at your disposal for any unscheduled intervention.',
    ],
    closing: 'Sincerely,',
    signatureName: 'Ada Lovelace, Director',
    postscript: ['Enclosures: 2'],
  };
}

describe('validateLetter', () => {
  it('requires sender, recipient, date and body', () => {
    const errors = validateLetter({
      sender: { name: '', lines: [] },
      recipient: { name: '', lines: [] },
      date: '', body: [],
    });
    expect(errors).toEqual(expect.arrayContaining([
      'sender.name is required', 'recipient.name is required',
      'date is required', 'at least one body paragraph is required',
    ]));
  });
});

describe('letterDocument', () => {
  it('rejects invalid letters', () => {
    expect(() => letterDocument({
      sender: { name: '', lines: [] }, recipient: { name: '', lines: [] }, date: '', body: [],
    })).toThrow(/invalid letter/);
  });

  it('renders a one-page business letter', () => {
    const { doc } = letterDocument(sampleLetter());
    const pdf = doc.build();
    expect(latin1(pdf).startsWith('%PDF-1.7')).toBe(true);
    expect((latin1(pdf).match(/\/Type \/Page[^s]/g) ?? []).length).toBe(1);
  });

  it('attaches the living document.json payload (full round-trip)', () => {
    const letter = sampleLetter();
    const { doc } = letterDocument(letter);
    const restored = extractAttachment(doc.build(), 'document.json');
    const payload = JSON.parse(new TextDecoder().decode(restored!));
    expect(payload.type).toBe('letter');
    expect(payload.data).toEqual(letter);
  });

  it('is byte-deterministic', () => {
    const a = letterDocument(sampleLetter()).doc.build();
    const b = letterDocument(sampleLetter()).doc.build();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
