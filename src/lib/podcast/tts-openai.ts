/**
 * OpenAI tts-1 renderer.
 *
 * Why OpenAI tts-1 over the in-browser SpeechSynthesis API:
 *   - The voice is podcast-grade. Native voices are robotic at any
 *     length over a few minutes.
 *   - It returns real audio bytes that we can cache in IndexedDB so a
 *     4hr podcast is rendered once and free to replay forever.
 *
 * Why not the OpenAI SDK: this endpoint is one POST returning audio
 * bytes. Pulling the SDK into the browser bundle for one call is
 * wasteful; `fetch` does the job.
 *
 * Chunking: tts-1's `input` field is capped at 4096 characters per
 * request. We split each segment on sentence boundaries, accumulate
 * up to ~3800 chars per chunk, render each in sequence, then concat
 * the MP3 blobs. MP3 frame concatenation is byte-safe for our
 * decoders (HTMLAudioElement on every modern browser) because each
 * chunk ends on a frame boundary the encoder emitted.
 */

import { getOpenAIKey } from '@/lib/openai-key';
import { timeoutSignal } from './abort';

/** Hard cap from the OpenAI API. */
const OPENAI_TTS_INPUT_MAX = 4096;
/** Our soft cap; leaves room for sentence-split slop. */
const CHUNK_TARGET = 3800;

export type OpenAIVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
/**
 * tts-1   — fastest, cheapest, audiobook-narrator quality
 * tts-1-hd — slower, ~2× cost, slightly cleaner highs
 * gpt-4o-mini-tts — newest, accepts an `instructions` field that
 *   steers tone/pace/emotion. Sounds dramatically more conversational
 *   than tts-1/hd at similar cost. Default for new podcasts.
 */
export type OpenAITtsModel = 'tts-1' | 'tts-1-hd' | 'gpt-4o-mini-tts';

export interface RenderOptions {
  voice?: OpenAIVoice;
  model?: OpenAITtsModel;
  /** 0.25 to 4.0; 1.0 is normal pace. tts-1/hd only — gpt-4o-mini-tts
   *  takes pacing through `instructions` instead and ignores this. */
  speed?: number;
  /** Tone/style steering string. Only honored by gpt-4o-mini-tts. */
  instructions?: string;
  signal?: AbortSignal;
}

/**
 * Default instruction strings the conversational two-voice path uses.
 * Voice A is the curious thinker; Voice B is the methodical one. These
 * are tuned for the Socratic dialogue shape the script prompt enforces.
 */
export const DEFAULT_INSTRUCTIONS_A =
  "Speak as a curious, engaged thinker working through an idea aloud, in a real conversation with one other person. Light pace with natural hesitations and small shifts in intonation when arriving at an insight. Slightly warm. Not a narrator. No announcer cadence. Trail off mid-sentence when invited to. Don't sound rehearsed.";

export const DEFAULT_INSTRUCTIONS_B =
  "Speak as a thoughtful, methodical thinker in a real conversation with one other person. Measured pace, clear articulation, calm. Slightly lower energy than the other speaker. Occasional soft pauses for emphasis. Conversational, not lecturing. Don't sound rehearsed.";

/**
 * Split text into TTS-sized chunks on sentence boundaries. Falls back
 * to comma/whitespace breaks when a single sentence exceeds the cap
 * (extremely rare for narration-grade prose).
 */
