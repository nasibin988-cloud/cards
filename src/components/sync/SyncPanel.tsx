'use client';

import { useEffect, useState } from 'react';
import { getSetting, setSetting, getJsonSetting, setJsonSetting } from '@/lib/db/queries';
import { db } from '@/lib/db/dexie';
import {
  SupabaseAdapter,
  LoopbackAdapter,
  type SyncAdapter,
  SUPABASE_SETUP_SQL,
} from '@/lib/sync/adapter';
import { push, pull, status, verifyPassphrase, type SyncStatus } from '@/lib/sync/sync';

interface Config {
  url: string;
  anonKey: string;
  email: string;
  password: string;
}
const ZERO_CONFIG: Config = { url: '', anonKey: '', email: '', password: '' };

export default function SyncPanel() {
  const [cfg, setCfg] = useState<Config>(ZERO_CONFIG);
  const [cfgStored, setCfgStored] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [passVerified, setPassVerified] = useState(false);
  const [status_, setStatus_] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);
  const [useLoopback, setUseLoopback] = useState(false);

  useEffect(() => {
    (async () => {
      const stored = await getJsonSetting<Config | null>('sync_config', null);
      if (stored) { setCfg(stored); setCfgStored(true); }
      const lb = await getJsonSetting<boolean>('sync_loopback', false);
      setUseLoopback(lb);
    })();
  }, []);

  const adapter: SyncAdapter | null = (() => {
    if (useLoopback) return new LoopbackAdapter();
    if (!cfg.url || !cfg.anonKey || !cfg.email || !cfg.password) return null;
    return new SupabaseAdapter(cfg);
  })();

  const saveCfg = async () => {
    await setJsonSetting('sync_config', cfg);
    setCfgStored(true);
    setInfo('Sync configuration saved.');
  };

  const clearCfg = async () => {
    await db().settings.delete('sync_config');
    setCfg(ZERO_CONFIG);
    setCfgStored(false);
    setStatus_(null);
  };

  const toggleLoopback = async (v: boolean) => {
    setUseLoopback(v);
    await setJsonSetting('sync_loopback', v);
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
    setBusy('push'); setError(null); setInfo(null);
    try {
      const s = await push(adapter, passphrase);
      setStatus_(s);
      setInfo('Pushed.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doPull = async () => {
    if (!adapter || !passphrase) return;
    if (!confirm('Pull will OVERWRITE local data. Continue?')) return;
    setBusy('pull'); setError(null); setInfo(null);
    try {
      const s = await pull(adapter, passphrase);
      setStatus_(s);
      setInfo('Pulled.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="text-xs text-dark-400 font-light leading-relaxed">
        End-to-end encrypted: your Supabase server stores only ciphertext. The encryption passphrase never leaves this device. <button onClick={() => setShowSql(s => !s)} className="text-saffron-300 hover:underline">See setup SQL</button>.
      </div>
      {showSql && (
        <pre className="text-2xs text-dark-300 font-mono bg-dark-800/40 rounded-xl p-3 overflow-x-auto whitespace-pre-wrap">{SUPABASE_SETUP_SQL}</pre>
      )}

      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={useLoopback}
          onChange={e => toggleLoopback(e.target.checked)}
          className="mt-1 accent-saffron-400"
        />
        <div>
          <div className="text-sm text-dark-100 font-light">Loopback mode (test without a backend)</div>
          <div className="text-2xs text-dark-400 font-light mt-0.5">
            Stores the encrypted snapshot in this device's localStorage. Useful for verifying the encryption pipeline before pointing at Supabase.
          </div>
        </div>
      </label>

      {!useLoopback && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Supabase URL">
            <input
              value={cfg.url}
              onChange={e => { setCfg({ ...cfg, url: e.target.value }); setCfgStored(false); }}
              placeholder="https://xxx.supabase.co"
              className={inputClass}
            />
          </Field>
          <Field label="Anon (public) key">
            <input
              value={cfg.anonKey}
              onChange={e => { setCfg({ ...cfg, anonKey: e.target.value }); setCfgStored(false); }}
              placeholder="eyJhbGciOi…"
              className={inputClass}
            />
          </Field>
          <Field label="Sync account email">
            <input
              value={cfg.email}
              onChange={e => { setCfg({ ...cfg, email: e.target.value }); setCfgStored(false); }}
              placeholder="you@example.com"
              className={inputClass}
            />
          </Field>
          <Field label="Sync account password">
            <input
              type="password"
              value={cfg.password}
              onChange={e => { setCfg({ ...cfg, password: e.target.value }); setCfgStored(false); }}
              className={inputClass}
            />
          </Field>
          <div className="col-span-2 flex items-center gap-2">
            {!cfgStored ? (
              <button onClick={saveCfg} disabled={!cfg.url || !cfg.anonKey || !cfg.email || !cfg.password} className="btn-gradient px-4 py-2 rounded-xl text-sm">
                Save config
              </button>
            ) : (
              <button onClick={clearCfg} className="px-4 py-2 rounded-xl text-sm text-crimson-300 hover:bg-crimson-900/20 transition border border-crimson-800/30">
                Clear config
              </button>
            )}
          </div>
        </div>
      )}

      <div className="border-t border-white/[0.04] pt-4">
        <Field label="Encryption passphrase" hint="Distinct from the account password. Lose this and the snapshot is unrecoverable.">
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

      {(adapter || useLoopback) && (
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
              className="btn-gradient px-4 py-2 rounded-xl text-sm"
            >
              {busy === 'push' ? 'Pushing…' : 'Push'}
            </button>
            <button
              onClick={doPull}
              disabled={busy !== null || !passphrase || !status_?.remoteVersion}
              className="px-4 py-2 rounded-xl text-sm text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition border border-white/[0.06]"
            >
              {busy === 'pull' ? 'Pulling…' : 'Pull'}
            </button>
          </div>
        </div>
      )}

      {info && <div className="text-sm text-saffron-300 font-light">{info}</div>}
      {error && <div className="text-sm text-crimson-300 font-light">{error}</div>}
    </div>
  );
}

const inputClass =
  'w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] focus:border-persian-500/30';

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
