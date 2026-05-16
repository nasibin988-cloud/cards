/**
 * Plan pass for an audio-priming podcast.
 *
 * One Sonnet 4.6 call: read the full card projection + the user's
 * target length, produce a clustered + budgeted segment plan that the
 * Opus script pass will then materialise in parallel.
 *
 * Why Sonnet, not Opus: this is a structural call (clustering + math),
 * not authoring. Opus is reserved for the script pass where prose
 * quality matters. Sonnet is much cheaper at this size and just as
 * good at "group these by theme."
 *
 * Why one call, not iterative: the model needs to see every card to
 * decide which themes exist. Streaming-cluster designs lose this and
 * end up with awkward overflow segments. The projection fits cleanly
 * inside Sonnet's context even at 500+ cards.
 */

import { makeAnthropicClient } from '@/lib/ai/client';
import { getSetting } from '@/lib/db/queries';
import { renderPlain } from '@/lib/cloze/parser';
import type { PodcastDepth } from '@/lib/db/schema';
import type { Projection, ProjectedCard } from './queue-projection';
import { timeoutSignal } from './abort';

/** Plan pass can be heavy on big card sets; 3 minutes covers a 500-card run. */
const PLAN_TIMEOUT_MS = 180_000;

const PLANNER_MODEL = 'claude-sonnet-4-6';

/** Average narration rate; 150 wpm is a comfortable podcast pace. */
export const WORDS_PER_MINUTE = 150;

export interface PlannedSegment {
  title: string;
  description: string;
  /** Card ids drawn in narration order. Real card.id values, not indices. */
  cardIds: string[];
  depth: PodcastDepth;
  targetWords: number;
}

export interface PodcastPlan {
  /** Title for the podcast as a whole. */
  title: string;
  /** Opening 1-2 sentence cold-open script the player narrates before segments. */
  intro: string;
  segments: PlannedSegment[];
  /** Total words across all segments (sum of targetWords). */
  totalTargetWords: number;
}

const SYSTEM_PROMPT = `You plan an audio podcast that primes a learner for a deck of flashcards they will study tomorrow. The podcast is meant for passive listening (earbuds, dishes, falling asleep), not active recall. No questions, no quizzes.

Your job is structural:

1. Read the full card list. Each entry has an INDEX, front text, deck, difficulty signal, and reason for inclusion.
2. Cluster the cards into 5 to 15 thematic SEGMENTS. Cluster by mechanism / concept / system, not by deck unless decks are clearly distinct topics. Adjacent ideas group together. Cards that test the same underlying concept go in the same segment.
3. Allocate a word budget to each segment proportional to (card count) x (average difficulty signal of cards in segment). Sum of segment budgets must equal the requested total word budget within 5 percent.
4. For each segment choose a DEPTH from {flash, standard, deep} based on words-per-card in that segment:
     - flash:    fewer than 20 words per card. Theme + named-card mentions only, no mechanism.
     - standard: 20 to 100 words per card. Mechanism summary + 1-2 anchors.
     - deep:     more than 100 words per card. Full mechanism + analogy + why it matters.
   If the user requested a depth override, every segment uses that depth and the planner ignores words-per-card thresholds.
5. Order the segments so PREREQUISITES come first. A concept that another concept depends on must precede the dependent. Foundations before specifics. After that constraint is met, place the highest-difficulty material in the middle of the listening session (peak-attention slot), and taper down at the end so the listener can wind down. When two segments are independent of each other, sort by difficulty (easier first).

Hard rules:
- Every non-suspended card in the input must appear in exactly ONE segment's cardIndices. No card is dropped, none is duplicated. (For flash tier, the segment script may not name each card; that is fine — the COVERAGE constraint applies to the plan, not the eventual prose.)
- Titles are at most 6 words, no em dashes, no first names, no years unless load-bearing, no meta words ("classic", "textbook").
- Descriptions are exactly one sentence.
- The intro is one or two sentences. Sets the scene for what's coming. No greeting, no "welcome", no "today we will".

Submit the plan through the submit_plan tool. The tool's schema is the source of truth for the response shape.`;

interface RawPlanResponse {
  title?: string;
  intro?: string;
  segments?: Array<{
    title?: string;
    description?: string;
    cardIndices?: number[];
    depth?: string;
    targetWords?: number;
  }>;
}

