/**
 * Hint generator: ask Claude for a single-line nudge that does NOT reveal
 * the answer, only narrows the search space. One round-trip, no streaming.
 */

import type { Card, Note } from '@/lib/db/schema';
import { getSetting } from '@/lib/db/queries';
import { makeAnthropicClient } from './client';
import { renderPlain } from '@/lib/cloze/parser';
import { DEFAULT_MODEL } from './claude';

const SYSTEM_PROMPT = `You give one-line hints for spaced-repetition cards.

The user is stuck on a card. Give them ONE short nudge (under 12 words) that helps them remember WITHOUT revealing the answer.

Rules:
- Never state the answer.
- Never use the answer's exact words.
- Prefer category, mechanism, or "first-letter" hints.
- Be terse; one sentence.
- No preamble. Output the hint and nothing else.`;

export async function generateHint(note: Note, card: Card): Promise<string> {
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Add your Claude API key in Settings to get hints.');
  const model = (await getSetting('claude_model')) || DEFAULT_MODEL;
  const client = await makeAnthropicClient(apiKey);

  const expected = note.modelId === 'cloze'
    ? renderPlain(note.fields.front)
    : note.fields.back;

  const res = await client.messages.create({
    model,
    max_tokens: 80,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        `Question: ${renderPlain(note.fields.front)}`,
        `Answer (do not reveal): ${expected}`,
        note.fields.extra && `Extra: ${note.fields.extra}`,
      ].filter(Boolean).join('\n'),
    }],
  });

  return res.content
    .filter(b => b.type === 'text')
    .map(b => 'text' in b ? b.text : '')
    .join('')
    .trim();
}