export function chunkForTts(text: string): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= CHUNK_TARGET) return cleaned ? [cleaned] : [];

  // Split on sentence terminators while keeping them attached to the
  // sentence they end. Greedy enough for narration: "Mr." style false
  // positives don't matter for TTS — the engine pauses anyway.
  const sentences = cleaned.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [cleaned];
  const chunks: string[] = [];
  let buf = '';
  for (const sRaw of sentences) {
    const s = sRaw.trim();
    if (!s) continue;
    if ((buf + ' ' + s).trim().length > CHUNK_TARGET) {
      if (buf) chunks.push(buf.trim());
      // Single sentence longer than the cap: hard-split on commas, then on space.
      if (s.length > OPENAI_TTS_INPUT_MAX) {
        let remainder = s;
        while (remainder.length > CHUNK_TARGET) {
          let cut = remainder.lastIndexOf(',', CHUNK_TARGET);
          if (cut < CHUNK_TARGET / 2) cut = remainder.lastIndexOf(' ', CHUNK_TARGET);
          if (cut <= 0) cut = CHUNK_TARGET;
          chunks.push(remainder.slice(0, cut).trim());
          remainder = remainder.slice(cut).trim();
        }
        buf = remainder;
      } else {
        buf = s;
      }
    } else {
      buf = buf ? `${buf} ${s}` : s;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

/**
 * Per-chunk hard timeout. tts-1 typically returns in 1-3s for one
 * chunk; 60s is generous but bounded. Without this, a hung connection
 * silently freezes the whole build because nothing else times out.
 */
const TTS_CHUNK_TIMEOUT_MS = 60_000;

async function renderChunk(
  apiKey: string,
  text: string,
  opts: RenderOptions,
): Promise<ArrayBuffer> {
  const { signal, cleanup } = timeoutSignal(opts.signal, TTS_CHUNK_TIMEOUT_MS);
  try {
    const model = opts.model ?? 'gpt-4o-mini-tts';
    // Endpoint shape is identical across all three TTS models. The only
    // model-conditional fields are `speed` (tts-1/hd only) and
    // `instructions` (gpt-4o-mini-tts only). Omit fields the model
    // doesn't honor to avoid the API rejecting the request.
    const body: Record<string, unknown> = {
      model,
      voice: opts.voice ?? 'alloy',
      input: text,
      response_format: 'mp3',
    };
    if (model === 'gpt-4o-mini-tts') {
      if (opts.instructions) body.instructions = opts.instructions;
    } else {
      body.speed = opts.speed ?? 1.0;
    }
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      throw new Error(`OpenAI TTS HTTP ${res.status}: ${errorText.slice(0, 200)}`);
    }
    return await res.arrayBuffer();
  } finally {
    cleanup();
  }
}

/**
 * Measure the duration of an MP3 blob using a hidden HTMLAudioElement.
 * Browser-only (uses DOM). Resolves once `loadedmetadata` fires.
 *
 * We need exact durations because the player builds a click-to-seek
 * transcript by accumulating turn durations into a (startSec, durationSec)
 * timeline; word-count estimates drift over a multi-minute segment.
 */
export function measureMp3Duration(blob: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('measureMp3Duration is browser-only'));
      return;
    }
    const url = URL.createObjectURL(blob);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    const cleanup = () => URL.revokeObjectURL(url);
    audio.addEventListener('loadedmetadata', () => {
      const d = audio.duration;
      cleanup();
      if (!Number.isFinite(d) || d <= 0) {
        reject(new Error('Audio metadata returned no duration'));
      } else {
        resolve(d);
      }
    });
    audio.addEventListener('error', () => {
      cleanup();
      reject(new Error('Failed to load audio for duration'));
    });
    audio.src = url;
  });
}

/**
 * Render a string to a single MP3 blob via OpenAI tts-1.
 *
 * For inputs over the API's 4096-char cap, splits into chunks, renders
 * each in sequence (NOT in parallel — the API rate-limits and ordering
 * matters for the final blob), then concatenates the MP3 payloads.
 *
 * Returns `null` if the input is empty.
 */
export async function renderTextToMp3(
  text: string,
  opts: RenderOptions = {},
): Promise<Blob | null> {
  const apiKey = await getOpenAIKey();
  if (!apiKey) {
    throw new Error('OpenAI API key not configured. Add it in Settings to use podcast TTS.');
  }
  const chunks = chunkForTts(text);
  if (chunks.length === 0) return null;
  const buffers: ArrayBuffer[] = [];
  for (const chunk of chunks) {
    buffers.push(await renderChunk(apiKey, chunk, opts));
  }
  return new Blob(buffers, { type: 'audio/mpeg' });
}

/**
 * Estimate the cost of rendering a string in USD.
 * Pricing:
 *   tts-1            $15 per 1M chars
 *   tts-1-hd         $30 per 1M chars
 *   gpt-4o-mini-tts  ~$12 per 1M output-audio chars (priced by output
 *                    tokens, but per-character cost lands close enough
 *                    for the builder's ballpark estimate)
 */
export function estimateCostUsd(text: string, model: OpenAITtsModel = 'gpt-4o-mini-tts'): number {
  const chars = text.length;
  const per1M =
    model === 'tts-1' ? 15
    : model === 'tts-1-hd' ? 30
    : 12;
  return (chars / 1_000_000) * per1M;
}

/* ─── Two-voice (per-turn) rendering ───────────────────────────── */

/** One conversational turn ready for TTS. */
export interface TurnInput {
  speaker: 'A' | 'B';
  text: string;
}

/** What the multi-voice renderer reports back to the orchestrator. */
export interface MultiVoiceRenderResult {
  /** Concatenated MP3 blob for the whole segment. */
  blob: Blob;
  /**
   * Per-turn timings in the same order as the input turns. Each entry
   * tells the player at what offset (relative to the segment) the turn
   * starts and how long it runs. Drives the transcript click-to-seek.
   */
  timings: Array<{ startSec: number; durationSec: number }>;
  /** Total duration of the concatenated blob in seconds. */
  totalDurationSec: number;
}

