'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { createSource, deleteSource, listSources } from '@/lib/db/queries';
import type { Source } from '@/lib/db/schema';
import { extractPdfText } from '@/lib/pdf/extract';
import { cn } from '@/lib/utils';

/**
 * Sources list + inline new-source form. Two paths in:
 *   - Paste raw text (with a title)
 *   - Drop a PDF (text layer is extracted)
 */
export default function SourceList() {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => setSources(await listSources());
  useEffect(() => { refresh(); }, []);

  const submit = async () => {
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createSource({
        title: title.trim() || body.split('\n', 1)[0].slice(0, 60) || 'Untitled',
        kind: 'paste',
        body: body.trim(),
      });
      setTitle('');
      setBody('');
      setAdding(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDropPdf = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const text = await extractPdfText(file);
      if (!text.trim()) throw new Error('No text layer in this PDF.');
      await createSource({
        title: file.name.replace(/\.pdf$/i, ''),
        kind: 'pdf',
        body: text,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this source and all its highlights? Cards already promoted are kept.')) return;
    await deleteSource(id);
    await refresh();
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <button
          onClick={() => setAdding(v => !v)}
          className="btn-gradient px-4 py-2 rounded-xl text-sm"
        >
          {adding ? 'Cancel' : '+ New source'}
        </button>
        <label className="px-4 py-2 rounded-xl text-sm text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition border border-white/[0.06] cursor-pointer">
          <input
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) onDropPdf(f);
              e.currentTarget.value = '';
            }}
          />
          {busy ? 'Reading…' : 'Drop PDF'}
        </label>
        {error && <span className="text-2xs text-crimson-300 font-light">{error}</span>}
      </div>

      {adding && (
        <div className="glass-card rounded-2xl p-5 space-y-3">
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Title (optional)"
            className="w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border border-white/[0.04]"
          />
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={10}
            placeholder="Paste a passage, chapter, or paper excerpt…"
            className="w-full bg-dark-800/30 rounded-xl px-4 py-3 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] font-mono leading-relaxed"
          />
          <button
            onClick={submit}
            disabled={busy || !body.trim()}
            className="btn-gradient px-5 py-2 rounded-xl text-sm"
          >
            {busy ? 'Saving…' : 'Save source'}
          </button>
        </div>
      )}

      {sources === null ? (
        <div className="glass-card rounded-2xl h-32 loading-shimmer" />
      ) : sources.length === 0 ? (
        <div className="glass-card rounded-2xl p-8 text-center text-dark-400">
          No sources yet. Paste a passage or drop a PDF to start.
        </div>
      ) : (
        <div className="glass-card rounded-2xl divide-y divide-white/[0.04]">
          {sources.map(s => (
            <SourceRow key={s.id} source={s} onDelete={() => remove(s.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function SourceRow({ source, onDelete }: { source: Source; onDelete: () => void }) {
  const wordCount = source.body.split(/\s+/).filter(Boolean).length;
  const progressPct = Math.round(source.progress * 100);
  return (
    <div className="px-5 py-3 flex items-center justify-between gap-4">
      <Link href={`/read/${source.id}`} className="flex-1 min-w-0">
        <div className="text-sm text-dark-100 font-light line-clamp-1">{source.title}</div>
        <div className="text-2xs text-dark-500 font-mono mt-1 flex items-center gap-3">
          <span>{source.kind}</span>
          <span>{wordCount.toLocaleString()} words</span>
          {progressPct > 0 && <span>{progressPct}% read</span>}
        </div>
      </Link>
      <div className="flex items-center gap-2 shrink-0">
        <Link
          href={`/study/${source.deckId}`}
          className="text-2xs uppercase tracking-widest text-saffron-300 hover:text-saffron-200 transition px-2 py-1"
        >
          Study
        </Link>
        <button
          onClick={onDelete}
          className={cn(
            'text-2xs uppercase tracking-widest transition px-2 py-1',
            'text-dark-500 hover:text-crimson-300',
          )}
        >
          Delete
        </button>
      </div>
    </div>
  );
}
