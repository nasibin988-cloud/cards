/**
 * Orchestrator: project → plan → script → render.
 *
 * The build is broken into discrete stages, each one persisting its
 * output before the next runs. If the user closes the tab mid-build,
 * the partial state survives on disk and `resumePodcastBuild()` can
 * pick up from the first incomplete stage. The script + render stages
 * fail per-segment (not for the whole batch) so a single Opus or TTS
 * blip never invalidates everything that succeeded.
 *
 * Progress is reported via a single `onEvent` callback so the page
 * shows a live status line without each stage needing its own
 * subscription wire. An `AbortSignal` threaded into every external
 * call cancels the build mid-flight.
 */

import { id as ulid } from '@/lib/ulid';
import { db } from '@/lib/db/dexie';
import type {
  Podcast,
  PodcastAudioStyle,
  PodcastDepth,
  PodcastHorizon,
  PodcastMode,
  PodcastSegment,
  PodcastTtsProvider,
  PodcastTurn,
} from '@/lib/db/schema';
import {
  createPodcast,
  getPodcast,
  listSegments,
  putSegments,
  putSegmentAudio,
  setPodcastStatus,
  setSegmentStatus,
  updatePodcast,
  updateSegment,
  totalAudioBytes,
} from '@/lib/db/podcast-queries';
import { projectQueue } from './queue-projection';
import { planPodcast, type PodcastPlan, type PlannedSegment } from './plan';
import { scriptAllSegments, scriptSingleSegment, type ScriptedSegment } from './script';
import { renderTurnsToSegment, type OpenAIVoice, type OpenAITtsModel } from './tts-openai';
import { WORDS_PER_MINUTE } from './plan';

export interface BuildInput {
  name?: string;
  deckIds: string[];
  mode?: PodcastMode;
  horizon: PodcastHorizon;
  /** Tag filter applied to the projection (preview mode). */
  tagFilter?: string[];
  /** Practice-query scope (preview mode). */
  practiceQueryId?: string;
  /** Requested length in seconds. */
  targetSeconds: number;
  depthOverride?: PodcastDepth | null;
  ttsProvider: PodcastTtsProvider;
  voiceA?: OpenAIVoice;
  voiceB?: OpenAIVoice;
  ttsModel?: OpenAITtsModel;
  /** Default 1.0; OpenAI TTS speed parameter applied at render time. */
  speed?: number;
  /** Audio finishing applied at playback time. */
  audioStyle?: PodcastAudioStyle;
  /** Optional name override. */
  signal?: AbortSignal;
}

export type BuildEvent =
  | { stage: 'projecting' }
  | { stage: 'planning'; cardCount: number }
  | { stage: 'planned'; podcastId: string; plan: PodcastPlan; estCostUsd: number }
  | { stage: 'scripting'; done: number; total: number }
  | { stage: 'rendering'; done: number; total: number; segmentIndex: number }
  | { stage: 'ready'; podcastId: string }
  | { stage: 'error'; message: string }
  | { stage: 'aborted'; podcastId: string };

export interface BuildResult {
  podcastId: string;
}

/**
 * Estimate render cost in USD from total script characters (final
 * accuracy comes from the script pass itself). Returns 0 for the
 * browser fallback.
 */
function estCostFromChars(chars: number, model: OpenAITtsModel | undefined): number {
  const per1M = (model === 'tts-1-hd') ? 30 : 15;
  return (chars / 1_000_000) * per1M;
}

/**
 * Build one podcast end-to-end. Returns the podcast id once status
 * reaches 'ready' (or throws if planning produced nothing usable).
 * Render failures on individual segments are recorded per-segment but
 * do not throw, so the listener still gets the segments that
 * succeeded. Honors `signal` for full-build cancellation.
 */
