/**
 * Generate three layered explanations of a card in a single Opus call:
 *   - simple:  ELI-12, intuition-first
 *   - deep:    full mechanism + WHY, at study depth
 *   - analogy: one concrete metaphor that anchors the concept
 *
 * One call returns all three, so the user-facing latency is one Opus
 * round-trip and switching between the three layers is instant.
 */

import { makeAnthropicClient } from './client';
import { getSetting } from '@/lib/db/queries';
import type { Note } from '@/lib/db/schema';
import { renderPlain } from '@/lib/cloze/parser';

const MODEL = 'claude-opus-4-7';

export interface LayeredExplanations {
  simple: string;
  deep: string;
  analogy: string;
  generatedAt: number;
}

const SYSTEM_PROMPT = `You write layered explanations of a flashcard for a learner who's stuck on it. Three layers, all in ONE response:

  - "simple": ELI-12. Plain language, intuition-first. 2-3 sentences. Lead with what the thing IS or DOES; skip jargon.
  - "deep": Full mechanism. Why it works the way it does. How its parts connect to each other and to neighboring concepts. 4-6 sentences. Study-depth voice.
  - "analogy": ONE concrete metaphor or short story (2-3 sentences) that anchors the concept in something the learner already knows. Pick something physical, sensory, or everyday. Don't say "like" repeatedly.

Constraints across all three:
  - Mechanism over narrative. Active voice.
  - No meta words ("recall that…", "note that…", "remember…"). The explanation IS the thought; don't narrate it.
  - No first names. No years unless load-bearing. No em dashes.
  - Don't restate the front. The learner already sees that.
  - Don't restate the back verbatim. Re-explain it.

Output JSON only, no fence, no prose before/after:
{
  "simple":  "<2-3 sentences>",
  "deep":    "<4-6 sentences>",
  "analogy": "<2-3 sentences>"
}`;

export async function generateExplanations(note: Note): Promise<LayeredExplanations> {
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Claude API key not configured. Add it in Settings.');
  const client = await makeAnthropicClient(apiKey);

  const userContent = `FRONT:
${renderPlain(note.fields.front)}

BACK:
${renderPlain(note.fields.back ?? '')}

${note.fields.extra ? `EXTRA:\n${renderPlain(note.fields.extra)}\n\n` : ''}Write the three layered explanations per the rules. JSON only.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1800,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }],
  });
  const text = response.content
    .map(b => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  const json = (() => {
    const fenced = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    if (fenced) return fenced[1].trim();
    const start = text.indexOf('{');
    return start >= 0 ? text.slice(start) : text;
  })();
  const parsed = JSON.parse(json) as { simple?: string; deep?: string; analogy?: string };
  const simple = (parsed.simple ?? '').trim();
  const deep = (parsed.deep ?? '').trim();
  const analogy = (parsed.analogy ?? '').trim();
  if (!simple || !deep || !analogy) {
    throw new Error('Opus returned an incomplete explanation set.');
  }
  return { simple, deep, analogy, generatedAt: Date.now() };
}
