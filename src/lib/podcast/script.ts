/**
 * Script pass: one Opus 4.7 call per planned segment, run in parallel
 * with a concurrency cap.
 *
 * Each call returns a two-voice CONVERSATION as an array of turns
 * (`{speaker: 'A'|'B', text}`), plus a speaker-attributed transition.
 * The model is told the segment is a passive-listening Socratic
 * dialogue between two thinkers, with hard rules against the usual
 * podcast clichés (greetings, names, "great point", em dashes, etc.).
 *
 * Active retrieval, confusion-emphasis, and cross-card synthesis are
 * baked into the prompt as natural dialogue moves rather than as
 * separate beats — the conversation IS the pedagogy.
 */

import { makeAnthropicClient } from '@/lib/ai/client';
import { getSetting } from '@/lib/db/queries';
import { db } from '@/lib/db/dexie';
import { renderPlain } from '@/lib/cloze/parser';
import type { Note, PodcastDepth, PodcastTurn } from '@/lib/db/schema';
import type { PlannedSegment } from './plan';
import { timeoutSignal } from './abort';

const SCRIPT_MODEL = 'claude-opus-4-7';

/** Max simultaneous Opus calls. Opus per-minute token limits are
 *  comfortably above what 6 typical-segment scripts consume. */
const MAX_PARALLEL = 6;

/** Per-segment timeout. Long deep-tier scripts can run 60s; 120s is safe. */
const SCRIPT_TIMEOUT_MS = 120_000;

/**
 * Tool definition that forces the script pass to emit a structurally
 * valid conversation. Eliminates "non-JSON" parse failures on long
 * deep-tier scripts where the model used to occasionally trail off in
 * prose around the JSON. With tool_choice + this schema, the model's
 * response IS the parsed object.
 */
const SCRIPT_TOOL: import('@anthropic-ai/sdk').Anthropic.Tool = {
  name: 'submit_conversation',
  description: 'Submit the two-voice conversation script for this segment.',
  input_schema: {
    type: 'object',
    required: ['turns', 'transition'],
    properties: {
      turns: {
        type: 'array',
        items: {
          type: 'object',
          required: ['speaker', 'text'],
          properties: {
            speaker: { type: 'string', enum: ['A', 'B'] },
            text: { type: 'string', description: 'Spoken words, no stage directions, no speaker labels.' },
          },
        },
      },
      transition: {
        type: 'object',
        required: ['speaker', 'text'],
        properties: {
          speaker: { type: 'string', enum: ['A', 'B'] },
          text: { type: 'string', description: 'One sentence handoff to the next segment.' },
        },
      },
    },
  },
};

export interface ScriptedSegment {
  index: number;
  title: string;
  description: string;
  cardIds: string[];
  depth: PodcastDepth;
  /** Two-voice turns in narration order. */
  turns: PodcastTurn[];
  /** Final handoff sentence, attributed to whichever voice said it. */
  transition: { speaker: 'A' | 'B'; text: string };
  /** Concatenated transcript (for browser-TTS fallback + display). */
  body: string;
  /** Error from this segment's Opus call, if any. */
  error?: string;
}

