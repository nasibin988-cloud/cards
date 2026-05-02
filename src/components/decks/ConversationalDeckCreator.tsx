'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  proposeDeckPlan,
  expandSection,
  type DeckPlan,
  type DeckPlanSection,
  type DraftCard,
} from '@/lib/ai/conversational-deck';
import { createDeck, createNote } from '@/lib/db/queries';
import InlineAlert from '@/components/ui/InlineAlert';
import { renderFront, renderRichText } from '@/lib/cloze/parser';
import { cn } from '@/lib/utils';

type Stage = 'brief' | 'plan' | 'review' | 'done';

interface SectionDrafts {
  drafts: DraftCard[];
  accepted: Set<number>;
  expanding: boolean;
  error: string | null;
}

export default function ConversationalDeckCreator() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('brief');
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [plan, setPlan] = useState<DeckPlan | null>(null);
  const [sections, setSections] = useState<Record<string, SectionDrafts>>({});
  const [savedDeckId, setSavedDeckId] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState(0);

  const propose = async () => {
    if (!brief.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const out = await proposeDeckPlan({ brief: brief.trim() });
      setPlan(out);
      setStage('plan');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const updatePlanSection = (idx: number, patch: Partial<DeckPlanSection>) => {
    if (!plan) return;
    const next = { ...plan, sections: plan.sections.map((s, i) => i === idx ? { ...s, ...patch } : s) };
    setPlan(next);
  };

  const removePlanSection = (idx: number) => {
    if (!plan) return;
    setPlan({ ...plan, sections: plan.sections.filter((_, i) => i !== idx) });
  };

  const expandAll = async () => {
    if (!plan) return;
    setStage('review');
    for (const section of plan.sections) {
      setSections(prev => ({
        ...prev,
        [section.slug]: { drafts: [], accepted: new Set(), expanding: true, error: null },
      }));
      try {
        const drafts = await expandSection({ brief, plan, section });
        setSections(prev => ({
          ...prev,
          [section.slug]: {
            drafts,
            accepted: new Set(drafts.map((_, i) => i)),
            expanding: false,
            error: null,
          },
        }));
      } catch (e) {
        setSections(prev => ({
          ...prev,
          [section.slug]: {
            drafts: [],
            accepted: new Set(),
            expanding: false,
            error: e instanceof Error ? e.message : String(e),
          },
        }));
      }
    }
  };

  const toggleDraft = (slug: string, idx: number) => {
    setSections(prev => {
      const cur = prev[slug];
      if (!cur) return prev;
      const next = new Set(cur.accepted);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return { ...prev, [slug]: { ...cur, accepted: next } };
    });
  };

  const finalize = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const deck = await createDeck({ name: plan.deckName, description: plan.description || undefined });
      let saved = 0;
      for (const section of plan.sections) {
        const sd = sections[section.slug];
        if (!sd) continue;
        for (let i = 0; i < sd.drafts.length; i++) {
          if (!sd.accepted.has(i)) continue;
          const d = sd.drafts[i];
          await createNote({
            deckId: deck.id,
            fields: d.fields,
            tags: d.tags,
            tier: d.tier,
            modelId: d.modelId,
          });
          saved++;
        }
      }
      setSavedDeckId(deck.id);
      setSavedCount(saved);
      setStage('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-6 md:py-10">
      <h1 className="text-3xl md:text-4xl font-extralight tracking-tight mb-2">Talk to a deck</h1>
      <p className="text-dark-400 font-light text-sm mb-8">
        Describe what you want to learn. Claude proposes a structured outline.
        You review, edit, and expand into draft cards before saving.
      </p>

      {error && <InlineAlert className="mb-4">{error}</InlineAlert>}

      {stage === 'brief' && (
        <div className="glass-card rounded-2xl p-5 space-y-3">
          <label className="block">
            <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">What do you want to learn?</div>
            <textarea
              autoFocus
              value={brief}
              onChange={e => setBrief(e.target.value)}
              rows={6}
              placeholder="e.g. I'm studying for the MCAT bio section. Focus on enzymes (kinetics, regulation, inhibition) at a clinical-yield level. Multi-cloze, mechanism-first."
              className="w-full bg-dark-800/30 rounded-xl px-4 py-3 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] leading-relaxed"
            />
          </label>
          <div className="flex items-center gap-3">
            <button
              onClick={propose}
              disabled={busy || !brief.trim()}
              className="btn-gradient px-4 py-2 rounded-xl text-sm uppercase tracking-[0.2em] font-light disabled:opacity-50"
            >
              {busy ? 'Proposing…' : 'Propose plan'}
            </button>
            <Link
              href="/decks/new"
              className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition px-3"
            >
              Manual mode
            </Link>
          </div>
        </div>
      )}

      {stage === 'plan' && plan && (
        <div className="space-y-4">
          <div className="glass-card rounded-2xl p-5 space-y-3">
            <label className="block">
              <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">Deck name</div>
              <input
                value={plan.deckName}
                onChange={e => setPlan({ ...plan, deckName: e.target.value })}
                className="w-full bg-dark-800/30 rounded-xl px-4 py-2 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04]"
              />
            </label>
            <label className="block">
              <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">Description</div>
              <input
                value={plan.description}
                onChange={e => setPlan({ ...plan, description: e.target.value })}
                className="w-full bg-dark-800/30 rounded-xl px-4 py-2 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04]"
              />
            </label>
            <label className="block">
              <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">Tag prefix</div>
              <input
                value={plan.tagPrefix}
                onChange={e => setPlan({ ...plan, tagPrefix: e.target.value })}
                className="w-full bg-dark-800/30 rounded-xl px-4 py-2 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] font-mono"
              />
            </label>
          </div>

          <div className="space-y-2">
            <h2 className="text-2xs uppercase tracking-widest text-dark-400">Sections ({plan.sections.length})</h2>
            {plan.sections.map((s, i) => (
              <div key={i} className="glass-card rounded-2xl p-4 flex items-start gap-3">
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      value={s.title}
                      onChange={e => updatePlanSection(i, { title: e.target.value })}
                      className="flex-1 bg-transparent text-sm font-light text-dark-100 outline-none border-b border-transparent focus:border-saffron-700/40 transition"
                    />
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={s.targetCount}
                      onChange={e => updatePlanSection(i, { targetCount: parseInt(e.target.value, 10) || 1 })}
                      className="w-16 bg-dark-800/30 rounded-lg px-2 py-1 text-xs text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] font-mono tabular-nums text-right"
                    />
                  </div>
                  <input
                    value={s.description}
                    onChange={e => updatePlanSection(i, { description: e.target.value })}
                    placeholder="What this section covers"
                    className="w-full bg-transparent text-2xs text-dark-300 placeholder:text-dark-500 outline-none border-b border-transparent focus:border-saffron-700/40 transition"
                  />
                  <div className="text-2xs text-dark-500 font-mono">slug: {s.slug}</div>
                </div>
                <button
                  onClick={() => removePlanSection(i)}
                  className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-crimson-300 transition px-2 shrink-0"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={expandAll}
              disabled={busy || plan.sections.length === 0}
              className="btn-gradient px-4 py-2 rounded-xl text-sm uppercase tracking-[0.2em] font-light disabled:opacity-50"
            >
              Expand into cards
            </button>
            <button
              onClick={() => setStage('brief')}
              className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition px-3"
            >
              ← Back
            </button>
          </div>
        </div>
      )}

      {stage === 'review' && plan && (
        <div className="space-y-4">
          {plan.sections.map(section => {
            const sd = sections[section.slug];
            return (
              <div key={section.slug} className="glass-card rounded-2xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="text-sm font-light text-dark-100">{section.title}</div>
                    <div className="text-2xs uppercase tracking-widest text-dark-500 mt-0.5 font-mono">
                      {sd?.expanding ? 'expanding…'
                        : sd?.error ? 'error'
                        : `${sd?.accepted.size ?? 0}/${sd?.drafts.length ?? 0} accepted`}
                    </div>
                  </div>
                </div>

                {sd?.error && <InlineAlert className="mb-2">{sd.error}</InlineAlert>}

                {sd && !sd.expanding && (
                  <div className="space-y-2">
                    {sd.drafts.map((d, i) => {
                      const isAccepted = sd.accepted.has(i);
                      const front = d.modelId === 'cloze' ? renderFront(d.fields.front, 1) : renderRichText(d.fields.front);
                      return (
                        <div
                          key={i}
                          onClick={() => toggleDraft(section.slug, i)}
                          className={cn(
                            'rounded-xl px-3 py-2 cursor-pointer transition border space-y-1',
                            isAccepted
                              ? 'bg-saffron-900/10 border-saffron-700/30'
                              : 'bg-dark-800/30 border-white/[0.04] hover:border-white/[0.08] opacity-60',
                          )}
                        >
                          <div className="flex items-start gap-3">
                            <span className={cn(
                              'shrink-0 mt-0.5 w-4 h-4 rounded border flex items-center justify-center',
                              isAccepted ? 'bg-saffron-500 border-saffron-400' : 'border-white/20 bg-dark-900/40',
                            )}>
                              {isAccepted && (
                                <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
                                  <path d="M2 6 L5 9 L10 3" stroke="#0c0c10" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              )}
                            </span>
                            <div className="flex-1 min-w-0 space-y-1">
                              <div
                                className="card-prose text-sm font-light text-dark-100 leading-relaxed"
                                dangerouslySetInnerHTML={{ __html: front }}
                              />
                              {d.fields.back && (
                                <div
                                  className="card-prose text-2xs font-light text-dark-300 leading-relaxed pt-1 border-t border-white/[0.04]"
                                  dangerouslySetInnerHTML={{ __html: renderRichText(d.fields.back) }}
                                />
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {sd.drafts.length === 0 && (
                      <div className="text-2xs text-dark-500 italic font-light">
                        No drafts produced for this section.
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={finalize}
              disabled={busy || plan.sections.every(s => !sections[s.slug] || sections[s.slug].accepted.size === 0)}
              className="btn-gradient px-4 py-2 rounded-xl text-sm uppercase tracking-[0.2em] font-light disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save deck'}
            </button>
            <button
              onClick={() => setStage('plan')}
              className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition px-3"
            >
              ← Edit plan
            </button>
          </div>
        </div>
      )}

      {stage === 'done' && plan && savedDeckId && (
        <div className="glass-card rounded-2xl p-6 space-y-4">
          <div className="text-2xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
            Deck created.
          </div>
          <p className="text-sm text-dark-300 font-light">
            Saved {savedCount} note{savedCount === 1 ? '' : 's'} to <span className="text-dark-100">{plan.deckName}</span>.
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => router.push(`/deck/${savedDeckId}`)}
              className="btn-gradient px-4 py-2 rounded-xl text-sm uppercase tracking-[0.2em] font-light"
            >
              Open deck
            </button>
            <button
              onClick={() => router.push(`/study/${savedDeckId}`)}
              className="text-2xs uppercase tracking-[0.2em] font-light px-3 py-2 rounded-xl text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition border border-white/[0.06]"
            >
              Start studying
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
