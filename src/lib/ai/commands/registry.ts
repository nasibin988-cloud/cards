import { getSetting } from '@/lib/db/queries';
import { DEFAULT_MODEL } from '../claude';
import { makeAnthropicClient } from '../client';
import { renderPlain } from '@/lib/cloze/parser';
import type { CommandResult, SlashCommand } from './types';
import { imageCommand } from './image';

async function quickClaude(system: string, user: string, maxTokens = 800): Promise<string> {
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Add your Claude API key in Settings.');
  const model = (await getSetting('claude_model')) || DEFAULT_MODEL;
  const client = await makeAnthropicClient(apiKey);
  const r = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
  });
  return r.content.map(c => (c.type === 'text' ? c.text : '')).join('').trim();
}

const explainCommand: SlashCommand = {
  name: 'explain',
  description: 'Structured deep dive on a topic',
  argHint: '[topic?]',
  needsAI: true,
  run: async (rawArgs, ctx) => {
    try {
      const f = ctx.note.fields;
      const topic = rawArgs.trim() || renderPlain(f.front);
      const system = `You are a careful tutor. Produce a tight, structured explanation in this order:
1. One-sentence "what".
2. Two or three sentences on "why" (mechanism, principle).
3. A common misconception or trap.
Use markdown sub-headers. Total under 180 words.`;
      const user = `Topic: ${topic}\n\nCard front: ${renderPlain(f.front)}\nCard back: ${f.back ?? ''}`;
      const content = await quickClaude(system, user, 600);
      return { kind: 'assistant', content, query: rawArgs.trim() || topic };
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  },
};

const mnemonicCommand: SlashCommand = {
  name: 'mnemonic',
  description: 'Propose a memorable hook',
  needsAI: true,
  run: async (_rawArgs, ctx) => {
    try {
      const f = ctx.note.fields;
      const system = `Suggest one mnemonic for this card. Prefer:
- Acronym or initialism (1 line).
- Visual scene (2 lines max).
- Phonetic / sound-alike (1 line).
Choose whichever fits the content best. Lead with the mnemonic itself, then a one-line "why this works". No preamble.`;
      const user = `Front: ${renderPlain(f.front)}\nBack: ${f.back ?? ''}`;
      const content = await quickClaude(system, user, 200);
      return { kind: 'assistant', content };
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  },
};

const defineCommand: SlashCommand = {
  name: 'define',
  description: 'Concise definition of a term',
  argHint: '[term]',
  needsAI: true,
  run: async (rawArgs, ctx) => {
    try {
      const term = rawArgs.trim();
      if (!term) {
        return { kind: 'error', message: 'Usage: /define <term>' };
      }
      const f = ctx.note.fields;
      const system = `Define the term in <40 words. Plain prose, no markdown headers. If the term is ambiguous, prefer the meaning that best fits the card's domain. End with one example use in italics.`;
      const user = `Term: ${term}\n\nCard context:\n${renderPlain(f.front)}\n${f.back ?? ''}`;
      const content = await quickClaude(system, user, 200);
      return { kind: 'assistant', content, query: term };
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  },
};

const clearCommand: SlashCommand = {
  name: 'clear',
  description: 'Clear the conversation',
  run: async () => ({ kind: 'clear' }),
};

const helpCommand: SlashCommand = {
  name: 'help',
  description: 'List commands',
  run: async () => {
    const lines = REGISTRY
      .filter(c => c.name !== 'help')
      .map(c => `- **/${c.name}** ${c.argHint ?? ''} — ${c.description}`)
      .join('\n');
    return {
      kind: 'assistant',
      content: `Available commands:\n${lines}`,
    };
  },
};

export const REGISTRY: SlashCommand[] = [
  imageCommand,
  explainCommand,
  mnemonicCommand,
  defineCommand,
  clearCommand,
  helpCommand,
];

/** Look up by name (case-insensitive). */
export function findCommand(name: string): SlashCommand | null {
  const lower = name.toLowerCase();
  return REGISTRY.find(c => c.name === lower) ?? null;
}

/**
 * Parse "/foo bar baz" into ("foo", "bar baz"). Returns null if the input
 * doesn't start with a slash.
 */
export function parseSlash(input: string): { name: string; args: string } | null {
  const m = /^\/([a-z]+)(?:\s+(.*))?$/i.exec(input.trimStart());
  if (!m) return null;
  return { name: m[1], args: m[2] ?? '' };
}

/** Filter the registry by partial command-name typed by the user. */
export function suggestCommands(prefix: string): SlashCommand[] {
  const lower = prefix.toLowerCase();
  return REGISTRY.filter(c => c.name.toLowerCase().startsWith(lower));
}

export type { CommandResult, SlashCommand };
