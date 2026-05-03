'use client';

import { useEffect, useRef, useState } from 'react';
import { getJsonSetting } from '@/lib/db/queries';
import { cn } from '@/lib/utils';

/**
 * Pomodoro work/break loop active during a study session.
 *
 * Behavior:
 *   - Reads `pomodoro_enabled` + work/break minutes from settings on mount.
 *   - When enabled, runs a setTimeout-based phase machine that flips
 *     between 'work' and 'break' indefinitely until the Reviewer unmounts.
 *   - During a break the parent renders a `<BreakOverlay/>` instead of
 *     the card (so the user actually rests), and rate / reveal callers
 *     check `phase === 'break'` and no-op.
 *   - "Skip phase" button is always visible during break; a small one
 *     surfaces in the header during work. Skipping just flips the phase
 *     immediately — the cycle keeps going.
 *
 * No countdown is shown anywhere by design — the visual is a background
 * tint shift at phase boundaries, not a numeric timer.
 */

export type PomodoroPhase = 'work' | 'break';

export interface PomodoroState {
  enabled: boolean;
  phase: PomodoroPhase;
  /** ms timestamp of the most recent phase boundary; used by CSS for
   *  the entrance animation (key=phaseStart force-restarts it). */
  phaseStart: number;
  /** Configured durations in minutes; surfaced for any UI that needs them. */
  workMinutes: number;
  breakMinutes: number;
  /** Caller-driven controls. */
  skipPhase: () => void;
}

export function usePomodoro(): PomodoroState {
  const [enabled, setEnabled] = useState(false);
  const [workMinutes, setWorkMinutes] = useState(25);
  const [breakMinutes, setBreakMinutes] = useState(5);
  const [phase, setPhase] = useState<PomodoroPhase>('work');
  const [phaseStart, setPhaseStart] = useState<number>(() => Date.now());
  const loadedRef = useRef(false);

  // One-shot config load. Settings live in IndexedDB so the read is async;
  // we don't want the timer to start until we know whether to run at all.
  useEffect(() => {
    (async () => {
      const [pe, pw, pb] = await Promise.all([
        getJsonSetting<boolean>('pomodoro_enabled', false),
        getJsonSetting<number>('pomodoro_work_minutes', 25),
        getJsonSetting<number>('pomodoro_break_minutes', 5),
      ]);
      setEnabled(pe);
      setWorkMinutes(Math.max(1, pw));
      setBreakMinutes(Math.max(1, pb));
      setPhaseStart(Date.now());
      loadedRef.current = true;
    })();
  }, []);

  // Phase transition timer. setTimeout-based so a single missed wake-up
  // doesn't accumulate drift; remaining = configured - elapsed every
  // time the deps change so manual skips reset cleanly.
  useEffect(() => {
    if (!enabled || !loadedRef.current) return;
    const duration = (phase === 'work' ? workMinutes : breakMinutes) * 60_000;
    const elapsed = Date.now() - phaseStart;
    const remaining = Math.max(0, duration - elapsed);
    const t = setTimeout(() => {
      setPhase(p => p === 'work' ? 'break' : 'work');
      setPhaseStart(Date.now());
    }, remaining);
    return () => clearTimeout(t);
  }, [enabled, phase, phaseStart, workMinutes, breakMinutes]);

  return {
    enabled,
    phase,
    phaseStart,
    workMinutes,
    breakMinutes,
    skipPhase: () => {
      setPhase(p => p === 'work' ? 'break' : 'work');
      setPhaseStart(Date.now());
    },
  };
}

/**
 * Full-screen overlay shown during the break phase. Centred message,
 * single "End break" button. Background gets the calming `pomodoro-break`
 * tint via the parent wrapper class; this component is purely the
 * foreground content.
 */
export function BreakOverlay({ onSkip }: { onSkip: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-6 py-20 animate-fade-in">
      <div className="text-center space-y-2">
        <div className="text-2xs uppercase tracking-[0.4em] text-saffron-300/80">Break</div>
        <h2 className="text-4xl md:text-5xl font-extralight tracking-tight bg-gradient-to-r from-saffron-200 via-saffron-100 to-persian-200 bg-clip-text text-transparent">
          Step away
        </h2>
        <p className="text-dark-300 font-light max-w-md mx-auto leading-relaxed">
          The deck&rsquo;s hidden so you actually rest. Stand, look out a window,
          drink water. The cycle resumes when you&rsquo;re back.
        </p>
      </div>
      <button
        onClick={onSkip}
        className="px-5 py-2 rounded-xl text-sm text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition border border-white/[0.06]"
      >
        End break early
      </button>
    </div>
  );
}

/**
 * Compact "End work" pill shown in the header during the work phase.
 * Discreet on purpose — the user shouldn't be drawn to it; it just has
 * to be there when they want it.
 */
export function EndWorkButton({ onSkip }: { onSkip: () => void }) {
  return (
    <button
      onClick={onSkip}
      title="End this work block early (still triggers the break)"
      className="hidden md:inline-flex items-center px-2.5 py-1 rounded-md text-2xs uppercase tracking-widest font-mono text-dark-500 hover:text-dark-200 hover:bg-white/[0.04] border border-white/[0.04] transition"
    >
      End work
    </button>
  );
}

/**
 * Wraps the Reviewer's main column in the right pomodoro class so
 * globals.css can run the background-tint animation on phase change.
 * `key={phaseStart}` forces React to reuse-or-mount the wrapper on
 * every transition, so the CSS entrance animation actually replays.
 */
export function PomodoroBackdrop({
  phase, phaseStart, children,
}: { phase: PomodoroPhase; phaseStart: number; children: React.ReactNode }) {
  return (
    <div
      key={phaseStart}
      className={cn(
        'flex-1 flex flex-col',
        phase === 'work' ? 'pomodoro-work-bg' : 'pomodoro-break-bg',
      )}
    >
      {children}
    </div>
  );
}
