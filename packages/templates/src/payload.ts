/**
 * Shared living-payload helper: every xpdf template embeds its own source
 * data as document.json, so the produced PDF can be dragged back into any
 * xpdf tool and edited again. PDF/A-3 safe (AFRelationship 'Source').
 */
import type { LayoutDocument, FontSource } from '@xpdf/document';

export function attachPayload(doc: LayoutDocument, type: string, version: number, data: unknown): void {
  doc.attach('document.json', new TextEncoder().encode(JSON.stringify({ type, version, data }, null, 2)), {
    mime: 'application/json',
    description: 'xpdf source document (round-trip payload)',
    afRelationship: 'Source',
  });
}

export interface TemplateTheme {
  /** Brand accent for headings and rules. */
  accent?: string;
  /** Body font: base-14 name or TTF bytes (TTF required for PDF/A). */
  font?: FontSource;
  /** Bold/emphasis font. */
  boldFont?: FontSource;
  /** PDF/A-3 mode ('3B' | '3U') for archival output. */
  pdfa?: '3B' | '3U';
}
