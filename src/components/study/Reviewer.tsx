'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Card, Deck, Note, Rating } from '@/lib/db/schema';
import {
  buryCard,
  cycleNoteFlag,
  getCard,
  getDeckCounts,
  getEffectiveDeckSettings,
  getMediaUrl,
  getNextCardForStudy,
  getNextCardFromNoteSet,
  getNote,
  getScopeCapStatus,
  getTodayStudyStats,
  listDescendantDeckIds,
  listRecentUndoableReviews,
  peekNextCardForStudy,
  recordReview,
  restoreCardDue,
  rollbackReview,
  snoozeCard,
  suspendCard,
  unburryStaleCards,
  updateDeck,
  type DeckCounts,
  type ScopeCapStatus,
  type TodayStudyStats,
} from '@/lib/db/queries';
import type { SchedulerOptions } from '@/lib/fsrs/scheduler';
import { analyzeDeckRetention, type DeckRetentionReport } from '@/lib/fsrs/analyze';
import RetentionTuneToast from '@/components/study/RetentionTuneToast';
import { FLAG_GLYPH, FLAG_LABEL, FlagGlyph } from '@/components/note/FlagPicker';
import { previewIntervals, type ScheduledRating } from '@/lib/fsrs/scheduler';
import CardRenderer from '@/components/card/CardRenderer';
import RatingButtons from '@/components/study/RatingButtons';
import ConfidenceButtons from '@/components/study/ConfidenceButtons';
import AskAI from '@/components/study/AskAI';
import TypeAnswer from '@/components/study/TypeAnswer';
import FeynmanPanel from '@/components/study/FeynmanPanel';
import LookupPanel from '@/components/lookup/LookupPanel';
import { cn } from '@/lib/utils';
import { generateHint } from '@/lib/ai/hint';
import { getJsonSetting, setJsonSetting, getSetting } from '@/lib/db/queries';
import { Tooltip } from '@/components/ui/Tooltip';
import { speak as ttsSpeak, cancelSpeech, isTtsSupported } from '@/lib/tts/speak';
import { cardToSpeech } from '@/lib/tts/text';

interface Props {
  deck: Deck;
  /**
   * When set, study is restricted to cards whose noteId is in the filter.
   * Used by saved practice queries that span multiple decks.
   */
  noteIdFilter?: ReadonlySet<string>;
  /**
   * Override the descendant resolution for "study a virtual parent" mode.
   * Pass an explicit deck-id list and a display name; the Reviewer will
   * pull cards from these decks instead of computing them off `deck.id`.
   * The supplied `deck` is used only for headers/auto-tune dismiss keys —
   * pass a synthetic one when entering this mode.
   */
  virtualScope?: {
    deckIds: string[];
    label: string;
  };
}

type Phase = 'front' | 'back' | 'empty' | 'loading';

