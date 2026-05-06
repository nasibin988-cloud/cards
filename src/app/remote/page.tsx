'use client';

/**
 * Phone-as-remote-control. Big buttons; each tap goes to the laptop via
 * the lowest-latency channel currently available:
 *
 *   1. WebRTC RTCDataChannel — when the peer connection has reached
 *      'connected' (USB tether: ~5 ms; same WiFi: ~30 ms).
 *   2. SSE+POST hub via Hetzner — when the data channel isn't open yet
 *      or has failed (~250–300 ms).
 *
 * The two paths share the same bearer token. WebRTC signaling rides on
 * top of the same SSE channel so we don't need any new auth or routes.
 *
 * Auth = the bearer token the user already configured for sync; we read
 * it from IndexedDB on load. No extra credentials to manage.
 */

import { useEffect, useRef, useState } from 'react';
import { db } from '@/lib/db/dexie';
import { withBasePath } from '@/lib/basePath';
import type { RemoteAction } from '@/lib/sync/remote-bus';
import { createInitiator, isSignal, type Peer, type SignalEnvelope } from '@/lib/sync/webrtc-peer';
import { cn } from '@/lib/utils';

type ConnState = 'unknown' | 'no-config' | 'ready' | 'sending' | 'error';
type ChannelMode = 'webrtc' | 'hub';

