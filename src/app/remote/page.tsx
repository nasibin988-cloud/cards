'use client';

/**
 * Phone-as-remote-control. Big buttons; each tap POSTs an action to
 * /api/sync/remote, which the laptop's open SSE stream picks up and
 * dispatches into Reviewer. Auth = the same bearer token used by sync.
 *
 * Latency budget: phone tap → POST round-trip → server publish → SSE
 * push → laptop dispatch. Each leg is one HTTPS keep-alive turn over
 * Hetzner; with the user in California, ~250–300 ms door-to-door is
 * realistic. Most of that is the trans-Atlantic round-trip.
 */

import { useEffect, useState } from 'react';
import { db } from '@/lib/db/dexie';
import { withBasePath } from '@/lib/basePath';
import type { RemoteAction } from '@/lib/sync/remote-bus';
import { cn } from '@/lib/utils';

type ConnState = 'unknown' | 'no-config' | 'ready' | 'sending' | 'error';

export default function RemotePage() {
  const [token, setToken] = useState<string | null>(null);
  const [postUrl, setPostUrl] = useState<string | null>(null);
  const [state, setState] = useState<ConnState>('unknown');
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await db().settings.get('sync_adapter_config');
        if (!cfg) { setState('no-config'); return; }
        const parsed = JSON.parse(cfg.value) as { kind?: string; url?: string; token?: string };
        if (parsed.kind !== 'self' || !parsed.token) { setState('no-config'); return; }
        const url = (parsed.url ?? '').replace(/\/snapshot(?=$|\?)/, '/remote')
          || `${window.location.origin}${withBasePath('/api/sync/remote')}`;
        setToken(parsed.token);
        setPostUrl(url);
        setState('ready');
      } catch {
        setState('no-config');
      }
    })();
  }, []);

  const send = async (action: RemoteAction) => {
    if (!token || !postUrl) return;
    setState('sending');
    setLastError(null);
    try {
      const r = await fetch(postUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(action),
        keepalive: true,
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        setLastError(`HTTP ${r.status}: ${txt || r.statusText}`);
        setState('error');
        return;
      }
      const data = (await r.json()) as { delivered: number; listeners: number };
      setLastAction(`${describe(action)} → ${data.delivered}/${data.listeners}`);
      setState('ready');
      // Tactile feedback so the user knows the tap registered before
      // the laptop visibly reacts (~250 ms hub round-trip).
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
    <div className="min-h-[100dvh] flex flex-col px-4 pt-6 pb-[max(env(safe-area-inset-bottom),1rem)] gap-3">
      <div className="text-center pb-2">
        <h1 className="text-2xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
          Remote
        </h1>
        <div className="text-2xs uppercase tracking-widest text-dark-500 font-mono mt-1">
          {lastAction ?? 'tap to send'}
        </div>
      </div>

      <BigBtn label="Reveal" tone="persian" onClick={() => send({ type: 'reveal' })} />

      <div className="grid grid-cols-2 gap-3">
        <BigBtn label="Again" sub="1" tone="crimson" onClick={() => send({ type: 'rate', rating: 1 })} />
        <BigBtn label="Hard"  sub="2" tone="dark"     onClick={() => send({ type: 'rate', rating: 2 })} />
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
  }
}

function BigBtn({
  label, sub, tone, onClick,
}: { label: string; sub?: string; tone: 'persian' | 'saffron' | 'crimson' | 'dark'; onClick: () => void }) {
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
        'flex-1 min-h-[6rem] rounded-3xl px-6 py-5 text-3xl font-extralight tracking-tight',
        'bg-gradient-to-br border backdrop-blur-md',
        'active:scale-[0.97] transition-transform select-none touch-manipulation',
        palette[tone],
      )}
    >
      <div>{label}</div>
      {sub && <div className="text-xs font-mono opacity-50 mt-1">{sub}</div>}
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