export default function Reviewer({ deck, noteIdFilter, virtualScope }: Props) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('loading');
  const [card, setCard] = useState<Card | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [intervals, setIntervals] = useState<ScheduledRating[]>([]);
  const [counts, setCounts] = useState<DeckCounts>({ new: 0, learning: 0, review: 0, total: 0 });
  /** How many sub-decks the current study session pulls from (≥1 always). */
  const [scopeSize, setScopeSize] = useState<number>(1);
  /** Today's binding cap (most-restrictive across the scope), refreshed per fetch. */
  const [capStatus, setCapStatus] = useState<ScopeCapStatus | null>(null);
  const [shownAt, setShownAt] = useState<number>(0);
  const [askOpen, setAskOpen] = useState(false);
  /** When true, the Reviewer renders the Feynman teach-back panel instead of
   *  the regular front/back. Triggered by `T` on the front phase. */
  const [feynmanOpen, setFeynmanOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  /** TTS prefs hydrated from settings. Read once on mount; the panel writes
   *  back to settings, which we re-read when the user returns to study. */
  const [ttsPrefs, setTtsPrefs] = useState<{
    enabled: boolean;
    autoFront: boolean;
    autoBack: boolean;
    voiceURI: string;
    rate: number;
  }>({ enabled: false, autoFront: false, autoBack: false, voiceURI: '', rate: 1 });
  const [ttsActive, setTtsActive] = useState(false);
  // Undo stack. Every rate or snooze pushes onto it; Cmd+Z / U pops one off
  // and reverses it. When the stack is empty (e.g. a fresh session after a
  // reload) the undo handler falls back to walking the persisted review-log
  // history so the user can keep undoing past actions.
  type UndoEntry =
    | { kind: 'review'; cardId: string; logId: string }
    | { kind: 'snooze'; cardId: string; previousDue: number };
  const historyRef = useRef<UndoEntry[]>([]);
  const [typeMode, setTypeMode] = useState(false);
  const [confidenceMode, setConfidenceMode] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [hintLoading, setHintLoading] = useState(false);
  const [lookupOpen, setLookupOpen] = useState(false);
  const [lookupWord, setLookupWord] = useState('');

  useEffect(() => {
    getJsonSetting<boolean>('study_type_mode', false).then(setTypeMode);
    getJsonSetting<boolean>('study_confidence_mode', false).then(setConfidenceMode);
    // Hydrate TTS prefs once. The Settings panel writes simple string keys.
    (async () => {
      const [enabled, autoFront, autoBack, voiceURI, rate] = await Promise.all([
        getSetting('tts_enabled'),
        getSetting('tts_autoplay_front'),
        getSetting('tts_autoplay_back'),
        getSetting('tts_voice_uri'),
        getSetting('tts_rate'),
      ]);
      setTtsPrefs({
        enabled: enabled === '1',
        autoFront: autoFront === '1',
        autoBack: autoBack === '1',
        voiceURI: voiceURI ?? '',
        rate: rate ? parseFloat(rate) : 1,
      });
    })();
  }, []);

  // Auto-play TTS on phase changes when enabled. Returning a cleanup that
  // cancels any in-flight utterance keeps successive cards from overlapping.
  useEffect(() => {
    if (!ttsPrefs.enabled || !card || !note) return;
    if (phase === 'front' && ttsPrefs.autoFront) speakCurrentInline('front');
    else if (phase === 'back' && ttsPrefs.autoBack) speakCurrentInline('back');
    return () => { cancelSpeech(); setTtsActive(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, card?.id, ttsPrefs.enabled, ttsPrefs.autoFront, ttsPrefs.autoBack]);

  // Inline version (no useCallback churn for the effect deps array).
  function speakCurrentInline(sideToSpeak: 'front' | 'back') {
    if (!card || !note) return;
    if (!isTtsSupported()) return;
    const text = cardToSpeech(note, sideToSpeak, card.clozeOrd);
    if (!text) return;
    setTtsActive(true);
    ttsSpeak(text, {
      voiceURI: ttsPrefs.voiceURI || undefined,
      rate: ttsPrefs.rate,
      onEnd: () => setTtsActive(false),
      onError: () => setTtsActive(false),
    });
  }

  // Speak helper bound to current prefs + active card.
  const speakCurrent = useCallback((sideToSpeak: 'front' | 'back') => {
    if (!ttsPrefs.enabled || !card || !note) return;
    if (!isTtsSupported()) return;
    const ord = card.clozeOrd;
    const text = cardToSpeech(note, sideToSpeak, ord);
    if (!text) return;
    setTtsActive(true);
    ttsSpeak(text, {
      voiceURI: ttsPrefs.voiceURI || undefined,
      rate: ttsPrefs.rate,
      onEnd: () => setTtsActive(false),
      onError: () => setTtsActive(false),
    });
  }, [ttsPrefs, card, note]);

  // Retention auto-tuning toast: on mount, see if observed retention has
  // drifted ≥5pp from the deck's target. If so (and not recently dismissed),
  // surface a one-click apply.
  const [tuneReport, setTuneReport] = useState<DeckRetentionReport | null>(null);
  useEffect(() => {
    if (noteIdFilter) return; // Practice queries don't get auto-tune.
    if (virtualScope) return; // Virtual-parent study has no single deck to tune.
    const dismissKey = `retention_tune_dismissed_${deck.id}`;
    const RECHECK_DAYS = 7;
    (async () => {
      const lastDismissed = await getJsonSetting<number>(dismissKey, 0);
      if (Date.now() - lastDismissed < RECHECK_DAYS * 86_400_000) return;
      // Use the effective retention (own override or inherited) so the
      // tuner doesn't compare observed retention to a stale 0.9 default
      // when the user has set 0.85 on the parent.
      const effective = await getEffectiveDeckSettings(deck.id);
      const report = await analyzeDeckRetention(deck.id, effective.desiredRetention.value);
      const drifted = report.delta !== null && Math.abs(report.delta) >= 0.05
        && report.recommendedRetentionTarget !== null;
      if (drifted) setTuneReport(report);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck.id, virtualScope]);
  const dismissTune = async () => {
    await setJsonSetting<number>(`retention_tune_dismissed_${deck.id}`, Date.now());
    setTuneReport(null);
  };
  const applyTune = async () => {
    if (!tuneReport?.recommendedRetentionTarget) return;
    await updateDeck(deck.id, { desiredRetention: tuneReport.recommendedRetentionTarget });
    showFlash(`Retention target now ${Math.round(tuneReport.recommendedRetentionTarget * 100)}%.`);
    await dismissTune();
    // Reload page so the deck prop refreshes.
    if (typeof window !== 'undefined') window.location.reload();
  };
  useEffect(() => {
    setHint(null);
  }, [card?.id]);

  const [sessionStartDue, setSessionStartDue] = useState<number | null>(null);
  const [sessionReviewed, setSessionReviewed] = useState(0);
  const [todayStats, setTodayStats] = useState<TodayStudyStats | null>(null);

  // Prefetch cache: warmed Card + Note for the card that would come AFTER
  // the current one. Consumed by `fetchNext` to skip a DB roundtrip.
  const prefetchRef = useRef<{ card: Card; note: Note } | null>(null);

  const RESUME_TTL_MS = 2 * 60 * 60_000;
  // Resume state is keyed by the active study scope. For real decks we use
  // the deck id; for virtual-parent study we key by the label so different
  // paths don't share state.
  const resumeKey = `cards:resume:${virtualScope ? `path:${virtualScope.label}` : deck.id}`;

  // For a leaf deck the study scope is `[deck.id]`; for a parent it
  // includes every `::` descendant. Resolved fresh inside fetchNext so we
  // don't have to coordinate a separate state hook with the first fetch.
  const resolveStudyDeckIds = useCallback(async () => {
    if (virtualScope) return virtualScope.deckIds;
    const descendants = await listDescendantDeckIds(deck.id);
    return descendants.length > 0 ? [deck.id, ...descendants] : [deck.id];
  }, [deck.id, virtualScope]);

  // Per-card scheduler options. When studying a parent, each card's leaf
  // can override the parent's retention/weights/etc.; this helper resolves
  // that chain on demand. Keep small and side-effect-free so the prefetch
  // path can call it without coordinating state.
  const effectiveOptsFor = useCallback(async (deckIdOfCard: string): Promise<SchedulerOptions> => {
    const eff = await getEffectiveDeckSettings(deckIdOfCard);
    return {
      retention: eff.desiredRetention.value,
      maxInterval: eff.maxInterval.value,
      // fsrsParams may be unset in the chain; pass undefined so the scheduler
      // uses its DEFAULT_W. We can't pass an empty array — fsrs treats that
      // as "weight vector of length 0" and crashes.
      w: eff.fsrsParams.value.length > 0 ? eff.fsrsParams.value : undefined,
    };
  }, []);

  const fetchNext = useCallback(async () => {
    setPhase('loading');
    // Don't auto-close the Ask panel: AskAI persists the conversation across
    // card changes (with a divider) so the user can keep asking while rating.
    const studyDeckIds = await resolveStudyDeckIds();
    setScopeSize(studyDeckIds.length);
    await unburryStaleCards(studyDeckIds);

    // Consume prefetch if we have one and it matches the in-scope deck set.
    // Re-read the cached card from the DB before serving it: the just-rated
    // card may have buried siblings (sibling-bury), and one of those siblings
    // could be sitting in the prefetch slot. Without this re-read the picker's
    // bury filter is bypassed and c2 follows c1 immediately.
    const studySet = new Set(studyDeckIds);
    let next: Card | undefined;
    let n: Note | undefined;
    const cached = prefetchRef.current;
    prefetchRef.current = null;
    if (cached && studySet.has(cached.card.deckId)) {
      const fresh = await getCard(cached.card.id);
      if (fresh && !fresh.suspended && !fresh.buried) {
        next = fresh;
        n = cached.note;
      }
    }
    if (!next) {
      next = noteIdFilter
        ? await getNextCardFromNoteSet(noteIdFilter)
        : await getNextCardForStudy(studyDeckIds);
      if (next) n = await getNote(next.noteId);
    }

    const newCounts = await getDeckCounts(studyDeckIds);
    setCounts(newCounts);
    // Refresh today's caps — refreshes at the same cadence as counts so the
    // pill stays accurate as the user advances through the session.
    getScopeCapStatus(studyDeckIds).then(setCapStatus).catch(() => { /* silent */ });
    // Best-effort refresh of today's totals — discreet header pill.
    getTodayStudyStats().then(setTodayStats).catch(() => { /* silent */ });
    if (sessionStartDue === null) {
      setSessionStartDue(newCounts.new + newCounts.learning + newCounts.review);
    }
    if (!next || !n) {
      setCard(null);
      setNote(null);
      setPhase('empty');
      return;
    }
    const opts = await effectiveOptsFor(next.deckId);
    setIntervals(previewIntervals(next, opts));
    setCard(next);
    setNote(n);
    setPhase('front');
    setShownAt(Date.now());
    setFeynmanOpen(false); // never carry teach-back state across cards.

    // Warm the next-next card in the background. Best-effort: skip in
    // practice mode (filtered queues need a different peek primitive),
    // and silently swallow errors so a prefetch never breaks study flow.
    if (!noteIdFilter) {
      const currentId = next.id;
      void (async () => {
        try {
          const peek = await peekNextCardForStudy(studyDeckIds, currentId);
          if (!peek) return;
          const peekNote = await getNote(peek.noteId);
          if (!peekNote) return;
          // Pre-resolve the image URL too — costs nothing if no image.
          if (peekNote.fields.image) await getMediaUrl(peekNote.fields.image);
          prefetchRef.current = { card: peek, note: peekNote };
        } catch { /* swallow */ }
      })();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveStudyDeckIds, effectiveOptsFor, noteIdFilter]);

  // Try to restore a card the user was on before reload/tab close. Falls
  // through to fetchNext on miss so the regular path still drives the first
  // card. Only runs once per mount.
  const bootstrappedRef = useRef(false);
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    (async () => {
      // Practice queues skip resume — the noteIdFilter set isn't persisted,
      // so a saved card might fall outside the new filter and confuse users.
      if (noteIdFilter) {
        await fetchNext();
        return;
      }
      try {
        const raw = typeof window !== 'undefined' ? localStorage.getItem(resumeKey) : null;
        if (!raw) { await fetchNext(); return; }
        const saved = JSON.parse(raw) as { cardId: string; phase: Phase; savedAt: number };
        if (Date.now() - saved.savedAt > RESUME_TTL_MS) {
          localStorage.removeItem(resumeKey);
          await fetchNext();
          return;
        }
        const studyDeckIds = await resolveStudyDeckIds();
        const c = await getCard(saved.cardId);
        const inScope = c && studyDeckIds.includes(c.deckId);
        if (!c || !inScope || c.suspended || c.buried) {
          localStorage.removeItem(resumeKey);
          await fetchNext();
          return;
        }
        const n = await getNote(c.noteId);
        if (!n) { await fetchNext(); return; }
        const opts = await effectiveOptsFor(c.deckId);
        setIntervals(previewIntervals(c, opts));
        setCard(c);
        setNote(n);
        setPhase(saved.phase === 'back' ? 'back' : 'front');
        setShownAt(Date.now());
        const newCounts = await getDeckCounts(studyDeckIds);
        setCounts(newCounts);
        if (sessionStartDue === null) {
          setSessionStartDue(newCounts.new + newCounts.learning + newCounts.review);
        }
        getTodayStudyStats().then(setTodayStats).catch(() => { /* silent */ });
      } catch {
        await fetchNext();
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist resume target on every front/back transition. Cleared on rate.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (noteIdFilter) return;
    if (!card || (phase !== 'front' && phase !== 'back')) return;
    try {
      localStorage.setItem(resumeKey, JSON.stringify({
        cardId: card.id,
        phase,
        savedAt: Date.now(),
      }));
    } catch { /* private mode / quota — ignore */ }
  }, [card?.id, phase, resumeKey, noteIdFilter]);

  const reveal = useCallback(() => {
    if (phase === 'front') setPhase('back');
  }, [phase]);

  const rate = useCallback(
    async (rating: Rating) => {
      if (!card || phase !== 'back') return;
      const dur = Date.now() - shownAt;
      const opts = await effectiveOptsFor(card.deckId);
      const { log } = await recordReview(card, rating, dur, opts);
      historyRef.current.push({ kind: 'review', cardId: card.id, logId: log.id });
      setSessionReviewed(n => n + 1);
      try { localStorage.removeItem(resumeKey); } catch { /* ignore */ }
      fetchNext();
    },
    [card, phase, shownAt, effectiveOptsFor, fetchNext, resumeKey],
  );

  const burry = useCallback(async () => {
    if (!card) return;
    await buryCard(card.id);
    showFlash('Buried until tomorrow.');
    fetchNext();
  }, [card, fetchNext]);

  const snooze = useCallback(async (delayMs: number, label: string) => {
    if (!card) return;
    const r = await snoozeCard(card.id, delayMs);
    if (r) {
      historyRef.current.push({ kind: 'snooze', cardId: card.id, previousDue: r.previousDue });
      showFlash(`Snoozed ${label}.`);
    }
    fetchNext();
  }, [card, fetchNext]);

  const suspend = useCallback(async () => {
    if (!card) return;
    await suspendCard(card.id);
    showFlash('Suspended.');
    fetchNext();
  }, [card, fetchNext]);

  const cycleFlag = useCallback(async () => {
    if (!note) return;
    const next = await cycleNoteFlag(note.id);
    setNote({ ...note, flag: next, modifiedAt: Date.now() });
    showFlash(next ? `Flag: ${FLAG_GLYPH[next]} ${FLAG_LABEL[next]}` : 'Flag cleared.');
  }, [note]);

  const fetchHint = useCallback(async () => {
    if (!note || !card || hintLoading) return;
    setHintLoading(true);
    try {
      const h = await generateHint(note, card);
      setHint(h);
    } catch (err) {
      setHint(`[hint error] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setHintLoading(false);
    }
  }, [note, card, hintLoading]);

  const undo = useCallback(async () => {
    // Try the in-memory stack first (most recent action this session).
    let last: UndoEntry | undefined = historyRef.current.pop();

    // If the stack is empty, fall back to the persisted review log so the
    // user can keep undoing across reloads. Snoozes can't be recovered this
    // way (no log row), but reviews can — the snapshot is still in settings.
    if (!last) {
      try {
        const studyDeckIds = await resolveStudyDeckIds();
        const recent = await listRecentUndoableReviews(studyDeckIds, 1);
        if (recent.length > 0) {
          const log = recent[0];
          last = { kind: 'review', cardId: log.cardId, logId: log.id };
        }
      } catch { /* fall through to "nothing to undo" */ }
    }

    if (!last) {
      showFlash('Nothing to undo.');
      return;
    }

    if (last.kind === 'review') {
      await rollbackReview(last.cardId, last.logId);
    } else {
      await restoreCardDue(last.cardId, last.previousDue);
    }
    const restoredCardId = last.cardId;

    // Take the user back to the card they just acted on, in front-phase.
    // The picker would pick *some* card next based on priority, but for
    // undo we want the visual: "I'm back where I was, ready to re-rate."
    // If the card lookup somehow fails, fall back to the normal fetchNext
    // path so the session never gets stuck.
    const restoredCard = await getCard(restoredCardId);
    if (!restoredCard) {
      showFlash('Undone (card no longer exists).');
      fetchNext();
      return;
    }
    const restoredNote = await getNote(restoredCard.noteId);
    if (!restoredNote) {
      showFlash('Undone (note no longer exists).');
      fetchNext();
      return;
    }
    // Drop the prefetch — it's targeting the *post-undo* next card; if we
    // keep it around the rate handler will short-circuit to the wrong card.
    prefetchRef.current = null;

    const opts = await effectiveOptsFor(restoredCard.deckId);
    setIntervals(previewIntervals(restoredCard, opts));
    setCard(restoredCard);
    setNote(restoredNote);
    setPhase('front');
    setShownAt(Date.now());
    // The session-progress bar tracks how many cards the user has rated this
    // session. Undoing a rate should decrement; clamp at 0 since this fires
    // even on snooze undos which never incremented the counter.
    setSessionReviewed(n => Math.max(0, n - 1));
    // Refresh deck counts so the chips/cap pill reflect the rolled-back state.
    const studyDeckIds = await resolveStudyDeckIds();
    const newCounts = await getDeckCounts(studyDeckIds);
    setCounts(newCounts);
    getScopeCapStatus(studyDeckIds).then(setCapStatus).catch(() => { /* silent */ });
    const remaining = historyRef.current.length;
    showFlash(remaining > 0 ? `Undone. ${remaining} more.` : 'Undone.');
  }, [fetchNext, effectiveOptsFor, resolveStudyDeckIds]);

  function showFlash(msg: string) {
    setFlash(msg);
    setTimeout(() => setFlash(null), 1400);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape always handled, even from inside form fields.
      if (e.key === 'Escape') {
        if (askOpen) {
          e.preventDefault();
          setAskOpen(false);
        } else if (!isFormField(e.target)) {
          router.push('/');
        }
        return;
      }

      // Shortcuts are suppressed only when focus is inside a form field
      // (so typing into the Ask textarea doesn't fire ratings). The Ask
      // panel itself can stay visible while the user keeps rating cards.
      if (isFormField(e.target)) return;

      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (phase === 'front') reveal();
        return;
      }
      // 1-4 (top row) and j/k/l/; (home row) both rate.
      if (phase === 'back') {
        const rating = ratingFromKey(e.key);
        if (rating) {
          e.preventDefault();
          rate(rating);
          return;
        }
      }
      if (e.key === 'h' || e.key === 'H') {
        if (phase === 'front') {
          e.preventDefault();
          fetchHint();
        }
        return;
      }
      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        setAskOpen(true);
        return;
      }
      if (e.key === 'e' || e.key === 'E') {
        if (note) router.push(`/note/${note.id}`);
        return;
      }
      // T = Teach back (Feynman mode). Only meaningful from the front
      // phase — entering it from the back would skip the active-recall
      // step. Esc inside the panel cancels back to compose-mode.
      if ((e.key === 't' || e.key === 'T') && phase === 'front') {
        e.preventDefault();
        setFeynmanOpen(true);
        return;
      }
      // P = read this side aloud / stop. Only meaningful when TTS is on.
      if ((e.key === 'p' || e.key === 'P') && ttsPrefs.enabled) {
        e.preventDefault();
        if (ttsActive) { cancelSpeech(); setTtsActive(false); }
        else speakCurrent(phase === 'back' ? 'back' : 'front');
        return;
      }
      if (e.key === 'b' || e.key === 'B') {
        if (card) burry();
        return;
      }
      if (e.key === 's' || e.key === 'S') {
        if (card) suspend();
        return;
      }
      if (e.key === 'f' || e.key === 'F') {
        if (note) {
          e.preventDefault();
          cycleFlag();
        }
        return;
      }
      if (e.key === 'u' || e.key === 'U') {
        undo();
        return;
      }
      // Cmd/Ctrl+Z: step back to the previous card (same as `u`).
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        undo();
        return;
      }
      // Snooze: N = 1 hour ("not now"), M = 1 day ("mañana"). Adjacent on
      // the bottom row so they don't compete with the rating row.
      if (!e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === 'n' || e.key === 'N')) {
        if (!card) return;
        e.preventDefault();
        snooze(60 * 60_000, '1 hour');
        return;
      }
      if (!e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === 'm' || e.key === 'M')) {
        if (!card) return;
        e.preventDefault();
        snooze(24 * 60 * 60_000, '1 day');
        return;
      }
      // `?` is now handled globally in AppShell so the panel works app-wide.
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, reveal, rate, askOpen, note, card, router, fetchHint, cycleFlag, snooze, undo]);

  function isFormField(target: EventTarget | null): boolean {
    const tag = (target as HTMLElement | null)?.tagName?.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select';
  }

  function ratingFromKey(key: string): Rating | null {
    switch (key) {
      case '1': case 'j': case 'J': return 1;
      case '2': case 'k': case 'K': return 2;
      case '3': case 'l': case 'L': return 3;
      case '4': case ';': case ':': return 4;
      default: return null;
    }
  }

  function leafName(fullName: string): string {
    const segs = fullName.split('::').map(s => s.trim()).filter(Boolean);
    return segs[segs.length - 1] ?? fullName;
  }

  function formatMinutes(ms: number): string {
    const minutes = ms / 60_000;
    if (minutes < 1) return `${Math.round(ms / 1000)}s`;
    if (minutes < 10) return `${minutes.toFixed(1)}m`;
    return `${Math.round(minutes)}m`;
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="px-3 md:px-6 py-3 md:py-4 flex items-center justify-between gap-3 border-b border-white/[0.04] backdrop-blur-md bg-dark-950/40 sticky top-0 z-30">
        <div className="flex items-center gap-3 max-w-[35%] md:max-w-[40%] min-w-0">
          <Tooltip content={virtualScope?.label ?? deck.name} side="bottom">
            <Link
              href="/"
              aria-label={`Back to decks (${virtualScope?.label ?? deck.name})`}
              className="text-sm text-dark-300 hover:text-dark-100 transition truncate"
            >
              ← {leafName(virtualScope?.label ?? deck.name)}
            </Link>
          </Tooltip>
          {scopeSize > 1 && (
            <Tooltip
              content={`Studying across ${scopeSize} sub-decks under ${deck.name}`}
              side="bottom"
            >
              <span
                className="hidden md:inline-flex shrink-0 items-center px-1.5 py-0.5 rounded text-2xs uppercase tracking-widest font-mono bg-persian-900/30 text-persian-200/90 tabular-nums"
                aria-label={`Parent study: ${scopeSize} sub-decks`}
              >
                {scopeSize}↧
              </span>
            </Tooltip>
          )}
          {note?.flag && (
            <FlagGlyph
              flag={note.flag}
              size="md"
              title={`Flag: ${FLAG_LABEL[note.flag]} (press F to cycle)`}
            />
          )}
        </div>
        <div className="flex items-center gap-4">
          {sessionStartDue !== null && sessionStartDue > 0 && (
            <div className="hidden md:flex items-center gap-2">
              <div className="w-32 h-1.5 rounded-full bg-dark-800/60 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-crimson-700 via-saffron-500 to-persian-400 transition-all duration-300"
                  style={{
                    width: `${Math.min(100, (sessionReviewed / sessionStartDue) * 100)}%`,
                  }}
                />
              </div>
              <span className="text-2xs uppercase tracking-widest tabular-nums text-dark-400">
                {sessionReviewed}/{sessionStartDue}
              </span>
            </div>
          )}
          <div className="hidden sm:flex items-center gap-3 text-2xs uppercase tracking-widest tabular-nums">
            <span className="text-saffron-400">new {counts.new}</span>
            <span className="text-crimson-400">learn {counts.learning}</span>
            <span className="text-persian-300">review {counts.review}</span>
          </div>
          {ttsPrefs.enabled && card && note && (
            <Tooltip
              side="bottom"
              content={ttsActive
                ? 'Speaking… click to stop.'
                : `Read ${phase === 'back' ? 'back' : 'front'} aloud (P)`}
            >
              <button
                onClick={() => {
                  if (ttsActive) { cancelSpeech(); setTtsActive(false); }
                  else speakCurrent(phase === 'back' ? 'back' : 'front');
                }}
                aria-label={ttsActive ? 'Stop reading aloud' : 'Read this side aloud'}
                className={cn(
                  'inline-flex items-center justify-center h-7 w-7 rounded-md text-sm transition border',
                  ttsActive
                    ? 'bg-saffron-900/30 text-saffron-200 border-saffron-700/40'
                    : 'bg-dark-800/40 text-dark-300 hover:text-dark-100 hover:bg-white/[0.04] border-white/[0.06]',
                )}
              >
                {ttsActive ? '◼' : '🔊'}
              </button>
            </Tooltip>
          )}
          {capStatus && Number.isFinite(capStatus.newCap) && (
            <Tooltip
              side="bottom"
              content={`New introductions: ${capStatus.newUsed}/${capStatus.newCap} today${capStatus.newSource ? ` · cap from ${capStatus.newSource}` : ''}`}
            >
              <span
                className={cn(
                  'hidden md:inline-flex items-center text-2xs uppercase tracking-widest font-mono tabular-nums px-1.5 py-0.5 rounded',
                  capStatus.newUsed >= capStatus.newCap
                    ? 'bg-crimson-900/30 text-crimson-300'
                    : capStatus.newUsed / Math.max(1, capStatus.newCap) >= 0.8
                      ? 'bg-saffron-900/30 text-saffron-300'
                      : 'bg-dark-800/40 text-dark-400',
                )}
              >
                {capStatus.newUsed}/{capStatus.newCap} new
              </span>
            </Tooltip>
          )}
          {todayStats && todayStats.count > 0 && (
            <Tooltip
              side="bottom"
              content={`${todayStats.count} cards · ${(todayStats.totalMs / 60_000).toFixed(1)} min · ${todayStats.secondsPerCard.toFixed(1)}s/card`}
            >
            <div
              className="hidden lg:flex items-center gap-2 text-2xs uppercase tracking-widest tabular-nums text-dark-400"
            >
              <span className="text-dark-500">today</span>
              <span>{todayStats.count}</span>
              <span className="text-dark-500">·</span>
              <span>{formatMinutes(todayStats.totalMs)}</span>
              {todayStats.perMinute > 0 && (
                <>
                  <span className="text-dark-500">·</span>
                  <span>{todayStats.perMinute.toFixed(1)}/min</span>
                </>
              )}
            </div>
            </Tooltip>
          )}
        </div>
        <button
          onClick={() => setAskOpen(true)}
          className="btn-gradient px-3 md:px-4 py-1.5 rounded-lg text-xs uppercase tracking-[0.2em] font-light flex items-center gap-2 shrink-0"
          aria-label="Ask AI (a)"
        >
          Ask
          <kbd className="hidden md:inline text-2xs text-white/40 font-mono">A</kbd>
        </button>
      </header>

      <div className="flex-1 flex flex-col items-center justify-start pt-8 md:pt-16 lg:pt-20 pb-10 px-4 md:px-6 max-w-3xl mx-auto w-full">
        {phase === 'loading' && (
          <div className="text-dark-400 text-sm font-light loading-shimmer rounded-md px-4 py-2">
            Loading…
          </div>
        )}

        {phase === 'empty' && (() => {
          // Distinguish three "empty" states so we don't lie to the user
          // when there are clearly cards in the deck:
          //   1. Daily new-card cap reached but new cards remain.
          //   2. Daily review cap reached but reviews remain.
          //   3. Learning steps are pending later (e.g. 10-min step).
          //   4. Genuinely empty (no cards at all in scope).
          const newCapBinding = capStatus
            && Number.isFinite(capStatus.newCap)
            && capStatus.newUsed >= capStatus.newCap
            && counts.new > 0;
          const reviewCapBinding = !newCapBinding
            && capStatus
            && Number.isFinite(capStatus.reviewCap)
            && capStatus.reviewUsed >= capStatus.reviewCap
            && counts.review > 0;
          const learningPending = !newCapBinding
            && !reviewCapBinding
            && counts.learning > 0;

          let title = 'Nothing due';
          let body: React.ReactNode = (
            <>You&apos;re caught up on this deck. Add cards or come back later.</>
          );
          if (newCapBinding) {
            title = 'Daily cap reached';
            body = (
              <>
                You&apos;ve hit today&apos;s new-card cap
                {' '}<span className="font-mono text-saffron-300 tabular-nums">{capStatus!.newUsed}/{capStatus!.newCap}</span>
                {capStatus!.newSource && capStatus!.newSource !== deck.name && (
                  <>{' '}<span className="text-dark-500">(from {capStatus!.newSource})</span></>
                )}.
                {' '}<span className="text-dark-300">{counts.new} new card{counts.new === 1 ? '' : 's'} waiting.</span>
                {' '}Come back tomorrow, or raise the cap in Tuning.
              </>
            );
          } else if (reviewCapBinding) {
            title = 'Daily review cap reached';
            body = (
              <>
                You&apos;ve hit today&apos;s review cap
                {' '}<span className="font-mono text-saffron-300 tabular-nums">{capStatus!.reviewUsed}/{capStatus!.reviewCap}</span>.
                {' '}<span className="text-dark-300">{counts.review} review{counts.review === 1 ? '' : 's'} pending.</span>
                {' '}Come back tomorrow, or raise the cap in Tuning.
              </>
            );
          } else if (learningPending) {
            title = 'No cards due right now';
            body = (
              <>
                <span className="font-mono text-saffron-300 tabular-nums">{counts.learning}</span> card{counts.learning === 1 ? '' : 's'} {counts.learning === 1 ? 'is' : 'are'} in learning steps and will be due later today. Come back in a few minutes.
              </>
            );
          }
          const showTuningLink = newCapBinding || reviewCapBinding;
          // For virtual-parent study there's no single deck-edit destination;
          // route to the deck page instead so the user can pick a sub-deck.
          const deckEditHref = virtualScope
            ? `/decks/path/${encodeURIComponent(virtualScope.label)}`
            : `/deck/${deck.id}/edit`;
          return (
            <div className="text-center space-y-3 max-w-xl px-4">
              <h2 className="text-3xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
                {title}
              </h2>
              <p className="text-dark-300 font-light">{body}</p>
              <div className="flex gap-3 justify-center pt-2 flex-wrap">
                {showTuningLink && (
                  <Link
                    href={deckEditHref}
                    className="btn-gradient px-5 py-2 rounded-xl text-sm"
                  >
                    Adjust cap
                  </Link>
                )}
                <Link
                  href={`/deck/${deck.id}`}
                  className={cn(
                    'px-5 py-2 rounded-xl text-sm transition',
                    showTuningLink
                      ? 'text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] border border-white/[0.06]'
                      : 'btn-gradient',
                  )}
                >
                  Browse deck
                </Link>
                <Link
                  href="/"
                  className="px-5 py-2 rounded-xl text-sm text-dark-300 hover:text-dark-100 hover:bg-white/[0.04] transition"
                >
                  Back to decks
                </Link>
              </div>
            </div>
          );
        })()}

        {feynmanOpen && card && note && (
          <div className="w-full max-w-3xl glass-card rounded-2xl p-5 md:p-6 animate-slide-up">
            <FeynmanPanel
              note={note}
              card={card}
              onCancel={() => setFeynmanOpen(false)}
              onReadyToRate={async ({ rating, multiplier }) => {
                if (!card) return;
                const dur = Date.now() - shownAt;
                const opts = await effectiveOptsFor(card.deckId);
                const { log } = await recordReview(card, rating, dur, {
                  ...opts,
                  intervalMultiplier: multiplier,
                });
                historyRef.current.push({ kind: 'review', cardId: card.id, logId: log.id });
                setSessionReviewed(n => n + 1);
                try { localStorage.removeItem(resumeKey); } catch { /* ignore */ }
                setFeynmanOpen(false);
                fetchNext();
              }}
            />
          </div>
        )}

        {!feynmanOpen && (phase === 'front' || phase === 'back') && card && note && (
          <div className="w-full space-y-6">
            <div
              role={phase === 'front' ? 'button' : undefined}
              tabIndex={phase === 'front' ? 0 : undefined}
              onClick={phase === 'front' ? reveal : undefined}
              onKeyDown={phase === 'front' ? (e => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault();
                  reveal();
                }
              }) : undefined}
              onDoubleClick={e => {
                // Double-click any Persian/Arabic-script word → open lookup.
                const sel = window.getSelection?.()?.toString().trim();
                if (sel && /[؀-ۿ]/.test(sel)) {
                  e.preventDefault();
                  setLookupWord(sel);
                  setLookupOpen(true);
                }
              }}
              className={cn(
                'glass-card rounded-3xl p-7 md:p-9 min-h-[14rem] flex items-center justify-center animate-fade-in',
                phase === 'front' && 'cursor-pointer hover:border-white/[0.10] transition',
              )}
              aria-label={phase === 'front' ? 'Click to reveal answer' : undefined}
            >
              <CardRenderer note={note} card={card} side={phase} className="w-full" />
            </div>

            {phase === 'front' && typeMode && (
              <TypeAnswer note={note} card={card} onRate={rate} />
            )}

            {phase === 'front' && !typeMode && (
              <div className="flex justify-center">
                <button
                  onClick={reveal}
                  className="btn-gradient px-10 py-3 rounded-2xl text-sm uppercase tracking-[0.2em] font-light"
                >
                  Reveal
                </button>
              </div>
            )}

            {phase === 'front' && hint && (
              <div className="glass-card rounded-2xl p-4 max-w-xl mx-auto text-center">
                <div className="text-2xs uppercase tracking-widest text-saffron-400 mb-1">Hint</div>
                <div className="text-sm font-light italic text-dark-100">{hint}</div>
              </div>
            )}

            {phase === 'back' && (
              confidenceMode
                ? <ConfidenceButtons intervals={intervals} onRate={rate} />
                : <RatingButtons intervals={intervals} onRate={rate} />
            )}
          </div>
        )}
      </div>

      {note && card && (
        <AskAI open={askOpen} onClose={() => setAskOpen(false)} note={note} card={card} />
      )}

      <LookupPanel
        open={lookupOpen}
        onClose={() => setLookupOpen(false)}
        initialWord={lookupWord}
      />

      {/* KeyboardHelp is mounted globally in AppShell; keep helpOpen here
          for any future Reviewer-specific binding without a re-render hop. */}

      {tuneReport && (
        <RetentionTuneToast
          report={tuneReport}
          onApply={applyTune}
          onDismiss={dismissTune}
        />
      )}

      {flash && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-xl bg-dark-800/80 backdrop-blur-md border border-white/[0.06] text-sm text-dark-100 z-40 animate-fade-in">
          {flash}
        </div>
      )}
    </div>
  );
}
