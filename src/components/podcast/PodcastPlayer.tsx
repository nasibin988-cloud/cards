'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Podcast, PodcastSegment, PodcastTurn } from '@/lib/db/schema';
import { getSegmentAudio, listSegments } from '@/lib/db/podcast-queries';
import { db } from '@/lib/db/dexie';
import { speak, cancelSpeech } from '@/lib/tts/speak';
import { DroneBed, playBumper } from '@/lib/podcast/audio-fx';
import { retrySegment } from '@/lib/podcast/build';
import { cn } from '@/lib/utils';

interface Props {
  podcast: Podcast;
  segments: PodcastSegment[];
  onSegmentsChange?: (segs: PodcastSegment[]) => void;
}

const SPEED_OPTIONS = [0.85, 1.0, 1.15, 1.3, 1.5] as const;
const SLEEP_OPTIONS: Array<{ key: string; label: string; ms: number | null; endOfSegment?: boolean }> = [
  { key: 'off',  label: 'Off',           ms: null },
  { key: 'end',  label: 'End of segment', ms: null, endOfSegment: true },
  { key: '5',    label: '5 min',         ms: 5 * 60 * 1000 },
  { key: '15',   label: '15 min',        ms: 15 * 60 * 1000 },
  { key: '30',   label: '30 min',        ms: 30 * 60 * 1000 },
  { key: '60',   label: '1 hr',          ms: 60 * 60 * 1000 },
];

