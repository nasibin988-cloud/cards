'use client';

import { useEffect, useRef } from 'react';
import { withBasePath } from '@/lib/basePath';
import { db } from '@/lib/db/dexie';
import type { RemoteAction } from './remote-bus';
import { createResponder, isSignal, type Peer, type SignalEnvelope } from './webrtc-peer';

/**
 * Subscribe to the remote-control SSE stream and dispatch each incoming
 * action to the supplied handler. WebRTC is layered on top: we maintain
 * a peer connection in "responder" mode and, if a phone establishes a
 * data channel, route incoming actions through it instead. The SSE hub
 * stays open the whole time as both signaling transport AND fallback
 * (any DC failure silently degrades to hub-mediated actions, exactly
 * the pre-WebRTC behavior).
 *
 * Token is read from sync_adapter_config in IndexedDB — same bearer the
 * sync layer uses, so once the user has set up sync the remote works
 * with zero extra credentials.
 *
 * Caller passes a stable handler ref so the subscription effect doesn't
 * tear down on every render of the parent.
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
    let peer: Peer | null = null;
    let postUrl: string | null = null;
    let bearer: string | null = null;

    const sendSignal = async (s: SignalEnvelope) => {
      if (!postUrl || !bearer) return;
      try {
        await fetch(postUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${bearer}`,
          },
          body: JSON.stringify(s),
          keepalive: true,
        });
      } catch { /* signaling is best-effort; SSE retries the rest */ }
    };

    const ensurePeer = (): Peer | null => {
      if (peer) return peer;
      peer = createResponder({
        sendSignal,
        onMessage: (text) => {
          try {
            const action = JSON.parse(text) as RemoteAction;
            // The data channel only carries user actions, never signaling
            // (that's still on SSE). But guard anyway.
            if (!isSignal(action as { type: string })) {
              handlersRef.current.onAction(action);
            }
          } catch { /* malformed payload — ignore */ }
        },
        onOpen: () => { /* nothing to do — actions just start flowing */ },
        onClose: () => {
          // DC closed → from now on, actions flow over SSE again.
          // We rebuild the peer on the next inbound offer.
          peer?.dispose();
          peer = null;
        },
      });
      return peer;
    };

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
            const base = (parsed.url ?? '').replace(/\/snapshot(?=$|\?)/, '/remote/stream');
            url = base || `${window.location.origin}${withBasePath('/api/sync/remote/stream')}`;
            postUrl = (parsed.url ?? '').replace(/\/snapshot(?=$|\?)/, '/remote')
              || `${window.location.origin}${withBasePath('/api/sync/remote')}`;
            bearer = parsed.token;
          }
        }
      } catch { /* ignore — token simply unavailable */ }

      if (!token || !url) {
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
          if (isSignal(data as { type: string })) {
            // Route to WebRTC state machine; don't surface to the user-
            // action handler.
            const p = ensurePeer();
            if (p) void p.handleSignal(data as SignalEnvelope);
          } else {
            handlersRef.current.onAction(data);
          }
        } catch { /* malformed payload — ignore */ }
      };
      es.onerror = () => {
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
      // Critical: dispose the peer so its event listeners don't leak
      // across page navigations.
      peer?.dispose();
      peer = null;
    };
    // handlersRef is intentionally not a dep — it's a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
