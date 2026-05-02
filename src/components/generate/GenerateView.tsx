'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Deck } from '@/lib/db/schema';
import { createNote, listDecks } from '@/lib/db/queries';
import { generateNotes, type DraftNote, type GenerateStyle } from '@/lib/ai/generate';
import { proposeClozeMasks } from '@/lib/ai/cloze-place';
import { parseBulk } from '@/lib/authoring/bulk-parse';
import { renderFront, renderRichText } from '@/lib/cloze/parser';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/Tooltip';

const STYLES: Array<{ id: GenerateStyle; label: string }> = [
  { id: 'mcat-mechanism', label: 'Multi-Cloze' },
];

type Mode = 'ai' | 'bulk' | 'cloze-place';

export default function GenerateView() {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [deckId, setDeckId] = useState('');
  const [text, setText] = useState('');
  const [style, setStyle] = useState<GenerateStyle>('mcat-mechanism');
  const [count, setCount] = useState(8);
  const [tagPrefix, setTagPrefix] = useState('');
  const [busy, setBusy] = useState(false);
  const [streamLog, setStreamLog] = useState('');
  const [drafts, setDrafts] = useState<DraftNote[]>([]);
  const [accepted, setAccepted] = useState<Set<number>>(new Set());
  const [savedCount, setSavedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('ai');
  const [parseErrors, setParseErrors] = useState<Array<{ blockIndex: number; reason: string }>>([]);
  const [clozeTargetN, setClozeTargetN] = useState(4);

  useEffect(() => {
    listDecks().then(d => {
      setDecks(d);
      if (d.length > 0) setDeckId(d[0].id);
    });
  }, []);

  const generate = async () => {
    if (!text.trim() || !deckId) return;
    setBusy(true);
    setError(null);
    setStreamLog('');
    setDrafts([]);
    setAccepted(new Set());
    try {
      const result = await generateNotes({
        text: text.trim(),
        style,
        count,
        tagPrefix: tagPrefix.trim() || undefined,
        onChunk: chunk => setStreamLog(s => s + chunk),
      });
      setDrafts(result);
      // Pre-select all drafts; the user can deselect individually.
      setAccepted(new Set(result.map((_, i) => i)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const parseBulkText = () => {
    if (!text.trim() || !deckId) return;
    setError(null);
    const result = parseBulk(text);
    setParseErrors(result.errors.map(e => ({ blockIndex: e.blockIndex, reason: e.reason })));
    if (result.drafts.length === 0 && result.errors.length === 0) {
      setError('No card blocks found. Use the format documented above.');
      return;
    }
    setDrafts(result.drafts);
    setAccepted(new Set(result.drafts.map((_, i) => i)));
  };

  const placeClozes = async () => {
    if (!text.trim() || !deckId) return;
    setBusy(true);
    setError(null);
    setStreamLog('');
    setDrafts([]);
    setAccepted(new Set());
    try {
      const front = await proposeClozeMasks({
        passage: text.trim(),
        targetClozes: clozeTargetN,
        onChunk: chunk => setStreamLog(s => s + chunk),
      });
      const draft: DraftNote = {
        modelId: 'cloze',
        fields: { front, back: '' },
        tags: tagPrefix.trim() ? [tagPrefix.trim()] : [],
      };
      setDrafts([draft]);
      setAccepted(new Set([0]));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (i: number) => {
    setAccepted(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const saveAccepted = async () => {
    let saved = 0;
    for (let i = 0; i < drafts.length; i++) {
      if (!accepted.has(i)) continue;
      const d = drafts[i];
      await createNote({
        deckId,
        fields: d.fields,
        tags: d.tags,
        tier: d.tier,
        modelId: d.modelId,
      });
      saved++;
    }
    setSavedCount(saved);
    setDrafts([]);
    setAccepted(new Set());
    setText('');
    setStreamLog('');
  };

  if (decks.length === 0) {
    return (
      <div className="glass-card rounded-2xl p-8 text-center">
        <p className="text-dark-300 mb-3">You need a deck first.</p>
        <Link href="/decks/new" className="btn-gradient px-5 py-2 rounded-xl text-sm">Create a deck</Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {savedCount > 0 && (
        <div className="glass-card rounded-2xl p-4 border border-saffron-700/30 text-saffron-200 text-sm font-light">
          Saved {savedCount} note{savedCount === 1 ? '' : 's'}.
        </div>
      )}

      {drafts.length === 0 && (
        <div className="glass-card rounded-2xl p-6 space-y-4">
          <div className="flex gap-1 mb-2 flex-wrap">
            {(['ai', 'cloze-place', 'bulk'] as const).map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={
                  mode === m
                    ? 'text-2xs uppercase tracking-widest font-mono px-3 py-1.5 rounded-lg bg-persian-900/30 text-saffron-300'
                    : 'text-2xs uppercase tracking-widest font-mono px-3 py-1.5 rounded-lg text-dark-400 hover:text-dark-100 hover:bg-white/[0.03] transition'
                }
              >
                {m === 'ai' ? 'AI generate' : m === 'cloze-place' ? 'Cloze a passage' : 'Bulk paste'}
              </button>
            ))}
          </div>
          {mode === 'bulk' && (
            <div className="text-xs text-dark-400 font-light bg-dark-800/30 rounded-xl p-3 leading-relaxed">
              Paste blocks of <code className="text-saffron-300 font-mono">{'>'} CARD: v5</code> followed by{' '}
              <code className="text-saffron-300 font-mono">{'>'} Front: …</code> lines (one block per note, blank-line separated).
              Recognized fields: Front, Back, Extra, Mnemonic, Context, Image, Source, Tags, Tier.
            </div>
          )}
          {mode === 'cloze-place' && (
            <div className="text-xs text-dark-400 font-light bg-dark-800/30 rounded-xl p-3 leading-relaxed">
              Paste a short passage. Claude returns it verbatim with{' '}
              <code className="text-saffron-300 font-mono">{'{{c1::…}}'}</code> wrapped around the
              most retrieval-worthy terms. Edit before saving.
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">Deck</div>
              <select
                value={deckId}
                onChange={e => setDeckId(e.target.value)}
                className="w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] cursor-pointer"
              >
                {decks.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            {mode === 'ai' && (
              <label className="block">
                <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">Style</div>
                <select
                  value={style}
                  onChange={e => setStyle(e.target.value as GenerateStyle)}
                  className="w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] cursor-pointer"
                >
                  {STYLES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </label>
            )}
          </div>
          {mode === 'ai' && (
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">Target count</div>
                <input
                  type="number"
                  value={count}
                  min={1}
                  max={50}
                  onChange={e => setCount(parseInt(e.target.value, 10) || 8)}
                  className="w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] font-mono"
                />
              </label>
              <label className="block">
                <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">Tag prefix (optional)</div>
                <input
                  value={tagPrefix}
                  onChange={e => setTagPrefix(e.target.value)}
                  placeholder="bio::ch04::nervous-system"
                  className="w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] font-mono"
                />
              </label>
            </div>
          )}
          {mode === 'cloze-place' && (
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">Number of clozes</div>
                <input
                  type="number"
                  value={clozeTargetN}
                  min={1}
                  max={12}
                  onChange={e => setClozeTargetN(parseInt(e.target.value, 10) || 4)}
                  className="w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] font-mono"
                />
              </label>
              <label className="block">
                <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">Tag prefix (optional)</div>
                <input
                  value={tagPrefix}
                  onChange={e => setTagPrefix(e.target.value)}
                  placeholder="bio::ch04::nervous-system"
                  className="w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] font-mono"
                />
              </label>
            </div>
          )}
          <label className="block">
            <div className="flex items-baseline justify-between mb-1.5">
              <div className="text-2xs uppercase tracking-widest text-dark-400">
                {mode === 'ai' ? 'Source passage' : 'Card blocks'}
              </div>
              {mode !== 'bulk' && <PdfDropButton onText={t => setText(prev => prev ? `${prev}\n\n${t}` : t)} />}
            </div>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              rows={mode === 'bulk' ? 14 : 10}
              placeholder={
                mode === 'ai'
                  ? 'Paste a textbook section, paper excerpt, or your own notes — or drop a PDF.'
                  : '> CARD: v5\n> Front: …\n> Back: …\n> Tags: …'
              }
              className="w-full bg-dark-800/30 rounded-xl px-4 py-3 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] font-mono leading-relaxed"
            />
          </label>
          <div className="flex items-center gap-3">
            <button
              onClick={
                mode === 'ai' ? generate
                : mode === 'cloze-place' ? placeClozes
                : parseBulkText
              }
              disabled={busy || !text.trim() || !deckId}
              className="btn-gradient px-5 py-2 rounded-xl text-sm"
            >
              {mode === 'ai'
                ? (busy ? 'Generating…' : 'Generate')
                : mode === 'cloze-place'
                ? (busy ? 'Placing…' : 'Place clozes')
                : 'Parse blocks'}
            </button>
            {streamLog && busy && (
              <span className="text-2xs text-dark-500 font-mono">
                {streamLog.length} chars streamed
              </span>
            )}
          </div>
          {parseErrors.length > 0 && (
            <div className="text-xs text-crimson-300 font-light pt-2 border-t border-crimson-900/30">
              {parseErrors.length} block{parseErrors.length === 1 ? '' : 's'} skipped (missing Front).
            </div>
          )}
          {error && (
            <div className="text-sm text-crimson-300 font-light pt-2 border-t border-crimson-900/30">
              {error}
            </div>
          )}
        </div>
      )}

      {drafts.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs uppercase tracking-widest text-dark-400">
              Drafts ({drafts.length}) · {accepted.size} accepted
            </h2>
            <div className="flex gap-2">
              <button
                onClick={() => setAccepted(new Set(drafts.map((_, i) => i)))}
                className="text-2xs uppercase tracking-widest text-dark-400 hover:text-dark-100 transition"
              >
                Accept all
              </button>
              <button
                onClick={() => setAccepted(new Set())}
                className="text-2xs uppercase tracking-widest text-dark-400 hover:text-dark-100 transition"
              >
                Reject all
              </button>
              <button
                onClick={() => setDrafts([])}
                className="text-2xs uppercase tracking-widest text-dark-400 hover:text-dark-100 transition"
              >
                Discard
              </button>
            </div>
          </div>
          <div className="space-y-3">
            {drafts.map((d, i) => {
              const isAccepted = accepted.has(i);
              const front = d.modelId === 'cloze'
                ? renderFront(d.fields.front, 1)
                : renderRichText(d.fields.front);
              return (
                <div
                  key={i}
                  className={cn(
                    'glass-card rounded-2xl p-5 border transition cursor-pointer',
                    isAccepted ? 'border-saffron-700/40' : 'border-dark-700 opacity-60',
                  )}
                  onClick={() => toggle(i)}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={isAccepted}
                      onChange={() => toggle(i)}
                      className="mt-1 accent-saffron-400"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-2xs uppercase tracking-widest text-dark-500 mb-2 font-mono">
                        {d.modelId} · {(d.tags ?? []).join(' ')}
                      </div>
                      <div
                        className="card-prose text-base font-light"
                        dangerouslySetInnerHTML={{ __html: front }}
                      />
                      {d.fields.back && (
                        <div
                          className="card-prose text-sm font-light text-dark-300 mt-2 pt-2 border-t border-white/[0.04]"
                          dangerouslySetInnerHTML={{ __html: renderRichText(d.fields.back) }}
                        />
                      )}
                      {d.fields.extra && (
                        <div className="mt-2 text-2xs text-dark-500 italic line-clamp-3">
                          {d.fields.extra}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={saveAccepted}
              disabled={accepted.size === 0}
              className="btn-gradient px-5 py-2 rounded-xl text-sm"
            >
              Save {accepted.size} note{accepted.size === 1 ? '' : 's'}
            </button>
            <button
              onClick={() => setDrafts([])}
              className="px-4 py-2 rounded-xl text-sm text-dark-300 hover:text-dark-100 transition"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Small inline file picker that extracts text from a dropped PDF and hands
 * it back to the parent so it can append to its passage textarea. The
 * pdfjs worker is lazy-loaded on first use so the bundle stays slim.
 */
function PdfDropButton({ onText }: { onText: (t: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const { extractPdfText } = await import('@/lib/pdf/extract');
      const text = await extractPdfText(file);
      if (!text.trim()) throw new Error('No text layer in this PDF.');
      onText(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Tooltip content="Extract text from a PDF and append it to the passage above">
      <label className="text-2xs uppercase tracking-widest font-mono text-saffron-300 hover:text-saffron-200 transition cursor-pointer">
        {busy ? 'Reading PDF…' : error ? `PDF error: ${error}` : '+ PDF'}
        <input
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={e => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.currentTarget.value = '';
          }}
        />
      </label>
    </Tooltip>
  );
}
