/**
 * Orchestrator: project → plan → pipeline(script + render).
 *
 * The build is broken into discrete stages, each one persisting its
 * output before the next runs. If the user closes the tab mid-build,
 * partial state survives on disk and `resumePodcastBuild()` picks up
 * from the first incomplete stage. The script + render stages fail
 * per-segment (not for the whole batch), so a single Opus or TTS
 * blip never invalidates the rest.
 *
 * The big shape change vs. v1: script and render run as ONE PIPELINE
 * through two concurrency pools. As soon as segment N's script lands,
 * segment N's render kicks off — without waiting for the rest of the
 * script pass to finish. Combined with bumped concurrencies (6 script,
 * 3 render) this is the ~3× speedup over the v1 two-phase approach.
 *
 * Every external call is wrapped in a per-request timeout via the
 * `timeoutSignal` watchdog, so a single hung connection can't freeze
 * the whole build (the bug that stalled a real run at 5/7).
 *
 * Progress is reported through a single `onEvent` callback with a
 * `progress` event carrying both `scriptedDone` + `renderedDone`.
 */

import { id as ulid } from '@/lib/ulid';
import type {
  Podcast,
  PodcastAudioStyle,
  PodcastDepth,
  PodcastHorizon,
  PodcastMode,
  PodcastSegment,
  PodcastTtsProvider,
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
import { scriptSingleSegment } from './script';
import { renderTurnsToSegment, type OpenAIVoice, type OpenAITtsModel } from './tts-openai';
import { WORDS_PER_MINUTE } from './plan';
import { Pool } from './abort';

/** Pipeline concurrency caps. Script pool is the Opus side; render pool
 *  is the OpenAI TTS side. They run independently, so a script that
 *  lands first immediately moves to render even while later scripts are
 *  still in flight. */
const SCRIPT_PARALLEL = 6;
const RENDER_PARALLEL = 3;

export interface BuildInput {
  name?: string;
  deckIds: string[];
  mode?: PodcastMode;
  horizon: PodcastHorizon;
  tagFilter?: string[];
  practiceQueryId?: string;
  targetSeconds: number;
  depthOverride?: PodcastDepth | null;
  ttsProvider: PodcastTtsProvider;
  voiceA?: OpenAIVoice;
  voiceB?: OpenAIVoice;
  ttsModel?: OpenAITtsModel;
  speed?: number;
  audioStyle?: PodcastAudioStyle;
  signal?: AbortSignal;
}

export type BuildEvent =
  | { stage: 'projecting' }
  | { stage: 'planning'; cardCount: number }
  | { stage: 'planned'; podcastId: string; plan: PodcastPlan; estCostUsd: number }
  | { stage: 'progress'; scriptedDone: number; renderedDone: number; total: number }
  | { stage: 'ready'; podcastId: string }
  | { stage: 'error'; message: string }
  | { stage: 'aborted'; podcastId: string };

export interface BuildResult {
  podcastId: string;
}

function estCostFromChars(chars: number, model: OpenAITtsModel | undefined): number {
  const per1M = (model === 'tts-1-hd') ? 30 : 15;
  return (chars / 1_000_000) * per1M;
}

/* ─── Public API ───────────────────────────────────────────────── */

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
    const scopedProjection = { ...projection, cards };

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
    const plan = await planPodcast(scopedProjection, input.targetSeconds, depthOverride, signal);

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

    const estChars = plan.totalTargetWords * 5.5;
    const estCost = input.ttsProvider === 'openai'
      ? estCostFromChars(estChars, input.ttsModel)
      : 0;
    emit({ stage: 'planned', podcastId, plan, estCostUsd: estCost });

    if (signal?.aborted) throw new AbortError();
    await setPodcastStatus(podcastId, 'scripting');

    // Build the task list: every segment needs script-then-render. The
    // intro from the plan rides as the first turn of segment 0 so the
    // listener actually hears it (the script prompt forbids intros in
    // segment bodies).
    const reloadedPodcast = (await getPodcast(podcastId))!;
    const tasks: SegmentTask[] = segmentRows.map((row, i) => ({
      kind: 'script',
      segRow: row,
      plannedSeg: plan.segments[i],
      nextTitle: i + 1 < segmentRows.length ? plan.segments[i + 1].title : null,
      prependIntro: i === 0 && plan.intro ? plan.intro : undefined,
    }));
    await pipeline(reloadedPodcast, tasks, signal, emit);

    if (signal?.aborted) throw new AbortError();
    await finaliseAggregates(podcastId);
    await setPodcastStatus(podcastId, 'ready', { completedAt: Date.now() });
    emit({ stage: 'ready', podcastId });
    return { podcastId };
  } catch (err) {
    if (err instanceof AbortError || (err instanceof Error && err.name === 'AbortError')) {
      const existing = await getPodcast(podcastId);
      if (existing) await setPodcastStatus(podcastId, 'error', { error: 'Build cancelled' });
      emit({ stage: 'aborted', podcastId });
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    const existing = await getPodcast(podcastId);
    if (existing) await setPodcastStatus(podcastId, 'error', { error: msg });
    emit({ stage: 'error', message: msg });
    throw err;
  }
}