/**
 * Build the user-message payload. Front text is plain-rendered (cloze
 * shells unwrapped) and clipped to 140 chars so a 500-card projection
 * still fits comfortably.
 */
function buildPayload(
  projection: Projection,
  targetWords: number,
  depthOverride: PodcastDepth | null,
): string {
  const lines: string[] = [];
  lines.push(`TARGET TOTAL WORDS: ${targetWords}`);
  lines.push(`SEGMENT COUNT TARGET: ${segmentCountForBudget(targetWords)}`);
  lines.push(`DEPTH OVERRIDE: ${depthOverride ?? 'none'}`);
  lines.push(`HORIZON: ${projection.horizon}`);
  lines.push('');
  lines.push(`CARDS (${projection.cards.length} total):`);
  projection.cards.forEach((p, i) => {
    const front = renderPlain(p.note.fields.front).replace(/\s+/g, ' ').trim().slice(0, 140);
    const tags = (p.note.tags ?? []).slice(0, 3).join(',');
    lines.push(
      `[${i}] deck="${p.deck.name}" reason=${p.reason} diff=${p.difficultySignal.toFixed(1)}` +
      (tags ? ` tags=${tags}` : '') +
      ` | ${front}`,
    );
  });
  lines.push('');
  lines.push('Produce the JSON plan now.');
  return lines.join('\n');
}

/** Heuristic: 1 segment per ~10 minutes, clamped 5..15. */
function segmentCountForBudget(targetWords: number): number {
  const minutes = targetWords / WORDS_PER_MINUTE;
  return Math.max(5, Math.min(15, Math.round(minutes / 10)));
}

function parseDepth(v: unknown, fallback: PodcastDepth): PodcastDepth {
  return v === 'flash' || v === 'standard' || v === 'deep' ? v : fallback;
}

/**
 * Tool definition forcing the planner to emit a structurally-valid plan
 * directly via Anthropic's tool_use API. This eliminates the entire
 * class of "model wrote prose around the JSON" parse failures that
 * plagued the v1 implementation: the model literally cannot return
 * anything other than an object matching this schema.
 */
