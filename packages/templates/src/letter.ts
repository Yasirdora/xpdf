/**
 * Business letter template: sender/recipient/date/subject/body → LayoutDocument.
 *
 * Classic block layout (international, close to DIN 5008 form B without its
 * fold marks): sender top-left, date right-aligned, recipient block, bold
 * subject line, justified body, closing with signature gap.
 */
import { LayoutDocument } from '@xpdf/document';
import { attachPayload, type TemplateTheme } from './payload.js';

export interface Letter {
  sender: {
    name: string;
    /** Address lines (street, city, country, ...). */
    lines: string[];
    email?: string;
    phone?: string;
  };
  recipient: {
    name: string;
    /** Address lines as they should appear. */
    lines: string[];
  };
  /** Display string (ISO or preformatted). */
  date: string;
  /** Place line, e.g. 'Paris' → "Paris, 2026-08-12". */
  place?: string;
  subject?: string;
  /** e.g. 'Dear Ms. Lovelace,' — omitted for formal notices. */
  salutation?: string;
  /** Body paragraphs (plain text). */
  body: string[];
  /** e.g. 'Sincerely,' */
  closing?: string;
  /** Printed name under the signature gap. Defaults to sender.name. */
  signatureName?: string;
  /** e.g. 'Enclosures: 2' or 'cc: J. Doe'. */
  postscript?: string[];
}

export interface LetterDocumentResult {
  doc: LayoutDocument;
}

export function validateLetter(l: Letter): string[] {
  const errors: string[] = [];
  if (!l.sender?.name?.trim()) errors.push('sender.name is required');
  if (!l.recipient?.name?.trim()) errors.push('recipient.name is required');
  if (!l.date?.trim()) errors.push('date is required');
  if (!l.body?.length || l.body.every((p) => !p.trim())) errors.push('at least one body paragraph is required');
  return errors;
}

export function letterDocument(letter: Letter, theme: TemplateTheme = {}): LetterDocumentResult {
  const errors = validateLetter(letter);
  if (errors.length) throw new Error(`invalid letter:\n  - ${errors.join('\n  - ')}`);
  const accent = theme.accent ?? '#111827';
  const gray = '#4b5563';

  const doc = new LayoutDocument({
    pageSize: 'A4',
    margins: { top: 56, bottom: 56, left: 68, right: 68 },
    title: `Letter — ${letter.sender.name} to ${letter.recipient.name}`,
    author: letter.sender.name,
    defaultStyle: { font: 'letter-body', size: 10.5, lineHeight: 1.4 },
    ...(theme.pdfa !== undefined ? { pdfa: theme.pdfa } : {}),
  });
  doc.font('letter-body', theme.font ?? 'Helvetica');
  doc.font('letter-bold', theme.boldFont ?? 'Helvetica-Bold');

  // --- sender ---
  doc.paragraph(letter.sender.name, { font: 'letter-bold', size: 12, color: accent, spaceAfter: 1 });
  for (const line of letter.sender.lines) {
    doc.paragraph(line, { size: 9, color: gray, spaceAfter: 0 });
  }
  const contactBits = [letter.sender.email, letter.sender.phone].filter(Boolean);
  if (contactBits.length) {
    doc.paragraph(contactBits.join('  ·  '), { size: 9, color: gray, spaceAfter: 0 });
  }

  // --- date (right) ---
  doc.spacer(16);
  doc.paragraph([letter.place, letter.date].filter(Boolean).join(', '), {
    align: 'right', size: 10.5, spaceAfter: 0,
  });

  // --- recipient ---
  doc.spacer(16);
  doc.paragraph(letter.recipient.name, { font: 'letter-bold', size: 10.5, spaceAfter: 1 });
  for (const line of letter.recipient.lines) {
    doc.paragraph(line, { size: 10.5, spaceAfter: 0 });
  }

  // --- subject ---
  if (letter.subject) {
    doc.spacer(18);
    doc.paragraph(letter.subject, { font: 'letter-bold', size: 11, keepWithNext: true });
  }

  // --- body ---
  doc.spacer(letter.subject ? 10 : 20);
  if (letter.salutation) {
    doc.paragraph(letter.salutation, { size: 10.5, spaceAfter: 8, keepWithNext: true });
  }
  for (const p of letter.body) {
    doc.paragraph(p, { size: 10.5, align: 'justify', spaceAfter: 8 });
  }

  // --- closing ---
  if (letter.closing) {
    doc.spacer(6);
    doc.paragraph(letter.closing, { size: 10.5, spaceAfter: 0, keepWithNext: true });
  }
  // signature gap + printed name, never split from the closing
  doc.spacer(34);
  doc.paragraph(letter.signatureName ?? letter.sender.name, {
    font: 'letter-bold', size: 10.5, keepTogether: true,
  });

  for (const ps of letter.postscript ?? []) {
    doc.paragraph(ps, { size: 9, color: gray, spaceBefore: 6 });
  }

  attachPayload(doc, 'letter', 1, letter);
  return { doc };
}