/**
 * Pick up an interrupted (or errored) build. Inspects current segment
 * statuses and pipelines only the work that's missing.
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

  // Build the task list: each segment becomes a 'script' task (if no
  // body yet) or a 'render-only' task (body but no audio). Already-
  // rendered segments are skipped entirely.
  const tasks: SegmentTask[] = [];
  for (const seg of segs) {
    const isRendered = seg.status === 'rendered';
    if (isRendered) continue;
    const wantsRetry = options.retryErrors && seg.status === 'error';
    const needsScript = seg.status === 'planned' || (wantsRetry && (seg.turns?.length ?? 0) === 0);
    const needsRender = seg.status === 'scripted' || (wantsRetry && (seg.turns?.length ?? 0) > 0);
    if (!needsScript && !needsRender) continue;
    const nextTitle = seg.index + 1 < segs.length ? segs[seg.index + 1].title : null;
    if (needsScript) {
      tasks.push({
        kind: 'script',
        segRow: seg,
        plannedSeg: {
          title: seg.title,
          description: seg.description,
          cardIds: seg.cardIds,
          depth: seg.depth,
          targetWords: seg.targetWords,
        },
        nextTitle,
      });
    } else {
      tasks.push({ kind: 'render-only', segRow: seg, nextTitle });
    }
  }

  if (tasks.length === 0) {
    await setPodcastStatus(podcastId, 'ready', { completedAt: Date.now() });
    emit({ stage: 'ready', podcastId });
    return;
  }

  try {
    await pipeline(podcast, tasks, signal, emit);
    await finaliseAggregates(podcastId);
    await setPodcastStatus(podcastId, 'ready', { completedAt: Date.now() });
    emit({ stage: 'ready', podcastId });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      emit({ stage: 'aborted', podcastId });
      throw err;
    }
    throw err;
  }
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

  await finaliseAggregates(podcastId);
}

/* ─── Pipeline core ────────────────────────────────────────────── */

interface ScriptTask {
  kind: 'script';
  segRow: PodcastSegment;
  plannedSeg: PlannedSegment;
  nextTitle: string | null;
  /** Inject this string as the first A-turn (used for the plan's intro). */
  prependIntro?: string;
}
interface RenderOnlyTask {
  kind: 'render-only';
  segRow: PodcastSegment;
  nextTitle: string | null;
}
type SegmentTask = ScriptTask | RenderOnlyTask;

/**
 * Run a list of tasks through the script and render pools. Tasks
 * progress through their phases independently of each other; a finished
 * script immediately hands off to a render slot if one is free, so the
 * stages overlap.
 *
 * Per-task failures are recorded on the segment row (`error` + status
 * 'error') and do NOT abort the rest of the pipeline. Only an
 * AbortError from the signal propagates.
 */