export default function RemotePage() {
  const [token, setToken] = useState<string | null>(null);
  const [postUrl, setPostUrl] = useState<string | null>(null);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [state, setState] = useState<ConnState>('unknown');
  const [lastError, setLastError] = useState<string | null>(null);
  // Tracked for future reinstatement of the status row (currently the
  // chromeless layout doesn't display it). Setter calls in send() are
  // kept so flipping the JSX back on doesn't require re-plumbing.
  const [, setLastAction] = useState<string | null>(null);
  const [mode, setMode] = useState<ChannelMode>('hub');

  const peerRef = useRef<Peer | null>(null);
  const esRef = useRef<EventSource | null>(null);

  // ── Discover token + endpoints from the user's existing sync config ──
  useEffect(() => {
    (async () => {
      try {
        const cfg = await db().settings.get('sync_adapter_config');
        if (!cfg) { setState('no-config'); return; }
        const parsed = JSON.parse(cfg.value) as { kind?: string; url?: string; token?: string };
        if (parsed.kind !== 'self' || !parsed.token) { setState('no-config'); return; }
        const post = (parsed.url ?? '').replace(/\/snapshot(?=$|\?)/, '/remote')
          || `${window.location.origin}${withBasePath('/api/sync/remote')}`;
        const stream = (parsed.url ?? '').replace(/\/snapshot(?=$|\?)/, '/remote/stream')
          || `${window.location.origin}${withBasePath('/api/sync/remote/stream')}`;
        setToken(parsed.token);
        setPostUrl(post);
        setStreamUrl(stream);
        setState('ready');
      } catch {
        setState('no-config');
      }
    })();
  }, []);

  // ── Hub POST (fallback / signaling transport) ────────────────────────
  const sendViaPost = async (payload: RemoteAction | SignalEnvelope) => {
    if (!token || !postUrl) return;
    await fetch(postUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  };

  // ── SSE: receive WebRTC signaling from the laptop's responder ────────
  useEffect(() => {
    if (!streamUrl || !token) return;
    let stopped = false;
    let reconnectId: ReturnType<typeof setTimeout> | null = null;
    let backoff = 1_000;

    const open = () => {
      if (stopped) return;
      let es: EventSource;
      try {
        es = new EventSource(`${streamUrl}?token=${encodeURIComponent(token)}`);
      } catch {
        reconnectId = setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 30_000);
        return;
      }
      esRef.current = es;
      es.onopen = () => { backoff = 1_000; };
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as RemoteAction | { type: 'hello' };
          if (data.type === 'hello') return;
          if (isSignal(data as { type: string })) {
            const peer = peerRef.current;
            if (peer) void peer.handleSignal(data as SignalEnvelope);
          }
          // Non-signal actions echoed back to the phone are ignored — the
          // laptop dispatches them locally.
        } catch { /* ignore */ }
      };
      es.onerror = () => {
        es.close();
        esRef.current = null;
        if (stopped) return;
        reconnectId = setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      };
    };

    open();

    return () => {
      stopped = true;
      if (reconnectId) clearTimeout(reconnectId);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [streamUrl, token]);

  // ── WebRTC: phone is the initiator. Build once we have a token. ──────
  useEffect(() => {
    if (!token || !postUrl) return;
    let retryId: ReturnType<typeof setTimeout> | null = null;

    const build = () => {
      const peer = createInitiator({
        sendSignal: (s) => { void sendViaPost(s); },
        onOpen: () => { setMode('webrtc'); },
        onClose: () => {
          setMode('hub');
          // Give the laptop a moment to come back, then retry. We don't
          // hammer — the SSE hub keeps actions flowing in the meantime.
          retryId = setTimeout(() => {
            peerRef.current?.dispose();
            peerRef.current = null;
            build();
          }, 5_000);
        },
        onMessage: () => { /* phone doesn't expect messages back — yet */ },
      });
      peerRef.current = peer;
    };

    build();

    return () => {
      if (retryId) clearTimeout(retryId);
      peerRef.current?.dispose();
      peerRef.current = null;
      setMode('hub');
    };
    // sendViaPost depends on postUrl/token already in deps; the ref-style
    // closure captures whichever values were current at build time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, postUrl]);

  // ── Action send: prefer DC, fall back to POST ────────────────────────
  const send = async (action: RemoteAction) => {
    if (!token || !postUrl) return;
    setState('sending');
    setLastError(null);

    const text = JSON.stringify(action);
    const peer = peerRef.current;
    if (peer && peer.isOpen()) {
      const ok = peer.send(text);
      if (ok) {
        setLastAction(`${describe(action)} · webrtc`);
        setState('ready');
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          navigator.vibrate?.(10);
        }
        return;
      }
      // peer.send returned false (channel raced into a non-open state) —
      // fall through to the hub.
    }

    try {
      const r = await fetch(postUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: text,
        keepalive: true,
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        setLastError(`HTTP ${r.status}: ${txt || r.statusText}`);
        setState('error');
        return;
      }
      const data = (await r.json()) as { delivered: number; listeners: number };
      setLastAction(`${describe(action)} · hub ${data.delivered}/${data.listeners}`);
      setState('ready');
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate?.(15);
      }
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  };

  if (state === 'no-config') {
    return (
      <div className="max-w-md mx-auto px-6 py-10 text-center space-y-4">
        <h1 className="text-3xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
          Set up sync first
        </h1>
        <p className="text-dark-300 font-light leading-relaxed">
          The remote uses your sync server&rsquo;s bearer token. Go to <span className="text-dark-100">Settings → Sync (cloud)</span>, paste your endpoint URL + token, then come back.
        </p>
      </div>
    );
  }

  return (
    <div className="relative min-h-[100dvh] flex flex-col p-2 pt-[max(env(safe-area-inset-top),0.5rem)] pb-[max(env(safe-area-inset-bottom),0.5rem)] gap-2">
      {/* Tiny corner status dot — connection mode at a glance, no chrome
          competing with the buttons. WebRTC = pulsing saffron, hub = grey. */}
      <span
        className={cn(
          'absolute top-2 right-2 h-1.5 w-1.5 rounded-full pointer-events-none z-10',
          mode === 'webrtc' ? 'bg-saffron-300 animate-pulse' : 'bg-dark-600',
        )}
        aria-label={mode === 'webrtc' ? 'Direct connection' : 'Hub fallback'}
      />

      {/*
        Two big dual-purpose tap zones, side by side, filling the
        remaining viewport. Tapping either flips the card when the
        laptop is on the front; once flipped, left rates Again (1) and
        right rates Good (3). Mirrors the laptop's ←/→ arrow keys.
        The fuller button set (Reveal as a separate button, Hard/Easy,
        Undo/Bury/Suspend/etc.) is intentionally retained in the code
        — see the COMMENTED block below — so it can be restored later
        without re-deriving the markup.
      */}
      <div className="flex-1 grid grid-cols-2 gap-3">
        <BigBtn label="AGAIN" sub="1 · flip" tone="crimson" fill onClick={() => send({ type: 'tap-left' })} />
        <BigBtn label="GOOD"  sub="3 · flip" tone="saffron" fill onClick={() => send({ type: 'tap-right' })} />
      </div>

      {/*
      // ── Full-feature remote (Reveal + 1-4 + Undo/Bury/etc.). Kept
      //    for easy restoration; toggle by replacing the simplified
      //    block above with this one. Same `send()` helper, same
      //    server endpoints — no other changes needed.
      <BigBtn label="Reveal" tone="persian" onClick={() => send({ type: 'reveal' })} />
      <div className="grid grid-cols-2 gap-3">
        <BigBtn label="Again" sub="1" tone="crimson" onClick={() => send({ type: 'rate', rating: 1 })} />
        <BigBtn label="Hard"  sub="2" tone="dark"    onClick={() => send({ type: 'rate', rating: 2 })} />
        <BigBtn label="Good"  sub="3" tone="saffron" onClick={() => send({ type: 'rate', rating: 3 })} />
        <BigBtn label="Easy"  sub="4" tone="persian" onClick={() => send({ type: 'rate', rating: 4 })} />
      </div>
      <div className="grid grid-cols-3 gap-2 mt-1">
        <SmallBtn label="Undo"   onClick={() => send({ type: 'undo' })} />
        <SmallBtn label="Bury"   onClick={() => send({ type: 'bury' })} />
        <SmallBtn label="Susp."  onClick={() => send({ type: 'suspend' })} />
        <SmallBtn label="N: 1h"  onClick={() => send({ type: 'snooze-hour' })} />
        <SmallBtn label="M: 1d"  onClick={() => send({ type: 'snooze-day' })} />
        <SmallBtn label="Flag"   onClick={() => send({ type: 'flag-cycle' })} />
        <SmallBtn label="Edit"   onClick={() => send({ type: 'edit' })} />
        <SmallBtn label="Ask"    onClick={() => send({ type: 'ask' })} />
        <SmallBtn label="Pomo ↷" onClick={() => send({ type: 'end-pomodoro-phase' })} />
      </div>
      */}

      {lastError && (
        <div className="text-2xs text-crimson-300 font-mono break-words text-center mt-1">{lastError}</div>
      )}
    </div>
  );
}

function describe(a: RemoteAction): string {
  switch (a.type) {
    case 'rate': return `Rate ${a.rating}`;
    case 'reveal': return 'Reveal';
    case 'undo': return 'Undo';
    case 'snooze-hour': return 'Snooze 1h';
    case 'snooze-day':  return 'Snooze 1d';
    case 'bury': return 'Bury';
    case 'suspend': return 'Suspend';
    case 'end-pomodoro-phase': return 'Pomodoro skip';
    case 'flag-cycle': return 'Flag';
    case 'edit': return 'Edit';
    case 'ask': return 'Ask';
    case 'tap-left':  return 'Left';
    case 'tap-right': return 'Right';
    case 'webrtc-offer': case 'webrtc-answer': case 'webrtc-ice': case 'webrtc-bye': return 'signal';
  }
}

function BigBtn({
  label, sub, tone, onClick, fill,
}: { label: string; sub?: string; tone: 'persian' | 'saffron' | 'crimson' | 'dark'; onClick: () => void; fill?: boolean }) {
  const palette: Record<typeof tone, string> = {
    persian:  'from-persian-700/40  to-persian-900/40  text-persian-100  border-persian-700/40',
    saffron:  'from-saffron-700/40  to-saffron-900/40  text-saffron-100  border-saffron-700/40',
    crimson:  'from-crimson-700/40  to-crimson-900/40  text-crimson-100  border-crimson-700/40',
    dark:     'from-dark-700/40     to-dark-900/40     text-dark-100     border-white/[0.06]',
  };
  return (
    <button
      onClick={onClick}
      className={cn(
        // `fill` makes the button stretch to fill its grid cell — used
        // by the two-zone simplified remote so each tap target spans
        // ~half the viewport. Without `fill` we keep the original
        // pill-style sizing for the legacy multi-button layout.
        fill
          ? 'h-full w-full rounded-3xl px-6 py-5 text-4xl font-extralight tracking-tight flex flex-col items-center justify-center gap-3'
          : 'flex-1 min-h-[6rem] rounded-3xl px-6 py-5 text-3xl font-extralight tracking-tight',
        'bg-gradient-to-br border backdrop-blur-md',
        'active:scale-[0.97] transition-transform select-none touch-manipulation',
        palette[tone],
      )}
    >
      <div>{label}</div>
      {sub && <div className={cn('font-mono opacity-50', fill ? 'text-sm tracking-widest uppercase' : 'text-xs mt-1')}>{sub}</div>}
    </button>
  );
}

function SmallBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-xl px-3 py-3 text-xs font-mono uppercase tracking-widest text-dark-200 bg-dark-800/40 border border-white/[0.06] active:bg-white/[0.06] transition-colors select-none touch-manipulation"
    >
      {label}
    </button>
  );
}
