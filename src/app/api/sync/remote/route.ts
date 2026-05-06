/**
 * Remote-control POST endpoint. Phone (or any paired client) sends an
 * action; we publish it to every active SSE subscriber for the same
 * bearer token. Synchronous publish so the laptop receives the event in
 * the same tick the POST is being processed — minimum hub-mediated
 * latency.
 */

import { NextResponse } from 'next/server';
import { publish, subscriberCount, type RemoteAction } from '@/lib/sync/remote-bus';

export const runtime = 'nodejs';

function authToken(req: Request): string | null {
  const expected = process.env.CARDS_SYNC_TOKEN;
  if (!expected) return null;
  const header = req.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || token.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0 ? token : null;
}

function isAction(x: unknown): x is RemoteAction {
  if (!x || typeof x !== 'object') return false;
  const a = x as { type?: unknown; rating?: unknown };
  if (typeof a.type !== 'string') return false;
  switch (a.type) {
    case 'rate':
      return typeof a.rating === 'number' && [1, 2, 3, 4].includes(a.rating);
    case 'reveal':
    case 'undo':
    case 'snooze-hour':
    case 'snooze-day':
    case 'bury':
    case 'suspend':
    case 'end-pomodoro-phase':
    case 'flag-cycle':
    case 'edit':
    case 'ask':
      return true;
    default:
      return false;
  }
}

export async function POST(req: Request) {
  const token = authToken(req);
  if (!token) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!isAction(body)) {
    return NextResponse.json({ error: 'invalid_action' }, { status: 400 });
  }
  const delivered = publish(token, body);
  return NextResponse.json({ delivered, listeners: subscriberCount(token) });
}
