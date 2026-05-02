'use client';

/**
 * Feynman-mode panel: shown over a card while the user is in "teach back"
 * mode. Captures their plain-language explanation (text or live voice
 * transcription), submits to Claude for grading, then renders the grade
 * before they rate the card. The chosen rating + completeness drive an
 * FSRS interval bonus via `feynmanScheduleMultiplier`.
 *
 * Self-contained: parent passes the card/note + a callback that fires when
 * the user is ready to rate. We don't directly write to the schedule;
 * the Reviewer owns that path so undo / counts / caps stay in sync.
 */

import { useEffect, useRef, useState } from 'react';
import type { Card, Note, FeynmanGrade } from '@/lib/db/schema';
import { evaluateFeynmanExplanation, feynmanScheduleMultiplier } from '@/lib/ai/feynman';
import { recordFeynmanAttempt, updateFeynmanAttempt } from '@/lib/db/queries';
import { cn } from '@/lib/utils';

type Phase =
  | { kind: 'compose' }
  | { kind: 'grading' }
  | { kind: 'graded'; grade: FeynmanGrade; attemptId: string }
  | { kind: 'error'; message: string };

interface Props {
  note: Note;
  card: Card;
  /**
   * Called when the user is ready to rate. The caller passes this rating
   * to `recordReview` along with the multiplier so the schedule reflects
   * the bonus. `attemptId` lets the caller patch the saved log row with
   * the chosen rating + applied multiplier.
   */
  onReadyToRate: (input: {
    rating: 1 | 2 | 3 | 4;
    multiplier: number;
    attemptId: string;
  }) => void;
  /** Called when the user bails out without rating. */
  onCancel: () => void;
}

