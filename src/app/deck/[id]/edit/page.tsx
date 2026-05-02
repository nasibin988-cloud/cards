'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Deck, NewCardOrder } from '@/lib/db/schema';
import {
  deleteDeck,
  getDeck,
  getEffectiveDeckSettings,
  listDescendantDeckIds,
  updateDeck,
  type EffectiveDeckSettings,
} from '@/lib/db/queries';
import { optimizeFsrsWeights, type OptimizeResult } from '@/lib/fsrs/optimize';
import { analyzeDeckRetention, type DeckRetentionReport } from '@/lib/fsrs/analyze';
import {
  DEFAULT_MAX_INTERVAL,
  DEFAULT_NEW_PER_DAY,
  DEFAULT_RETENTION,
  DEFAULT_REVIEWS_PER_DAY,
  DEFAULT_W,
} from '@/lib/fsrs/defaults';
import { cn } from '@/lib/utils';
import ImagesSourcePanel from '@/components/decks/ImagesSourcePanel';

type Tab = 'info' | 'tuning' | 'media';

export default function EditDeckPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [deck, setDeck] = useState<Deck | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('info');

  // Info fields
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  // Tuning fields
  const [retention, setRetention] = useState<number>(DEFAULT_RETENTION);
  const [retentionOverride, setRetentionOverride] = useState(false);
  const [newPerDay, setNewPerDay] = useState<number>(DEFAULT_NEW_PER_DAY);
  const [newOverride, setNewOverride] = useState(false);
  const [reviewsPerDay, setReviewsPerDay] = useState<number>(DEFAULT_REVIEWS_PER_DAY);
  const [reviewsOverride, setReviewsOverride] = useState(false);
  const [maxInterval, setMaxInterval] = useState<number>(DEFAULT_MAX_INTERVAL);
  const [maxIntervalOverride, setMaxIntervalOverride] = useState(false);
  const [newCardOrder, setNewCardOrder] = useState<NewCardOrder>('added');
  const [audioTranscribe, setAudioTranscribe] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [weightsText, setWeightsText] = useState('');
  const [weightsError, setWeightsError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [descendantCount, setDescendantCount] = useState<number>(0);
  const [report, setReport] = useState<DeckRetentionReport | null>(null);
  const [effective, setEffective] = useState<EffectiveDeckSettings | null>(null);
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeProgress, setOptimizeProgress] = useState<{ epoch: number; loss: number } | null>(null);
  const [optimizeResult, setOptimizeResult] = useState<OptimizeResult | null>(null);

  useEffect(() => {
    getDeck(id).then(d => {
      setDeck(d ?? null);
      if (!d) return;
      setName(d.name);
      setDescription(d.description ?? '');

      setRetentionOverride(d.desiredRetention != null);
      setRetention(d.desiredRetention ?? DEFAULT_RETENTION);
      setNewOverride(d.newCardsPerDay != null);
      setNewPerDay(d.newCardsPerDay ?? DEFAULT_NEW_PER_DAY);
      setReviewsOverride(d.reviewsPerDay != null);
      setReviewsPerDay(d.reviewsPerDay ?? DEFAULT_REVIEWS_PER_DAY);
      setMaxIntervalOverride(d.maxInterval != null);
      setMaxInterval(d.maxInterval ?? DEFAULT_MAX_INTERVAL);
      setNewCardOrder(d.newCardOrder ?? 'added');
      setAudioTranscribe(!!d.audioTranscribe);
      setWeightsText(JSON.stringify(d.fsrsParams ?? DEFAULT_W));

      analyzeDeckRetention(id, d.desiredRetention ?? DEFAULT_RETENTION).then(setReport);
      listDescendantDeckIds(id).then(ids => setDescendantCount(ids.length));
      getEffectiveDeckSettings(id).then(setEffective);
    });
  }, [id]);

  const save = async () => {
    if (!deck) return;
    if (!name.trim()) return;

    let parsedWeights: number[] | undefined;
    if (showAdvanced && weightsText.trim()) {
      try {
        const parsed = JSON.parse(weightsText.trim());
        if (!Array.isArray(parsed) || parsed.length !== 19 || !parsed.every(x => typeof x === 'number' && Number.isFinite(x))) {
          setWeightsError('Must be a JSON array of 19 finite numbers.');
          return;
        }
        // Only persist if it's actually different from default.
        const isDefault = parsed.every((v, i) => v === DEFAULT_W[i]);
        parsedWeights = isDefault ? undefined : parsed;
      } catch {
        setWeightsError('Invalid JSON.');
        return;
      }
    }
    setWeightsError(null);
    setBusy(true);
    await updateDeck(deck.id, {
      name: name.trim(),
      description: description.trim() || undefined,
      desiredRetention: retentionOverride ? retention : undefined,
      newCardsPerDay: newOverride ? newPerDay : undefined,
      reviewsPerDay: reviewsOverride ? reviewsPerDay : undefined,
      maxInterval: maxIntervalOverride ? maxInterval : undefined,
      newCardOrder: newCardOrder === 'added' ? undefined : newCardOrder,
      audioTranscribe: audioTranscribe || undefined,
      fsrsParams: parsedWeights,
    });
    setBusy(false);
    router.push(`/deck/${deck.id}`);
  };

  const remove = async () => {
    if (!deck) return;
    await deleteDeck(deck.id);
    router.push('/');
  };

  if (deck === undefined) {
    return <div className="max-w-xl mx-auto px-6 py-10 text-dark-400">Loading…</div>;
  }
  if (!deck) {
    return (
      <div className="max-w-xl mx-auto px-6 py-10">
        <p className="text-dark-300">Deck not found.</p>
        <Link href="/" className="text-saffron-300 underline">← Back to decks</Link>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto px-6 py-10">
      <Link href={`/deck/${deck.id}`} className="text-sm text-dark-300 hover:text-dark-100 transition">
        ← {deck.name}
      </Link>
      <h1 className="text-3xl font-extralight tracking-tight mt-3 mb-6">Edit deck</h1>

      <div className="flex gap-1 mb-4">
        {(['info', 'tuning', 'media'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'text-2xs uppercase tracking-widest font-mono px-4 py-1.5 rounded-lg transition',
              tab === t
                ? 'bg-persian-900/30 text-saffron-300'
                : 'text-dark-400 hover:text-dark-100 hover:bg-white/[0.03]',
            )}
          >
            {t === 'info' ? 'Info' : t === 'tuning' ? 'Tuning' : 'Media'}
          </button>
        ))}
      </div>

      {tab === 'info' && (
        <div className="glass-card rounded-2xl p-6 space-y-4">
          <label className="block">
            <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">Name</div>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] focus:border-persian-500/30"
            />
          </label>
          <label className="block">
            <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">Description</div>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={3}
              className="w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] focus:border-persian-500/30"
            />
          </label>
        </div>
      )}

      {tab === 'tuning' && (
        <div className="glass-card rounded-2xl p-6 space-y-5">
          <DialRow
            label="Desired retention"
            help="What fraction of cards you want to recall correctly."
            override={retentionOverride}
            setOverride={setRetentionOverride}
            defaultLabel={`${(DEFAULT_RETENTION * 100).toFixed(0)}%`}
            inherited={
              effective && !effective.desiredRetention.isOwn && !effective.desiredRetention.isDefault
                ? { value: `${(effective.desiredRetention.value * 100).toFixed(0)}%`, sourceName: effective.desiredRetention.sourceName! }
                : null
            }
          >
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0.80}
                max={0.97}
                step={0.01}
                value={retention}
                onChange={e => {
                  setRetention(parseFloat(e.target.value));
                  if (!retentionOverride) setRetentionOverride(true);
                }}
                className="flex-1 accent-saffron-400"
              />
              <span className="text-sm text-saffron-300 tabular-nums font-mono w-12 text-right">
                {(retention * 100).toFixed(0)}%
              </span>
            </div>
          </DialRow>

          <DialRow
            label="New cards / day"
            help="Maximum new cards introduced per study session."
            override={newOverride}
            setOverride={setNewOverride}
            defaultLabel={String(DEFAULT_NEW_PER_DAY)}
            inherited={
              effective && !effective.newCardsPerDay.isOwn && !effective.newCardsPerDay.isDefault
                ? { value: String(effective.newCardsPerDay.value), sourceName: effective.newCardsPerDay.sourceName! }
                : null
            }
          >
            <NumberInput
              value={newPerDay}
              onChange={n => {
                setNewPerDay(n);
                if (!newOverride) setNewOverride(true);
              }}
              min={0}
              max={500}
            />
          </DialRow>

          <DialRow
            label="Reviews / day"
            help="Cap on the daily review queue. Excess pushes to tomorrow."
            override={reviewsOverride}
            setOverride={setReviewsOverride}
            defaultLabel={String(DEFAULT_REVIEWS_PER_DAY)}
            inherited={
              effective && !effective.reviewsPerDay.isOwn && !effective.reviewsPerDay.isDefault
                ? { value: String(effective.reviewsPerDay.value), sourceName: effective.reviewsPerDay.sourceName! }
                : null
            }
          >
            <NumberInput
              value={reviewsPerDay}
              onChange={n => {
                setReviewsPerDay(n);
                if (!reviewsOverride) setReviewsOverride(true);
              }}
              min={0}
              max={9999}
            />
          </DialRow>

          <DialRow
            label="Max interval (days)"
            help="Upper bound on how far FSRS will schedule a card."
            override={maxIntervalOverride}
            setOverride={setMaxIntervalOverride}
            defaultLabel={String(DEFAULT_MAX_INTERVAL)}
            inherited={
              effective && !effective.maxInterval.isOwn && !effective.maxInterval.isDefault
                ? { value: String(effective.maxInterval.value), sourceName: effective.maxInterval.sourceName! }
                : null
            }
          >
            <NumberInput
              value={maxInterval}
              onChange={n => {
                setMaxInterval(n);
                if (!maxIntervalOverride) setMaxIntervalOverride(true);
              }}
              min={1}
              max={36500}
            />
          </DialRow>

          <div>
            <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">New card order</div>
            <select
              value={newCardOrder}
              onChange={e => setNewCardOrder(e.target.value as NewCardOrder)}
              className="w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] cursor-pointer"
            >
              <option value="added">Added (FIFO)</option>
              <option value="random">Random</option>
              <option value="tagInterleaved">Interleaved by tag (round-robin)</option>
            </select>
            <div className="text-2xs text-dark-500 mt-1 font-light">
              Tag-interleaved prevents long runs of the same topic when introducing new cards.
            </div>
          </div>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={audioTranscribe}
              onChange={e => setAudioTranscribe(e.target.checked)}
              className="mt-1 accent-saffron-400"
            />
            <div>
              <div className="text-2xs uppercase tracking-widest text-dark-400">Auto-transcribe audio recordings</div>
              <div className="text-2xs text-dark-500 mt-1 font-light">
                When recording audio in the editor, run live transcription via the browser's Web Speech API and append the transcript to the Extra field. Free, browser-native, no API key. Quality varies by browser.
              </div>
            </div>
          </label>

          <div className="pt-3 border-t border-white/[0.04]">
            <button
              onClick={() => setShowAdvanced(s => !s)}
              className="text-2xs uppercase tracking-widest text-dark-400 hover:text-dark-100 transition"
            >
              {showAdvanced ? '− Hide advanced' : '+ Show advanced'}
            </button>
          </div>

          {showAdvanced && (
            <div className="space-y-4">
              <label className="block">
                <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5 flex items-center justify-between">
                  <span>FSRS-5 weights (19 numbers)</span>
                  <button
                    onClick={() => setWeightsText(JSON.stringify(DEFAULT_W))}
                    className="text-2xs uppercase tracking-widest text-saffron-300/80 hover:text-saffron-200 transition normal-case"
                  >
                    Reset to default
                  </button>
                </div>
                <textarea
                  value={weightsText}
                  onChange={e => setWeightsText(e.target.value)}
                  rows={4}
                  className="w-full bg-dark-800/30 rounded-xl px-3 py-2 text-2xs text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] font-mono leading-relaxed"
                  spellCheck={false}
                />
                {weightsError && (
                  <div className="text-2xs text-crimson-300 mt-1.5 font-light">{weightsError}</div>
                )}
                <div className="text-2xs text-dark-500 mt-2 font-light">
                  Edit only if you've optimized weights from your own review history. Defaults are the FSRS-5 paper values.
                </div>
              </label>

              <div className="rounded-xl border border-white/[0.04] bg-dark-800/20 p-4 space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="text-2xs uppercase tracking-widest text-dark-300">
                      Optimize from history
                    </div>
                    <div className="text-2xs text-dark-500 mt-1 font-light">
                      Fits the 19 weights to this deck's actual review log via gradient descent. Numerical, in-browser, ~5-10s.
                    </div>
                  </div>
                  <button
                    onClick={async () => {
                      setOptimizing(true);
                      setOptimizeProgress(null);
                      setOptimizeResult(null);
                      try {
                        const res = await optimizeFsrsWeights(id, {
                          onProgress: setOptimizeProgress,
                        });
                        setOptimizeResult(res);
                      } finally {
                        setOptimizing(false);
                      }
                    }}
                    disabled={optimizing}
                    className="btn-gradient px-3 py-1.5 rounded-lg text-2xs uppercase tracking-[0.2em] font-light disabled:opacity-50"
                  >
                    {optimizing ? 'Optimizing…' : 'Run optimizer'}
                  </button>
                </div>
                {optimizeProgress && (
                  <div className="text-2xs text-dark-500 font-mono tabular-nums">
                    Epoch {optimizeProgress.epoch} · loss = {optimizeProgress.loss.toFixed(5)}
                  </div>
                )}
                {optimizeResult && (
                  <OptimizeResultPanel
                    result={optimizeResult}
                    onAccept={() => {
                      setWeightsText(JSON.stringify(optimizeResult.optimizedWeights));
                      setOptimizeResult(null);
                    }}
                    onReject={() => setOptimizeResult(null)}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'media' && (
        <ImagesSourcePanel deckId={deck.id} />
      )}

      {tab !== 'media' && (
        <div className="flex items-center gap-3 pt-5">
          <button
            onClick={save}
            disabled={busy || !name.trim()}
            className="btn-gradient px-5 py-2 rounded-xl text-sm"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <Link
            href={`/deck/${deck.id}`}
            className="text-dark-300 hover:text-dark-100 px-3 py-1.5 text-sm transition"
          >
            Cancel
          </Link>
        </div>
      )}

      {tab === 'tuning' && report && (
        <div className="mt-6 glass-card rounded-2xl p-6 space-y-3">
          <h2 className="text-lg font-light tracking-tight text-dark-100">Schedule analysis</h2>
          {report.observedRetention === null ? (
            <p className="text-sm text-dark-400 font-light">{report.reasoning}</p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3 max-w-md">
                <Metric label="Reviews" value={String(report.totalReviews)} />
                <Metric
                  label="Observed"
                  value={`${(report.observedRetention * 100).toFixed(1)}%`}
                  tone={report.delta && report.delta < -0.02 ? 'crimson' : report.delta && report.delta > 0.02 ? 'saffron' : 'neutral'}
                />
                <Metric
                  label="FSRS predicted"
                  value={`${(report.predictedRetention! * 100).toFixed(1)}%`}
                />
              </div>
              <p className="text-sm text-dark-300 font-light">{report.reasoning}</p>
              {report.recommendedRetentionTarget !== null && (
                <div className="pt-2 flex items-center gap-3">
                  <span className="text-xs text-dark-400">
                    Recommended retention target:{' '}
                    <span className="font-mono text-saffron-300">{report.recommendedRetentionTarget.toFixed(2)}</span>
                  </span>
                  <button
                    onClick={() => {
                      setRetention(report.recommendedRetentionTarget!);
                      setRetentionOverride(true);
                    }}
                    className="px-3 py-1 rounded-md text-2xs uppercase tracking-widest bg-saffron-900/20 text-saffron-200 hover:bg-saffron-900/30 transition border border-saffron-700/30"
                  >
                    Apply
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="mt-8 pt-6 border-t border-white/[0.04]">
        {!confirmDelete ? (
          <button
            onClick={() => setConfirmDelete(true)}
            className="text-sm text-crimson-400 hover:text-crimson-300 transition"
          >
            Delete deck
          </button>
        ) : (
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm text-dark-300">
              {descendantCount > 0
                ? `Delete this deck plus ${descendantCount} sub-deck${descendantCount === 1 ? '' : 's'} (and all their cards)?`
                : 'Delete this deck and all its cards?'}
            </span>
            <button
              onClick={remove}
              className="px-4 py-1.5 rounded-lg text-sm bg-crimson-900/40 text-crimson-200 hover:bg-crimson-800/50 transition"
            >
              {descendantCount > 0 ? `Yes, delete ${descendantCount + 1} decks` : 'Yes, delete'}
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="px-4 py-1.5 rounded-lg text-sm text-dark-300 hover:text-dark-100 transition"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function DialRow({
  label, help, override, setOverride, defaultLabel, inherited, children,
}: {
  label: string;
  help: string;
  override: boolean;
  setOverride: (v: boolean) => void;
  defaultLabel: string;
  /** When set, this field has no own value but inherits from an ancestor. */
  inherited?: { value: string; sourceName: string } | null;
  children: React.ReactNode;
}) {
  // Direct-manipulation pattern: the input is always interactive. Any user
  // change auto-flips override (handled by the parent setters). The
  // right-hand label is informational when not overriding, and becomes
  // a "Reset" affordance when overriding.
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5 gap-3">
        <div className="text-2xs uppercase tracking-widest text-dark-400 shrink-0">{label}</div>
        {override ? (
          <button
            onClick={() => setOverride(false)}
            className="text-2xs uppercase tracking-widest text-saffron-300 hover:text-saffron-200 transition truncate text-right"
            title={
              inherited
                ? `Reset to inherited value from ${inherited.sourceName}.`
                : `Reset to default (${defaultLabel}).`
            }
          >
            ↺ Reset
          </button>
        ) : (
          <span
            className={cn(
              'text-2xs uppercase tracking-widest truncate text-right',
              inherited ? 'text-persian-200/80' : 'text-dark-500',
            )}
            title={
              inherited
                ? `Inheriting from ${inherited.sourceName}. Edit below to override.`
                : `Default value. Edit below to set a per-deck override.`
            }
          >
            {inherited
              ? `Inherits ${inherited.value} from ${inherited.sourceName}`
              : `Default · ${defaultLabel}`}
          </span>
        )}
      </div>
      <div className={override ? '' : 'opacity-70'}>{children}</div>
      <div className="text-2xs text-dark-500 mt-1 font-light">{help}</div>
    </div>
  );
}

function OptimizeResultPanel({
  result, onAccept, onReject,
}: {
  result: OptimizeResult;
  onAccept: () => void;
  onReject: () => void;
}) {
  if (result.insufficientData) {
    return (
      <div className="text-2xs text-crimson-300 font-light">
        Need at least {result.insufficientData.need} review-state reviews to optimize.
        You have {result.insufficientData.have}.
      </div>
    );
  }
  const improvedFraction = result.initialLoss === 0
    ? 0
    : (result.improvement / result.initialLoss);
  const meaningful = result.improvement > 0.001 && improvedFraction > 0.005;
  return (
    <div className="space-y-2 text-2xs">
      <div className="font-mono tabular-nums text-dark-300">
        Loss: <span className="text-dark-500">{result.initialLoss.toFixed(5)}</span>
        <span className="text-dark-700 mx-1.5">→</span>
        <span className={cn(meaningful ? 'text-saffron-300' : 'text-dark-400')}>
          {result.finalLoss.toFixed(5)}
        </span>
        <span className="text-dark-500 ml-2">
          ({result.improvement >= 0 ? '−' : '+'}{Math.abs(result.improvement / Math.max(1e-9, result.initialLoss) * 100).toFixed(2)}%)
        </span>
      </div>
      <div className="text-2xs text-dark-500 font-mono">
        {result.reviewsUsed} reviews · {result.epochsRun} epoch{result.epochsRun === 1 ? '' : 's'} · stop: {result.stop}
      </div>
      {!meaningful && (
        <div className="text-2xs text-dark-400 font-light">
          Improvement is small (&lt; 0.5%). Your current weights already fit this history well.
        </div>
      )}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onAccept}
          disabled={!meaningful}
          className="px-3 py-1.5 rounded-lg text-2xs uppercase tracking-[0.2em] font-light bg-persian-900/40 text-saffron-200 border border-saffron-700/30 hover:bg-persian-800/50 transition disabled:opacity-40"
        >
          Apply weights
        </button>
        <button
          onClick={onReject}
          className="px-3 py-1.5 rounded-lg text-2xs uppercase tracking-[0.2em] font-light text-dark-300 hover:text-dark-100 hover:bg-white/[0.04] transition"
        >
          Discard
        </button>
      </div>
    </div>
  );
}

function NumberInput({
  value, onChange, disabled, min, max,
}: { value: number; onChange: (n: number) => void; disabled?: boolean; min?: number; max?: number }) {
  return (
    <input
      type="number"
      value={value}
      onChange={e => onChange(parseInt(e.target.value, 10) || 0)}
      disabled={disabled}
      min={min}
      max={max}
      className="w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] focus:border-persian-500/30 font-mono tabular-nums"
    />
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'crimson' | 'saffron' | 'neutral' }) {
  const toneClass = tone === 'crimson' ? 'text-crimson-300' : tone === 'saffron' ? 'text-saffron-300' : 'text-dark-100';
  return (
    <div className="bg-dark-800/30 rounded-xl p-3 text-center">
      <div className={`text-xl font-light ${toneClass}`}>{value}</div>
      <div className="text-2xs uppercase tracking-widest text-dark-500 mt-0.5">{label}</div>
    </div>
  );
}
