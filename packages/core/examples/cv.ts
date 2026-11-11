/**
 * Example: a professional one-page CV with @xpdf/core.
 * Same writer, different document type — the pattern Phase 3 turns into templates.
 *
 * Run: npx tsx examples/cv.ts  →  writes examples/cv.pdf
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Document, getFontMetrics } from '../src/index.js';

const ACCENT = '#1e40af';
const INK = '#111827';
const MUTED = '#6b7280';
const RULE = '#e5e7eb';

const cv = {
  name: 'Ada Lovelace',
  title: 'Computing Engineer & Analytical Engine Specialist',
  contact: ['ada@analytical.engineer', '+44 20 7946 0958', 'London, UK', 'github.com/ada-lovelace'],
  summary:
    'Pioneering engineer with 15+ years of experience in algorithmic computation, ' +
    'mechanical computing systems, and the translation of mathematical methods into ' +
    'executable machine processes. Author of the first published algorithm intended ' +
    'for machine execution.',
  experience: [
    {
      role: 'Principal Analyst',
      org: 'Analytical Engine Project, C. Babbage',
      period: '1842 — 1852',
      points: [
        'Designed the Bernoulli number computation engine — regarded as the first computer program',
        'Developed looping and branching constructs for general-purpose calculation',
        'Documented the Engine\'s capabilities beyond numerical calculation, incl. symbolic composition',
      ],
    },
    {
      role: 'Mathematical Translator & Annotator',
      org: 'L. F. Menabrea Memoir Project',
      period: '1840 — 1843',
      points: [
        'Translated and tripled the canonical memoir on the Analytical Engine',
        'Added Notes A–G, establishing the conceptual foundation of software',
      ],
    },
  ],
  education: [
    { degree: 'Private tutorship in Mathematics & Logic', org: 'A. De Morgan, University of London', period: '1829 — 1840' },
  ],
  skills: ['Algorithm design', 'Analytical engines', 'Mathematical notation', 'Technical writing', 'French-English translation'],
};

const doc = new Document({
  title: `CV — ${cv.name}`,
  author: cv.name,
  subject: 'Curriculum Vitae',
  keywords: ['cv', 'resume', 'xpdf'],
});

const page = doc.addPage();
const M = 50;
const W = 595.28;
const R = W - M;
let y = 0;

// header band
page.rect(0, 0, W, 108, ACCENT);
page.text(cv.name, M, 44, { font: 'Times-Bold', size: 26, color: '#ffffff' });
page.text(cv.title, M, 68, { size: 12.5, color: '#dbeafe' });
page.text(cv.contact.join('   ·   '), M, 90, { size: 8.5, color: '#bfdbfe' });
y = 136;

const section = (title: string) => {
  page.text(title.toUpperCase(), M, y, { font: 'Helvetica-Bold', size: 9, color: ACCENT, charSpacing: 1.2 });
  page.line(M, y + 6, R, y + 6, RULE, 0.8);
  y += 24;
};

// summary
section('Summary');
for (const line of wrap(cv.summary, 'Helvetica', 9.5, R - M)) {
  page.text(line, M, y, { size: 9.5, color: INK });
  y += 13.5;
}
y += 14;

// experience
section('Experience');
for (const job of cv.experience) {
  page.text(job.role, M, y, { font: 'Helvetica-Bold', size: 11, color: INK });
  page.text(job.period, M, y, { size: 9, color: MUTED, align: 'right', width: R - M });
  y += 14;
  page.text(job.org, M, y, { size: 9.5, color: MUTED });
  y += 16;
  for (const pt of job.points) {
    for (const [i, line] of wrap(pt, 'Helvetica', 9.5, R - M - 14).entries()) {
      if (i === 0) page.text('\u2022', M + 4, y, { size: 9.5, color: ACCENT });
      page.text(line, M + 14, y, { size: 9.5, color: INK });
      y += 13.5;
    }
  }
  y += 12;
}

// education
section('Education');
for (const ed of cv.education) {
  page.text(ed.degree, M, y, { font: 'Helvetica-Bold', size: 10.5, color: INK });
  page.text(ed.period, M, y, { size: 9, color: MUTED, align: 'right', width: R - M });
  y += 14;
  page.text(ed.org, M, y, { size: 9.5, color: MUTED });
  y += 18;
}

// skills
section('Skills');
const chipPad = 8;
let cx = M;
const cy = y;
for (const skill of cv.skills) {
  const tw = getFontMetrics('Helvetica').widthAt(skill, 8.5);
  const w = tw + chipPad * 2;
  if (cx + w > R) break;
  page.rect(cx, cy - 9, w, 17, '#eff6ff');
  page.text(skill, cx + chipPad, y + 3.5, { size: 8.5, color: ACCENT });
  cx += w + 6;
}

// footer link
const label = 'adacv.dev';
page.text(label, M, 812, { size: 8.5, color: '#2563eb' });
page.link('https://example.com', M, 804, getFontMetrics('Helvetica').widthAt(label, 8.5), 10, { underline: '#2563eb' });

doc.setOutlines([
  { title: cv.name, page, y: 0 },
  { title: 'Experience', page, y: 200 },
  { title: 'Education', page, y: 500 },
]);

doc.attach(
  'document.json',
  new TextEncoder().encode(JSON.stringify({ spec: 'xpdf:1', type: 'cv', data: cv }, null, 2)),
  { mime: 'application/json', description: 'xpdf source document' },
);

const out = join(dirname(fileURLToPath(import.meta.url)), 'cv.pdf');
writeFileSync(out, doc.build());
console.log(`Wrote ${out}`);

/** Greedy word wrap using AFM metrics. */
function wrap(text: string, font: 'Helvetica', size: number, maxW: number): string[] {
  const m = getFontMetrics(font);
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const joined = line ? `${line} ${word}` : word;
    if (!line || m.widthAt(joined, size) <= maxW) line = joined;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
