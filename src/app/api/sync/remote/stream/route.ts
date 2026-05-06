/**
 * Remote-control SSE stream. Laptop's Reviewer holds this connection
 * open; the in-memory bus pushes actions as they arrive from /api/sync/remote.
 *
 * Implementation notes:
 *   - We run on the Node runtime so we can hold the connection open
 *     indefinitely. Edge runtime can't keep streams alive past its
 *     execution timeout in some environments.
 *   - A 25-second keep-alive ping (`:` comment line) prevents idle-timer
 *     proxies (Cloudflare-class infra, Caddy default = 0 but some
 *     reverse proxies trim to 30s) from cutting the stream.
 *   - We don't buffer past actions; if the laptop reconnects after a
 *     drop, anything sent during the gap is missed. Acceptable for a
 *     remote-control use case (user re-taps).
 */

import { subscribe } from '@/lib/sync/remote-bus';

export const runtime = 'nodejs';
// Don't try to dedupe identical fetches; each connection is unique.
export const dynamic = 'force-dynamic';

function authToken(req: Request): string | null {
  const expected = process.env.CARDS_SYNC_TOKEN;
  if (!expected) return null;
  // SSE in browsers can't set Authorization headers via EventSource, so we
  // also accept ?token=… as a query param. The endpoint isn't sensitive
  // beyond the snapshot endpoint (token is the same secret), so passing
  // it via query is fine — TLS still encrypts it on the wire.
  const url = new URL(req.url);
  const fromQuery = url.searchParams.get('token') || '';
  const fromHeader = (req.headers.get('authorization') || '').startsWith('Bearer ')
    ? (req.headers.get('authorization') || '').slice(7)
    : '';
  const token = fromHeader || fromQuery;
  if (!token || token.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0 ? token : null;
}

export async function GET(req: Request) {
  const token = authToken(req);
  if (!token) {
    return new Response('unauthorized', { status: 401 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let pingId: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      // Send an initial hello so the EventSource onopen fires reliably
      // and the client can immediately confirm the channel is live.
      send({ type: 'hello' });
      unsubscribe = subscribe(token, action => send(action));
      // Periodic comment line to defeat proxy idle timeouts.
      pingId = setInterval(() => {
        try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { /* closed */ }
      }, 25_000);
    },
    cancel() {
      if (pingId) clearInterval(pingId);
      if (unsubscribe) unsubscribe();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      // Tell intermediate proxies (looking at you, Caddy) not to buffer.
      'x-accel-buffering': 'no',
    },
  });
}
