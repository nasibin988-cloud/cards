'use client';

import { useEffect, useRef, useState } from 'react';
import { getJsonSetting } from '@/lib/db/queries';
import {
  SelfHostedAdapter,
  SupabaseAdapter,
  type SyncAdapter,
} from './adapter';
import { pull, push, status, type SyncStatus } from './sync';

/**
 * Auto-sync orchestration. Mounted once at the app shell so it's active
 * on every route. Behavior:
 *
 *   - On mount: load adapter config + passphrase. If both present, run a
 *     status check.
 *       - "behind": auto-pull (remote has changes, local does not).
 *       - "untouched": auto-push the baseline so the empty server gets
 *         seeded with this device's data.
 *       - "ahead" / "in-sync": leave alone.
 *       - "diverged": surface a one-shot toast and STOP — never overwrite
 *         silently.
 *   - While running: subscribe to `cards:dirty` events emitted by Dexie
 *     hooks. Debounce a push by `PUSH_DEBOUNCE_MS` so a study burst
 *     produces one network round-trip, not one per rate.
 *   - On `visibilitychange` to hidden, or `pagehide`/`beforeunload`:
 *     flush the pending push immediately so closing the tab can't
 *     swallow data.
 *
 * Returns a status object for the UI to render a small badge if it
 * wants. The caller decides where to show that.
 */

export type AutoSyncState =
  | { kind: 'disabled' }
  | { kind: 'idle'; lastStatus: SyncStatus | null; lastError: string | null }
  | { kind: 'syncing'; phase: 'pull' | 'push' }
  | { kind: 'diverged'; lastStatus: SyncStatus };

const PUSH_DEBOUNCE_MS = 8_000;
/** How often to retry a stuck push (network hiccup, server down, etc).
 *  Without this, the only retry trigger is the next dirty event — which
 *  may never come if the user stops editing. 60s is short enough that a
 *  recovery still happens within one session, long enough not to hammer
 *  the server when it's down. */
const RETRY_HEARTBEAT_MS = 60_000;

interface AdapterCfg {
  kind: 'self' | 'supabase';
  // self
  url?: string;
  token?: string;
  // supabase (legacy)
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  email?: string;
  password?: string;
}

async function loadAdapter(): Promise<SyncAdapter | null> {
  const enabled = await getJsonSetting<boolean>('sync_auto_enabled', true);
  if (!enabled) return null;
  const cfg = await getJsonSetting<AdapterCfg | null>('sync_adapter_config', null);
  if (!cfg) return null;
  if (cfg.kind === 'self') {
    if (!cfg.url || !cfg.token) return null;
    return new SelfHostedAdapter({ url: cfg.url, token: cfg.token });
  }
  if (cfg.kind === 'supabase') {
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !cfg.email || !cfg.password) return null;
    return new SupabaseAdapter({
      url: cfg.supabaseUrl,
      anonKey: cfg.supabaseAnonKey,
      email: cfg.email,
      password: cfg.password,
    });
  }
  return null;
}

async function loadPassphrase(): Promise<string | null> {
  // The passphrase is stored ONLY when the user opts into auto-sync.
  // Sync without auto-sync still requires the user to type it each session.
  return getJsonSetting<string | null>('sync_auto_passphrase', null);
}

