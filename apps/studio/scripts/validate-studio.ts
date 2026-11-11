/**
 * Headless functional validation of the Studio engine bridge:
 * every template builds, and every built PDF restores its editor source.
 * Run: npx tsx scripts/validate-studio.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildTemplate, restoreFromPdf, TEMPLATE_META, type TemplateId } from '../src/lib/engine';
import { SAMPLES } from '../src/lib/samples';

const here = dirname(fileURLToPath(import.meta.url));
const fonts = {
  regular: new Uint8Array(readFileSync(join(here, '../public/fonts/Ubuntu-R.ttf'))),
  bold: new Uint8Array(readFileSync(join(here, '../public/fonts/Ubuntu-B.ttf'))),
};

const latin1 = (u: Uint8Array) => [...u].map((b) => String.fromCharCode(b)).join('');

for (const id of Object.keys(TEMPLATE_META) as TemplateId[]) {
  const source = SAMPLES[id];
  const bytes = buildTemplate(id, source, fonts);
  if (!latin1(bytes).startsWith('%PDF-1.7')) throw new Error(`${id}: not a PDF`);

  // the living round-trip: build → restore → editor text must come back identical
  const restored = restoreFromPdf(bytes);
  if (restored.type !== id) throw new Error(`${id}: restored type ${restored.type}`);
  if (restored.editorText !== source) {
    // JSON payloads round-trip semantically; compare canonical forms
    const a = JSON.stringify(JSON.parse(restored.editorText));
    const b = JSON.stringify(JSON.parse(source));
    if (a !== b) throw new Error(`${id}: round-trip mismatch`);
  }

  // and the restored text must rebuild byte-identically (determinism)
  const rebuilt = buildTemplate(id, restored.editorText, fonts);
  if (!Buffer.from(bytes).equals(Buffer.from(rebuilt))) {
    throw new Error(`${id}: rebuild after restore is not byte-identical`);
  }
  console.log(`${id.padEnd(10)} OK  ${bytes.length.toLocaleString('en-US')} bytes, restore + rebuild identical`);
}

// negative path: a foreign PDF has no payload
const foreign = buildTemplate('letter', SAMPLES.letter, null);
const stripped = foreign.slice(0, foreign.length); // same bytes, but we test with a pdf lacking payload below
try {
  // craft: any PDF without document.json — use core directly
  const { Document } = await import('@xpdf/core');
  const doc = new Document();
  const p = doc.addPage(595.28, 841.89);
  p.text('hello', 72, 72);
  restoreFromPdf(doc.build());
  throw new Error('foreign PDF should have thrown');
} catch (e) {
  if (!(e instanceof Error) || !/not made by xpdf/.test(e.message)) throw e;
  console.log('foreign PDF  OK  (clear error, no crash)');
}
void stripped;
console.log('\nALL STUDIO ENGINE CHECKS PASSED');
