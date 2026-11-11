/**
 * CV / résumé template: structured career data → LayoutDocument.
 *
 * Single-column classic layout (sidebar variants need multi-flow layout —
 * a later core feature, tracked in the design doc). Entries use keepWithNext
 * chains so a role heading never strands at a page bottom.
 */
import { LayoutDocument } from '@xpdf/document';
import { attachPayload, type TemplateTheme } from './payload.js';

export interface CvExperience {
  role: string;
  org: string;
  location?: string;
  /** Display strings, e.g. start: '2021', end: '2024' or 'Present'. */
  start: string;
  end?: string;
  highlights?: string[];
}

export interface CvEducation {
  degree: string;
  institution: string;
  location?: string;
  start?: string;
  end?: string;
  details?: string[];
}

export interface Cv {
  name: string;
  /** Professional headline, e.g. 'Senior Compiler Engineer'. */
  title?: string;
  contact?: {
    email?: string;
    phone?: string;
    location?: string;
    /** Shown as labels joined to the contact line. */
    links?: Array<{ label: string; url?: string }>;
  };
  summary?: string;
  experience?: CvExperience[];
  education?: CvEducation[];
  skills?: Array<{ category: string; items: string[] }>;
  languages?: Array<{ name: string; level: string }>;
  certifications?: Array<{ name: string; issuer?: string; year?: string }>;
}

export interface CvDocumentResult {
  doc: LayoutDocument;
}

export function validateCv(cv: Cv): string[] {
  const errors: string[] = [];
  if (!cv.name?.trim()) errors.push('name is required');
  for (const [i, e] of (cv.experience ?? []).entries()) {
    if (!e.role?.trim()) errors.push(`experience[${i}]: role is required`);
    if (!e.org?.trim()) errors.push(`experience[${i}]: org is required`);
    if (!e.start?.trim()) errors.push(`experience[${i}]: start is required`);
  }
  for (const [i, e] of (cv.education ?? []).entries()) {
    if (!e.degree?.trim()) errors.push(`education[${i}]: degree is required`);
    if (!e.institution?.trim()) errors.push(`education[${i}]: institution is required`);
  }
  return errors;
}

function dateRange(start: string | undefined, end: string | undefined): string {
  return [start, end ?? 'Present'].filter(Boolean).join(' – ');
}

export function cvDocument(cv: Cv, theme: TemplateTheme = {}): CvDocumentResult {
  const errors = validateCv(cv);
  if (errors.length) throw new Error(`invalid CV:\n  - ${errors.join('\n  - ')}`);
  const accent = theme.accent ?? '#1e40af';
  const gray = '#4b5563';

  const doc = new LayoutDocument({
    pageSize: 'A4',
    margins: { top: 52, bottom: 52, left: 56, right: 56 },
    title: `CV — ${cv.name}`,
    author: cv.name,
    defaultStyle: { font: 'cv-body', size: 10, lineHeight: 1.35 },
    ...(theme.pdfa !== undefined ? { pdfa: theme.pdfa } : {}),
  });
  doc.font('cv-body', theme.font ?? 'Helvetica');
  doc.font('cv-bold', theme.boldFont ?? 'Helvetica-Bold');

  const section = (label: string) => {
    doc.paragraph(label.toUpperCase(), {
      font: 'cv-bold', size: 9, color: accent, spaceBefore: 16, spaceAfter: 5, keepWithNext: true,
    });
  };

  // --- header ---
  doc.paragraph(cv.name, { font: 'cv-bold', size: 22, color: accent, spaceAfter: 2 });
  if (cv.title) doc.paragraph(cv.title, { size: 12, color: gray, spaceAfter: 4 });
  const contactBits: string[] = [];
  const c = cv.contact;
  if (c?.email) contactBits.push(c.email);
  if (c?.phone) contactBits.push(c.phone);
  if (c?.location) contactBits.push(c.location);
  for (const l of c?.links ?? []) contactBits.push(l.label);
  if (contactBits.length) {
    doc.paragraph(contactBits.join('  ·  '), { size: 9, color: gray, spaceAfter: 2 });
  }

  if (cv.summary) {
    section('Summary');
    doc.paragraph(cv.summary, { size: 10 });
  }

  if (cv.experience?.length) {
    section('Experience');
    for (const e of cv.experience) {
      doc.table({
        columns: ['*', 'auto'],
        columnAlign: ['left', 'right'],
        header: 1,
        rows: [[e.role, dateRange(e.start, e.end)]],
        style: {
          size: 10.5, borders: 'none', padding: 0, headerFill: null,
          headerFont: 'cv-bold', headerColor: '#111827',
        },
        keepWithNext: true,
      });
      doc.paragraph([e.org, e.location].filter(Boolean).join(' — '), {
        size: 9.5, color: gray, spaceAfter: 3, keepWithNext: (e.highlights?.length ?? 0) > 0,
      });
      for (const [i, h] of (e.highlights ?? []).entries()) {
        doc.paragraph(`•  ${h}`, {
          size: 10, indent: 10, spaceAfter: 2,
          keepWithNext: i < e.highlights!.length - 1,
        });
      }
      doc.spacer(4);
    }
  }

  if (cv.education?.length) {
    section('Education');
    for (const e of cv.education) {
      doc.table({
        columns: ['*', 'auto'],
        columnAlign: ['left', 'right'],
        header: 1,
        rows: [[e.degree, e.start || e.end ? dateRange(e.start, e.end) : '']],
        style: {
          size: 10.5, borders: 'none', padding: 0, headerFill: null,
          headerFont: 'cv-bold', headerColor: '#111827',
        },
        keepWithNext: true,
      });
      doc.paragraph([e.institution, e.location].filter(Boolean).join(' — '), {
        size: 9.5, color: gray, spaceAfter: 3, keepWithNext: (e.details?.length ?? 0) > 0,
      });
      for (const d of e.details ?? []) {
        doc.paragraph(`•  ${d}`, { size: 10, indent: 10, spaceAfter: 2 });
      }
      doc.spacer(4);
    }
  }

  if (cv.skills?.length) {
    section('Skills');
    for (const s of cv.skills) {
      doc.paragraph([
        { text: `${s.category}: `, font: 'cv-bold' },
        { text: s.items.join(', ') },
      ], { size: 10, spaceAfter: 3 });
    }
  }

  if (cv.languages?.length) {
    section('Languages');
    doc.paragraph(cv.languages.map((l) => `${l.name} (${l.level})`).join('  ·  '), { size: 10 });
  }

  if (cv.certifications?.length) {
    section('Certifications');
    for (const cert of cv.certifications) {
      doc.paragraph(`•  ${[[cert.name, cert.issuer].filter(Boolean).join(' — '), cert.year].filter(Boolean).join(', ')}`, {
        size: 10, indent: 10, spaceAfter: 2,
      });
    }
  }

  attachPayload(doc, 'cv', 1, cv);
  return { doc };
}
