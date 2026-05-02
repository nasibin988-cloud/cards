'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Card, Note, Rating } from '@/lib/db/schema';
import { gradeAnswer, type GraderResult } from '@/lib/ai/grader';
import { cn } from '@/lib/utils';

interface Props {
  note: Note;
  card: Card;
  onRate: (rating: Rating) => void;
}

const RATING_LABELS: Record<Rating, string> = {
  1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy',
};

export default function TypeAnswer({ note, card, onRate }: Props) {
  const [text, setText] = useState('');
  const [grading, setGrading] = useState(false);
  const [result, setResult] = useState<GraderResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Voice capture: Web Speech API. The mic button toggles recording; partial
  // transcripts stream into the textarea so the user can see what the model
  // heard. Final result remains editable before grading.
  const [recording, setRecording] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const supportsSpeech = typeof window !== 'undefined' && getRecognitionCtor() !== null;

  useEffect(() => {
    return () => {
      try { recognitionRef.current?.stop(); } catch { /* ignore */ }
    };
  }, []);

  const toggleRecord = () => {
    if (recording) {
      try { recognitionRef.current?.stop(); } catch { /* ignore */ }
      recognitionRef.current = null;
      setRecording(false);
      return;
    }
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError('Voice not supported in this browser.');
      return;
    }
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-US';
    r.onresult = (e: SpeechRecognitionEventLike) => {
      let acc = '';
      for (let i = 0; i < e.results.length; i++) {
        acc += e.results[i][0].transcript;
      }
      setText(acc.trim());
    };
    r.onerror = (e: Event) => {
      const ev = e as { error?: string };
      if (ev.error && ev.error !== 'no-speech' && ev.error !== 'aborted') {
        setError(`Voice: ${ev.error}`);
      }
      setRecording(false);
    };
    r.onend = () => setRecording(false);
    try { r.start(); } catch { /* ignore double-start */ }
    recognitionRef.current = r;
    setRecording(true);
  };

  const submit = async () => {
    if (!text.trim() || grading) return;
    setGrading(true);
    setError(null);
    try {
      const r = await gradeAnswer(note, card, text);
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGrading(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  if (result) {
    return (
      <div className="glass-card rounded-2xl p-5 space-y-4 max-w-2xl mx-auto w-full">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-2xs uppercase tracking-widest text-dark-500 mb-1">AI suggested rating</div>
            <div className={cn(
              'text-2xl font-extralight tracking-tight',
              result.rating === 1 && 'text-crimson-300',
              result.rating === 2 && 'text-saffron-300',
              result.rating === 3 && 'text-persian-200',
              result.rating === 4 && 'text-saffron-200',
            )}>
              {RATING_LABELS[result.rating]}
            </div>
          </div>
          <div className="text-2xs uppercase tracking-widest text-dark-500 font-mono">
            {result.matched ? 'matched' : 'mismatch'}
          </div>
        </div>
        <div className="text-sm font-light text-dark-100 italic">
          {result.critique}
        </div>
        <div className="grid grid-cols-4 gap-2">
          {([1, 2, 3, 4] as const).map(r => (
            <button
              key={r}
              onClick={() => onRate(r)}
              className={cn(
                'py-2 rounded-xl text-sm font-light border transition',
                result.rating === r
                  ? 'bg-persian-900/40 text-saffron-200 border-saffron-700/40'
                  : 'bg-dark-800/30 text-dark-300 border-white/[0.04] hover:text-dark-100',
              )}
            >
              {RATING_LABELS[r]}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="glass-card rounded-2xl p-5 space-y-3 max-w-2xl mx-auto w-full">
      <div className="flex items-center justify-between">
        <div className="text-2xs uppercase tracking-widest text-dark-400">
          {recording ? 'Listening…' : 'Type or speak your answer'}
        </div>
        {supportsSpeech && (
          <button
            type="button"
            onClick={toggleRecord}
            disabled={grading}
            aria-pressed={recording}
            className={cn(
              'text-2xs uppercase tracking-[0.2em] font-light px-3 py-1.5 rounded-lg transition border',
              recording
                ? 'bg-crimson-900/30 text-crimson-200 border-crimson-700/40 animate-pulse'
                : 'text-saffron-300 hover:text-saffron-200 hover:bg-saffron-900/15 border-saffron-700/30',
            )}
          >
            {recording ? '■ Stop' : '● Voice'}
          </button>
        )}
      </div>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={onKey}
        autoFocus
        rows={3}
        placeholder="Type your answer, then Cmd+Enter to grade…"
        className="w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] focus:border-persian-500/30"
      />
      {error && (
        <div className="text-sm text-crimson-300 font-light">{error}</div>
      )}
      <div className="flex items-center gap-3">
        <button
          onClick={submit}
          disabled={grading || !text.trim()}
          className="btn-gradient px-5 py-2 rounded-xl text-sm"
        >
          {grading ? 'Grading…' : 'Grade'}
          <kbd className="ml-2 text-2xs text-white/50 font-mono">Cmd+Enter</kbd>
        </button>
        <span className="text-2xs text-dark-500">
          AI compares your answer to the back. Accept its rating or override below.
        </span>
      </div>
    </div>
  );
}

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
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};
function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
