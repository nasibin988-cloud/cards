'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type {
  Deck,
  ExamConfig,
  ExamCoverage,
  ExamDifficulty,
  ExamQuestionType,
} from '@/lib/db/schema';
import { getDeck, listTagsInDeck, getSetting } from '@/lib/db/queries';
import { pickSourceNotes, createExam } from '@/lib/exam/queries';
import {
  generateExamQuestions,
  buildExamTitle,
  type GeneratorProgress,
} from '@/lib/exam/generator';
import { cn } from '@/lib/utils';

type CountChoice = 10 | 25 | 50 | 100;
type TypeChoice = 'mcq' | 'mixed' | 'free';
type CoverageChoice = 'random' | 'lapses' | 'tags';

export default function ExamGenerator({ deckId }: { deckId: string }) {
  const router = useRouter();
  const [deck, setDeck] = useState<Deck | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [hasKey, setHasKey] = useState<boolean | null>(null);

  const [count, setCount] = useState<CountChoice>(50);
  const [typeMix, setTypeMix] = useState<TypeChoice>('mcq');
  const [difficulty, setDifficulty] = useState<ExamDifficulty>('match');
  const [coverage, setCoverage] = useState<CoverageChoice>('random');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<GeneratorProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [d, t, k] = await Promise.all([
        getDeck(deckId),
        listTagsInDeck(deckId),
        getSetting('claude_api_key'),
      ]);
      setDeck(d ?? null);
      // Drop xref tags from filter UI; user-facing tags only.
      setTags(t.filter(x => !x.startsWith('xref::')));
      setHasKey(!!k);
    })();
  }, [deckId]);

  const generate = async () => {
    if (!deck) return;
    setError(null);
    setWorking(true);
    try {
      const types: ExamQuestionType[] =
        typeMix === 'mcq' ? ['mcq']
        : typeMix === 'free' ? ['free']
        : ['mcq', 'free'];
      const cov: ExamCoverage =
        coverage === 'tags' && selectedTags.length > 0
          ? { kind: 'tags', tags: selectedTags }
          : coverage === 'lapses'
          ? { kind: 'lapses' }
          : { kind: 'random' };
      const config: ExamConfig = { count, types, difficulty, coverage: cov };
      const sourceCap = Math.min(count * 2, 200);
      const sources = await pickSourceNotes(deckId, cov, sourceCap);
      if (sources.length === 0) {
        throw new Error('No source notes match those filters.');
      }
      const questions = await generateExamQuestions({
        notes: sources,
        config,
        onProgress: setProgress,
      });
      if (questions.length === 0) {
        throw new Error('Generator returned no questions. Try different parameters or check your API key.');
      }
      const title = buildExamTitle(deck.name, config);
      const exam = await createExam({ deckId, title, config, questions });
      router.push(`/exam/take/${exam.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setWorking(false);
      setProgress(null);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <Link href={`/deck/${deckId}`} className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition">
        ← {deck?.name ?? 'Deck'}
      </Link>
      <h1 className="text-3xl md:text-4xl font-extralight tracking-tight mt-4 mb-2">AI exam</h1>
      <p className="text-dark-400 font-light text-sm mb-8">
        Generate a fresh exam from this deck. Questions are written from the cards in different language so you test understanding, not phrasing.
      </p>

      {hasKey === false && (
        <div className="mb-6 glass-card rounded-2xl p-4 bg-saffron-900/10 border-saffron-700/20 text-sm text-dark-200">
          Claude API key required. <Link href="/settings" className="text-saffron-300 underline">Add it in Settings</Link>.
        </div>
      )}

      {!working ? (
        <div className="glass-card rounded-2xl p-6 space-y-6">
          <Field label="Question count">
            <div className="grid grid-cols-4 gap-2">
              {[10, 25, 50, 100].map(n => (
                <Pill key={n} active={count === n} onClick={() => setCount(n as CountChoice)}>{n}</Pill>
              ))}
            </div>
          </Field>

          <Field label="Question types">
            <div className="grid grid-cols-3 gap-2">
              <Pill active={typeMix === 'mcq'} onClick={() => setTypeMix('mcq')}>MCQ</Pill>
              <Pill active={typeMix === 'mixed'} onClick={() => setTypeMix('mixed')}>Mixed</Pill>
              <Pill active={typeMix === 'free'} onClick={() => setTypeMix('free')}>Free</Pill>
            </div>
            <FieldHint>
              {typeMix === 'mcq' ? '4-option multiple choice; auto-graded.'
                : typeMix === 'free' ? 'Short-answer; AI grades against the model answer.'
                : '~70% multiple choice, ~30% free response.'}
            </FieldHint>
          </Field>

          <Field label="Difficulty">
            <div className="grid grid-cols-3 gap-2">
              <Pill active={difficulty === 'easier'} onClick={() => setDifficulty('easier')}>Easier</Pill>
              <Pill active={difficulty === 'match'} onClick={() => setDifficulty('match')}>Match</Pill>
              <Pill active={difficulty === 'harder'} onClick={() => setDifficulty('harder')}>Harder</Pill>
            </div>
            <FieldHint>
              {difficulty === 'easier' ? 'Direct recall.'
                : difficulty === 'match' ? 'Same level as the cards.'
                : 'Synthesis, two-step reasoning, distinguishing similar concepts.'}
            </FieldHint>
          </Field>

          <Field label="Coverage">
            <div className="grid grid-cols-3 gap-2">
              <Pill active={coverage === 'random'} onClick={() => setCoverage('random')}>Random</Pill>
              <Pill active={coverage === 'lapses'} onClick={() => setCoverage('lapses')}>Weak areas</Pill>
              <Pill active={coverage === 'tags'} onClick={() => setCoverage('tags')}>By tag</Pill>
            </div>
            <FieldHint>
              {coverage === 'lapses' ? 'Bias toward cards you\'ve lapsed on most.'
                : coverage === 'tags' ? 'Pick which tag(s) to draw from.'
                : 'Uniform random sample.'}
            </FieldHint>
            {coverage === 'tags' && (
              <div className="mt-3 max-h-48 overflow-y-auto bg-dark-800/30 rounded-xl p-3 border border-white/[0.04]">
                {tags.length === 0 ? (
                  <div className="text-sm text-dark-500">No tags in this deck.</div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map(t => {
                      const active = selectedTags.includes(t);
                      return (
                        <button
                          key={t}
                          onClick={() => setSelectedTags(prev => active ? prev.filter(x => x !== t) : [...prev, t])}
                          className={cn(
                            'text-2xs uppercase tracking-wider px-2 py-1 rounded-md border transition',
                            active
                              ? 'bg-persian-900/40 text-saffron-200 border-saffron-700/40'
                              : 'bg-dark-800/30 text-dark-300 border-white/[0.04] hover:text-dark-100',
                          )}
                        >
                          {t}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </Field>

          {error && (
            <div className="text-sm text-crimson-300 bg-crimson-900/15 rounded-xl p-3 border border-crimson-800/30">
              {error}
            </div>
          )}

          <button
            onClick={generate}
            disabled={!hasKey || (coverage === 'tags' && selectedTags.length === 0)}
            className="btn-gradient w-full px-5 py-3 rounded-2xl text-sm uppercase tracking-[0.2em] font-light disabled:opacity-50"
          >
            Generate exam
          </button>
          <div className="text-2xs text-dark-500 text-center">
            Estimated cost: ~${estimateCost(count).toFixed(2)} (Sonnet) — varies with deck size.
          </div>
        </div>
      ) : (
        <div className="glass-card rounded-2xl p-8 text-center space-y-4">
          <div className="text-2xs uppercase tracking-[0.2em] text-saffron-300">
            {progress?.stage === 'generating' ? 'Generating' : progress?.stage === 'finalizing' ? 'Finalizing' : 'Preparing'}
          </div>
          <div className="text-lg font-light text-dark-100">
            {progress?.message ?? 'Sampling source cards…'}
          </div>
          {progress && progress.total > 0 && (
            <div className="max-w-sm mx-auto">
              <div className="h-1.5 rounded-full bg-dark-800/60 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-saffron-500 to-persian-400 transition-all duration-300"
                  style={{ width: `${(progress.done / progress.total) * 100}%` }}
                />
              </div>
              <div className="text-2xs uppercase tracking-widest tabular-nums text-dark-500 mt-2">
                {progress.done} / {progress.total}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-widest text-dark-400 mb-2">{label}</div>
      {children}
    </div>
  );
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return <div className="text-2xs text-dark-500 mt-2 font-light">{children}</div>;
}

function Pill({
  children, active, onClick,
}: { children: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-xl py-2 text-sm transition',
        active
          ? 'bg-persian-900/40 text-saffron-200 border border-saffron-700/30'
          : 'border border-white/[0.06] text-dark-300 hover:text-dark-100 hover:bg-white/[0.04]',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Rough cost estimate based on token math: ~150 input tokens per source card,
 * ~120 output tokens per question. Sonnet 4.6 pricing: $3/MTok input, $15/MTok
 * output. This is an order-of-magnitude figure, not exact.
 */
function estimateCost(count: number): number {
  const sourceCap = Math.min(count * 2, 200);
  const inputTokens = sourceCap * 150 + count * 50;
  const outputTokens = count * 120;
  return (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15;
}
