import type Anthropic from '@anthropic-ai/sdk';
import type { Card, Note } from '@/lib/db/schema';
import { getSetting } from '@/lib/db/queries';
import { makeAnthropicClient } from './client';
import { buildSystemPrompt } from './prompts';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export const DEFAULT_MODEL = 'claude-sonnet-4-6';
export const MODEL_OPTIONS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (fast, default)' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7 (most capable)' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (cheapest)' },
] as const;

interface AskParams {
  note: Note;
  card: Card;
  history: ChatMessage[];
  onDelta: (chunk: string) => void;
  signal?: AbortSignal;
}

async function makeClient(apiKey: string): Promise<Anthropic> {
  return makeAnthropicClient(apiKey);
}

export async function askClaude({ note, card, history, onDelta, signal }: AskParams): Promise<void> {
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Claude API key not configured. Add it in Settings.');
  const model = (await getSetting('claude_model')) || DEFAULT_MODEL;
  const client = await makeClient(apiKey);

  const systemText = buildSystemPrompt(note, card);

  const stream = client.messages.stream({
    model,
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: systemText,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: history.map(m => ({ role: m.role, content: m.content })),
  });

  if (signal) {
    signal.addEventListener('abort', () => stream.abort(), { once: true });
  }

  stream.on('text', delta => onDelta(delta));
  await stream.finalMessage();
}

export async function testApiKey(apiKey: string, model = DEFAULT_MODEL): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const client = await makeClient(apiKey);
    await client.messages.create({
      model,
      max_tokens: 4,
      messages: [{ role: 'user', content: 'ping' }],
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
