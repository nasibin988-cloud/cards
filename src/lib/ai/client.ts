/**
 * Lazy-load the Anthropic SDK. Every file under `lib/ai/` (and the Persian
 * lookup) used to `import Anthropic from '@anthropic-ai/sdk'` at module
 * scope, which caused the SDK to be bundled into every route that
 * transitively reaches an AI helper — even before the user interacts with
 * any AI feature.
 *
 * Pattern:
 *   import { makeAnthropicClient } from '@/lib/ai/client';
 *   const client = await makeAnthropicClient(apiKey);
 *
 * Type-only imports (`import type Anthropic from '@anthropic-ai/sdk'`) are
 * still safe — TS erases them, so they don't pull the SDK at build time.
 */

import type Anthropic from '@anthropic-ai/sdk';

type AnthropicCtor = typeof import('@anthropic-ai/sdk').default;

let _ctor: AnthropicCtor | null = null;
let _pending: Promise<AnthropicCtor> | null = null;

async function getAnthropicCtor(): Promise<AnthropicCtor> {
  if (_ctor) return _ctor;
  if (_pending) return _pending;
  _pending = (async () => {
    const mod = await import('@anthropic-ai/sdk');
    _ctor = mod.default;
    _pending = null;
    return _ctor;
  })();
  return _pending;
}

export async function makeAnthropicClient(apiKey: string): Promise<Anthropic> {
  const Ctor = await getAnthropicCtor();
  return new Ctor({ apiKey, dangerouslyAllowBrowser: true });
}
