'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  Deck,
  PodcastAudioStyle,
  PodcastDepth,
  PodcastHorizon,
  PodcastMode,
  PodcastTtsProvider,
} from '@/lib/db/schema';
import { listDecks, listTagsInDeck } from '@/lib/db/queries';
import { getOpenAIKey } from '@/lib/openai-key';
import { getSetting } from '@/lib/db/queries';
import { buildPodcast, type BuildEvent } from '@/lib/podcast/build';
import { estimateCostUsd, type OpenAITtsModel, type OpenAIVoice } from '@/lib/podcast/tts-openai';
import { WORDS_PER_MINUTE } from '@/lib/podcast/plan';
import { cn } from '@/lib/utils';

interface LengthChoice { label: string; seconds: number }

const LENGTHS: LengthChoice[] = [
  { label: '15 min', seconds: 15 * 60 },
  { label: '30 min', seconds: 30 * 60 },
  { label: '1 hr',   seconds: 60 * 60 },
  { label: '2 hr',   seconds: 120 * 60 },
  { label: '4 hr',   seconds: 240 * 60 },
];

const REVIEW_HORIZONS: Array<{ key: PodcastHorizon; label: string; hint: string }> = [
  { key: 'today',    label: 'Today',     hint: 'whatever FSRS would serve right now' },
  { key: 'tomorrow', label: 'Tomorrow',  hint: 'today plus tomorrow\'s due cards + intake' },
  { key: 'week',     label: 'Next 7 d',  hint: 'everything that would land this week' },
];

const PREVIEW_HORIZONS: Array<{ key: PodcastHorizon; label: string; hint: string }> = [
  { key: 'new-only', label: 'New only', hint: 'cards you haven\'t seen yet' },
  { key: 'all',      label: 'All',      hint: 'every non-suspended card in the deck(s)' },
];

const DEPTHS: Array<{ key: PodcastDepth | 'auto'; label: string; hint: string }> = [
  { key: 'auto',     label: 'Auto',     hint: 'pick depth per segment from words-per-card' },
  { key: 'flash',    label: 'Flash',    hint: 'theme + mention, no mechanism' },
  { key: 'standard', label: 'Standard', hint: 'mechanism summary per card' },
  { key: 'deep',     label: 'Deep',     hint: 'full mechanism + analogy + why' },
];

const VOICES: OpenAIVoice[] = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

