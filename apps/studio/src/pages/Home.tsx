import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileUp, FileText, RotateCcw, CircleCheck, CircleAlert } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  buildTemplate, loadFonts, restoreFromPdf,
  TEMPLATE_META, type FontAssets, type TemplateId,
} from '@/lib/engine';
import { SAMPLES } from '@/lib/samples';

const TABS = Object.keys(TEMPLATE_META) as TemplateId[];

export default function Home() {
  const [tab, setTab] = useState<TemplateId>('invoice');
  const [texts, setTexts] = useState<Record<TemplateId, string>>({ ...SAMPLES });
  const [fonts, setFonts] = useState<FontAssets | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [restored, setRestored] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const text = texts[tab];
  const generation = useRef(0);

  useEffect(() => {
    loadFonts().then(setFonts).catch(() => setFonts(null));
  }, []);

  // rebuild on edit (debounced) — latest generation wins
  useEffect(() => {
    const gen = ++generation.current;
    setBuilding(true);
    const timer = setTimeout(() => {
      try {
        const bytes = buildTemplate(tab, text, fonts);
        if (generation.current !== gen) return;
        const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' }));
        setPdfUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
        setPdfBytes(bytes);
        setError(null);
      } catch (e) {
        if (generation.current !== gen) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (generation.current === gen) setBuilding(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [tab, text, fonts]);

  const edit = useCallback((value: string) => {
    setTexts((prev) => ({ ...prev, [tab]: value }));
    setRestored(null);
  }, [tab]);

  const reset = useCallback(() => {
    setTexts((prev) => ({ ...prev, [tab]: SAMPLES[tab] }));
    setRestored(null);
  }, [tab]);

  const download = useCallback(() => {
    if (!pdfBytes) return;
    const url = URL.createObjectURL(new Blob([pdfBytes.buffer as ArrayBuffer], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = TEMPLATE_META[tab].file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, [pdfBytes, tab]);

  // --- the living-PDF drop: restore editor state from a dropped file ---
  const onDrop = useCallback(async (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const restoredDoc = restoreFromPdf(bytes);
      setTab(restoredDoc.type);
      setTexts((prev) => ({ ...prev, [restoredDoc.type]: restoredDoc.editorText }));
      setRestored(`${file.name} → ${TEMPLATE_META[restoredDoc.type].label} source recovered`);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const onDragOver = (e: DragEvent) => { e.preventDefault(); setDragging(true); };
    const onDragLeave = (e: DragEvent) => { if (!e.relatedTarget) setDragging(false); };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [onDrop]);

  const meta = TEMPLATE_META[tab];

  return (
    <div className="flex min-h-screen flex-col bg-neutral-50 text-neutral-900">
      {/* header */}
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <FileText className="h-6 w-6 text-blue-700" />
            <div>
              <h1 className="text-lg font-semibold tracking-tight">xpdf Studio</h1>
              <p className="text-xs text-neutral-500">the living-PDF playground — zero dependencies, byte-deterministic</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">@xpdf/core</Badge>
            <Badge variant="secondary">@xpdf/templates</Badge>
            <Badge variant="outline">running in your browser</Badge>
          </div>
        </div>
      </header>

      {/* tabs */}
      <div className="border-b bg-white">
        <div className="mx-auto max-w-7xl px-6">
          <Tabs value={tab} onValueChange={(v) => { setTab(v as TemplateId); setError(null); }}>
            <TabsList className="h-11 bg-transparent">
              {TABS.map((id) => (
                <TabsTrigger key={id} value={id} className="data-[state=active]:bg-neutral-100">
                  {TEMPLATE_META[id].label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>

      {/* workspace */}
      <main className="mx-auto grid w-full max-w-7xl flex-1 grid-cols-1 gap-4 px-6 py-4 lg:grid-cols-2">
        {/* editor */}
        <section className="flex min-h-[70vh] flex-col rounded-lg border bg-white shadow-sm">
          <div className="flex items-center justify-between px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{meta.format === 'json' ? 'Document data (JSON)' : 'Fountain source'}</span>
              <Badge variant="outline" className="text-[10px]">{meta.hint}</Badge>
            </div>
            <Button variant="ghost" size="sm" onClick={reset} title="Reset to sample">
              <RotateCcw className="mr-1 h-3.5 w-3.5" /> Reset
            </Button>
          </div>
          <Separator />
          <Textarea
            value={text}
            onChange={(e) => edit(e.target.value)}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none rounded-none border-0 font-mono text-[12.5px] leading-relaxed focus-visible:ring-0"
          />
          <Separator />
          <div className="flex items-center gap-2 px-4 py-2 text-xs">
            {error ? (
              <>
                <CircleAlert className="h-3.5 w-3.5 shrink-0 text-red-600" />
                <span className="truncate text-red-700" title={error}>{error}</span>
              </>
            ) : restored ? (
              <>
                <CircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                <span className="text-emerald-700">{restored}</span>
              </>
            ) : (
              <>
                <CircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                <span className="text-neutral-500">
                  {building ? 'rebuilding…' : 'valid — preview is live'}
                </span>
              </>
            )}
            <span className="ml-auto shrink-0 text-neutral-400">{text.length.toLocaleString()} chars</span>
          </div>
        </section>

        {/* preview */}
        <section className="flex min-h-[70vh] flex-col rounded-lg border bg-white shadow-sm">
          <div className="flex items-center justify-between px-4 py-2.5">
            <span className="text-sm font-medium">Preview</span>
            <Button size="sm" onClick={download} disabled={!pdfBytes || !!error}>
              <Download className="mr-1.5 h-3.5 w-3.5" /> Download {meta.file}
            </Button>
          </div>
          <Separator />
          {pdfUrl && !error ? (
            <iframe title="PDF preview" src={pdfUrl} className="min-h-0 flex-1 rounded-b-lg" />
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-neutral-400">
              {error ? 'Fix the document data to restore the preview.' : 'Building preview…'}
            </div>
          )}
        </section>
      </main>

      {/* footer */}
      <footer className="border-t bg-white">
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-6 py-3 text-xs text-neutral-500">
          <FileUp className="h-3.5 w-3.5" />
          <span>
            Every PDF carries its own source as an embedded <code className="rounded bg-neutral-100 px-1">document.json</code>.
            Download one, drag it back in — it is still editable.
          </span>
        </div>
      </footer>

      {/* drop overlay */}
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-blue-700/10 backdrop-blur-[1px]">
          <div className="rounded-xl border-2 border-dashed border-blue-600 bg-white/90 px-10 py-8 text-center shadow-lg">
            <FileUp className="mx-auto mb-2 h-8 w-8 text-blue-700" />
            <p className="font-medium text-blue-900">Drop an xpdf file</p>
            <p className="text-sm text-blue-700">its editable source will be restored</p>
          </div>
        </div>
      )}
    </div>
  );
}