async function pipeline(
  podcast: Podcast,
  tasks: SegmentTask[],
  signal: AbortSignal | undefined,
  emit: (e: BuildEvent) => void,
): Promise<void> {
  const scriptPool = new Pool(SCRIPT_PARALLEL);
  const renderPool = new Pool(RENDER_PARALLEL);
  const total = tasks.length;
  let scriptedDone = tasks.filter(t => t.kind === 'render-only').length;
  let renderedDone = 0;
  const reportProgress = () =>
    emit({ stage: 'progress', scriptedDone, renderedDone, total });

  reportProgress();

  const doTask = async (task: SegmentTask): Promise<void> => {
    const segRow = task.segRow;
    let turns = segRow.turns ?? [];

    /* ─── Script phase ─── */
    if (task.kind === 'script') {
      try {
        if (signal?.aborted) throw new AbortError();
        const scripted = await scriptPool.run(() => scriptSingleSegment(
          task.plannedSeg, segRow.index, total, task.nextTitle, podcast.name, signal,
        ));
        const introTurn = task.prependIntro
          ? [{ speaker: 'A' as const, text: task.prependIntro }]
          : [];
        turns = [
          ...introTurn,
          ...scripted.turns,
          { speaker: scripted.transition.speaker, text: scripted.transition.text },
        ];
        const transcript = turns.map(t => `${t.speaker}: ${t.text}`).join('\n\n');
        await updateSegment(segRow.id, {
          turns,
          script: transcript,
          transition: scripted.transition.text,
          status: 'scripted',
          error: undefined,
        });
      } catch (err) {
        if (err instanceof AbortError || (err instanceof Error && err.name === 'AbortError')) {
          throw err;
        }
        await setSegmentStatus(segRow.id, 'error', {
          error: err instanceof Error ? err.message : String(err),
        });
        scriptedDone++;
        renderedDone++;
        reportProgress();
        return;
      }
      scriptedDone++;
      reportProgress();
    }

    /* ─── Render phase ─── */
    if (podcast.ttsProvider === 'openai') {
      try {
        if (signal?.aborted) throw new AbortError();
        const segForRender: PodcastSegment = { ...segRow, turns };
        await renderPool.run(() => renderSegmentAudio(podcast, segForRender, signal));
      } catch (err) {
        if (err instanceof AbortError || (err instanceof Error && err.name === 'AbortError')) {
          throw err;
        }
        await setSegmentStatus(segRow.id, 'error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      // Browser-TTS: no audio bytes, just approximate duration so the
      // library/podcast page show a useful total.
      const words = turns.map(t => t.text).join(' ').split(/\s+/).filter(Boolean).length;
      await updateSegment(segRow.id, {
        status: 'rendered',
        durationSec: (words / WORDS_PER_MINUTE) * 60,
      });
    }
    renderedDone++;
    reportProgress();
  };

  await Promise.all(tasks.map(doTask));
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
      model: 'tts-1',
      speed: 1.0,
      signal,
    },
  );
  await putSegmentAudio(podcast.id, seg.index, 'audio/mpeg', result.blob);
  const stampedTurns = turns.map((t, i) => ({
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

/**
 * After the pipeline completes, recompute the podcast row's
 * aggregates (totalChars, durationSec, totalBytes) so the library tile
 * + player chrome show correct numbers.
 */
async function finaliseAggregates(podcastId: string): Promise<void> {
  const segs = await listSegments(podcastId);
  segs.sort((a, b) => a.index - b.index);
  let totalChars = 0;
  let durationSec = 0;
  for (const s of segs) {
    totalChars += (s.script ?? '').length;
    durationSec += s.durationSec ?? 0;
  }
  const totalBytes = await totalAudioBytes(podcastId);
  await updatePodcast(podcastId, { totalChars, durationSec, totalBytes });
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