export default function PodcastBuilder({ onCreated }: { onCreated?: () => void }) {
  const router = useRouter();
  const [decks, setDecks] = useState<Deck[]>([]);
  const [selectedDecks, setSelectedDecks] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<PodcastMode>('review');
  const [horizon, setHorizon] = useState<PodcastHorizon>('tomorrow');
  const [seconds, setSeconds] = useState<number>(30 * 60);
  const [customMinutes, setCustomMinutes] = useState<string>('');
  const [depthChoice, setDepthChoice] = useState<PodcastDepth | 'auto'>('auto');
  const [provider, setProvider] = useState<PodcastTtsProvider>('openai');
  const [voiceA, setVoiceA] = useState<OpenAIVoice>('alloy');
  const [voiceB, setVoiceB] = useState<OpenAIVoice>('onyx');
  const [ttsModel, setTtsModel] = useState<OpenAITtsModel>('gpt-4o-mini-tts');
  const [audioStyle, setAudioStyle] = useState<PodcastAudioStyle>('none');
  const [tagOptions, setTagOptions] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [hasOpenAIKey, setHasOpenAIKey] = useState<boolean | null>(null);
  const [hasClaudeKey, setHasClaudeKey] = useState<boolean | null>(null);
  const [running, setRunning] = useState(false);
  const [event, setEvent] = useState<BuildEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abortCtrl, setAbortCtrl] = useState<AbortController | null>(null);

  useEffect(() => {
    listDecks().then(setDecks);
    Promise.all([getOpenAIKey(), getSetting('claude_api_key')]).then(([oa, cl]) => {
      setHasOpenAIKey(!!oa);
      setHasClaudeKey(!!cl);
    });
  }, []);

  // Reload tags when deck selection changes (preview mode only uses them
  // but loading them in review mode doesn't hurt and pre-warms the cache).
  useEffect(() => {
    if (selectedDecks.size === 0) { setTagOptions([]); return; }
    let cancelled = false;
    Promise.all([...selectedDecks].map(id => listTagsInDeck(id, true))).then(lists => {
      if (cancelled) return;
      const u = new Set<string>();
      for (const l of lists) for (const t of l) u.add(t);
      setTagOptions([...u].sort());
      // Drop tags from selection that no longer apply.
      setSelectedTags(prev => {
        const next = new Set<string>();
        for (const t of prev) if (u.has(t)) next.add(t);
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [selectedDecks]);

  // When the mode toggles, snap the horizon to a sensible default.
  useEffect(() => {
    if (mode === 'review' && !REVIEW_HORIZONS.find(h => h.key === horizon)) {
      setHorizon('tomorrow');
    }
    if (mode === 'preview' && !PREVIEW_HORIZONS.find(h => h.key === horizon)) {
      setHorizon('new-only');
    }
  }, [mode, horizon]);

  const targetWords = useMemo(
    () => Math.round((seconds / 60) * WORDS_PER_MINUTE),
    [seconds],
  );

  const estCost = provider === 'openai'
    ? estimateCostUsd(' '.repeat(Math.round(targetWords * 5.5)), ttsModel)
    : 0;

  const canGenerate =
    selectedDecks.size > 0
    && seconds > 0
    && !running
    && hasClaudeKey === true
    && (provider === 'browser' || hasOpenAIKey === true)
    && voiceA !== voiceB;

  const toggleDeck = (id: string) => {
    setSelectedDecks(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectAll = () => setSelectedDecks(new Set(decks.map(d => d.id)));
  const clearAll  = () => setSelectedDecks(new Set());
  const toggleTag = (t: string) => {
    setSelectedTags(prev => {
      const n = new Set(prev);
      if (n.has(t)) n.delete(t); else n.add(t);
      return n;
    });
  };

  const applyCustom = () => {
    const n = parseFloat(customMinutes);
    if (!Number.isFinite(n) || n <= 0) return;
    const clamped = Math.max(1, Math.min(240, n));
    setSeconds(Math.round(clamped * 60));
  };

  const onGenerate = async () => {
    setRunning(true);
    setError(null);
    setEvent({ stage: 'projecting' });
    const ctrl = new AbortController();
    setAbortCtrl(ctrl);
    try {
      const result = await buildPodcast(
        {
          deckIds: [...selectedDecks],
          mode,
          horizon,
          tagFilter: mode === 'preview' && selectedTags.size > 0 ? [...selectedTags] : undefined,
          targetSeconds: seconds,
          depthOverride: depthChoice === 'auto' ? null : depthChoice,
          ttsProvider: provider,
          voiceA: provider === 'openai' ? voiceA : undefined,
          voiceB: provider === 'openai' ? voiceB : undefined,
          ttsModel: provider === 'openai' ? ttsModel : undefined,
          audioStyle,
          signal: ctrl.signal,
        },
        ev => setEvent(ev),
      );
      onCreated?.();
      router.push(`/podcast/${result.podcastId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Build cancelled') {
        setError('Cancelled.');
      } else {
        setError(msg);
      }
      setRunning(false);
      setAbortCtrl(null);
    }
  };

  const onCancel = () => {
    abortCtrl?.abort();
  };

  const horizons = mode === 'review' ? REVIEW_HORIZONS : PREVIEW_HORIZONS;

  return (
    <div className="glass-card rounded-3xl p-6 md:p-8 space-y-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-2xl md:text-3xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
          New podcast
        </h2>
        <span className="text-2xs uppercase tracking-widest text-dark-500 font-mono">
          {targetWords.toLocaleString()} words · ~{Math.round(seconds / 60)} min
          {provider === 'openai' && estCost > 0 ? ` · ~$${estCost.toFixed(2)}` : ''}
        </span>
      </div>

      <Section title="Mode">
        <ChipRow>
          <Chip active={mode === 'review'} onClick={() => setMode('review')} title="Cards FSRS will surface for review; AI picks">
            Review
          </Chip>
          <Chip active={mode === 'preview'} onClick={() => setMode('preview')} title="Cards you want to learn fresh; you pick">
            Preview
          </Chip>
        </ChipRow>
        <div className="mt-2 text-2xs text-dark-500 font-light">
          {mode === 'review'
            ? 'AI picks cards based on FSRS state. Useful for the night before review.'
            : 'You scope the cards (new only / by tag). Useful for material you plan to learn fresh tomorrow.'}
        </div>
      </Section>

      <Section title="Decks">
        <div className="flex items-center gap-2 mb-2">
          <button type="button" onClick={selectAll} className="text-2xs uppercase tracking-widest text-dark-400 hover:text-saffron-300 transition font-mono">select all</button>
          <span className="text-dark-700">·</span>
          <button type="button" onClick={clearAll} className="text-2xs uppercase tracking-widest text-dark-400 hover:text-saffron-300 transition font-mono">clear</button>
          <span className="text-2xs text-dark-500 ml-auto font-mono">{selectedDecks.size}/{decks.length}</span>
        </div>
        <div className="max-h-56 overflow-y-auto rounded-xl border border-white/[0.04] bg-dark-800/30 p-2 space-y-0.5">
          {decks.length === 0 ? (
            <div className="text-sm text-dark-500 font-light p-3">No decks yet.</div>
          ) : decks.map(d => (
            <label key={d.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.03] cursor-pointer">
              <input type="checkbox" checked={selectedDecks.has(d.id)} onChange={() => toggleDeck(d.id)} className="accent-saffron-500" />
              <span className="text-sm text-dark-100 font-light flex-1 truncate">{d.name}</span>
            </label>
          ))}
        </div>
      </Section>

      <Section title="Horizon">
        <ChipRow>
          {horizons.map(h => (
            <Chip key={h.key} active={horizon === h.key} onClick={() => setHorizon(h.key)} title={h.hint}>
              {h.label}
            </Chip>
          ))}
        </ChipRow>
      </Section>

      {mode === 'preview' && tagOptions.length > 0 && (
        <Section title="Filter by tags">
          <div className="flex items-center gap-2 mb-2">
            <button
              type="button"
              onClick={() => setSelectedTags(new Set())}
              className="text-2xs uppercase tracking-widest text-dark-400 hover:text-saffron-300 transition font-mono"
            >
              clear
            </button>
            <span className="text-2xs text-dark-500 ml-auto font-mono">
              {selectedTags.size}/{tagOptions.length}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
            {tagOptions.map(t => (
              <Chip key={t} active={selectedTags.has(t)} onClick={() => toggleTag(t)} small>
                {t}
              </Chip>
            ))}
          </div>
          <div className="mt-1 text-2xs text-dark-500 font-light">
            When tags are selected, only cards carrying at least one of them are narrated.
          </div>
        </Section>
      )}

      <Section title="Length">
        <ChipRow>
          {LENGTHS.map(l => (
            <Chip key={l.seconds} active={seconds === l.seconds} onClick={() => setSeconds(l.seconds)}>
              {l.label}
            </Chip>
          ))}
          <div className="flex items-center gap-1.5 ml-1">
            <input
              type="number"
              min={1}
              max={240}
              placeholder="custom"
              value={customMinutes}
              onChange={e => setCustomMinutes(e.target.value)}
              onBlur={applyCustom}
              onKeyDown={e => e.key === 'Enter' && applyCustom()}
              className="w-20 px-2.5 py-1.5 rounded-lg text-sm bg-dark-800/30 border border-white/[0.04] focus:bg-dark-800/50 focus:outline-none text-dark-100 font-light"
            />
            <span className="text-2xs text-dark-500 font-mono uppercase tracking-widest">min</span>
          </div>
        </ChipRow>
      </Section>

      <Section title="Depth">
        <ChipRow>
          {DEPTHS.map(d => (
            <Chip key={d.key} active={depthChoice === d.key} onClick={() => setDepthChoice(d.key)} title={d.hint}>
              {d.label}
            </Chip>
          ))}
        </ChipRow>
      </Section>

      <Section title="Voices">
        <ChipRow>
          <Chip
            active={provider === 'openai' && ttsModel === 'gpt-4o-mini-tts'}
            onClick={() => { setProvider('openai'); setTtsModel('gpt-4o-mini-tts'); }}
            title="Newest OpenAI model. Accepts tone instructions, sounds noticeably more conversational than tts-1/hd. Recommended."
          >
            OpenAI 4o-mini (best)
          </Chip>
          <Chip active={provider === 'openai' && ttsModel === 'tts-1'} onClick={() => { setProvider('openai'); setTtsModel('tts-1'); }}>
            OpenAI tts-1
          </Chip>
          <Chip active={provider === 'openai' && ttsModel === 'tts-1-hd'} onClick={() => { setProvider('openai'); setTtsModel('tts-1-hd'); }}>
            OpenAI HD
          </Chip>
          <Chip active={provider === 'browser'} onClick={() => setProvider('browser')}>
            Browser (single voice, robotic)
          </Chip>
        </ChipRow>
        {provider === 'openai' && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <VoicePicker label="Voice A (curious)" value={voiceA} onChange={setVoiceA} other={voiceB} />
            <VoicePicker label="Voice B (methodical)" value={voiceB} onChange={setVoiceB} other={voiceA} />
          </div>
        )}
        {provider === 'openai' && voiceA === voiceB && (
          <div className="mt-2 text-2xs text-saffron-300 font-mono uppercase tracking-widest">
            pick two different voices
          </div>
        )}
      </Section>

      <Section title="Audio finishing (optional)">
        <ChipRow>
          <Chip active={audioStyle === 'none'} onClick={() => setAudioStyle('none')}>None</Chip>
          <Chip active={audioStyle === 'bumpers'} onClick={() => setAudioStyle('bumpers')} title="Soft chime between segments">
            Bumpers
          </Chip>
          <Chip active={audioStyle === 'bed'} onClick={() => setAudioStyle('bed')} title="Low-volume ambient drone under narration">
            Bed
          </Chip>
          <Chip active={audioStyle === 'both'} onClick={() => setAudioStyle('both')}>Both</Chip>
        </ChipRow>
      </Section>

      {(hasClaudeKey === false || (provider === 'openai' && hasOpenAIKey === false)) && (
        <div className="text-sm text-saffron-300 font-light px-3 py-2.5 rounded-xl bg-saffron-900/15 border border-saffron-900/30">
          {hasClaudeKey === false && (<div>Add a Claude API key in Settings to plan and write podcasts.</div>)}
          {provider === 'openai' && hasOpenAIKey === false && (<div>Add an OpenAI API key in Settings for OpenAI audio (or switch voices to Browser).</div>)}
        </div>
      )}

      {error && (
        <div className="text-sm text-red-300 font-light px-3 py-2.5 rounded-xl bg-red-900/15 border border-red-900/30">
          {error}
        </div>
      )}

      {running && event && <ProgressLine event={event} />}

      <div className="flex items-center justify-end gap-3 pt-1">
        {running && (
          <button type="button" onClick={onCancel} className="px-4 py-2.5 rounded-xl text-sm text-dark-300 hover:text-red-300 transition border border-white/[0.06]">
            Cancel
          </button>
        )}
        <button type="button" onClick={onGenerate} disabled={!canGenerate} className="btn-gradient px-6 py-2.5 rounded-xl text-sm disabled:opacity-50 disabled:cursor-not-allowed">
          {running ? 'Building…' : 'Generate'}
        </button>
      </div>
    </div>
  );
}

function VoicePicker({
  label, value, onChange, other,
}: {
  label: string;
  value: OpenAIVoice;
  onChange: (v: OpenAIVoice) => void;
  other: OpenAIVoice;
}) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-widest text-dark-500 mb-1 font-mono">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {VOICES.map(v => (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            className={cn(
              'px-2.5 py-1 rounded-lg text-2xs font-mono uppercase tracking-widest transition border',
              value === v
                ? 'bg-saffron-900/40 text-saffron-200 border-saffron-700/40'
                : v === other
                  ? 'bg-dark-800/20 text-dark-600 border-white/[0.04] cursor-not-allowed'
                  : 'bg-dark-800/30 text-dark-300 border-white/[0.04] hover:text-dark-100 hover:bg-white/[0.04]',
            )}
            disabled={v === other}
          >
            {v}
          </button>
        ))}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-2xs uppercase tracking-widest text-dark-500 mb-2 font-mono">{title}</h3>
      {children}
    </div>
  );
}

function ChipRow({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-1.5 flex-wrap">{children}</div>;
}

function Chip({
  active, onClick, children, title, small,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
  small?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'rounded-lg transition border',
        small ? 'px-2.5 py-1 text-2xs font-mono uppercase tracking-widest' : 'px-3 py-1.5 text-sm font-light',
        active
          ? 'bg-saffron-900/40 text-saffron-200 border-saffron-700/40 shadow-inner'
          : 'bg-dark-800/30 text-dark-300 border-white/[0.04] hover:text-dark-100 hover:bg-white/[0.04]',
      )}
    >
      {children}
    </button>
  );
}

function ProgressLine({ event }: { event: BuildEvent }) {
  // With the pipelined orchestrator, scripting and rendering interleave,
  // so we show ONE progress bar driven by rendered/total (the slower
  // pool) plus a sub-label exposing the script pool's progress too.
  const message = (() => {
    switch (event.stage) {
      case 'projecting': return 'Pulling cards in scope…';
      case 'planning':   return `Planning structure (${event.cardCount} cards)…`;
      case 'planned':    return `Plan ready: ${event.plan.segments.length} segments, ~$${event.estCostUsd.toFixed(2)}. Building…`;
      case 'progress':   return `Writing ${event.scriptedDone}/${event.total} · Rendering ${event.renderedDone}/${event.total}`;
      case 'ready':      return 'Ready. Opening player…';
      case 'aborted':    return 'Build cancelled.';
      case 'error':      return `Error: ${event.message}`;
    }
  })();
  const progress = event.stage === 'progress'
    ? Math.round((event.renderedDone / Math.max(event.total, 1)) * 100)
    : null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-2xs uppercase tracking-widest font-mono">
        <span className="text-saffron-300">{message}</span>
        {progress !== null && <span className="text-dark-400">{progress}%</span>}
      </div>
      <div className="h-1 rounded-full bg-dark-800/60 overflow-hidden">
        <div className="h-full bg-gradient-to-r from-saffron-500 to-persian-500 transition-all" style={{ width: progress !== null ? `${progress}%` : '8%' }} />
      </div>
    </div>
  );
}
