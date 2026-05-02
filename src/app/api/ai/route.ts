/**
 * Placeholder for future server-side AI proxy.
 *
 * V1 is local-only: the browser calls the Anthropic API directly using the user's
 * own key (stored in IndexedDB, with `dangerouslyAllowBrowser: true`). When this
 * app is later embedded in the Rebuilding Iran site, this route will hold a
 * server-side key and proxy `/api/ai` so individual users don't paste keys.
 */

export const runtime = 'edge';

export async function POST() {
  return new Response(
    JSON.stringify({
      error: 'not_implemented',
      message: 'V1 calls Anthropic from the browser. Configure your key in /settings.',
    }),
    {
      status: 501,
      headers: { 'content-type': 'application/json' },
    },
  );
}
