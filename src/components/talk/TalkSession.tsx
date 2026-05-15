'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Note, TalkSession, TalkTurn } from '@/lib/db/schema';
import { db } from '@/lib/db/dexie';
import { appendTalkTurn, updateTalkSession } from '@/lib/db/talk-queries';
import { Recorder } from '@/lib/talk/record';
import { transcribeAudio } from '@/lib/talk/stt';
import { generateAssistantReply } from '@/lib/talk/chat';
import { renderTextToMp3 } from '@/lib/podcast/tts-openai';
import { projectQueue } from '@/lib/podcast/queue-projection';
import { buildCardContexts, updateCoverage, introducedCount } from '@/lib/talk/coverage';
import { cn } from '@/lib/utils';

type Status =
  | 'loading'
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'error';

interface Props {
  session: TalkSession;
}

export default function TalkSessionView({ session: initialSession }: Props) {
  const [session, setSession] = useState<TalkSession>(initialSession);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [cardCount, setCardCount] = useState(0);
  const cardsRef = useRef<Array<{ id: string; note: Note }>>([]);
  const cardContextsRef = useRef<ReturnType<typeof buildCardContexts>>([]);
  const recorderRef = useRef<Recorder | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const activeAbortRef = useRef<AbortController | null>(null);

  /* ─── Load curriculum on mount ─── */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const projection = await projectQueue(session.deckIds, session.horizon);
        if (cancelled) return;
        const cards = projection.cards.map(p => ({ id: p.card.id, note: p.note }));
        cardsRef.current = cards;
        cardContextsRef.current = buildCardContexts(cards);
        setCardCount(cards.length);
        setStatus('idle');
        if (cards.length === 0) {
          setError('No cards in scope. Pick a wider horizon or a different deck and restart the session.');
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [session.deckIds, session.horizon]);

  /* ─── Cleanup ─── */

  useEffect(() => () => {
    recorderRef.current?.release();
    activeAbortRef.current?.abort();
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
  }, []);

  /* ─── Auto-scroll transcript to latest ─── */

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [session.turns.length]);

  /* ─── Push-to-talk lifecycle ─── */

  const startRecording = useCallback(async () => {
    if (status === 'recording') return;
    if (status !== 'idle') return;
    setError(null);
    try {
      if (!recorderRef.current) recorderRef.current = new Recorder();
      await recorderRef.current.start();
      // Stop any current TTS playback so the user can barge in.
      const audio = audioRef.current;
      if (audio && !audio.paused) audio.pause();
      setStatus('recording');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }, [status]);

  const stopRecordingAndRespond = useCallback(async () => {
    if (status !== 'recording') return;
    const ctrl = new AbortController();
    activeAbortRef.current = ctrl;
    setStatus('transcribing');
    let userText = '';
    try {
      const blob = await recorderRef.current!.stop();
      // Sanity guard against the user holding the key for a flicker.
      if (blob.size < 500) {
        setStatus('idle');
        return;
      }
      userText = await transcribeAudio(blob, { signal: ctrl.signal });
      if (!userText.trim()) {
        setStatus('idle');
        return;
      }
      const userTurn: TalkTurn = { role: 'user', text: userText, at: Date.now() };
      const nextHistoryBeforeAssistant = [...session.turns, userTurn];
      await appendTalkTurn(session.id, userTurn);
      setSession(s => ({ ...s, turns: nextHistoryBeforeAssistant }));

      setStatus('thinking');
      const replyText = await generateAssistantReply(
        nextHistoryBeforeAssistant,
        cardsRef.current,
        ctrl.signal,
      );
      const assistantTurn: TalkTurn = { role: 'assistant', text: replyText, at: Date.now() };
      // Coverage bookkeeping.
      const coverage = { ...session.coverage };
      updateCoverage(coverage, replyText, cardContextsRef.current);

      const fullHistory = [...nextHistoryBeforeAssistant, assistantTurn];
      await appendTalkTurn(session.id, assistantTurn);
      await updateTalkSession(session.id, { coverage });
      setSession(s => ({ ...s, turns: fullHistory, coverage }));

      // TTS the response and play.
      setStatus('speaking');
      const mp3 = await renderTextToMp3(replyText, {
        voice: (session.voice ?? 'alloy') as never,
        model: session.ttsModel ?? 'tts-1',
        signal: ctrl.signal,
      });
      if (mp3) await playBlob(mp3);
      setStatus('idle');
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setStatus('idle');
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    } finally {
      activeAbortRef.current = null;
    }
  }, [status, session]);

  const playBlob = useCallback(async (blob: Blob) => {
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio();
      audioRef.current = audio;
    }
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    const url = URL.createObjectURL(blob);
    audioUrlRef.current = url;
    audio.src = url;
    await new Promise<void>((resolve) => {
      const cleanup = () => {
        audio!.removeEventListener('ended', onEnd);
        audio!.removeEventListener('pause', onPause);
        resolve();
      };
      const onEnd = () => cleanup();
      const onPause = () => {
        // User barged in via space; abort playback gracefully.
        if (audio!.currentTime < audio!.duration) cleanup();
      };
      audio!.addEventListener('ended', onEnd);
      audio!.addEventListener('pause', onPause);
      audio!.play().catch(() => cleanup());
    });
  }, []);

  /* ─── Spacebar = push-to-talk ─── */

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return;
      e.preventDefault();
      if (status === 'idle') startRecording();
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return;
      e.preventDefault();
      if (status === 'recording') stopRecordingAndRespond();
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [status, startRecording, stopRecordingAndRespond]);

  /* ─── End session ─── */

  const endSession = async () => {
    if (status === 'recording') return;
    await updateTalkSession(session.id, { endedAt: Date.now() });
    setSession(s => ({ ...s, endedAt: Date.now() }));
  };

  /* ─── Render ─── */

  const introduced = useMemo(() => introducedCount(session.coverage), [session.coverage]);

  return (
    <div className="space-y-6">
      <div className="glass-card rounded-3xl p-6 md:p-8 space-y-4">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl md:text-3xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
            {session.name}
          </h1>
          <Link href="/talk" className="text-2xs uppercase tracking-widest font-mono text-dark-400 hover:text-saffron-300 transition">
            ← Talk
          </Link>
        </div>

        <div className="text-2xs uppercase tracking-widest font-mono text-dark-500 flex items-center gap-3 flex-wrap">
          <span>{cardCount} cards in scope</span>
          <span className="text-dark-700">·</span>
          <span>{introduced}/{cardCount} covered</span>
          {session.endedAt && (
            <>
              <span className="text-dark-700">·</span>
              <span className="text-dark-300">ended</span>
            </>
          )}
        </div>

        <div className="h-1 rounded-full bg-dark-800/60 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-saffron-500 to-persian-500 transition-all"
            style={{ width: cardCount > 0 ? `${Math.round((introduced / cardCount) * 100)}%` : '0%' }}
          />
        </div>

        {error && (
          <div className="text-sm text-red-300 font-light px-3 py-2 rounded-xl bg-red-900/15 border border-red-900/30">
            {error}
          </div>
        )}

        <div className="flex items-center justify-center gap-4 pt-2">
          <button
            type="button"
            onMouseDown={startRecording}
            onMouseUp={stopRecordingAndRespond}
            onMouseLeave={() => { if (status === 'recording') stopRecordingAndRespond(); }}
            onTouchStart={e => { e.preventDefault(); startRecording(); }}
            onTouchEnd={e => { e.preventDefault(); stopRecordingAndRespond(); }}
            disabled={status !== 'idle' && status !== 'recording'}
            className={cn(
              'w-24 h-24 rounded-full text-white text-sm font-mono uppercase tracking-widest transition border-2 select-none',
              status === 'recording'
                ? 'bg-crimson-700/60 border-crimson-400 animate-pulse'
                : status === 'idle'
                  ? 'btn-gradient border-transparent hover:scale-105'
                  : 'bg-dark-800/40 border-white/[0.08] text-dark-500 cursor-not-allowed',
            )}
            title="Hold Space or click + hold"
          >
            {status === 'recording' ? '● rec' : 'hold'}
          </button>
        </div>

        <div className="text-center text-2xs uppercase tracking-widest font-mono">
          <span className={cn(
            status === 'recording' ? 'text-crimson-300'
            : status === 'thinking' ? 'text-saffron-300 animate-pulse'
            : status === 'transcribing' ? 'text-saffron-300 animate-pulse'
            : status === 'speaking' ? 'text-persian-300'
            : 'text-dark-500',
          )}>
            {statusLabel(status)}
          </span>
          <div className="text-2xs text-dark-600 mt-1">Hold Space (or the button) to speak.</div>
        </div>

        <div className="flex items-center justify-end gap-3">
          {!session.endedAt && (
            <button
              type="button"
              onClick={endSession}
              disabled={status === 'recording'}
              className="text-2xs uppercase tracking-widest font-mono text-dark-400 hover:text-saffron-300 transition disabled:opacity-50"
            >
              end session
            </button>
          )}
        </div>
      </div>

      <div className="glass-card rounded-3xl p-6 md:p-7 space-y-3">
        <h2 className="text-2xs uppercase tracking-widest text-dark-500 font-mono">Transcript</h2>
        <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
          {session.turns.length === 0 ? (
            <div className="text-sm text-dark-400 font-light">
              Press Space and say something to start the conversation.
            </div>
          ) : (
            session.turns.map((t, i) => (
              <div key={i} className={cn(
                'px-3 py-2 rounded-xl text-sm font-light',
                t.role === 'user'
                  ? 'bg-persian-900/15 text-persian-100 ml-8'
                  : 'bg-saffron-900/15 text-saffron-50 mr-8',
              )}>
                <div className="text-2xs uppercase tracking-widest font-mono mb-1 opacity-70">
                  {t.role === 'user' ? 'you' : 'study partner'}
                </div>
                <div>{t.text}</div>
              </div>
            ))
          )}
          <div ref={transcriptEndRef} />
        </div>
      </div>
    </div>
  );
}

function statusLabel(s: Status): string {
  switch (s) {
    case 'loading':       return 'loading curriculum…';
    case 'idle':          return 'ready';
    case 'recording':     return 'listening (release to send)';
    case 'transcribing':  return 'transcribing…';
    case 'thinking':      return 'thinking…';
    case 'speaking':      return 'speaking';
    case 'error':         return 'error';
  }
}

// Convenience: re-export the db handle for future helpers that may
// want to write per-turn audio. Currently unused.
export const _db = db;
