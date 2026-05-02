/**
 * Conversational deck creation.
 *
 * Two AI calls:
 *   1. proposeDeckPlan: turn the user's natural-language brief into a deck
 *      name + description + tag prefix + a structured outline (subsections
 *      with target card counts).
 *   2. expandSection: given the brief + plan + a single subsection, return
 *      DraftNote[] cards for that subsection.
 *
 * The UI reads the plan so the user can accept/reject the structure before
 * any cards are generated, then expands one section at a time with progress.
 */

import { getSetting } from '@/lib/db/queries';
import type { NoteFields, Tier } from '@/lib/db/schema';
import { DEFAULT_MODEL } from './claude';
import { makeAnthropicClient } from './client';

export interface DeckPlanSection {
  /** Slug-ish key, used for tag suffixes. */
  slug: string;
  /** Human-readable header. */
  title: string;
  /** Target card count Claude proposes for this section. */
  targetCount: number;
  /** Brief description of what this section will cover. */
  description: string;
}

export interface DeckPlan {
  deckName: string;
  description: string;
  tagPrefix: string;
  sections: DeckPlanSection[];
}

export interface DraftCard {
  fields: NoteFields;
  tags: string[];
  tier?: Tier;
  modelId: 'basic' | 'cloze';
}

interface ProposeOpts {
  brief: string;
}

export async function proposeDeckPlan({ brief }: ProposeOpts): Promise<DeckPlan> {
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Add your Claude API key in Settings.');
  const model = (await getSetting('claude_model')) || DEFAULT_MODEL;
  const client = await makeAnthropicClient(apiKey);

  const system = `You are a careful flashcard architect. The user describes what they want to learn; you respond with a structured deck plan.

Output STRICT JSON only, no commentary:
{
  "deckName": string,
  "description": string,
  "tagPrefix": string,
  "sections": [
    {
      "slug": string,
      "title": string,
      "targetCount": integer (5..30),
      "description": string
    }
  ]
}

Rules:
- "deckName" uses :: for hierarchy where natural (e.g. "MCAT::Biology::Enzymes").
- "tagPrefix" matches the deck path with :: separators (e.g. "mcat::biology::enzymes").
- "sections" should typically be 3-7 entries.
- Section slugs are short, lower_snake_case.
- targetCount is realistic: 8-20 for most, larger only for big topics.
- No em dashes anywhere in user-visible text.
- Quality first — propose structure that someone serious about the topic would actually want.`;

  const r = await client.messages.create({
    model,
    max_tokens: 1024,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: brief }],
  });
  const text = r.content.map(c => (c.type === 'text' ? c.text : '')).join('').trim();
  return parsePlan(text);
}

function parsePlan(text: string): DeckPlan {
  let cleaned = text;
  if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  let obj: unknown;
  try { obj = JSON.parse(cleaned); } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Could not parse plan from Claude.');
    obj = JSON.parse(m[0]);
  }
  const o = obj as Partial<DeckPlan>;
  if (!o || typeof o.deckName !== 'string' || !Array.isArray(o.sections)) {
    throw new Error('Plan JSON missing required fields.');
  }
  return {
    deckName: o.deckName,
    description: typeof o.description === 'string' ? o.description : '',
    tagPrefix: typeof o.tagPrefix === 'string' ? o.tagPrefix : '',
    sections: o.sections
      .filter((s): s is DeckPlanSection =>
        s && typeof s === 'object'
        && typeof s.slug === 'string'
        && typeof s.title === 'string'
        && typeof s.targetCount === 'number'
      )
      .map(s => ({
        slug: s.slug,
        title: s.title,
        targetCount: Math.max(1, Math.min(50, Math.round(s.targetCount))),
        description: typeof s.description === 'string' ? s.description : '',
      })),
  };
}

export interface ExpandOpts {
  brief: string;
  plan: DeckPlan;
  section: DeckPlanSection;
  onChunk?: (delta: string) => void;
}

export async function expandSection({ brief, plan, section, onChunk }: ExpandOpts): Promise<DraftCard[]> {
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Add your Claude API key in Settings.');
  const model = (await getSetting('claude_model')) || DEFAULT_MODEL;
  const client = await makeAnthropicClient(apiKey);

  const system = `You are a careful flashcard author. Produce up to ${section.targetCount} cards for the named section. Cloze syntax {{c1::answer}}, multi-cloze where each is independently retrievable. Mechanism over narrative. No em dashes. Define unfamiliar terms inline.

Output ONLY a JSON array of:
{
  "modelId": "basic" | "cloze",
  "fields": { "front": string, "back": string, "extra"?: string, "context"?: string, "source"?: string, "mnemonic"?: string },
  "tags": string[],
  "tier"?: "core" | "clinical" | "advanced" | "bridge" | "standard" | "extended" | "scholarly"
}

Quality first — fewer good cards beats more poor ones.`;

  const userParts = [
    `User brief: ${brief}`,
    `Deck: ${plan.deckName}`,
    `Section: ${section.title}`,
    `Section description: ${section.description}`,
    `Tag prefix: ${plan.tagPrefix}::${section.slug}`,
    `Target count: ${section.targetCount}`,
    '',
    'Return JSON now.',
  ];
  const userPrompt = userParts.join('\n');

  let acc = '';
  const stream = client.messages.stream({
    model,
    max_tokens: 4096,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt }],
  });
  stream.on('text', delta => {
    acc += delta;
    onChunk?.(delta);
  });
  await stream.finalMessage();
  return parseDrafts(acc);
}

function parseDrafts(text: string): DraftCard[] {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  let arr: unknown;
  try { arr = JSON.parse(cleaned); } catch {
    const m = cleaned.match(/\[[\s\S]*\]/);
    if (!m) return [];
    try { arr = JSON.parse(m[0]); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter(isDraft);
}

function isDraft(x: unknown): x is DraftCard {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (o.modelId !== 'basic' && o.modelId !== 'cloze') return false;
  if (!o.fields || typeof o.fields !== 'object') return false;
  const f = o.fields as Record<string, unknown>;
  if (typeof f.front !== 'string') return false;
  if (!Array.isArray(o.tags)) return false;
  return true;
}
