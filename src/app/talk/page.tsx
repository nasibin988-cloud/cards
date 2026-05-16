'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Deck, PodcastHorizon, TalkSession } from '@/lib/db/schema';
import { listDecks, getSetting } from '@/lib/db/queries';
import { getOpenAIKey } from '@/lib/openai-key';
import { createTalkSession, deleteTalkSession, listTalkSessions } from '@/lib/db/talk-queries';
import { id as ulid } from '@/lib/ulid';
import { cn } from '@/lib/utils';

const HORIZONS: Array<{ key: PodcastHorizon; label: string; hint: string }> = [
  { key: 'today',    label: 'Today',     hint: 'cards FSRS would serve right now' },
  { key: 'tomorrow', label: 'Tomorrow',  hint: 'today + tomorrow\'s reviews + intake' },
  { key: 'week',     label: 'Next 7 d',  hint: 'next-7-day surface' },
  { key: 'new-only', label: 'New only',  hint: 'unseen cards in the deck(s)' },
  { key: 'all',      label: 'All',       hint: 'everything in the deck(s)' },
];

const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const;

export default function TalkIndex() {
  const router = useRouter();
  const [decks, setDecks] = useState<Deck[]>([]);
  const [sessions, setSessions] = useState<TalkSession[]>([]);
  const [selectedDecks, setSelectedDecks] = useState<Set<string>>(new Set());
  const [horizon, setHorizon] = useState<PodcastHorizon>('tomorrow');
  const [voice, setVoice] = useState<typeof VOICES[number]>('nova');
  const [hasOpenAI, setHasOpenAI] = useState<boolean | null>(null);
  const [hasClaude, setHasClaude] = useState<boolean | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listDecks().then(setDecks);
    listTalkSessions().then(setSessions);
    Promise.all([getOpenAIKey(), getSetting('claude_api_key')]).then(([oa, cl]) => {
      setHasOpenAI(!!oa);
      setHasClaude(!!cl);
    });
  }, []);

  const toggleDeck = (id: string) => {
    setSelectedDecks(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const canStart = selectedDecks.size > 0 && hasOpenAI === true && hasClaude === true && !starting;

  const onStart = async () => {
    setStarting(true);
    setError(null);
    try {
      const sessionId = ulid();
      const names = decks
        .filter(d => selectedDecks.has(d.id))
        .map(d => d.name);
      const name = names.length === 1
        ? names[0]
        : `${names.slice(0, 2).join(' + ')}${names.length > 2 ? ', …' : ''}`;
      await createTalkSession({
        id: sessionId,
        name,
        deckIds: [...selectedDecks],
        horizon,
        voice,
        ttsModel: 'gpt-4o-mini-tts',
      });
      router.push(`/talk/${sessionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm('Delete this session and its transcript?')) return;
    await deleteTalkSession(id);
    listTalkSessions().then(setSessions);
  };

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-6 md:py-10 space-y-8">
      <div className="space-y-2">
        <h1 className="text-3xl md:text-4xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
          Talk
        </h1>
        <p className="text-sm text-dark-300 font-light max-w-xl">
          Have a Socratic conversation about a deck. Hold Space to speak, release to send.
          The study partner asks, probes, and walks through the material with you.
        </p>
      </div>

      <div className="glass-card rounded-3xl p-6 md:p-8 space-y-5">
        <h2 className="text-2xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
          New session
        </h2>

        <div>
          <h3 className="text-2xs uppercase tracking-widest text-dark-500 mb-2 font-mono">Decks</h3>
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
        </div>

        <div>
          <h3 className="text-2xs uppercase tracking-widest text-dark-500 mb-2 font-mono">Curriculum scope</h3>
          <div className="flex items-center gap-1.5 flex-wrap">
            {HORIZONS.map(h => (
              <Chip key={h.key} active={horizon === h.key} onClick={() => setHorizon(h.key)} title={h.hint}>
                {h.label}
              </Chip>
            ))}
          </div>
        </div>

        <div>
          <h3 className="text-2xs uppercase tracking-widest text-dark-500 mb-2 font-mono">Voice (study partner)</h3>
          <div className="flex items-center gap-1.5 flex-wrap">
            {VOICES.map(v => (
              <Chip key={v} active={voice === v} onClick={() => setVoice(v)} small>
                {v}
              </Chip>
            ))}
          </div>
        </div>

        {(hasOpenAI === false || hasClaude === false) && (
          <div className="text-sm text-saffron-300 font-light px-3 py-2.5 rounded-xl bg-saffron-900/15 border border-saffron-900/30">
            Talk needs both keys in Settings: Claude (for the partner) and OpenAI (for STT and voice).
          </div>
        )}

        {error && (
          <div className="text-sm text-red-300 font-light px-3 py-2.5 rounded-xl bg-red-900/15 border border-red-900/30">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end pt-1">
          <button
            type="button"
            onClick={onStart}
            disabled={!canStart}
            className="btn-gradient px-6 py-2.5 rounded-xl text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {starting ? 'Starting…' : 'Start session'}
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-2xs uppercase tracking-widest text-dark-500 font-mono">Past sessions</h2>
        {sessions.length === 0 ? (
          <div className="glass-card rounded-3xl p-6 text-sm text-dark-400 font-light">No sessions yet.</div>
        ) : (
          <ul className="space-y-2">
            {sessions.map(s => (
              <li key={s.id} className="glass-card glass-card-hover rounded-2xl p-4 flex items-center gap-4">
                <Link href={`/talk/${s.id}`} className="flex-1 min-w-0">
                  <div className="text-sm text-dark-100 font-light truncate">{s.name}</div>
                  <div className="text-2xs text-dark-500 font-mono mt-0.5 flex items-center gap-2 flex-wrap">
                    <span>{s.turns.length} turns</span>
                    <span className="text-dark-700">·</span>
                    <span>{new Date(s.startedAt).toLocaleString()}</span>
                    {s.endedAt && (
                      <>
                        <span className="text-dark-700">·</span>
                        <span>ended</span>
                      </>
                    )}
                  </div>
                </Link>
                <button
                  type="button"
                  onClick={() => onDelete(s.id)}
                  className="text-2xs uppercase tracking-widest font-mono text-dark-500 hover:text-red-300 transition px-2"
                >
                  delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
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