const SYSTEM_PROMPT = `You write one segment of an audio podcast that primes a learner for spaced-repetition study. The segment is a CONVERSATION between two voices, A and B. The listener is passive: earbuds in, eyes closed, no screen.

The conversation is genuine and Socratic. Both voices are thinking aloud. Neither is a host. Neither is interviewing the other. They are two people working through material together. Voice A leans curious, sometimes leaps to predictions, sometimes wrong. Voice B leans methodical, occasionally admits hesitation or says they had to look something up. Both push back on each other when the other oversimplifies.

HARD FORMAT RULES (the listener will reject the audio if you break these):

- NEVER use first names. The voices do not say each other's names. They do not address the listener. There is no "you" pointed at the listener.
- NEVER greet. No "welcome", no "today we'll cover", no "in this segment", no "let's get into". The first turn begins mid-thought, as if the listener tuned in late.
- NEVER sign off. No "that's it", no "see you next time". The transition is one voice pointing toward the next concept, not a goodbye.
- NEVER acknowledge production. No "great point", "exactly", "good question", "well said", "absolutely". These are AI-tells.
- NEVER use stage directions, speaker labels, or quotation marks inside the text. Just the spoken words.
- NEVER use em dashes. Use commas, periods, or restructure.
- NEVER frame a confusion as "students confuse this with..." as if reading a textbook. If a confusion is worth voicing, ONE of the voices admits in first person that THEY confuse it.

WHAT THE CONVERSATION DOES, naturally:

1. Works through the cards in this segment as a thought thread, NOT a list. Cards that share a mechanism collapse into the same passage. Do not announce a card or read its front.

2. Active retrieval emerges from the dialogue. ONE voice trails off mid-sentence (...and that gives a net of...); the OTHER picks it up (Two.). OR one voice GUESSES (often wrong) and gets corrected gently. OR one asks the other to predict before revealing. Use this two or three times in a deep segment, once or twice in standard, never in flash. The retrieval IS the dialogue: do not say "pause and recall", do not insert artificial silences.

3. Confusion gets voiced and resolved. When a card involves a known-tricky distinction, ONE voice says in first person that they mix it up, then the OTHER (or the same voice, working through it) gets it straight. Use this when the cards actually involve disambiguation, not on every segment.

4. Cross-card synthesis happens through reference, not announcement. When two cards in this segment share a mechanism, ONE voice asks if it is the same idea as the earlier point, or contradicts something said a minute ago, and they reconcile it. Only when it actually links.

5. The voices vary their turn length. Sometimes a one-word reaction ("Right."), sometimes a three-sentence explanation. They interrupt each other occasionally ("Oh, wait."). They self-correct ("No, that's not right, let me start over."). Avoid metronomic alternation.

DEPTH determines scale:
- "flash": 2 to 4 turns total. Each one or two sentences. Just enough to name the concept and one anchor. No mechanism worked through.
- "standard": 8 to 15 turns. Each 1-3 sentences. Mechanism is stated. One or two retrieval beats. No extended analogy.
- "deep": 20 to 40 turns. Full mechanism. One concrete analogy that anchors the abstract part, worked into the dialogue (not announced). One voiced confusion-then-resolution. One sentence somewhere on why this matters. Range from one-word reactions to four-sentence explanations.

TARGET WORD COUNT applies to the sum of all turn texts. Stay within plus or minus 10 percent. The transition does not count toward target words.

TRANSITION is one sentence (12 to 25 words) spoken by one of the voices, naming or referring to the next segment. If this is the final segment, the transition is one sentence said by either voice that lets the listener exit without ceremony.

Submit the conversation through the submit_conversation tool. The tool's schema is the source of truth for the response shape.`;

interface RawScriptResponse {
  turns?: Array<{ speaker?: string; text?: string }>;
  transition?: { speaker?: string; text?: string };
}

function depthRule(depth: PodcastDepth): string {
  switch (depth) {
    case 'flash':    return 'flash';
    case 'standard': return 'standard';
    case 'deep':     return 'deep';
  }
}

function cardBlock(note: Note): string {
  const front = renderPlain(note.fields.front).replace(/\s+/g, ' ').trim();
  const back = renderPlain(note.fields.back ?? '').replace(/\s+/g, ' ').trim();
  const extra = note.fields.extra
    ? renderPlain(note.fields.extra).replace(/\s+/g, ' ').trim()
    : '';
  const parts = [`FRONT: ${front}`, back ? `BACK: ${back}` : ''];
  if (extra) parts.push(`EXTRA: ${extra}`);
  return parts.filter(Boolean).join('\n');
}

