/**
 * Take a passage, return the same passage with cloze syntax inserted around
 * key terms. Differs from `generateNotes`: this preserves the user's prose
 * as-is and only marks spans, rather than rewriting into card form.
 *
 * Output is a single string with `{{c1::...}} {{c2::...}}` etc.
 */

import { getSetting } from '@/lib/db/queries';
import { DEFAULT_MODEL } from './claude';
import { makeAnthropicClient } from './client';

interface ProposeOpts {
  passage: string;
  /** Roughly how many distinct cloze ords to produce. Default 4. */
  targetClozes?: number;
  onChunk?: (delta: string) => void;
}

export async function proposeClozeMasks(opts: ProposeOpts): Promise<string> {
  const { passage, targetClozes = 4, onChunk } = opts;
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Add your Claude API key in Settings.');
  const model = (await getSetting('claude_model')) || DEFAULT_MODEL;
  const client = await makeAnthropicClient(apiKey);

  const system = `You are a careful flashcard author. The user gives you a passage; you return the same passage with cloze deletions inserted around the most important retrieval-worthy terms.

Rules:
- Preserve the original prose verbatim. Do NOT rewrite, summarize, or rearrange.
- Wrap exactly ${targetClozes} distinct cloze ords (c1..c${targetClozes}). Use the same ord twice only when two spans are truly the same retrieval point.
- Each cloze span should be a single concept: 1-6 words. Avoid masking trivial fillers (articles, prepositions).
- Add no commentary, no preamble, no code fences. Output ONLY the modified passage.`;

  const user = passage;

  let acc = '';
  const stream = client.messages.stream({
    model,
    max_tokens: 2048,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
  });
  stream.on('text', delta => {
    acc += delta;
    onChunk?.(delta);
  });
  await stream.finalMessage();
  return acc.trim();
}
