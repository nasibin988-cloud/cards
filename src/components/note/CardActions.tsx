'use client';

import { useEffect, useState } from 'react';
import type { Card } from '@/lib/db/schema';
import {
  buryCard,
  listCardsByNote,
  listReviewsForCard,
  resetCardProgress,
  rescheduleCard,
  suspendCard,
  unburyCard,
  unsuspendCard,
} from '@/lib/db/queries';
import type { ReviewLog } from '@/lib/db/schema';
import { cn } from '@/lib/utils';

/**
 * Per-card actions for the note edit page. Shows one row per card on this
 * note (cloze ords or future siblings) with state, due, lapses, and the
 * suspend / bury / reset / reschedule buttons.
 */
export default function CardActions({ noteId }: { noteId: string }) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = async () => {
    setCards(await listCardsByNote(noteId));
  };

  useEffect(() => {
    let cancelled = false;
    listCardsByNote(noteId).then(c => { if (!cancelled) setCards(c); });
    return () => { cancelled = true; };
  }, [noteId]);

  const run = async (id: string, op: () => Promise<void>) => {
    setBusyId(id);
    try {
      await op();
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  if (cards === null) return null;
  if (cards.length === 0) {
    return (
      <div className="text-sm text-dark-500 font-light">
        No cards on this note yet (the note hasn't been saved or the cloze field is empty).
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {cards.map(c => (
        <CardRow key={c.id} card={c} busy={busyId === c.id} run={run} />
      ))}
    </div>
  );
}

function CardRow({
  card, busy, run,
}: {
  card: Card;
  busy: boolean;
  run: (id: string, op: () => Promise<void>) => Promise<void>;
}) {
  const [showReschedule, setShowReschedule] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<ReviewLog[] | null>(null);
  const dueDate = new Date(card.due);
  const dueLabel = formatDue(dueDate);
  const ord = card.clozeOrd != null ? `c${card.clozeOrd}` : 'card';

  const toggleHistory = async () => {
    const next = !showHistory;
    setShowHistory(next);
    if (next && history === null) {
      setHistory(await listReviewsForCard(card.id));
    }
  };

  return (
    <div className="glass-card rounded-xl px-4 py-3">
      <div className="flex items-center gap-3 flex-wrap">
        <StateBadge state={card.state} />
        <span className="text-2xs uppercase tracking-widest font-mono text-dark-500">{ord}</span>
        <span className="text-2xs uppercase tracking-widest text-dark-500">due</span>
        <span className="text-xs tabular-nums text-dark-200">{dueLabel}</span>
        {card.lapses > 0 && (
          <span className="text-2xs uppercase tracking-widest text-crimson-300/80">
            {card.lapses} lapse{card.lapses === 1 ? '' : 's'}
          </span>
        )}
        {card.suspended && <Tag color="dark">suspended</Tag>}
        {card.buried && <Tag color="persian">buried</Tag>}

        <div className="flex-1" />

        <ActionBtn
          label={card.suspended ? 'Unsuspend' : 'Suspend'}
          busy={busy}
          onClick={() => run(card.id, () => card.suspended ? unsuspendCard(card.id) : suspendCard(card.id))}
        />
        <ActionBtn
          label={card.buried ? 'Unbury' : 'Bury'}
          busy={busy}
          onClick={() => run(card.id, () => card.buried ? unburyCard(card.id) : buryCard(card.id))}
        />
        <ActionBtn
          label="Reset"
          busy={busy}
          onClick={() => run(card.id, () => resetCardProgress(card.id))}
        />
        <ActionBtn
          label={showReschedule ? 'Cancel' : 'Reschedule'}
          busy={busy}
          onClick={() => setShowReschedule(s => !s)}
        />
        <ActionBtn label={showHistory ? 'Hide history' : 'History'} busy={busy} onClick={toggleHistory} />
      </div>
      {showReschedule && (
        <RescheduleControl
          currentDue={dueDate}
          busy={busy}
          onCancel={() => setShowReschedule(false)}
          onApply={async (date) => {
            await run(card.id, () => rescheduleCard(card.id, date.getTime()));
            setShowReschedule(false);
          }}
        />
      )}
      {showHistory && (
        <HistoryTimeline history={history} reps={card.reps} />
      )}
    </div>
  );
}

const RATING_LABEL: Record<number, string> = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };
const RATING_TONE: Record<number, string> = {
  1: 'text-crimson-300',
  2: 'text-saffron-300',
  3: 'text-persian-200',
  4: 'text-saffron-200',
};

function HistoryTimeline({ history, reps }: { history: ReviewLog[] | null; reps: number }) {
  if (history === null) {
    return <div className="mt-3 pt-3 border-t border-white/[0.04] text-2xs text-dark-500">Loading history…</div>;
  }
  if (history.length === 0) {
    return (
      <div className="mt-3 pt-3 border-t border-white/[0.04] text-2xs text-dark-500">
        No reviews yet (reps: {reps}).
      </div>
    );
  }
  return (
    <div className="mt-3 pt-3 border-t border-white/[0.04]">
      <div className="text-2xs uppercase tracking-widest text-dark-500 mb-2">
        {history.length} review{history.length === 1 ? '' : 's'}
      </div>
      <ul className="space-y-1 max-h-48 overflow-y-auto pr-1">
        {history.map(log => {
          const date = new Date(log.review);
          const dateStr = date.toISOString().slice(0, 10);
          const timeStr = date.toTimeString().slice(0, 5);
          return (
            <li key={log.id} className="grid grid-cols-[5rem_3rem_5rem_3.5rem_1fr] gap-2 text-2xs items-center">
              <span className="font-mono text-dark-500">{dateStr}</span>
              <span className="font-mono text-dark-500 tabular-nums">{timeStr}</span>
              <span className={cn('font-mono uppercase tracking-widest', RATING_TONE[log.rating])}>
                {RATING_LABEL[log.rating] ?? log.rating}
              </span>
              <span className="font-mono text-dark-400 tabular-nums">
                {log.scheduledDays > 0 ? `${log.scheduledDays}d` : '—'}
              </span>
              <span className="text-dark-500 truncate">
                {log.state} · S {log.stability.toFixed(2)} · D {log.difficulty.toFixed(2)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RescheduleControl({
  currentDue, busy, onApply, onCancel,
}: {
  currentDue: Date;
  busy: boolean;
  onApply: (d: Date) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(toInputDate(currentDue));
  return (
    <div className="mt-3 pt-3 border-t border-white/[0.04] flex items-center gap-2 flex-wrap">
      <input
        type="date"
        value={value}
        onChange={e => setValue(e.target.value)}
        className="bg-dark-800/30 rounded-lg px-3 py-1.5 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04]"
      />
      <QuickDate label="Today" onPick={() => setValue(toInputDate(new Date()))} />
      <QuickDate label="+1d" onPick={() => setValue(toInputDate(addDays(new Date(), 1)))} />
      <QuickDate label="+7d" onPick={() => setValue(toInputDate(addDays(new Date(), 7)))} />
      <QuickDate label="+30d" onPick={() => setValue(toInputDate(addDays(new Date(), 30)))} />
      <button
        disabled={busy || !value}
        onClick={() => onApply(parseInputDate(value))}
        className="btn-gradient px-3 py-1.5 rounded-lg text-2xs uppercase tracking-[0.2em] font-light disabled:opacity-50"
      >
        Apply
      </button>
      <button
        disabled={busy}
        onClick={onCancel}
        className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition px-2"
      >
        Cancel
      </button>
    </div>
  );
}

function StateBadge({ state }: { state: Card['state'] }) {
  const cls = state === 'new' ? 'text-saffron-300 bg-saffron-900/20 border-saffron-700/30'
    : state === 'learning' ? 'text-crimson-200 bg-crimson-900/25 border-crimson-700/30'
    : state === 'relearning' ? 'text-crimson-300 bg-crimson-900/30 border-crimson-700/40'
    : 'text-persian-200 bg-persian-900/25 border-persian-700/30';
  return (
    <span className={cn('text-2xs uppercase tracking-widest font-mono px-2 py-0.5 rounded-md border', cls)}>
      {state}
    </span>
  );
}

function Tag({ children, color }: { children: React.ReactNode; color: 'dark' | 'persian' }) {
  const cls = color === 'persian'
    ? 'text-persian-200 bg-persian-900/25 border-persian-700/30'
    : 'text-dark-300 bg-dark-800/40 border-white/[0.06]';
  return (
    <span className={cn('text-2xs uppercase tracking-widest px-2 py-0.5 rounded-md border', cls)}>
      {children}
    </span>
  );
}

function ActionBtn({
  label, onClick, busy,
}: { label: string; onClick: () => void; busy: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="text-2xs uppercase tracking-[0.2em] font-light px-3 py-1.5 rounded-lg text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition border border-white/[0.06] disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function QuickDate({ label, onPick }: { label: string; onPick: () => void }) {
  return (
    <button
      onClick={onPick}
      className="text-2xs uppercase tracking-[0.2em] font-light px-2 py-1 rounded-md text-dark-400 hover:text-dark-100 hover:bg-white/[0.03] transition"
    >
      {label}
    </button>
  );
}

function toInputDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseInputDate(s: string): Date {
  const [y, m, d] = s.split('-').map(n => parseInt(n, 10));
  return new Date(y, m - 1, d, 4, 0, 0); // 4am, before any reasonable study window
}

function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

function formatDue(d: Date): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const diff = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff > 0 && diff < 30) return `in ${diff}d`;
  if (diff < 0 && diff > -30) return `${-diff}d ago`;
  return d.toISOString().slice(0, 10);
}