export function useAutoSync(): AutoSyncState {
  const [state, setState] = useState<AutoSyncState>({ kind: 'disabled' });
  const adapterRef = useRef<SyncAdapter | null>(null);
  const passphraseRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const inFlightRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-run the effect when sync settings might have changed. The Settings
  // page bumps this counter on save so we re-load without a full reload.
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    const onConfigChanged = () => setReloadTick(t => t + 1);
    window.addEventListener('cards:sync-config-changed', onConfigChanged);
    return () => window.removeEventListener('cards:sync-config-changed', onConfigChanged);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let dirtyHandler: (() => void) | null = null;
    let visibilityHandler: (() => void) | null = null;
    let unloadHandler: (() => void) | null = null;
    let heartbeatId: ReturnType<typeof setInterval> | null = null;

    const flushPush = async () => {
      if (!adapterRef.current || !passphraseRef.current) return;
      if (!dirtyRef.current) return;
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      dirtyRef.current = false;
      try {
        // Cheap status check first; only push if local is genuinely
        // ahead. The dirty event fires on every Dexie write, including
        // those that don't bump the local sync version (settings table
        // is excluded from hooks, so most writes do bump it — but a
        // status check is still much cheaper than re-encrypting a
        // 100MB snapshot just to discover the server is already current).
        const s = await status(adapterRef.current);
        if (cancelled) return;
        if (s.state === 'in-sync') {
          setState({ kind: 'idle', lastStatus: s, lastError: null });
          return;
        }
        if (s.state === 'diverged') {
          setState({ kind: 'diverged', lastStatus: s });
          return;
        }
        if (s.state === 'behind') {
          // Don't auto-pull from a debounced push handler — that's the
          // job of the on-mount path. Just record status and bail.
          setState({ kind: 'idle', lastStatus: s, lastError: null });
          return;
        }
        // 'ahead' or 'untouched' — push.
        setState({ kind: 'syncing', phase: 'push' });
        const after = await push(adapterRef.current, passphraseRef.current);
        if (!cancelled) {
          setState({ kind: 'idle', lastStatus: after, lastError: null });
        }
      } catch (err) {
        // Re-set dirty so a later attempt retries; surface the error.
        dirtyRef.current = true;
        if (!cancelled) {
          setState({
            kind: 'idle',
            lastStatus: null,
            lastError: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        inFlightRef.current = false;
      }
    };

    const scheduleFlush = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void flushPush();
      }, PUSH_DEBOUNCE_MS);
    };

    (async () => {
      const adapter = await loadAdapter();
      const passphrase = await loadPassphrase();
      if (!adapter || !passphrase) {
        if (!cancelled) setState({ kind: 'disabled' });
        return;
      }
      adapterRef.current = adapter;
      passphraseRef.current = passphrase;

      // Initial status check + auto-pull / auto-baseline-push.
      try {
        const s = await status(adapter);
        if (cancelled) return;
        if (s.state === 'behind') {
          setState({ kind: 'syncing', phase: 'pull' });
          await pull(adapter, passphrase);
          // Force a reload so every data-fetching component re-reads
          // from the just-replaced IndexedDB. Without this the user sees
          // empty deck/notes/etc until they manually refresh — even
          // though the DB has the pulled data. Auto-pull only fires on
          // app open so a reload here is acceptable (no in-flight work
          // gets dropped).
          if (!cancelled) {
            setState({ kind: 'syncing', phase: 'pull' });
            setTimeout(() => window.location.reload(), 250);
          }
          return;
        } else if (s.state === 'untouched') {
          // Seed the server with our baseline so future devices have
          // something to pull. Safe — there's nothing to overwrite.
          setState({ kind: 'syncing', phase: 'push' });
          const after = await push(adapter, passphrase);
          if (!cancelled) setState({ kind: 'idle', lastStatus: after, lastError: null });
        } else if (s.state === 'diverged') {
          if (!cancelled) setState({ kind: 'diverged', lastStatus: s });
          return; // Don't subscribe to dirty — we won't auto-push past a divergence.
        } else {
          if (!cancelled) setState({ kind: 'idle', lastStatus: s, lastError: null });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            kind: 'idle',
            lastStatus: null,
            lastError: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      // Subscribe to dirty events.
      dirtyHandler = () => {
        dirtyRef.current = true;
        scheduleFlush();
      };
      window.addEventListener('cards:dirty', dirtyHandler);

      // Heartbeat: every minute, if there's still pending dirty work
      // (e.g. the previous push errored out), retry. Without this the
      // only retry trigger is the next user edit — which may never come
      // if they stop interacting after the failure.
      heartbeatId = setInterval(() => {
        if (dirtyRef.current && !inFlightRef.current) void flushPush();
      }, RETRY_HEARTBEAT_MS);

      // Flush on tab hide / unload so closing the tab doesn't lose data.
      visibilityHandler = () => {
        if (document.visibilityState === 'hidden') void flushPush();
      };
      unloadHandler = () => { void flushPush(); };
      document.addEventListener('visibilitychange', visibilityHandler);
      window.addEventListener('pagehide', unloadHandler);
      window.addEventListener('beforeunload', unloadHandler);
    })();

    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (heartbeatId) clearInterval(heartbeatId);
      if (dirtyHandler) window.removeEventListener('cards:dirty', dirtyHandler);
      if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
      if (unloadHandler) {
        window.removeEventListener('pagehide', unloadHandler);
        window.removeEventListener('beforeunload', unloadHandler);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadTick]);

  return state;
}
