/**
 * xpdf engine bridge for the browser playground.
 *
 * The same packages that run in Node run unchanged in the browser — the
 * engine has zero runtime dependencies. This module turns editor text into
 * PDF bytes per template, and restores editor text back from a dropped PDF
 * via the living document.json payload.
 */
import { extractAttachment } from '@xpdf/core';
import { applyFacturX, type Invoice } from '@xpdf/einvoice';
import {
  invoiceDocument, cvDocument, reportDocument, letterDocument, paperDocument,
  screenplayDocument,
} from '@xpdf/templates';

export type TemplateId = 'invoice' | 'cv' | 'report' | 'letter' | 'paper' | 'screenplay';

export const TEMPLATE_META: Record<TemplateId, { label: string; format: 'json' | 'fountain'; file: string; hint: string }> = {
  invoice: { label: 'Invoice', format: 'json', file: 'invoice.pdf', hint: 'EN 16931 model → PDF/A-3B + Factur-X XML' },
  cv: { label: 'CV', format: 'json', file: 'cv.pdf', hint: 'Structured career data → classic résumé' },
  report: { label: 'Report', format: 'json', file: 'report.pdf', hint: 'Title page, numbered sections, footnotes' },
  letter: { label: 'Letter', format: 'json', file: 'letter.pdf', hint: 'International business-letter layout' },
  paper: { label: 'Paper', format: 'json', file: 'paper.pdf', hint: 'Abstract, sections, references, footnotes' },
  screenplay: { label: 'Screenplay', format: 'fountain', file: 'screenplay.pdf', hint: 'Fountain → MORE/CONT’D, dual dialogue' },
};

export interface FontAssets {
  regular: Uint8Array;
  bold: Uint8Array;
}

export async function loadFonts(): Promise<FontAssets> {
  const [r, b] = await Promise.all([
    fetch('./fonts/Ubuntu-R.ttf').then((res) => res.arrayBuffer()),
    fetch('./fonts/Ubuntu-B.ttf').then((res) => res.arrayBuffer()),
  ]);
  return { regular: new Uint8Array(r), bold: new Uint8Array(b) };
}

/** Build PDF bytes from editor text. Throws with a readable message on bad input. */
export function buildTemplate(id: TemplateId, source: string, fonts: FontAssets | null): Uint8Array {
  switch (id) {
    case 'invoice': {
      const inv = JSON.parse(source) as Invoice;
      const theme = fonts
        ? { font: fonts.regular, boldFont: fonts.bold, pdfa: '3B' as const }
        : {};
      const { doc } = invoiceDocument(inv, theme);
      applyFacturX(doc, inv); // attaches factur-x.xml; totals from the same source
      return doc.build();
    }
    case 'cv':
      return cvDocument(JSON.parse(source)).doc.build();
    case 'report':
      return reportDocument(JSON.parse(source)).doc.build();
    case 'letter':
      return letterDocument(JSON.parse(source)).doc.build();
    case 'paper':
      return paperDocument(JSON.parse(source)).doc.build();
    case 'screenplay':
      return screenplayDocument(source).doc.build();
  }
}

export interface RestoredDocument {
  type: TemplateId;
  editorText: string;
}

/**
 * The living-PDF moment: drag a generated file back in and recover its
 * editable source from the embedded document.json payload.
 */
export function restoreFromPdf(bytes: Uint8Array): RestoredDocument {
  const payloadBytes = extractAttachment(bytes, 'document.json');
  if (!payloadBytes) {
    throw new Error('No document.json payload found — this PDF was not made by xpdf.');
  }
  const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as {
    type: string;
    version: number;
    data: unknown;
  };
  switch (payload.type) {
    case 'invoice':
    case 'cv':
    case 'report':
    case 'letter':
    case 'paper':
      return { type: payload.type, editorText: JSON.stringify(payload.data, null, 2) };
    case 'screenplay': {
      const fountain = (payload.data as { fountain?: string })?.fountain;
      if (typeof fountain !== 'string') throw new Error('Screenplay payload missing its Fountain source.');
      return { type: 'screenplay', editorText: fountain };
    }
    default:
      throw new Error(`Unknown xpdf payload type: ${payload.type}`);
  }
}