export async function buildPodcast(
  input: BuildInput,
  onEvent?: (e: BuildEvent) => void,
): Promise<BuildResult> {
  const emit = (e: BuildEvent) => onEvent?.(e);
  const podcastId = ulid();
  const depthOverride = input.depthOverride ?? null;
  const signal = input.signal;

  try {
    if (signal?.aborted) throw new AbortError();

    emit({ stage: 'projecting' });
    const projection = await projectQueue(input.deckIds, input.horizon);
    let cards = projection.cards;
    if (input.tagFilter && input.tagFilter.length > 0) {
      const tagSet = new Set(input.tagFilter);
      cards = cards.filter(p => (p.note.tags ?? []).some(t => tagSet.has(t)));
    }
    if (cards.length === 0) {
      const msg = 'No cards in scope after filters. Try a wider horizon or remove tag filters.';
      emit({ stage: 'error', message: msg });
      throw new Error(msg);
    }
    // Substitute the filtered list back in so plan + script see only those.
    const scopedProjection = { ...projection, cards };

    // Materialise the Podcast row immediately so the library shows it.
    const podcast: Podcast = await createPodcast({
      id: podcastId,
      name: input.name?.trim() || autoName(projection.decksById, input.horizon, cards.length),
      deckIds: input.deckIds,
      horizon: input.horizon,
      mode: input.mode,
      tagFilter: input.tagFilter,
      practiceQueryId: input.practiceQueryId,
      audioStyle: input.audioStyle ?? 'none',
      targetSeconds: input.targetSeconds,
      depthOverride: depthOverride ?? undefined,
      ttsProvider: input.ttsProvider,
      voiceA: input.ttsProvider === 'openai' ? (input.voiceA ?? 'alloy') : undefined,
      voiceB: input.ttsProvider === 'openai' ? (input.voiceB ?? 'onyx') : undefined,
      status: 'planning',
      cardCount: cards.length,
      totalChars: 0,
    });

    if (signal?.aborted) throw new AbortError();
    emit({ stage: 'planning', cardCount: cards.length });
    const plan = await planPodcast(scopedProjection, input.targetSeconds, depthOverride);

    const segmentRows: PodcastSegment[] = plan.segments.map((s, i) => ({
      id: ulid(),
      podcastId,
      index: i,
      title: s.title,
      description: s.description,
      cardIds: s.cardIds,
      depth: s.depth,
      targetWords: s.targetWords,
      script: '',
      transition: '',
      status: 'planned',
    }));
    await putSegments(segmentRows);
    await updatePodcast(podcastId, { name: plan.title || podcast.name });

    // Cost preview event. Rough at this point (real char count lands
    // after scripting); we use word-count × 5.5 as the char proxy.
    const estChars = plan.totalTargetWords * 5.5;
    const estCost = input.ttsProvider === 'openai'
      ? estCostFromChars(estChars, input.ttsModel)
      : 0;
    emit({ stage: 'planned', podcastId, plan, estCostUsd: estCost });

    if (signal?.aborted) throw new AbortError();
    await setPodcastStatus(podcastId, 'scripting');
    emit({ stage: 'scripting', done: 0, total: segmentRows.length });

    const scripted = await scriptAllSegments(
      plan.segments,
      plan.title || podcast.name,
      (done, total) => emit({ stage: 'scripting', done, total }),
      signal,
    );

    // Persist each scripted segment (or its error). Intro from the plan
    // is prepended to segment 0 as an A-turn so the listener doesn't
    // miss it (the script prompt forbids intros from inside segments).
    let totalChars = 0;
    for (let i = 0; i < scripted.length; i++) {
      const s = scripted[i];
      const row = segmentRows[i];
      if (s.error) {
        await setSegmentStatus(row.id, 'error', {
          turns: [],
          script: '',
          transition: '',
          error: s.error,
        });
      } else {
        const turns = i === 0 && plan.intro
          ? [{ speaker: 'A' as const, text: plan.intro }, ...s.turns, { speaker: s.transition.speaker, text: s.transition.text }]
          : [...s.turns, { speaker: s.transition.speaker, text: s.transition.text }];
        const transcript = turns.map(t => `${t.speaker}: ${t.text}`).join('\n\n');
        totalChars += transcript.length;
        await updateSegment(row.id, {
          turns,
          script: transcript,
          transition: s.transition.text,
          status: 'scripted',
        });
      }
    }
    await updatePodcast(podcastId, { totalChars });

    if (signal?.aborted) throw new AbortError();
    await setPodcastStatus(podcastId, 'rendering');

    if (input.ttsProvider === 'openai') {
      await renderAllSegments(podcastId, input, signal, (done, total, segmentIndex) =>
        emit({ stage: 'rendering', done, total, segmentIndex }),
      );
    } else {
      // Browser TTS: mark segments rendered, approximate durations.
      const segs = await listSegments(podcastId);
      segs.sort((a, b) => a.index - b.index);
      let durationAcc = 0;
      for (const seg of segs) {
        if (seg.status === 'error') continue;
        const text = (seg.turns ?? []).map(t => t.text).join(' ');
        const words = text.split(/\s+/).filter(Boolean).length;
        const approx = (words / WORDS_PER_MINUTE) * 60;
        await updateSegment(seg.id, { status: 'rendered', durationSec: approx });
        durationAcc += approx;
      }
      await updatePodcast(podcastId, { durationSec: durationAcc });
    }

    if (signal?.aborted) throw new AbortError();
    await setPodcastStatus(podcastId, 'ready', { completedAt: Date.now() });
    emit({ stage: 'ready', podcastId });
    return { podcastId };
  } catch (err) {
    if (err instanceof AbortError || (err instanceof Error && err.name === 'AbortError')) {
      const existing = await getPodcast(podcastId);
      if (existing) {
        await setPodcastStatus(podcastId, 'error', { error: 'Build cancelled' });
      }
      emit({ stage: 'aborted', podcastId });
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    const existing = await getPodcast(podcastId);
    if (existing) {
      await setPodcastStatus(podcastId, 'error', { error: msg });
    }
    emit({ stage: 'error', message: msg });
    throw err;
  }
}

/**
 * Pick up an interrupted build. Inspects current segment statuses and
 * re-runs only what's missing:
 *   - segments at 'planned' (no script): re-script + re-render
 *   - segments at 'scripted'  (no audio): re-render only
 *   - segments at 'rendered' or 'error': left alone unless retryErrors
 */
export async function resumePodcastBuild(
  podcastId: string,
  onEvent?: (e: BuildEvent) => void,
  signal?: AbortSignal,
  options: { retryErrors?: boolean } = {},
): Promise<void> {
  const emit = (e: BuildEvent) => onEvent?.(e);
  const podcast = await getPodcast(podcastId);
  if (!podcast) throw new Error('Podcast not found.');
  const segs = await listSegments(podcastId);
  segs.sort((a, b) => a.index - b.index);
  if (segs.length === 0) throw new Error('No segments to resume.');

  await setPodcastStatus(podcastId, 'scripting');

  // Re-script anything that's missing a body (status 'planned' or
  // 'error' when retryErrors).
  const needsScript = segs.filter(s =>
    s.status === 'planned'
    || (options.retryErrors && s.status === 'error'),
  );
  if (needsScript.length > 0) {
    let done = 0;
    emit({ stage: 'scripting', done, total: needsScript.length });
    for (const row of needsScript) {
      if (signal?.aborted) throw new AbortError();
      const plannedShape: PlannedSegment = {
        title: row.title,
        description: row.description,
        cardIds: row.cardIds,
        depth: row.depth,
        targetWords: row.targetWords,
      };
      try {
        const next = row.index + 1 < segs.length ? segs[row.index + 1].title : null;
        const s = await scriptSingleSegment(plannedShape, row.index, segs.length, next, podcast.name, signal);
        const turns = [...s.turns, { speaker: s.transition.speaker, text: s.transition.text }];
        const transcript = turns.map(t => `${t.speaker}: ${t.text}`).join('\n\n');
        await updateSegment(row.id, {
          turns,
          script: transcript,
          transition: s.transition.text,
          status: 'scripted',
          error: undefined,
        });
      } catch (err) {
        await setSegmentStatus(row.id, 'error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      done++;
      emit({ stage: 'scripting', done, total: needsScript.length });
    }
  }

  // Re-render anything that's missing audio (OpenAI mode only).
  if (podcast.ttsProvider === 'openai') {
    await setPodcastStatus(podcastId, 'rendering');
    const fresh = await listSegments(podcastId);
    fresh.sort((a, b) => a.index - b.index);
    const needsRender = fresh.filter(s =>
      (s.status === 'scripted')
      || (options.retryErrors && s.status === 'error' && (s.turns?.length ?? 0) > 0),
    );
    let done = 0;
    const total = needsRender.length;
    if (total > 0) emit({ stage: 'rendering', done, total, segmentIndex: needsRender[0].index });
    for (const seg of needsRender) {
      if (signal?.aborted) throw new AbortError();
      try {
        await renderSegmentAudio(podcast, seg, signal);
      } catch (err) {
        await setSegmentStatus(seg.id, 'error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      done++;
      emit({ stage: 'rendering', done, total, segmentIndex: seg.index });
    }
  }

  // Refresh aggregates.
  const final = await listSegments(podcastId);
  final.sort((a, b) => a.index - b.index);
  const durationSec = final.reduce((acc, s) => acc + (s.durationSec ?? 0), 0);
  const totalBytes = await totalAudioBytes(podcastId);
  await updatePodcast(podcastId, { durationSec, totalBytes });
  await setPodcastStatus(podcastId, 'ready', { completedAt: Date.now() });
  emit({ stage: 'ready', podcastId });
}

/**
 * Retry one segment from scratch: re-script + re-render. Used by the
 * player's per-segment retry button.
 */
export async function retrySegment(
  podcastId: string,
  segmentIndex: number,
  signal?: AbortSignal,
): Promise<void> {
  const podcast = await getPodcast(podcastId);
  if (!podcast) throw new Error('Podcast not found.');
  const segs = await listSegments(podcastId);
  segs.sort((a, b) => a.index - b.index);
  const row = segs.find(s => s.index === segmentIndex);
  if (!row) throw new Error(`Segment ${segmentIndex} not found.`);

  const plannedShape: PlannedSegment = {
    title: row.title,
    description: row.description,
    cardIds: row.cardIds,
    depth: row.depth,
    targetWords: row.targetWords,
  };
  const next = segmentIndex + 1 < segs.length ? segs[segmentIndex + 1].title : null;
  const s = await scriptSingleSegment(plannedShape, segmentIndex, segs.length, next, podcast.name, signal);
  const turns = [...s.turns, { speaker: s.transition.speaker, text: s.transition.text }];
  const transcript = turns.map(t => `${t.speaker}: ${t.text}`).join('\n\n');
  await updateSegment(row.id, {
    turns,
    script: transcript,
    transition: s.transition.text,
    status: 'scripted',
    error: undefined,
    durationSec: undefined,
  });

  if (podcast.ttsProvider === 'openai') {
    const fresh = await listSegments(podcastId);
    const updatedRow = fresh.find(x => x.id === row.id)!;
    await renderSegmentAudio(podcast, updatedRow, signal);
  } else {
    const words = (turns.map(t => t.text).join(' ')).split(/\s+/).filter(Boolean).length;
    await updateSegment(row.id, {
      status: 'rendered',
      durationSec: (words / WORDS_PER_MINUTE) * 60,
    });
  }
}

/* ─── Internals ────────────────────────────────────────────────── */

async function renderAllSegments(
  podcastId: string,
  input: BuildInput,
  signal: AbortSignal | undefined,
  onEach: (done: number, total: number, segmentIndex: number) => void,
): Promise<void> {
  const podcast = await getPodcast(podcastId);
  if (!podcast) throw new Error('Podcast vanished mid-build.');
  const segs = await listSegments(podcastId);
  segs.sort((a, b) => a.index - b.index);
  const renderable = segs.filter(s => s.status === 'scripted' && (s.turns?.length ?? 0) > 0);
  const total = renderable.length;
  let done = 0;
  let durationAcc = 0;
  for (const seg of renderable) {
    if (signal?.aborted) throw new AbortError();
    try {
      const dur = await renderSegmentAudio(podcast, seg, signal);
      durationAcc += dur;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      await setSegmentStatus(seg.id, 'error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    done++;
    onEach(done, total, seg.index);
  }
  // Skipped segments (status 'error') contribute 0 duration.
  for (const seg of segs) {
    if (seg.status === 'rendered' && seg.durationSec) durationAcc += seg.durationSec;
  }
  const totalBytes = await totalAudioBytes(podcastId);
  await updatePodcast(podcastId, { durationSec: durationAcc, totalBytes });
}

/**
 * Render audio for one segment using the multi-voice renderer, writing
 * the blob into podcastAudio and the per-turn timings into the segment
 * row. Returns the segment duration in seconds.
 */
async function renderSegmentAudio(
  podcast: Podcast,
  seg: PodcastSegment,
  signal: AbortSignal | undefined,
): Promise<number> {
  const turns = seg.turns ?? [];
  if (turns.length === 0) {
    throw new Error(`Segment "${seg.title}" has no turns to render.`);
  }
  const voiceA = (podcast.voiceA ?? 'alloy') as OpenAIVoice;
  const voiceB = (podcast.voiceB ?? 'onyx') as OpenAIVoice;
  const result = await renderTurnsToSegment(
    turns.map(t => ({ speaker: t.speaker, text: t.text })),
    {
      voiceA,
      voiceB,
      model: 'tts-1', // user can override via Podcast.ttsModel in a later iteration
      speed: 1.0,
      signal,
    },
  );
  await putSegmentAudio(podcast.id, seg.index, 'audio/mpeg', result.blob);
  const stampedTurns: PodcastTurn[] = turns.map((t, i) => ({
    speaker: t.speaker,
    text: t.text,
    startSec: result.timings[i]?.startSec ?? 0,
    durationSec: result.timings[i]?.durationSec ?? 0,
  }));
  await updateSegment(seg.id, {
    turns: stampedTurns,
    status: 'rendered',
    durationSec: result.totalDurationSec,
    error: undefined,
  });
  return result.totalDurationSec;
}

class AbortError extends Error {
  constructor() {
    super('Build cancelled');
    this.name = 'AbortError';
  }
}

function autoName(
  decksById: Map<string, { name: string }>,
  horizon: PodcastHorizon,
  cardCount: number,
): string {
  const deckNames = [...decksById.values()].map(d => d.name).slice(0, 3);
  const deckPart = deckNames.length === 0
    ? 'Study'
    : deckNames.length === 1
      ? deckNames[0]
      : `${deckNames.slice(0, 2).join(' + ')}${deckNames.length > 2 ? ', …' : ''}`;
  const horizonPart =
    horizon === 'today' ? 'today'
    : horizon === 'tomorrow' ? 'tomorrow'
    : horizon === 'week' ? 'next 7 days'
    : horizon === 'new-only' ? 'new cards'
    : 'all cards';
  return `${deckPart} (${horizonPart}, ${cardCount} cards)`;
}
