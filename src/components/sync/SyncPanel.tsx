'use client';

import { useEffect, useMemo, useState } from 'react';
import { getJsonSetting, setJsonSetting } from '@/lib/db/queries';
import { db } from '@/lib/db/dexie';
import { withBasePath } from '@/lib/basePath';
import {
  SelfHostedAdapter,
  SupabaseAdapter,
  LoopbackAdapter,
  type SyncAdapter,
  SUPABASE_SETUP_SQL,
} from '@/lib/sync/adapter';
import { push, pull, status, verifyPassphrase, type SyncStatus, type SyncProgress } from '@/lib/sync/sync';

type AdapterKind = 'self' | 'supabase' | 'loopback';

interface AdapterCfg {
  kind: AdapterKind;
  // self-hosted
  url?: string;
  token?: string;
  // supabase (legacy / fallback)
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  email?: string;
  password?: string;
}

const ZERO: AdapterCfg = { kind: 'self', url: '', token: '' };

function notifyConfigChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('cards:sync-config-changed'));
  }
}

export default function SyncPanel() {
  const [cfg, setCfg] = useState<AdapterCfg>(ZERO);
  const [cfgStored, setCfgStored] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [passVerified, setPassVerified] = useState(false);
  const [status_, setStatus_] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);
  const [autoEnabled, setAutoEnabled] = useState(true);
  const [progress, setProgress] = useState<SyncProgress | null>(null);

  useEffect(() => {
    (async () => {
      const stored = await getJsonSetting<AdapterCfg | null>('sync_adapter_config', null);
      if (stored) {
        setCfg(stored);
        setCfgStored(true);
      } else {
        // Migrate the old single-shape `sync_config` (Supabase-only) if present
        // so existing setups don't lose their connection.
        const legacy = await getJsonSetting<{ url: string; anonKey: string; email: string; password: string } | null>(
          'sync_config', null,
        );
        if (legacy && legacy.url) {
          const migrated: AdapterCfg = {
            kind: 'supabase',
            supabaseUrl: legacy.url,
            supabaseAnonKey: legacy.anonKey,
            email: legacy.email,
            password: legacy.password,
          };
          setCfg(migrated);
          setCfgStored(true);
          await setJsonSetting('sync_adapter_config', migrated);
        } else {
          // Default the self-hosted URL to this origin's API route — one
          // less thing to type for the most common deploy.
          const defaultUrl = typeof window !== 'undefined'
            ? `${window.location.origin}${withBasePath('/api/sync/snapshot')}`
            : '';
          setCfg({ ...ZERO, url: defaultUrl });
        }
      }
      const auto = await getJsonSetting<boolean>('sync_auto_enabled', true);
      setAutoEnabled(auto);
      const storedPass = await getJsonSetting<string | null>('sync_auto_passphrase', null);
      if (storedPass) {
        setPassphrase(storedPass);
        setPassVerified(true);
      }
    })();
  }, []);

  const adapter: SyncAdapter | null = useMemo(() => {
    if (cfg.kind === 'loopback') return new LoopbackAdapter();
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
  }, [cfg]);

  const saveCfg = async () => {
    await setJsonSetting('sync_adapter_config', cfg);
    setCfgStored(true);
    setInfo('Sync configuration saved.');
    notifyConfigChanged();
  };

  const clearCfg = async () => {
    await db().settings.delete('sync_adapter_config');
    await db().settings.delete('sync_config');
    await db().settings.delete('sync_auto_passphrase');
    setCfg({ ...ZERO });
    setCfgStored(false);
    setStatus_(null);
    setPassphrase('');
    setPassVerified(false);
    notifyConfigChanged();
  };

  const setKind = (kind: AdapterKind) => {
    setCfg(c => ({ ...c, kind }));
    setCfgStored(false);
  };

  const verify = async () => {
    setBusy('verify'); setError(null); setInfo(null);
    try {
      const ok = await verifyPassphrase(passphrase);
      setPassVerified(ok);
      if (!ok) setError('Passphrase verification failed (likely a Web Crypto issue).');
      else setInfo('Passphrase derived successfully.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const refreshStatus = async () => {
    if (!adapter) return;
    setBusy('status'); setError(null);
    try {
      setStatus_(await status(adapter));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doPush = async () => {
    if (!adapter || !passphrase) return;
    if (status_?.state === 'diverged' && !confirm('Remote and local have diverged. Push will OVERWRITE the remote snapshot. Continue?')) return;
    setBusy('push'); setError(null); setInfo(null); setProgress(null);
    try {
      const s = await push(adapter, passphrase, p => setProgress(p));
      setStatus_(s);
      setInfo('Pushed.');
      setBusy(null);
      setProgress(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
      setProgress(null);
    }
  };

  const doPull = async () => {
    if (!adapter || !passphrase) return;
    if (!confirm('Pull will OVERWRITE local data. Continue?')) return;
    setBusy('pull'); setError(null); setInfo(null); setProgress(null);
    try {
      await pull(adapter, passphrase, p => setProgress(p));
      // Page reload after pull is the simplest way to make every
      // data-fetching component (DeckList, TodayBar, Reviewer, …)
      // re-read from the just-replaced IndexedDB. Without this, anything
      // that mounted before the pull keeps its pre-pull React state and
      // looks empty even though the DB has the pulled data. Keep
      // `busy='pull'` so the button stays visibly active until the
      // reload destroys the state — clearing it here flashes the button
      // back to "Pull now" for a frame, which reads as unresponsive.
      setInfo('Pulled. Reloading…');
      setTimeout(() => window.location.reload(), 400);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
      setProgress(null);
    }
  };

  const toggleAuto = async (v: boolean) => {
    setAutoEnabled(v);
    await setJsonSetting('sync_auto_enabled', v);
    if (!v) {
      // Drop the persisted passphrase when auto-sync is turned off so it
      // doesn't sit in IndexedDB if the user changes their mind about
      // storing it.
      await db().settings.delete('sync_auto_passphrase');
    } else if (passVerified && passphrase) {
      await setJsonSetting('sync_auto_passphrase', passphrase);
    }
    notifyConfigChanged();
  };

  // Persist the passphrase when the user verifies it AND auto-sync is on,
  // so the auto-sync hook can use it on subsequent app loads without the
  // user retyping. (Stored alongside other settings in IndexedDB; never
  // sent to the server. The encryption key is derived from this on every
  // sync; a stored copy is the same security posture as a stored API key.)
  useEffect(() => {
    if (autoEnabled && passVerified && passphrase) {
      void setJsonSetting('sync_auto_passphrase', passphrase);
      notifyConfigChanged();
    }
  }, [autoEnabled, passVerified, passphrase]);

  return (
    <div className="space-y-5">
      <div className="text-xs text-dark-400 font-light leading-relaxed">
        End-to-end encrypted: the sync server only ever sees ciphertext; the encryption passphrase never leaves this device.
      </div>

      {/* Adapter selector */}
      <div className="flex flex-wrap gap-2">
        {(['self', 'supabase', 'loopback'] as AdapterKind[]).map(k => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`px-3 py-1.5 rounded-lg text-xs uppercase tracking-widest font-mono border transition ${
              cfg.kind === k
                ? 'bg-saffron-900/30 text-saffron-200 border-saffron-700/50'
                : 'bg-dark-800/30 text-dark-300 border-white/[0.06] hover:text-dark-100 hover:bg-white/[0.04]'
            }`}
          >
            {k === 'self' ? 'Self-hosted' : k === 'supabase' ? 'Supabase' : 'Loopback'}
          </button>
        ))}
      </div>

      {cfg.kind === 'self' && (
        <div className="space-y-3">
          <div className="text-2xs text-dark-500 font-light leading-relaxed">
            Points at your own HTTPS endpoint that implements <code className="font-mono text-dark-300">GET</code> /
            <code className="font-mono text-dark-300"> PUT /api/sync/snapshot</code>. The Cards container ships this route;
            on Hetzner it&rsquo;s already wired up. The bearer token must match <code className="font-mono text-dark-300">CARDS_SYNC_TOKEN</code> on the server.
          </div>
          <Field label="Endpoint URL">
            <input
              value={cfg.url ?? ''}
              onChange={e => { setCfg(c => ({ ...c, url: e.target.value })); setCfgStored(false); }}
              placeholder="https://rebuilding-iran.com/cards/api/sync/snapshot"
              className={inputClass}
            />
          </Field>
          <Field label="Bearer token" hint="From your server's CARDS_SYNC_TOKEN env var.">
            <input
              type="password"
              value={cfg.token ?? ''}
              onChange={e => { setCfg(c => ({ ...c, token: e.target.value })); setCfgStored(false); }}
              className={`${inputClass} font-mono`}
            />
          </Field>
        </div>
      )}

      {cfg.kind === 'supabase' && (
        <div className="space-y-3">
          <div className="text-2xs text-dark-400 font-light leading-relaxed">
            Stores the encrypted snapshot in your own Supabase project.{' '}
            <button onClick={() => setShowSql(s => !s)} className="text-saffron-300 hover:underline">See setup SQL</button>.
          </div>
          {showSql && (
            <pre className="text-2xs text-dark-300 font-mono bg-dark-800/40 rounded-xl p-3 overflow-x-auto whitespace-pre-wrap">{SUPABASE_SETUP_SQL}</pre>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Supabase URL">
              <input
                value={cfg.supabaseUrl ?? ''}
                onChange={e => { setCfg(c => ({ ...c, supabaseUrl: e.target.value })); setCfgStored(false); }}
                placeholder="https://xxx.supabase.co"
                className={inputClass}
              />
            </Field>
            <Field label="Anon (public) key">
              <input
                value={cfg.supabaseAnonKey ?? ''}
                onChange={e => { setCfg(c => ({ ...c, supabaseAnonKey: e.target.value })); setCfgStored(false); }}
                placeholder="eyJhbGciOi…"
                className={inputClass}
              />
            </Field>
            <Field label="Sync account email">
              <input
                value={cfg.email ?? ''}
                onChange={e => { setCfg(c => ({ ...c, email: e.target.value })); setCfgStored(false); }}
                placeholder="you@example.com"
                className={inputClass}
              />
            </Field>
            <Field label="Sync account password">
              <input
                type="password"
                value={cfg.password ?? ''}
                onChange={e => { setCfg(c => ({ ...c, password: e.target.value })); setCfgStored(false); }}
                className={inputClass}
              />
            </Field>
          </div>
        </div>
      )}

      {cfg.kind === 'loopback' && (
        <div className="text-2xs text-dark-400 font-light">
          Stores the encrypted snapshot in this device&rsquo;s localStorage. Useful for verifying the encryption pipeline before pointing at a real server.
        </div>
      )}

      <div className="flex items-center gap-2">
        {!cfgStored ? (
          <button onClick={saveCfg} disabled={!adapter} className="btn-gradient px-4 py-2 rounded-xl text-sm">
            Save config
          </button>
        ) : (
          <button onClick={clearCfg} className="px-4 py-2 rounded-xl text-sm text-crimson-300 hover:bg-crimson-900/20 transition border border-crimson-800/30">
            Clear config
          </button>
        )}
      </div>

      <div className="border-t border-white/[0.04] pt-4">
        <Field label="Encryption passphrase" hint="Distinct from any account password. Lose it and the snapshot is unrecoverable.">
          <div className="flex gap-2">
            <input
              type="password"
              value={passphrase}
              onChange={e => { setPassphrase(e.target.value); setPassVerified(false); }}
              className={`${inputClass} flex-1 font-mono`}
              placeholder="long, memorable phrase"
            />
            <button
              onClick={verify}
              disabled={busy !== null || !passphrase}
              className="px-4 py-2 rounded-xl text-sm text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition border border-white/[0.06]"
            >
              {busy === 'verify' ? 'Deriving…' : 'Verify'}
            </button>
          </div>
        </Field>
        {passVerified && <div className="text-2xs text-saffron-300 mt-1">Passphrase ready.</div>}
      </div>

      <label className="flex items-start gap-3 cursor-pointer pt-2">
        <input
          type="checkbox"
          checked={autoEnabled}
          onChange={e => toggleAuto(e.target.checked)}
          className="mt-1 accent-saffron-400"
        />
        <div>
          <div className="text-sm text-dark-100 font-light">Auto-sync</div>
          <div className="text-2xs text-dark-400 font-light mt-0.5">
            Pull on app open if the server is ahead, push 8 seconds after each change (or instantly when you close the tab).
            Requires the passphrase above; it&rsquo;s stored locally so you don&rsquo;t retype it.
          </div>
        </div>
      </label>

      {(adapter) && (
        <div className="border-t border-white/[0.04] pt-4 space-y-3">
          <div className="flex items-center justify-between">
            <button
              onClick={refreshStatus}
              disabled={busy !== null}
              className="text-xs text-dark-300 hover:text-dark-100 transition px-3 py-1.5 rounded-lg hover:bg-white/[0.04]"
            >
              {busy === 'status' ? 'Checking…' : 'Check status'}
            </button>
            {status_ && (
              <span className="text-2xs uppercase tracking-widest font-mono text-dark-400">
                {status_.state}
              </span>
            )}
          </div>
          {status_ && (
            <div className="grid grid-cols-3 gap-3 text-2xs uppercase tracking-widest font-mono text-dark-500">
              <div>Local v<span className="text-dark-100 ml-1">{status_.localVersion}</span></div>
              <div>Remote v<span className="text-dark-100 ml-1">{status_.remoteVersion ?? '—'}</span></div>
              <div>Last sync <span className="text-dark-100 ml-1">
                {status_.lastSyncMs ? new Date(status_.lastSyncMs).toLocaleString() : '—'}
              </span></div>
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={doPush}
              disabled={busy !== null || !passphrase}
              className="btn-gradient px-4 py-2 rounded-xl text-sm inline-flex items-center gap-2"
            >
              {busy === 'push' && <Spinner />}
              {busy === 'push' ? 'Pushing…' : 'Push now'}
            </button>
            <button
              onClick={doPull}
              disabled={busy !== null || !passphrase || !status_?.remoteVersion}
              className="btn-gradient px-4 py-2 rounded-xl text-sm inline-flex items-center gap-2"
            >
              {busy === 'pull' && <Spinner />}
              {busy === 'pull' ? 'Pulling…' : 'Pull now'}
            </button>
          </div>
          {progress && <ProgressLine p={progress} />}
        </div>
      )}

      {info && <div className="text-sm text-saffron-300 font-light">{info}</div>}
      {error && (
        <div className="text-sm text-crimson-300 font-light bg-crimson-900/20 border border-crimson-800/30 rounded-xl p-3 break-words">
          {error}
        </div>
      )}
    </div>
  );
}

const inputClass =
  'w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] focus:border-persian-500/30';

function ProgressLine({ p }: { p: SyncProgress }) {
  const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
  const verb = p.kind === 'push' ? 'uploading' : 'downloading';
  const what = p.phase === 'snapshot'
    ? 'snapshot'
    : `media ${p.current}/${p.total}`;
  return (
    <div className="space-y-1.5">
      <div className="text-2xs text-dark-400 font-mono uppercase tracking-widest tabular-nums">
        {verb} {what}
      </div>
      <div className="h-1 rounded-full bg-dark-800/60 overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-saffron-400 to-persian-400 transition-all duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function Spinner() {
  // 14×14 SVG ring; CSS animation rotates it. Inline so no asset round-trip,
  // and so the stroke color tracks the parent button's `currentColor`.
  return (
    <svg
      className="animate-spin"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-2xs uppercase tracking-widest text-dark-400">{label}</span>
        {hint && <span className="text-2xs text-dark-500 font-light">{hint}</span>}
      </div>
      {children}
    </label>
  );
}