async function scriptOne(
  apiKey: string,
  segment: PlannedSegment,
  index: number,
  total: number,
  nextSegmentTitle: string | null,
  podcastTitle: string,
  signal: AbortSignal | undefined,
): Promise<ScriptedSegment> {
  const client = await makeAnthropicClient(apiKey);
  const cards = await db().cards.bulkGet(segment.cardIds);
  const noteIds = Array.from(
    new Set(cards.map(c => c?.noteId).filter(Boolean) as string[]),
  );
  const notes = await db().notes.bulkGet(noteIds);
  const noteById = new Map<string, Note>();
  for (const n of notes) if (n) noteById.set(n.id, n);

  const lines: string[] = [];
  lines.push(`PODCAST TITLE: ${podcastTitle}`);
  lines.push(`THIS SEGMENT: "${segment.title}" (${index + 1} of ${total})`);
  lines.push(`SEGMENT DESCRIPTION: ${segment.description}`);
  lines.push(`DEPTH: ${depthRule(segment.depth)}`);
  lines.push(`TARGET WORDS (sum of turn texts): ${segment.targetWords}`);
  lines.push(nextSegmentTitle
    ? `NEXT SEGMENT: "${nextSegmentTitle}"`
    : 'NEXT SEGMENT: (none, this is the final segment)');
  lines.push('');
  lines.push(`CARDS IN ORDER (${segment.cardIds.length}, collapse together where they share a mechanism):`);
  cards.forEach((c, i) => {
    if (!c) return;
    const note = noteById.get(c.noteId);
    if (!note) return;
    lines.push(`--- card ${i + 1} ---`);
    lines.push(cardBlock(note));
  });
  lines.push('');
  lines.push('Submit the conversation through the submit_conversation tool.');

  const { signal: timedSignal, cleanup } = timeoutSignal(signal, SCRIPT_TIMEOUT_MS);
  let response;
  try {
    response = await client.messages.create(
      {
        model: SCRIPT_MODEL,
        max_tokens: 12_000,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: [SCRIPT_TOOL],
        tool_choice: { type: 'tool', name: SCRIPT_TOOL.name },
        messages: [{ role: 'user', content: lines.join('\n') }],
      },
      { signal: timedSignal },
    );
  } finally {
    cleanup();
  }

  // Pull the submit_conversation tool_use block. With tool_choice
  // forcing the tool, the API guarantees its `input` already parses
  // as the schema above — no JSON.parse on raw text needed.
  const toolBlock = response.content.find(
    b => b.type === 'tool_use' && b.name === SCRIPT_TOOL.name,
  );
  let parsed: RawScriptResponse;
  if (toolBlock && toolBlock.type === 'tool_use') {
    parsed = toolBlock.input as RawScriptResponse;
  } else {
    // Defensive fallback for the rare case the API returns prose (e.g.
    // hit max_tokens before emitting the tool_use). Surface raw text
    // so failures are debuggable.
    const text = response.content.map(b => (b.type === 'text' ? b.text : '')).join('').trim();
    const json = extractJson(text);
    if (!json) {
      throw new Error(
        `Script pass returned no tool_use block for segment "${segment.title}". Raw text: ${text.slice(0, 300)}`,
      );
    }
    try { parsed = JSON.parse(json); }
    catch (err) {
      throw new Error(
        `Script pass fallback JSON parse failed for segment "${segment.title}": ${err instanceof Error ? err.message : String(err)}. Raw: ${json.slice(0, 200)}`,
      );
    }
  }
  const turns: PodcastTurn[] = (parsed.turns ?? [])
    .map(t => ({
      speaker: t.speaker === 'B' ? 'B' as const : 'A' as const,
      text: String(t.text ?? '').trim(),
    }))
    .filter(t => t.text.length > 0);

  if (turns.length === 0) {
    throw new Error(`Script pass returned no turns for segment "${segment.title}".`);
  }

  const transitionSpeaker = parsed.transition?.speaker === 'B' ? 'B' as const : 'A' as const;
  const transitionText = String(parsed.transition?.text ?? '').trim();

  // Concatenated transcript used as a display + browser-TTS fallback.
  // We keep speaker prefixes so the transcript view can render them
  // visually, and the browser-TTS path strips them at speak time.
  const body = turns.map(t => `${t.speaker}: ${t.text}`).join('\n\n');

  return {
    index,
    title: segment.title,
    description: segment.description,
    cardIds: segment.cardIds,
    depth: segment.depth,
    turns,
    transition: { speaker: transitionSpeaker, text: transitionText },
    body,
  };
}

/**
 * Run script-pass for all segments with bounded concurrency. Failures
 * are surfaced per-segment in `error` rather than throwing the whole
 * batch, so the player can still play the segments that landed and the
 * user can retry just the missing ones. `signal` aborts all in-flight
 * + queued calls.
 */
export async function scriptAllSegments(
  segments: PlannedSegment[],
  podcastTitle: string,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ScriptedSegment[]> {
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Claude API key not configured. Add it in Settings.');

  const out: ScriptedSegment[] = new Array(segments.length);
  let inFlight = 0;
  let nextIndex = 0;
  let done = 0;

  return new Promise((resolve) => {
    const launchNext = () => {
      while (inFlight < MAX_PARALLEL && nextIndex < segments.length) {
        const i = nextIndex++;
        const seg = segments[i];
        const nextTitle = i + 1 < segments.length ? segments[i + 1].title : null;
        inFlight++;
        scriptOne(apiKey, seg, i, segments.length, nextTitle, podcastTitle, signal)
          .then(result => { out[i] = result; })
          .catch(err => {
            out[i] = {
              index: i,
              title: seg.title,
              description: seg.description,
              cardIds: seg.cardIds,
              depth: seg.depth,
              turns: [],
              transition: { speaker: 'A', text: '' },
              body: '',
              error: err instanceof Error ? err.message : String(err),
            };
          })
          .finally(() => {
            inFlight--;
            done++;
            onProgress?.(done, segments.length);
            if (done === segments.length) resolve(out);
            else launchNext();
          });
      }
    };
    launchNext();
  });
}

/**
 * Script-pass for a SINGLE segment. Used by per-segment retry in the
 * player. Throws on failure so the caller can show an error.
 */
export async function scriptSingleSegment(
  segment: PlannedSegment,
  index: number,
  total: number,
  nextSegmentTitle: string | null,
  podcastTitle: string,
  signal?: AbortSignal,
): Promise<ScriptedSegment> {
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Claude API key not configured. Add it in Settings.');
  return scriptOne(apiKey, segment, index, total, nextSegmentTitle, podcastTitle, signal);
}

/** Best-effort JSON extraction used only when tool_use is absent. Same
 *  brace-walking helper as in plan.ts; kept local so each module stays
 *  self-contained. */
function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('{');
  if (start < 0) return null;
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
