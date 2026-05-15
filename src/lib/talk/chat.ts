/**
 * Streaming Claude chat for the Socratic voice loop.
 *
 * One call per assistant turn. The system prompt + curriculum is
 * cached so subsequent turns within the same session re-use it
 * without re-paying the input-tokens hit. Card context is passed as
 * a compact list of "front | back-snippet" lines.
 *
 * We stream the response (Anthropic SDK supports it) so the UI can
 * show text as it arrives AND we can pipe completed sentences into
 * TTS in parallel, cutting perceived latency on long replies. For
 * the first cut here we await the full text and TTS it at once;
 * sentence-streamed TTS is a follow-up.
 */

import { makeAnthropicClient } from '@/lib/ai/client';
import { getSetting } from '@/lib/db/queries';
import { renderPlain } from '@/lib/cloze/parser';
import type { Note, TalkTurn } from '@/lib/db/schema';

const CHAT_MODEL = 'claude-opus-4-7';

const SYSTEM_PROMPT = `You are a study partner having a real voice conversation with a learner. The curriculum below is a set of flashcards the learner is preparing to study. You and the learner discuss this material together.

Your behavior:

- Socratic. Don't quiz robotically. Don't dump information. Walk through ideas together.
- One thought at a time. 2-4 sentences per turn, occasionally one sentence, occasionally five.
- Ask the learner to predict, explain back, or compare. When they get something right, build on it. When they're stuck, give one nudge (not the answer); if still stuck, explain.
- Introduce new material when the current thread feels resolved. Cover the curriculum across the conversation; don't list cards out loud.
- Match the learner's energy. If they're tired, slow down. If they're sharp, push harder.
- Speak naturally for voice playback: contractions are fine, no markdown, no headers, no lists, no asterisks. Just sentences.

HARD RULES:

- NEVER greet. NEVER sign off. NEVER narrate your behavior ("let me ask you", "let's switch topics", "good point").
- NEVER use first names. NEVER use em dashes.
- NEVER use year mentions unless load-bearing. NEVER use stage directions.
- Active voice. Mechanism over narrative.
- If asked something off-curriculum, answer briefly and steer back.
- When ending an answer with a question to the learner, ask ONE question, not a list.

You speak the response that will be read aloud verbatim by a TTS voice. Be ready for the listener to barge in mid-thought; keep each turn self-contained.`;

interface CardForContext {
  id: string;
  note: Note;
}

export function buildCurriculumLine(c: CardForContext): string {
  const front = renderPlain(c.note.fields.front).replace(/\s+/g, ' ').trim().slice(0, 140);
  const back = renderPlain(c.note.fields.back ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return `- ${front}${back ? ` | ${back}` : ''}`;
}

export async function generateAssistantReply(
  history: TalkTurn[],
  cards: CardForContext[],
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Claude API key not configured. Add it in Settings.');
  const client = await makeAnthropicClient(apiKey);

  // System payload is split into two cache-ephemeral blocks so the
  // long curriculum survives subsequent turns and we only pay for the
  // turn-specific message.
  const curriculum = cards.slice(0, 250).map(buildCurriculumLine).join('\n');
  const system = [
    { type: 'text' as const, text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' as const } },
    { type: 'text' as const, text: `CURRICULUM (${cards.length} cards):\n${curriculum}`, cache_control: { type: 'ephemeral' as const } },
  ];

  const messages = history.map(t => ({
    role: t.role === 'assistant' ? 'assistant' as const : 'user' as const,
    content: t.text,
  }));

  const response = await client.messages.create(
    {
      model: CHAT_MODEL,
      max_tokens: 1024,
      system,
      messages,
    },
    signal ? { signal } : undefined,
  );

  const text = response.content
    .map(b => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();

  return text;
}
