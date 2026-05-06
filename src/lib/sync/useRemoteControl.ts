'use client';

import { useEffect, useRef } from 'react';
import { withBasePath } from '@/lib/basePath';
import { db } from '@/lib/db/dexie';
import type { RemoteAction } from './remote-bus';

/**
 * Subscribe to the remote-control SSE stream and dispatch each incoming
 * action to the supplied handler. Reconnects with exponential backoff on
 * transient errors so a brief network blip doesn't kill the channel.
 *
 * Token is read from sync_adapter_config in IndexedDB — same bearer the
 * sync layer uses, so once the user has set up sync the remote works
 * with zero extra credentials.
 *
 * Caller passes a stable handler ref-like object via `handlersRef` so the
 * subscription effect doesn't tear down on every render of the parent.
 */

export interface RemoteHandlers {
  onAction(action: RemoteAction): void;
}

export function useRemoteControl(handlersRef: React.MutableRefObject<RemoteHandlers>): void {
  const stoppedRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let es: EventSource | null = null;
    let backoff = 1_000;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      if (stoppedRef.current) return;
      // Pull the current sync token. Done on every (re)connect so a
      // settings change while the app is open propagates without a
      // page reload.
      let token: string | null = null;
      let url: string | null = null;
      try {
        const cfg = await db().settings.get('sync_adapter_config');
        if (cfg) {
          const parsed = JSON.parse(cfg.value) as { kind?: string; url?: string; token?: string };
          if (parsed.kind === 'self' && parsed.token) {
            token = parsed.token;
            // Stream URL is sibling of the snapshot URL.
            // .../snapshot → .../remote/stream
            const base = (parsed.url ?? '').replace(/\/snapshot(?=$|\?)/, '/remote/stream');
            url = base || `${window.location.origin}${withBasePath('/api/sync/remote/stream')}`;
          }
        }
      } catch { /* ignore — token simply unavailable */ }

      if (!token || !url) {
        // Sync isn't configured; nothing to do. Try again later in case
        // the user finishes setup mid-session.
        timer = setTimeout(connect, 5_000);
        return;
      }

      try {
        es = new EventSource(`${url}?token=${encodeURIComponent(token)}`);
      } catch {
        timer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30_000);
        return;
      }

      es.onopen = () => { backoff = 1_000; };
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as RemoteAction | { type: 'hello' };
          if (data.type === 'hello') return;
          handlersRef.current.onAction(data);
        } catch { /* malformed payload — ignore */ }
      };
      es.onerror = () => {
        // EventSource auto-retries internally, but we close + reconnect
        // ourselves with backoff so a stuck channel doesn't keep
        // attempting at full speed.
        es?.close();
        es = null;
        if (stoppedRef.current) return;
        timer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      };
    };

    connect();

    return () => {
      stoppedRef.current = true;
      if (timer) clearTimeout(timer);
      es?.close();
    };
    // handlersRef is intentionally not a dep — it's a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