export default function PodcastPlayer({ podcast, segments, onSegmentsChange }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const droneRef = useRef<DroneBed | null>(null);
  const sleepTimerRef = useRef<number | null>(null);
  const stopAtSegmentEndRef = useRef(false);
  const hasStartedRef = useRef(false);

  const [activeIndex, setActiveIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [audioReady, setAudioReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [speed, setSpeed] = useState<number>(1.0);
  const [sleepKey, setSleepKey] = useState<string>('off');
  const [showTranscript, setShowTranscript] = useState(false);
  const [retryingIndex, setRetryingIndex] = useState<number | null>(null);

  const isOpenAI = podcast.ttsProvider === 'openai';

  /* ─── Audio FX wiring ──────────────────────────────────────── */

  const audioStyle = podcast.audioStyle ?? 'none';
  const bumpersOn = audioStyle === 'bumpers' || audioStyle === 'both';
  const bedOn = audioStyle === 'bed' || audioStyle === 'both';

  useEffect(() => {
    return () => {
      droneRef.current?.stop();
      droneRef.current = null;
      if (sleepTimerRef.current) window.clearTimeout(sleepTimerRef.current);
    };
  }, []);

  const startBedIfEnabled = useCallback(() => {
    if (!bedOn) return;
    if (!droneRef.current) droneRef.current = new DroneBed();
    droneRef.current.start();
  }, [bedOn]);
  const stopBed = useCallback(() => {
    droneRef.current?.stop();
  }, []);

  /* ─── Blob loading (OpenAI mode) ───────────────────────────── */

  const loadSegmentBlob = useCallback(async (index: number) => {
    if (!isOpenAI) return;
    setAudioReady(false);
    setError(null);
    const audio = audioRef.current;
    if (!audio) return;
    try {
      const row = await getSegmentAudio(podcast.id, index);
      if (!row) {
        setError(`Audio missing for segment ${index + 1}.`);
        return;
      }
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      const url = URL.createObjectURL(row.blob);
      objectUrlRef.current = url;
      audio.src = url;
      audio.load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [isOpenAI, podcast.id]);

  // Initial + on-segment-change blob load.
  useEffect(() => {
    if (isOpenAI) {
      loadSegmentBlob(activeIndex);
    } else {
      setAudioReady(true);
    }
  }, [activeIndex, isOpenAI, loadSegmentBlob]);

  // Cleanup blob URL + speech on unmount.
  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    cancelSpeech();
  }, []);

  /* ─── MediaSession ─────────────────────────────────────────── */

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const seg = segments[activeIndex];
    if (!seg) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: seg.title || podcast.name,
      artist: podcast.name,
      album: 'Priming podcast',
    });
    navigator.mediaSession.setActionHandler('play', () => playPause(true));
    navigator.mediaSession.setActionHandler('pause', () => playPause(false));
    navigator.mediaSession.setActionHandler('nexttrack', () => jumpSegment(activeIndex + 1));
    navigator.mediaSession.setActionHandler('previoustrack', () => jumpSegment(activeIndex - 1));
    return () => {
      if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
      navigator.mediaSession.setActionHandler('nexttrack', null);
      navigator.mediaSession.setActionHandler('previoustrack', null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, segments]);

  /* ─── Audio element wiring ─────────────────────────────────── */

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !isOpenAI) return;
    const onLoaded = () => {
      setDuration(audio.duration || 0);
      setAudioReady(true);
      audio.playbackRate = speed;
      if (playing) audio.play().catch(() => {});
    };
    const onTime = () => setPosition(audio.currentTime || 0);
    const onEnded = async () => {
      // Heard-it tagging on segment-end: mark every card in this segment.
      await markCardsPrimed(segments[activeIndex]?.cardIds ?? []);
      if (stopAtSegmentEndRef.current) {
        stopAtSegmentEndRef.current = false;
        setSleepKey('off');
        setPlaying(false);
        stopBed();
        return;
      }
      jumpSegment(activeIndex + 1, /* afterEnded */ true);
    };
    const onErr = () => setError('Audio failed to load.');
    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onErr);
    return () => {
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onErr);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, isOpenAI, playing, segments, speed]);

  // Apply speed live when user changes it.
  useEffect(() => {
    const audio = audioRef.current;
    if (audio && isOpenAI) audio.playbackRate = speed;
  }, [speed, isOpenAI]);

  /* ─── Sleep timer ──────────────────────────────────────────── */

  useEffect(() => {
    if (sleepTimerRef.current) {
      window.clearTimeout(sleepTimerRef.current);
      sleepTimerRef.current = null;
    }
    stopAtSegmentEndRef.current = false;
    const opt = SLEEP_OPTIONS.find(o => o.key === sleepKey);
    if (!opt || !playing) return;
    if (opt.endOfSegment) {
      stopAtSegmentEndRef.current = true;
      return;
    }
    if (opt.ms === null) return;
    sleepTimerRef.current = window.setTimeout(() => {
      playPause(false);
      setSleepKey('off');
    }, opt.ms);
    return () => {
      if (sleepTimerRef.current) {
        window.clearTimeout(sleepTimerRef.current);
        sleepTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sleepKey, playing]);

  /* ─── Controls ─────────────────────────────────────────────── */

  const playPause = (next?: boolean) => {
    const desired = next ?? !playing;
    setPlaying(desired);
    if (desired) {
      hasStartedRef.current = true;
      startBedIfEnabled();
    } else {
      stopBed();
    }
    if (isOpenAI) {
      const audio = audioRef.current;
      if (!audio) return;
      if (desired) audio.play().catch(() => {});
      else audio.pause();
    } else {
      if (desired) speakSegment(activeIndex);
      else cancelSpeech();
    }
  };

  const speakSegment = (index: number) => {
    const seg = segments[index];
    if (!seg) return;
    const text = stripSpeakerLabels(seg.script || (seg.turns ?? []).map(t => t.text).join('\n\n'));
    if (!text.trim()) return;
    speak(text, {
      rate: speed,
      onEnd: async () => {
        await markCardsPrimed(seg.cardIds);
        if (stopAtSegmentEndRef.current) {
          stopAtSegmentEndRef.current = false;
          setSleepKey('off');
          setPlaying(false);
          stopBed();
          return;
        }
        if (index + 1 < segments.length) {
          if (bumpersOn) playBumper();
          setActiveIndex(index + 1);
          setTimeout(() => speakSegment(index + 1), bumpersOn ? 450 : 150);
        } else {
          setPlaying(false);
          stopBed();
        }
      },
      onError: () => setPlaying(false),
    });
  };

  const jumpSegment = (index: number, afterEnded = false) => {
    if (index < 0 || index >= segments.length) {
      setPlaying(false);
      stopBed();
      return;
    }
    if (bumpersOn && hasStartedRef.current && index !== activeIndex) {
      playBumper();
    }
    setActiveIndex(index);
    setPosition(0);
    if (!isOpenAI && playing && !afterEnded) {
      cancelSpeech();
      setTimeout(() => speakSegment(index), bumpersOn ? 450 : 100);
    }
  };

  const seek = (sec: number) => {
    if (!isOpenAI) return;
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = sec;
    setPosition(sec);
  };

  const seekToTurn = (segIndex: number, turn: PodcastTurn) => {
    if (segIndex !== activeIndex) {
      setActiveIndex(segIndex);
      setTimeout(() => seek(turn.startSec ?? 0), 200);
    } else {
      seek(turn.startSec ?? 0);
    }
  };

  /* ─── Per-segment retry ─────────────────────────────────────── */

  const onRetry = async (segIndex: number) => {
    setRetryingIndex(segIndex);
    setError(null);
    try {
      await retrySegment(podcast.id, segIndex);
      const segs = await listSegments(podcast.id);
      segs.sort((a, b) => a.index - b.index);
      onSegmentsChange?.(segs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetryingIndex(null);
    }
  };

  /* ─── Study these cards ─────────────────────────────────────── */

  const allCardIds = useMemo(
    () => Array.from(new Set(segments.flatMap(s => s.cardIds))),
    [segments],
  );

  /* ─── Derived display values ───────────────────────────────── */

  const segDur = (s: PodcastSegment) => s.durationSec ?? 0;
  const totalDur = segments.reduce((acc, s) => acc + segDur(s), 0);
  const totalElapsed = segments.slice(0, activeIndex).reduce((acc, s) => acc + segDur(s), 0) + position;
  const activeTurnIdx = useMemo(() => {
    const seg = segments[activeIndex];
    if (!seg?.turns) return -1;
    let idx = -1;
    for (let i = 0; i < seg.turns.length; i++) {
      const t = seg.turns[i];
      if ((t.startSec ?? 0) <= position) idx = i;
      else break;
    }
    return idx;
  }, [position, activeIndex, segments]);

  return (
    <div className="space-y-6">
      <audio ref={audioRef} preload="auto" className="hidden" />

      {/* ─── Player card ─── */}
      <div className="glass-card rounded-3xl p-6 md:p-8 space-y-5">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl md:text-3xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
            {podcast.name}
          </h1>
          <span className="text-2xs uppercase tracking-widest text-dark-500 font-mono whitespace-nowrap">
            {fmt(totalElapsed)} / {fmt(totalDur)}
          </span>
        </div>

        <div className="text-sm text-dark-300 font-light">
          {segments[activeIndex]?.description}
        </div>

        {error && (
          <div className="text-sm text-red-300 font-light px-3 py-2 rounded-xl bg-red-900/15 border border-red-900/30">
            {error}
          </div>
        )}

        {/* Segment scrubber */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-2xs uppercase tracking-widest font-mono text-dark-500">
            <span>{segments[activeIndex]?.title}</span>
            <span className="ml-auto">segment {activeIndex + 1}/{segments.length}</span>
          </div>
          {isOpenAI ? (
            <input
              type="range"
              min={0}
              max={Math.max(duration, 0.1)}
              step={0.1}
              value={position}
              onChange={e => seek(parseFloat(e.target.value))}
              disabled={!audioReady}
              className="w-full accent-saffron-500"
            />
          ) : (
            <div className="h-1 rounded-full bg-dark-800/60 overflow-hidden">
              <div className={cn('h-full bg-gradient-to-r from-saffron-500 to-persian-500 transition-all', playing && 'animate-pulse')} style={{ width: playing ? '40%' : '0%' }} />
            </div>
          )}
          <div className="flex justify-between text-2xs text-dark-500 font-mono">
            <span>{fmt(position)}</span>
            <span>{isOpenAI ? fmt(duration) : 'browser TTS'}</span>
          </div>
        </div>

        {/* Transport */}
        <div className="flex items-center justify-center gap-3">
          <ControlButton onClick={() => jumpSegment(activeIndex - 1)} title="Previous segment">⟵</ControlButton>
          <button type="button" onClick={() => playPause()} className="btn-gradient w-16 h-16 rounded-full text-xl flex items-center justify-center" title={playing ? 'Pause' : 'Play'}>
            {playing ? '❚❚' : '▶'}
          </button>
          <ControlButton onClick={() => jumpSegment(activeIndex + 1)} title="Next segment">⟶</ControlButton>
          {isOpenAI && <ControlButton onClick={() => seek(Math.max(0, position - 15))} title="Back 15s">-15</ControlButton>}
          {isOpenAI && <ControlButton onClick={() => seek(Math.min(duration, position + 30))} title="Forward 30s">+30</ControlButton>}
        </div>

        {/* Speed + sleep */}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <div className="flex items-center gap-1.5">
            <span className="text-2xs uppercase tracking-widest text-dark-500 font-mono">speed</span>
            {SPEED_OPTIONS.map(s => (
              <button
                key={s}
                type="button"
                onClick={() => setSpeed(s)}
                className={cn(
                  'px-2 py-0.5 rounded-md text-2xs font-mono transition border',
                  speed === s
                    ? 'bg-saffron-900/40 text-saffron-200 border-saffron-700/40'
                    : 'bg-dark-800/30 text-dark-400 border-white/[0.04] hover:text-dark-100',
                )}
              >
                {s}x
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 ml-auto">
            <span className="text-2xs uppercase tracking-widest text-dark-500 font-mono">sleep</span>
            <select
              value={sleepKey}
              onChange={e => setSleepKey(e.target.value)}
              className="bg-dark-800/30 border border-white/[0.04] rounded-md text-2xs font-mono text-dark-200 px-2 py-1 focus:outline-none"
            >
              {SLEEP_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center justify-between gap-3 pt-1">
          <button
            type="button"
            onClick={() => setShowTranscript(t => !t)}
            className="text-2xs uppercase tracking-widest font-mono text-dark-400 hover:text-saffron-300 transition"
          >
            {showTranscript ? 'hide transcript' : 'show transcript'}
          </button>
          {allCardIds.length > 0 && podcast.deckIds[0] && (
            <Link
              href={`/study/${podcast.deckIds[0]}`}
              className="text-2xs uppercase tracking-widest font-mono text-saffron-300 hover:text-saffron-200 transition"
              title="Open Reviewer in the first deck of this podcast"
            >
              study these cards →
            </Link>
          )}
        </div>
      </div>

      {/* ─── Transcript view ─── */}
      {showTranscript && (
        <div className="glass-card rounded-3xl p-6 md:p-7 space-y-4">
          <h2 className="text-2xs uppercase tracking-widest text-dark-500 font-mono">Transcript</h2>
          {segments.map(seg => (
            <div key={seg.id} className="space-y-1.5">
              <div className={cn(
                'text-2xs uppercase tracking-widest font-mono pb-1 border-b border-white/[0.04]',
                seg.index === activeIndex ? 'text-saffron-300' : 'text-dark-500',
              )}>
                {String(seg.index + 1).padStart(2, '0')} · {seg.title}
              </div>
              {(seg.turns ?? []).map((t, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => seekToTurn(seg.index, t)}
                  className={cn(
                    'w-full text-left px-2 py-1 rounded-md transition flex gap-3 items-start',
                    seg.index === activeIndex && i === activeTurnIdx
                      ? 'bg-saffron-900/20 text-saffron-100'
                      : 'text-dark-200 hover:bg-white/[0.03]',
                  )}
                  disabled={!isOpenAI}
                  title={isOpenAI ? 'Click to seek' : 'Seek not available in browser TTS mode'}
                >
                  <span className={cn(
                    'shrink-0 text-2xs font-mono w-5 text-right pt-0.5',
                    t.speaker === 'A' ? 'text-persian-300' : 'text-saffron-300',
                  )}>
                    {t.speaker}
                  </span>
                  <span className="flex-1 text-sm font-light">{t.text}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* ─── Segment list ─── */}
      <div className="glass-card rounded-3xl p-6 md:p-7 space-y-3">
        <h2 className="text-2xs uppercase tracking-widest text-dark-500 font-mono">Segments</h2>
        <ol className="space-y-1">
          {segments.map(s => {
            const active = s.index === activeIndex;
            const failed = s.status === 'error';
            const missingAudio = isOpenAI && s.status !== 'rendered';
            const broken = failed || missingAudio;
            return (
              <li key={s.id} className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={broken && !active}
                  onClick={() => jumpSegment(s.index)}
                  className={cn(
                    'flex-1 text-left px-3 py-2 rounded-xl transition flex items-center gap-3',
                    active
                      ? 'bg-saffron-900/30 text-saffron-100'
                      : broken
                        ? 'text-dark-500 cursor-not-allowed'
                        : 'text-dark-200 hover:bg-white/[0.03]',
                  )}
                >
                  <span className="text-2xs font-mono text-dark-500 w-6 text-right">
                    {String(s.index + 1).padStart(2, '0')}
                  </span>
                  <span className="flex-1 text-sm font-light truncate">{s.title}</span>
                  <span className="text-2xs font-mono text-dark-500">
                    {failed ? 'error' : missingAudio ? 'pending' : fmt(s.durationSec ?? 0)}
                  </span>
                </button>
                {broken && (
                  <button
                    type="button"
                    onClick={() => onRetry(s.index)}
                    disabled={retryingIndex !== null}
                    className="text-2xs uppercase tracking-widest font-mono text-dark-400 hover:text-saffron-300 transition px-2 py-1 disabled:opacity-50"
                    title="Re-script and re-render this segment"
                  >
                    {retryingIndex === s.index ? 'retrying…' : 'retry'}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function ControlButton({ onClick, children, title }: { onClick: () => void; children: React.ReactNode; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="w-10 h-10 rounded-xl bg-dark-800/40 border border-white/[0.04] text-dark-200 hover:text-dark-50 hover:bg-white/[0.06] transition text-sm font-mono"
    >
      {children}
    </button>
  );
}

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Strip "A: " / "B: " speaker prefixes from a transcript so browser
 * TTS doesn't say them out loud.
 */
function stripSpeakerLabels(text: string): string {
  return text.replace(/^[AB]:\s*/gm, '');
}

/**
 * Mark every card in a segment as "primed" so the Reviewer can surface
 * a small indicator the next time it serves one of them. Idempotent;
 * Reviewer clears `lastPrimedAt` once the card is actually reviewed.
 */
async function markCardsPrimed(cardIds: string[]): Promise<void> {
  if (cardIds.length === 0) return;
  const now = Date.now();
  await db().transaction('rw', db().cards, async () => {
    for (const id of cardIds) {
      await db().cards.update(id, { lastPrimedAt: now });
    }
  });
}
