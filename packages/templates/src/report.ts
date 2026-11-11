/**
 * Report template: titled, numbered sections with rich blocks → LayoutDocument.
 *
 * Title page + flowing body; sections auto-number (1, 1.1) by level.
 * Footnotes ride on TextRun.note (fixpoint-resolved by the paginator);
 * page numbers come from a render-time furniture footer.
 */
import { LayoutDocument, type TextRun, type TableDef } from '@xpdf/document';
import { attachPayload, type TemplateTheme } from './payload.js';

export type ReportBlock =
  | { type: 'paragraph'; text: string | TextRun[] }
  | { type: 'list'; items: Array<string | TextRun[]>; ordered?: boolean }
  | { type: 'table'; columns: TableDef['columns']; rows: string[][]; header?: number }
  | { type: 'image'; jpeg: Uint8Array; width: number; caption?: string }
  | { type: 'quote'; text: string; source?: string };

export interface ReportSection {
  heading: string;
  /** 1 = top-level section, 2 = subsection. Default 1. */
  level?: 1 | 2;
  blocks: ReportBlock[];
}

export interface Report {
  title: string;
  subtitle?: string;
  author?: string;
  affiliation?: string;
  /** Display string (ISO or preformatted). */
  date?: string;
  abstract?: string;
  sections: ReportSection[];
}

export interface ReportTheme extends TemplateTheme {
  /** Footer with "Page X of Y" (default true). */
  pageNumbers?: boolean;
}

export interface ReportDocumentResult {
  doc: LayoutDocument;
}

export function validateReport(r: Report): string[] {
  const errors: string[] = [];
  if (!r.title?.trim()) errors.push('title is required');
  if (!r.sections?.length) errors.push('at least one section is required');
  for (const [i, s] of (r.sections ?? []).entries()) {
    if (!s.heading?.trim()) errors.push(`sections[${i}]: heading is required`);
    if (!s.blocks?.length) errors.push(`sections[${i}]: at least one block is required`);
  }
  return errors;
}

export function reportDocument(report: Report, theme: ReportTheme = {}): ReportDocumentResult {
  const errors = validateReport(report);
  if (errors.length) throw new Error(`invalid report:\n  - ${errors.join('\n  - ')}`);
  const accent = theme.accent ?? '#0f3d63';
  const gray = '#4b5563';
  const pageNumbers = theme.pageNumbers ?? true;

  const doc = new LayoutDocument({
    pageSize: 'A4',
    margins: { top: 64, bottom: 64, left: 64, right: 64 },
    title: report.title,
    ...(report.author !== undefined ? { author: report.author } : {}),
    defaultStyle: { font: 'report-body', size: 10.5, lineHeight: 1.4 },
    ...(theme.pdfa !== undefined ? { pdfa: theme.pdfa } : {}),
    ...(pageNumbers
      ? {
          footer: (page, ctx) => {
            page.text(`Page ${ctx.page} of ${ctx.pages}`, 0, 826, {
              font: ctx.font('report-body'), size: 8, color: '#9ca3af', align: 'center', width: page.width,
            });
          },
        }
      : {}),
  });
  doc.font('report-body', theme.font ?? 'Helvetica');
  doc.font('report-bold', theme.boldFont ?? 'Helvetica-Bold');

  // --- title page ---
  doc.spacer(180);
  doc.paragraph(report.title, { font: 'report-bold', size: 26, color: accent, align: 'center', spaceAfter: 8 });
  if (report.subtitle) {
    doc.paragraph(report.subtitle, { size: 14, color: gray, align: 'center', spaceAfter: 8 });
  }
  doc.spacer(24);
  if (report.author) {
    doc.paragraph(report.author, { font: 'report-bold', size: 12, align: 'center', spaceAfter: 2 });
  }
  if (report.affiliation) {
    doc.paragraph(report.affiliation, { size: 10.5, color: gray, align: 'center', spaceAfter: 2 });
  }
  if (report.date) {
    doc.paragraph(report.date, { size: 10.5, color: gray, align: 'center' });
  }
  if (report.abstract) {
    doc.spacer(28);
    doc.paragraph([
      { text: 'Abstract. ', font: 'report-bold' },
      { text: report.abstract },
    ], { size: 10, color: '#374151', indent: 36 });
  }
  doc.pageBreak();

  // --- numbered sections ---
  let h1 = 0;
  let h2 = 0;
  for (const s of report.sections) {
    const level = s.level ?? 1;
    let label: string;
    if (level === 1) {
      h1 += 1; h2 = 0;
      label = `${h1}.  ${s.heading}`;
      doc.paragraph(label, {
        font: 'report-bold', size: 15, color: accent, spaceBefore: 18, spaceAfter: 7, keepWithNext: true,
      });
    } else {
      h2 += 1;
      label = `${h1}.${h2}  ${s.heading}`;
      doc.paragraph(label, {
        font: 'report-bold', size: 12, color: accent, spaceBefore: 12, spaceAfter: 5, keepWithNext: true,
      });
    }

    for (const b of s.blocks) {
      switch (b.type) {
        case 'paragraph':
          doc.paragraph(b.text, { size: 10.5, spaceAfter: 6, align: 'justify' });
          break;
        case 'list':
          for (const [i, item] of b.items.entries()) {
            const marker = b.ordered ? `${i + 1}.  ` : '•  ';
            const runs = typeof item === 'string' ? marker + item : [{ text: marker }, ...item];
            doc.paragraph(runs, { size: 10.5, indent: 14, spaceAfter: 3 });
          }
          doc.spacer(3);
          break;
        case 'table':
          doc.table({
            columns: b.columns,
            rows: b.rows,
            ...(b.header !== undefined ? { header: b.header } : {}),
            style: {
              size: 9.5, padding: 4, borders: 'horizontal', borderColor: '#e5e7eb',
              headerFont: 'report-bold', headerFill: '#f3f4f6',
            },
          });
          doc.spacer(6);
          break;
        case 'image':
          doc.image(b.jpeg, { width: b.width, align: 'center', keepTogether: true });
          if (b.caption) {
            doc.paragraph(b.caption, { size: 9, color: gray, align: 'center', spaceBefore: 3, spaceAfter: 6 });
          } else {
            doc.spacer(6);
          }
          break;
        case 'quote':
          doc.paragraph(b.text, {
            size: 10.5, indent: 28, color: '#374151', spaceBefore: 4, spaceAfter: b.source ? 2 : 6,
          });
          if (b.source) {
            doc.paragraph(`— ${b.source}`, { size: 9.5, color: gray, indent: 28, spaceAfter: 6 });
          }
          break;
      }
    }
  }

  attachPayload(doc, 'report', 1, report);
  return { doc };
}