const PLAN_TOOL: import('@anthropic-ai/sdk').Anthropic.Tool = {
  name: 'submit_plan',
  description: 'Submit the clustered + budgeted segment plan for the podcast.',
  input_schema: {
    type: 'object',
    required: ['title', 'intro', 'segments'],
    properties: {
      title: { type: 'string', description: 'Podcast-wide title.' },
      intro: { type: 'string', description: 'One to two sentence cold-open.' },
      segments: {
        type: 'array',
        items: {
          type: 'object',
          required: ['title', 'description', 'cardIndices', 'depth', 'targetWords'],
          properties: {
            title: { type: 'string', description: 'At most 6 words.' },
            description: { type: 'string', description: 'Exactly one sentence.' },
            cardIndices: {
              type: 'array',
              items: { type: 'integer', minimum: 0 },
              description: 'Indices into the CARDS list provided in the user message.',
            },
            depth: { type: 'string', enum: ['flash', 'standard', 'deep'] },
            targetWords: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
  },
};

export async function planPodcast(
  projection: Projection,
  targetSeconds: number,
  depthOverride: PodcastDepth | null,
  signal?: AbortSignal,
): Promise<PodcastPlan> {
  if (projection.cards.length === 0) {
    throw new Error('Nothing to narrate: the queue projection is empty.');
  }
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Claude API key not configured. Add it in Settings.');
  const client = await makeAnthropicClient(apiKey);

  const targetWords = Math.round((targetSeconds / 60) * WORDS_PER_MINUTE);
  const payload = buildPayload(projection, targetWords, depthOverride);

  const { signal: timedSignal, cleanup } = timeoutSignal(signal, PLAN_TIMEOUT_MS);
  let response;
  try {
    response = await client.messages.create(
      {
        model: PLANNER_MODEL,
        max_tokens: 16_000,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: [PLAN_TOOL],
        tool_choice: { type: 'tool', name: PLAN_TOOL.name },
        messages: [{ role: 'user', content: payload }],
      },
      { signal: timedSignal },
    );
  } finally {
    cleanup();
  }

  // Pull the submit_plan tool_use block out of the response. With
  // tool_choice forcing this tool, the API guarantees exactly one
  // tool_use block whose `input` already parses as the schema above.
  const toolBlock = response.content.find(
    b => b.type === 'tool_use' && b.name === PLAN_TOOL.name,
  );
  if (!toolBlock || toolBlock.type !== 'tool_use') {
    // Fall back to text scraping for the rare case the API returns
    // plain text despite tool_choice (typically only on stop_reason
    // 'max_tokens'). Surface the raw text so failures are debuggable.
    const text = response.content.map(b => (b.type === 'text' ? b.text : '')).join('').trim();
    const json = extractJson(text);
    if (!json) {
      throw new Error(
        `Plan pass returned no tool_use block and no parseable JSON. Raw text: ${text.slice(0, 400)}`,
      );
    }
    let parsed: RawPlanResponse;
    try { parsed = JSON.parse(json); }
    catch (err) {
      throw new Error(
        `Plan pass fallback JSON parse failed: ${err instanceof Error ? err.message : String(err)}. Raw: ${json.slice(0, 200)}`,
      );
    }
    return materializePlan(parsed, projection, targetWords, depthOverride);
  }
  const parsed = toolBlock.input as RawPlanResponse;
  return materializePlan(parsed, projection, targetWords, depthOverride);
}

/** Best-effort JSON extraction used only when tool_use is absent. */
function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('{');
  if (start < 0) return null;
  // Walk forward keeping track of brace depth so we close on the
  // matching `}` rather than slicing to end-of-text.
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Resolve indices → card ids, enforce the coverage invariant, and
 * patch up depth + targetWords with defaults when the model leaves
 * them off. Throws if the segment list is structurally broken (the
 * caller can offer the user a retry).
 */
function materializePlan(
  raw: RawPlanResponse,
  projection: Projection,
  targetWords: number,
  depthOverride: PodcastDepth | null,
): PodcastPlan {
  const rawSegments = raw.segments ?? [];
  if (rawSegments.length === 0) {
    throw new Error('Plan pass returned zero segments.');
  }
  const seenIndices = new Set<number>();
  const segments: PlannedSegment[] = [];
  for (const s of rawSegments) {
    const indices = (s.cardIndices ?? []).filter(
      n => Number.isInteger(n) && n >= 0 && n < projection.cards.length,
    );
    const cardIds: string[] = [];
    for (const i of indices) {
      if (seenIndices.has(i)) continue;
      seenIndices.add(i);
      cardIds.push(projection.cards[i].card.id);
    }
    if (cardIds.length === 0) continue;
    const depth = depthOverride ?? parseDepth(s.depth, 'standard');
    const fallbackWords = Math.max(
      80,
      Math.round((cardIds.length / projection.cards.length) * targetWords),
    );
    const tw = typeof s.targetWords === 'number' && s.targetWords > 0
      ? Math.round(s.targetWords)
      : fallbackWords;
    segments.push({
      title: String(s.title ?? '').trim().slice(0, 80) || 'Segment',
      description: String(s.description ?? '').trim(),
      cardIds,
      depth,
      targetWords: tw,
    });
  }

  // Coverage fix-up: any card not assigned to a segment falls into a
  // "loose ends" final segment. We never silently drop user content.
  const missing: ProjectedCard[] = [];
  projection.cards.forEach((p, i) => {
    if (!seenIndices.has(i)) missing.push(p);
  });
  if (missing.length > 0) {
    const depth = depthOverride ?? 'flash';
    const wpc = depth === 'deep' ? 150 : depth === 'standard' ? 50 : 12;
    segments.push({
      title: 'Loose ends',
      description: 'Cards that did not slot cleanly into another theme.',
      cardIds: missing.map(p => p.card.id),
      depth,
      targetWords: Math.max(80, missing.length * wpc),
    });
  }

  return {
    title: String(raw.title ?? '').trim() || `Priming podcast (${projection.cards.length} cards)`,
    intro: String(raw.intro ?? '').trim(),
    segments,
    totalTargetWords: segments.reduce((s, x) => s + x.targetWords, 0),
  };
}
