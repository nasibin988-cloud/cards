/**
 * Resolve the OpenAI API key, preferring a per-device Settings override
 * over a build-time baked-in fallback.
 *
 * Priority:
 *   1. IndexedDB Settings (`openai_api_key`) — set per-origin by the user.
 *   2. `NEXT_PUBLIC_OPENAI_API_KEY` baked into the production bundle at
 *      Docker build time from the host's `/opt/cards/.env`.
 *
 * The build-time fallback is what lets the Hetzner deploy "just work" out
 * of the box; the Settings override is what lets a user paste a different
 * key on a different device without rebuilding.
 *
 * Because (2) is a `NEXT_PUBLIC_*` var it IS in the browser bundle for
 * anyone with access to rebuilding-iran.com/cards. The user is aware of
 * this tradeoff (single-user app, key scoped to this deployment).
 */

import { getSetting } from '@/lib/db/queries';

export async function getOpenAIKey(): Promise<string | null> {
  const fromSettings = await getSetting('openai_api_key');
  if (fromSettings && fromSettings.trim()) return fromSettings.trim();
  const fromEnv = process.env.NEXT_PUBLIC_OPENAI_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return null;
}