export default function FeynmanPanel({ note, card, onReadyToRate, onCancel }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'compose' });
  const [text, setText] = useState('');
  const [inputMode, setInputMode] = useState<'text' | 'voice'>('text');
  const [voiceState, setVoiceState] = useState<'idle' | 'listening' | 'unsupported'>('idle');
  const [showReference, setShowReference] = useState(false);
  const startedAtRef = useRef<number>(Date.now());
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset and refocus on every new card.
  useEffect(() => {
    setPhase({ kind: 'compose' });
    setText('');
    setShowReference(false);
    startedAtRef.current = Date.now();
    setTimeout(() => textareaRef.current?.focus(), 0);
    return () => {
      try { recognitionRef.current?.stop(); } catch { /* ignore */ }
      recognitionRef.current = null;
    };
  }, [card.id]);

  const startVoice = () => {
    const Ctor = (window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    }).SpeechRecognition ?? (window as unknown as {
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    }).webkitSpeechRecognition;
    if (!Ctor) {
      setVoiceState('unsupported');
      return;
    }
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || 'en-US';
    let baseline = text;
    r.onresult = (e) => {
      let interim = '';
      let final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const transcript = e.results[i][0]?.transcript ?? '';
        if (e.results[i].isFinal) final += transcript;
        else interim += transcript;
      }
      // Append final segments to the baseline; show interim mid-stream.
      if (final) {
        baseline = (baseline ? baseline + ' ' : '') + final.trim();
      }
      setText(interim ? `${baseline} ${interim.trim()}` : baseline);
    };
    r.onerror = () => {
      setVoiceState('idle');
    };
    r.onend = () => {
      setVoiceState('idle');
      // Persist the final accumulated transcript.
      setText(baseline);
    };
    r.start();
    recognitionRef.current = r;
    setVoiceState('listening');
    setInputMode('voice');
  };

  const stopVoice = () => {
    try { recognitionRef.current?.stop(); } catch { /* ignore */ }
    recognitionRef.current = null;
    setVoiceState('idle');
  };

  const submit = async () => {
    if (text.trim().length < 5) return;
    stopVoice();
    setPhase({ kind: 'grading' });
    const durationMs = Date.now() - startedAtRef.current;
    try {
      const grade = await evaluateFeynmanExplanation(note.id, card.id, text);
      // Persist the attempt + grade. We patch the record on rate with the
      // applied multiplier so the log fully captures the round-trip.
      const log = await recordFeynmanAttempt({
        cardId: card.id,
        noteId: note.id,
        deckId: card.deckId,
        explanation: text,
        inputMode,
        durationMs,
        grade,
      });
      setPhase({ kind: 'graded', grade, attemptId: log.id });
    } catch (e) {
      setPhase({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const skipGrade = async () => {
    // User chose to bypass AI grading and just see the back. Still log the
    // attempt so we have a record; no multiplier applies.
    stopVoice();
    const durationMs = Date.now() - startedAtRef.current;
    const log = await recordFeynmanAttempt({
      cardId: card.id,
      noteId: note.id,
      deckId: card.deckId,
      explanation: text,
      inputMode,
      durationMs,
    });
    // Synthesize a zero-completeness grade so the UI shows reference and lets
    // the user rate; multiplier resolves to 1.0 (no bonus).
    setPhase({
      kind: 'graded',
      grade: { covered: [], missed: [], vague: [], completeness: 0, rationale: 'Skipped grading.' },
      attemptId: log.id,
    });
  };

  const rate = async (rating: 1 | 2 | 3 | 4) => {
    if (phase.kind !== 'graded') return;
    const multiplier = feynmanScheduleMultiplier(rating, phase.grade.completeness);
    await updateFeynmanAttempt(phase.attemptId, { rating, scheduleMultiplier: multiplier });
    onReadyToRate({ rating, multiplier, attemptId: phase.attemptId });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="text-2xs uppercase tracking-widest font-mono text-saffron-300">
          Feynman mode · teach this back
        </h2>
        <button
          onClick={() => { stopVoice(); onCancel(); }}
          className="text-2xs uppercase tracking-widest text-dark-400 hover:text-dark-100 transition"
        >
          Exit · Esc
        </button>
      </div>

      {phase.kind === 'compose' && (
        <>
          <p className="text-sm text-dark-300 font-light">
            Explain this card in plain language, as if teaching a curious friend who&apos;s never heard of it. The AI grader checks what you covered, what you missed, and what was hand-waved.
          </p>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            rows={6}
            placeholder="When you push something across the floor, you give it kinetic energy. Work is the dot product of force and displacement…"
            className="w-full bg-dark-800/30 rounded-xl px-4 py-3 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] resize-none font-light"
          />
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              {voiceState === 'listening' ? (
                <button
                  onClick={stopVoice}
                  className="text-2xs uppercase tracking-widest font-light px-3 py-1.5 rounded-lg bg-crimson-900/40 text-crimson-200 border border-crimson-700/30 hover:bg-crimson-800/50 transition"
                >
                  ◼ Stop voice
                </button>
              ) : (
                <button
                  onClick={startVoice}
                  disabled={voiceState === 'unsupported'}
                  title={voiceState === 'unsupported' ? 'Web Speech API not available in this browser' : ''}
                  className={cn(
                    'text-2xs uppercase tracking-widest font-light px-3 py-1.5 rounded-lg border transition',
                    voiceState === 'unsupported'
                      ? 'text-dark-600 border-white/[0.04] cursor-not-allowed'
                      : 'text-persian-200 border-persian-700/40 hover:bg-persian-900/20',
                  )}
                >
                  ● Speak
                </button>
              )}
              <span className="text-2xs text-dark-500 font-mono tabular-nums">
                {text.trim().split(/\s+/).filter(Boolean).length} words
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={skipGrade}
                disabled={text.trim().length < 5}
                className="text-2xs uppercase tracking-widest text-dark-400 hover:text-dark-100 transition px-3 py-1.5 rounded-lg disabled:opacity-40"
              >
                Skip grading
              </button>
              <button
                onClick={submit}
                disabled={text.trim().length < 5}
                className="btn-gradient px-4 py-2 rounded-lg text-2xs uppercase tracking-[0.2em] font-light disabled:opacity-40"
              >
                Submit · ⌘↵
              </button>
            </div>
          </div>
        </>
      )}

      {phase.kind === 'grading' && (
        <div className="text-sm text-dark-300 font-light loading-shimmer rounded-xl bg-dark-800/30 px-4 py-3">
          Grading your explanation…
        </div>
      )}

      {phase.kind === 'error' && (
        <div className="space-y-3">
          <div className="text-sm text-crimson-300 font-light bg-crimson-900/20 border border-crimson-700/30 rounded-xl px-4 py-3">
            {phase.message}
          </div>
          <button
            onClick={() => setPhase({ kind: 'compose' })}
            className="text-2xs uppercase tracking-widest text-dark-300 hover:text-dark-100 transition"
          >
            ← Back to your explanation
          </button>
        </div>
      )}

      {phase.kind === 'graded' && (
        <GradeView
          grade={phase.grade}
          showReference={showReference}
          onToggleReference={() => setShowReference(s => !s)}
          onRate={rate}
        />
      )}
    </div>
  );
}

function GradeView({
  grade, showReference, onToggleReference, onRate,
}: {
  grade: FeynmanGrade;
  showReference: boolean;
  onToggleReference: () => void;
  onRate: (rating: 1 | 2 | 3 | 4) => void;
}) {
  // Completeness % drives the bonus preview shown alongside the rating row.
  const pct = Math.round(grade.completeness * 100);
  const goodMult = feynmanScheduleMultiplier(3, grade.completeness);
  const easyMult = feynmanScheduleMultiplier(4, grade.completeness);
  const hasBonus = goodMult > 1 || easyMult > 1;
  return (
    <div className="space-y-4">
      {grade.rationale && (
        <div className="text-sm font-light text-dark-200 bg-dark-800/30 border border-white/[0.04] rounded-xl px-4 py-3">
          {grade.rationale}
        </div>
      )}
      <div className="grid md:grid-cols-3 gap-3">
        <GradeColumn label="Covered" tone="saffron" items={grade.covered} />
        <GradeColumn label="Missed" tone="crimson" items={grade.missed} />
        <GradeColumn label="Vague" tone="persian" items={grade.vague} />
      </div>
      <div className="text-2xs text-dark-500 font-mono tabular-nums">
        Completeness <span className="text-saffron-300">{pct}%</span>
        {hasBonus && (
          <>
            {' '}· Schedule bonus on Good <span className="text-saffron-300">{goodMult.toFixed(2)}×</span>
            {' '}/ Easy <span className="text-saffron-300">{easyMult.toFixed(2)}×</span>
          </>
        )}
      </div>
      <button
        onClick={onToggleReference}
        className="text-2xs uppercase tracking-widest text-persian-200/80 hover:text-persian-100 transition"
      >
        {showReference ? '− Hide reference' : '+ Show reference (click to compare)'}
      </button>
      <div className="pt-2 border-t border-white/[0.04]">
        <div className="text-2xs uppercase tracking-widest text-dark-500 mb-2">Rate this card</div>
        <div className="grid grid-cols-4 gap-2">
          <RateButton onClick={() => onRate(1)} label="Again" tone="crimson" />
          <RateButton onClick={() => onRate(2)} label="Hard" tone="saffron-dim" />
          <RateButton onClick={() => onRate(3)} label="Good" tone="saffron" />
          <RateButton onClick={() => onRate(4)} label="Easy" tone="persian" />
        </div>
      </div>
    </div>
  );
}

function GradeColumn({
  label, tone, items,
}: {
  label: string;
  tone: 'saffron' | 'crimson' | 'persian';
  items: string[];
}) {
  const head =
    tone === 'saffron' ? 'text-saffron-300' :
    tone === 'crimson' ? 'text-crimson-300' :
    'text-persian-200';
  return (
    <div className="bg-dark-800/30 border border-white/[0.04] rounded-xl p-3 space-y-2 min-h-[6rem]">
      <div className={cn('text-2xs uppercase tracking-widest font-mono', head)}>{label}</div>
      {items.length === 0 ? (
        <div className="text-2xs text-dark-600 font-light italic">—</div>
      ) : (
        <ul className="space-y-1">
          {items.map((s, i) => (
            <li key={i} className="text-2xs text-dark-200 font-light leading-snug">• {s}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RateButton({
  onClick, label, tone,
}: {
  onClick: () => void;
  label: string;
  tone: 'crimson' | 'saffron-dim' | 'saffron' | 'persian';
}) {
  const cls =
    tone === 'crimson' ? 'bg-crimson-900/40 text-crimson-200 border-crimson-700/30 hover:bg-crimson-800/50' :
    tone === 'saffron-dim' ? 'bg-saffron-900/30 text-saffron-200 border-saffron-700/30 hover:bg-saffron-800/40' :
    tone === 'saffron' ? 'bg-saffron-700/40 text-saffron-100 border-saffron-600/40 hover:bg-saffron-700/60' :
    'bg-persian-900/40 text-persian-100 border-persian-700/40 hover:bg-persian-800/50';
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-lg border px-3 py-2 text-sm font-light tracking-tight transition',
        cls,
      )}
    >
      {label}
    </button>
  );
}

/* ─── Web Speech API minimal types ────────────────────────────── */

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: Event) => void) | null;
  onend: ((e: Event) => void) | null;
  start: () => void;
  stop: () => void;
};
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
};
type SpeechRecognitionResultListLike = {
  length: number;
  [index: number]: {
    isFinal: boolean;
    [index: number]: { transcript: string };
  };
};