export interface MultiVoiceRenderOptions {
  voiceA: OpenAIVoice;
  voiceB: OpenAIVoice;
  model?: OpenAITtsModel;
  speed?: number;
  /** Per-voice instruction strings; only honored by gpt-4o-mini-tts.
   *  When omitted, the defaults exported above are used. */
  instructionsA?: string;
  instructionsB?: string;
  /** Max simultaneous TTS calls. Defaults to 4. */
  maxParallel?: number;
  signal?: AbortSignal;
}

/**
 * Render an ordered list of two-voice turns into a single segment blob
 * plus per-turn timings. Renders turns in parallel with a concurrency
 * cap (the API allows it and ordering doesn't matter — we know who
 * goes when by the array index).
 *
 * Each turn's text may itself exceed the 4096-char API cap, in which
 * case it gets internally chunked and the chunk bytes are concatenated
 * into that turn's audio bytes (each turn still measures as one logical
 * unit for timing purposes).
 *
 * No inter-turn silence is injected here: tts-1 voices end sentences
 * with natural prosody, and the boundary between adjacent turn blobs
 * already reads as a pause to listeners. Saves the trouble of
 * generating + concatenating silence MP3s.
 */
export async function renderTurnsToSegment(
  turns: TurnInput[],
  opts: MultiVoiceRenderOptions,
): Promise<MultiVoiceRenderResult> {
  const apiKey = await getOpenAIKey();
  if (!apiKey) {
    throw new Error('OpenAI API key not configured. Add it in Settings to use podcast TTS.');
  }
  const maxParallel = Math.max(1, Math.min(opts.maxParallel ?? 4, turns.length));

  // Render each turn to a Blob (multi-chunk safe internally).
  const buffersPerTurn: (ArrayBuffer[] | null)[] = new Array(turns.length).fill(null);

  const model = opts.model ?? 'gpt-4o-mini-tts';
  const instructionsA = opts.instructionsA ?? DEFAULT_INSTRUCTIONS_A;
  const instructionsB = opts.instructionsB ?? DEFAULT_INSTRUCTIONS_B;

  await runParallel(turns.length, maxParallel, async (i) => {
    const turn = turns[i];
    if (!turn.text.trim()) {
      buffersPerTurn[i] = [];
      return;
    }
    const voice = turn.speaker === 'A' ? opts.voiceA : opts.voiceB;
    const instructions = turn.speaker === 'A' ? instructionsA : instructionsB;
    const chunks = chunkForTts(turn.text);
    const out: ArrayBuffer[] = [];
    for (const chunk of chunks) {
      out.push(await renderChunk(apiKey, chunk, {
        voice,
        model,
        speed: opts.speed,
        instructions,
        signal: opts.signal,
      }));
    }
    buffersPerTurn[i] = out;
  });

  // Measure each turn's duration in parallel. measureMp3Duration spins
  // up its own hidden HTMLAudioElement per call, so they don't interfere.
  // Sequential measurement added ~50-150ms × N to total render time;
  // parallel collapses it to ~max single measurement (~150ms).
  const durations = await Promise.all(buffersPerTurn.map(async (bufs, i) => {
    if (!bufs || bufs.length === 0) return 0;
    try {
      return await measureMp3Duration(new Blob(bufs, { type: 'audio/mpeg' }));
    } catch {
      // Fallback to word-count estimate if metadata load fails.
      return Math.max(0.5, (turns[i].text.split(/\s+/).length / 150) * 60 / (opts.speed ?? 1));
    }
  }));
  // Cumulative-sum to derive each turn's start offset.
  const timings: Array<{ startSec: number; durationSec: number }> = [];
  let acc = 0;
  for (const d of durations) {
    timings.push({ startSec: acc, durationSec: d });
    acc += d;
  }

  const allBuffers: ArrayBuffer[] = [];
  for (const bufs of buffersPerTurn) {
    if (bufs) allBuffers.push(...bufs);
  }
  const blob = new Blob(allBuffers, { type: 'audio/mpeg' });

  return { blob, timings, totalDurationSec: acc };
}

/**
 * Run `worker(i)` for i in [0, count) with a cap on simultaneous
 * executions. Resolves once every index has completed. Errors propagate
 * up (the caller is expected to treat any failure as fatal for that
 * segment and surface a retry button).
 */
function runParallel(
  count: number,
  cap: number,
  worker: (i: number) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let inFlight = 0;
    let next = 0;
    let done = 0;
    let failed = false;
    const launch = () => {
      while (!failed && inFlight < cap && next < count) {
        const i = next++;
        inFlight++;
        worker(i)
          .then(() => {
            inFlight--;
            done++;
            if (done === count) resolve();
            else launch();
          })
          .catch(err => {
            if (failed) return;
            failed = true;
            reject(err);
          });
      }
      if (count === 0) resolve();
    };
    launch();
  });
}
