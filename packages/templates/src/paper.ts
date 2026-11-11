/**
 * Academic paper template: title/authors/abstract/numbered sections/references
 * → LayoutDocument.
 *
 * Single-column (two-column needs multi-flow layout — a later core feature).
 * Footnotes via TextRun.note, citations as plain markers ([1]); references
 * use a hanging indent. PDF/A mode recommended for archival (arXiv-style).
 */
import { LayoutDocument, type TextRun } from '@xpdf/document';
import { attachPayload, type TemplateTheme } from './payload.js';

export interface PaperSection {
  heading: string;
  /** 1 = section, 2 = subsection. Default 1. */
  level?: 1 | 2;
  paragraphs: Array<string | TextRun[]>;
}

export interface Paper {
  title: string;
  authors: Array<{ name: string; affiliation?: string; email?: string }>;
  abstract: string;
  keywords?: string[];
  sections: PaperSection[];
  /** Reference entries, cited as [1], [2], ... in order. */
  references?: string[];
  acknowledgements?: string;
}

export interface PaperDocumentResult {
  doc: LayoutDocument;
}

export function validatePaper(p: Paper): string[] {
  const errors: string[] = [];
  if (!p.title?.trim()) errors.push('title is required');
  if (!p.authors?.length) errors.push('at least one author is required');
  for (const [i, a] of (p.authors ?? []).entries()) {
    if (!a.name?.trim()) errors.push(`authors[${i}]: name is required`);
  }
  if (!p.abstract?.trim()) errors.push('abstract is required');
  if (!p.sections?.length) errors.push('at least one section is required');
  for (const [i, s] of (p.sections ?? []).entries()) {
    if (!s.heading?.trim()) errors.push(`sections[${i}]: heading is required`);
    if (!s.paragraphs?.length) errors.push(`sections[${i}]: at least one paragraph is required`);
  }
  return errors;
}

export function paperDocument(paper: Paper, theme: TemplateTheme = {}): PaperDocumentResult {
  const errors = validatePaper(paper);
  if (errors.length) throw new Error(`invalid paper:\n  - ${errors.join('\n  - ')}`);
  const accent = theme.accent ?? '#111111';
  const gray = '#4b5563';

  const doc = new LayoutDocument({
    pageSize: 'A4',
    margins: { top: 72, bottom: 72, left: 72, right: 72 },
    title: paper.title,
    author: paper.authors.map((a) => a.name).join(', '),
    defaultStyle: { font: 'paper-body', size: 10.5, lineHeight: 1.45 },
    footer: (page, ctx) => {
      page.text(String(ctx.page), 0, 812, {
        font: ctx.font('paper-body'), size: 9, color: '#9ca3af', align: 'center', width: page.width,
      });
    },
    ...(theme.pdfa !== undefined ? { pdfa: theme.pdfa } : {}),
  });
  doc.font('paper-body', theme.font ?? 'Times-Roman');
  doc.font('paper-bold', theme.boldFont ?? 'Times-Bold');

  // --- title block ---
  doc.paragraph(paper.title, { font: 'paper-bold', size: 17, align: 'center', spaceAfter: 10 });
  doc.paragraph(paper.authors.map((a) => a.name).join(',  '), {
    size: 11, align: 'center', spaceAfter: 3,
  });
  const affiliations = [...new Set(paper.authors.map((a) => a.affiliation).filter(Boolean))];
  if (affiliations.length) {
    doc.paragraph(affiliations.join('  ·  '), { size: 9.5, color: gray, align: 'center', spaceAfter: 2 });
  }
  const emails = paper.authors.map((a) => a.email).filter(Boolean);
  if (emails.length) {
    doc.paragraph(emails.join(',  '), { size: 9.5, color: gray, align: 'center' });
  }

  // --- abstract ---
  doc.spacer(14);
  doc.paragraph([
    { text: 'Abstract — ', font: 'paper-bold', size: 9.5 },
    { text: paper.abstract, size: 9.5 },
  ], { indent: 30, align: 'justify', spaceAfter: 6 });
  if (paper.keywords?.length) {
    doc.paragraph([
      { text: 'Keywords — ', font: 'paper-bold', size: 9.5 },
      { text: paper.keywords.join(', '), size: 9.5 },
    ], { indent: 30, spaceAfter: 4 });
  }

  // --- numbered sections ---
  let h1 = 0;
  let h2 = 0;
  for (const s of paper.sections) {
    const level = s.level ?? 1;
    if (level === 1) {
      h1 += 1; h2 = 0;
      doc.paragraph(`${h1}.  ${s.heading}`, {
        font: 'paper-bold', size: 12.5, spaceBefore: 16, spaceAfter: 5, keepWithNext: true,
      });
    } else {
      h2 += 1;
      doc.paragraph(`${h1}.${h2}  ${s.heading}`, {
        font: 'paper-bold', size: 11, spaceBefore: 10, spaceAfter: 4, keepWithNext: true,
      });
    }
    for (const p of s.paragraphs) {
      doc.paragraph(p, { size: 10.5, align: 'justify', spaceAfter: 6 });
    }
  }

  if (paper.acknowledgements) {
    doc.paragraph('Acknowledgements', {
      font: 'paper-bold', size: 12.5, spaceBefore: 16, spaceAfter: 5, keepWithNext: true,
    });
    doc.paragraph(paper.acknowledgements, { size: 10.5, align: 'justify' });
  }

  if (paper.references?.length) {
    doc.paragraph('References', {
      font: 'paper-bold', size: 12.5, spaceBefore: 16, spaceAfter: 5, keepWithNext: true,
    });
    for (const [i, ref] of paper.references.entries()) {
      // hanging indent: [n] sticks out to the left
      doc.paragraph(`[${i + 1}]  ${ref}`, {
        size: 9.5, indent: 24, firstLineIndent: -24, spaceAfter: 3,
      });
    }
  }

  attachPayload(doc, 'paper', 1, paper);
  return { doc };
}
