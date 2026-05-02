'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  findCandidates,
  rewriteCard,
  REASON_DESCRIPTIONS,
  type AuditCandidate,
  type AuditReason,
  type RewriteResult,
} from '@/lib/ai/auditor';
import { listDecks, updateNote } from '@/lib/db/queries';
import type { Deck, Note } from '@/lib/db/schema';
import { renderFront, renderRichText } from '@/lib/cloze/parser';
import { SkeletonList } from '@/components/ui/Skeleton';
import InlineAlert from '@/components/ui/InlineAlert';
import { cn } from '@/lib/utils';

export default function AuditView() {
  const [candidates, setCandidates] = useState<AuditCandidate[] | null>(null);
  const [decks, setDecks] = useState<Deck[]>([]);
  const [filterDeck, setFilterDeck] = useState<string>('');
  const [filterReason, setFilterReason] = useState<AuditReason | ''>('');

  const refresh = async () => {
    const [cs, ds] = await Promise.all([findCandidates({ topK: 100 }), listDecks()]);
    setCandidates(cs);
    setDecks(ds);
  };

  useEffect(() => { refresh(); }, []);

  const visible = useMemo(() => {
    if (candidates === null) return [];
    return candidates.filter(c => {
      if (filterDeck && c.note.deckId !== filterDeck) return false;
      if (filterReason && !c.reasons.includes(filterReason)) return false;
      return true;
    });
  }, [candidates, filterDeck, filterReason]);

  const deckById = new Map(decks.map(d => [d.id, d]));

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <h1 className="text-3xl md:text-4xl font-extralight tracking-tight mb-2">Audit</h1>
      <p className="text-dark-400 font-light text-sm mb-8 max-w-2xl">
        AI-flagged candidate cards in need of rewriting. Heuristic flag (lapsing, overlong, malformed, sparse) → Claude proposes a rewrite → you accept with one click.
      </p>

      <div className="flex gap-3 mb-6 flex-wrap">
        <select
          value={filterDeck}
          onChange={e => setFilterDeck(e.target.value)}
          className="bg-dark-800/30 rounded-xl px-3 py-2 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] cursor-pointer"
        >
          <option value="">All decks</option>
          {decks.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select
          value={filterReason}
          onChange={e => setFilterReason(e.target.value as AuditReason | '')}
          className="bg-dark-800/30 rounded-xl px-3 py-2 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] cursor-pointer"
        >
          <option value="">All reasons</option>
          {(Object.keys(REASON_DESCRIPTIONS) as AuditReason[]).map(r => (
            <option key={r} value={r}>{REASON_DESCRIPTIONS[r]}</option>
          ))}
        </select>
        <button
          onClick={refresh}
          className="text-2xs uppercase tracking-[0.2em] font-light px-3 py-2 rounded-xl text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition border border-white/[0.06]"
        >
          Re-scan
        </button>
        {candidates !== null && (
          <span className="text-2xs uppercase tracking-widest text-dark-500 self-center tabular-nums">
            {visible.length} of {candidates.length}
          </span>
        )}
      </div>

      {candidates === null ? (
        <SkeletonList count={5} height="h-16" />
      ) : candidates.length === 0 ? (
        <div className="glass-card rounded-2xl p-8 text-center text-dark-400 font-light text-sm">
          No flagged cards. Your deck is clean.
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((c, i) => (
            <CandidateRow
              key={c.note.id}
              candidate={c}
              deckName={deckById.get(c.note.deckId)?.name ?? ''}
              onAccept={async (next) => {
                await updateNote(c.note.id, { fields: next });
                // Drop this candidate locally; user can re-scan to re-evaluate.
                setCandidates(prev => prev ? prev.filter((_, j) => j !== i) : prev);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CandidateRow({
  candidate, deckName, onAccept,
}: {
  candidate: AuditCandidate;
  deckName: string;
  onAccept: (fields: import('@/lib/db/schema').NoteFields) => Promise<void>;
}) {
  const { note } = candidate;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rewrite, setRewrite] = useState<RewriteResult | null>(null);

  const proposeRewrite = async () => {
    setBusy(true);
    setError(null);
    try {
      setRewrite(await rewriteCard(note));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const isCloze = note.modelId === 'cloze';
  const frontPreview = isCloze ? renderFront(note.fields.front, 1) : renderRichText(note.fields.front);

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-5 py-4 flex items-center gap-4 hover:bg-white/[0.02] transition text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="text-sm font-light text-dark-100 truncate">
            {plainPreview(note)}
          </div>
          <div className="text-2xs uppercase tracking-widest text-dark-500 mt-1 flex items-center gap-2 flex-wrap">
            <span>{deckName.split('::').slice(-1)[0] || deckName}</span>
            <span>·</span>
            <span>{candidate.summary}</span>
          </div>
        </div>
        <div className="flex gap-1 shrink-0">
          {candidate.reasons.map(r => (
            <span key={r} className={cn(
              'text-2xs uppercase tracking-widest px-2 py-0.5 rounded border font-mono',
              r === 'lapsing' ? 'text-crimson-300 border-crimson-700/30 bg-crimson-900/10'
                : r === 'overlong' ? 'text-saffron-300 border-saffron-700/30 bg-saffron-900/10'
                : r === 'malformed' ? 'text-crimson-200 border-crimson-700/40 bg-crimson-900/20'
                : 'text-dark-300 border-white/[0.06] bg-dark-800/30',
            )}>
              {r}
            </span>
          ))}
        </div>
      </button>

      {open && (
        <div className="px-5 pb-5 pt-1 border-t border-white/[0.04] space-y-4">
          <div className="grid lg:grid-cols-2 gap-3">
            <Side label="Current">
              <div className="card-prose text-sm font-light text-dark-100" dangerouslySetInnerHTML={{ __html: frontPreview }} />
              {note.fields.back && (
                <div className="card-prose text-sm font-light text-dark-300 mt-2 pt-2 border-t border-white/[0.04]" dangerouslySetInnerHTML={{ __html: renderRichText(note.fields.back) }} />
              )}
            </Side>
            <Side label="Proposed" accent>
              {!rewrite ? (
                <div className="text-2xs text-dark-500 italic font-light">
                  Click "Propose rewrite" to generate.
                </div>
              ) : (
                <>
                  <div
                    className="card-prose text-sm font-light text-dark-100"
                    dangerouslySetInnerHTML={{ __html: isCloze ? renderFront(rewrite.fields.front, 1) : renderRichText(rewrite.fields.front) }}
                  />
                  {rewrite.fields.back && (
                    <div className="card-prose text-sm font-light text-dark-300 mt-2 pt-2 border-t border-white/[0.04]" dangerouslySetInnerHTML={{ __html: renderRichText(rewrite.fields.back) }} />
                  )}
                  {rewrite.rationale && (
                    <div className="text-2xs text-saffron-300/80 italic font-light mt-3 pt-2 border-t border-white/[0.04]">
                      {rewrite.rationale}
                    </div>
                  )}
                </>
              )}
            </Side>
          </div>

          {error && <InlineAlert>{error}</InlineAlert>}

          <div className="flex items-center gap-3 flex-wrap">
            {!rewrite ? (
              <button
                onClick={proposeRewrite}
                disabled={busy}
                className="btn-gradient px-4 py-2 rounded-xl text-2xs uppercase tracking-[0.2em] font-light disabled:opacity-50"
              >
                {busy ? 'Thinking…' : 'Propose rewrite'}
              </button>
            ) : (
              <>
                <button
                  onClick={async () => {
                    setBusy(true);
                    try { await onAccept(rewrite.fields); } finally { setBusy(false); }
                  }}
                  disabled={busy}
                  className="btn-gradient px-4 py-2 rounded-xl text-2xs uppercase tracking-[0.2em] font-light disabled:opacity-50"
                >
                  {busy ? 'Saving…' : 'Accept rewrite'}
                </button>
                <button
                  onClick={proposeRewrite}
                  disabled={busy}
                  className="text-2xs uppercase tracking-[0.2em] font-light px-3 py-2 rounded-xl text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition border border-white/[0.06]"
                >
                  Try again
                </button>
                <button
                  onClick={() => setRewrite(null)}
                  disabled={busy}
                  className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition px-3"
                >
                  Discard
                </button>
              </>
            )}
            <Link
              href={`/note/${note.id}`}
              className="ml-auto text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition px-3"
            >
              Open in editor →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function Side({ label, accent, children }: { label: string; accent?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn(
      'rounded-xl p-3 border space-y-2',
      accent ? 'border-saffron-700/30 bg-saffron-900/10' : 'border-white/[0.06] bg-dark-800/30',
    )}>
      <div className={cn(
        'text-2xs uppercase tracking-widest font-mono',
        accent ? 'text-saffron-300' : 'text-dark-400',
      )}>
        {label}
      </div>
      {children}
    </div>
  );
}

function plainPreview(note: Note): string {
  const f = note.fields.front || note.fields.back || '';
  const stripped = f.replace(/\{\{c\d+::([^:}]+)(?:::[^}]*)?\}\}/g, '$1').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (stripped.length <= 80) return stripped;
  return stripped.slice(0, 78).trimEnd() + '…';
}
