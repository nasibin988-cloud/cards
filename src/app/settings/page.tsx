'use client';

import { useEffect, useState } from 'react';
import { getSetting, setSetting } from '@/lib/db/queries';
import { db } from '@/lib/db/dexie';
import { DEFAULT_MODEL, MODEL_OPTIONS, testApiKey } from '@/lib/ai/claude';
import { getJsonSetting, setJsonSetting } from '@/lib/db/queries';
import dynamic from 'next/dynamic';

const BackupPanel = dynamic(() => import('@/components/backup/BackupPanel'), { ssr: false });
const SyncPanel = dynamic(() => import('@/components/sync/SyncPanel'), { ssr: false });
const WatchPanel = dynamic(() => import('@/components/watch/WatchPanel'), { ssr: false });
const NotificationsPanel = dynamic(() => import('@/components/notifications/NotificationsPanel'), { ssr: false });
const TtsPanel = dynamic(() => import('@/components/study/TtsSettings'), { ssr: false });

export default function SettingsPage() {
  const [keyDraft, setKeyDraft] = useState(''); // unmasked working value
  const [keyStored, setKeyStored] = useState(false);
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [retention, setRetention] = useState('0.90');
  const [retentionError, setRetentionError] = useState<string | null>(null);
  const [leechThreshold, setLeechThreshold] = useState('8');
  const [leechError, setLeechError] = useState<string | null>(null);
  const [siblingBuryMin, setSiblingBuryMin] = useState('5');
  const [siblingBuryError, setSiblingBuryError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [confirmNuke, setConfirmNuke] = useState(false);
  const [typeMode, setTypeMode] = useState(false);
  const [confidenceMode, setConfidenceMode] = useState(false);

  useEffect(() => {
    (async () => {
      const k = await getSetting('claude_api_key');
      const m = await getSetting('claude_model');
      const r = await getSetting('default_retention');
      const lt = await getSetting('leech_threshold');
      const sbm = await getSetting('sibling_bury_minutes');
      const tm = await getJsonSetting<boolean>('study_type_mode', false);
      const cm = await getJsonSetting<boolean>('study_confidence_mode', false);
      if (k) { setKeyDraft(k); setKeyStored(true); }
      if (m) setModel(m);
      if (r) setRetention(r);
      if (lt) setLeechThreshold(lt);
      if (sbm) setSiblingBuryMin(sbm);
      setTypeMode(tm);
      setConfidenceMode(cm);
      if ('storage' in navigator && 'estimate' in navigator.storage) {
        const e = await navigator.storage.estimate();
        setStorage({ usage: e.usage ?? 0, quota: e.quota ?? 0 });
      }
    })();
  }, []);

  const saveTypeMode = async (v: boolean) => {
    setTypeMode(v);
    await setJsonSetting('study_type_mode', v);
  };

  const saveConfidenceMode = async (v: boolean) => {
    setConfidenceMode(v);
    await setJsonSetting('study_confidence_mode', v);
  };

  const saveKey = async () => {
    if (!keyDraft.trim()) return;
    await setSetting('claude_api_key', keyDraft.trim());
    setKeyStored(true);
    setTestResult(null);
  };

  const clearKey = async () => {
    await db().settings.delete('claude_api_key');
    setKeyStored(false);
    setKeyDraft('');
    setTestResult(null);
  };

  const editKey = () => {
    // Switch back to edit mode without losing the stored value until save is hit.
    setKeyStored(false);
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    const k = await getSetting('claude_api_key');
    if (!k) { setTesting(false); setTestResult({ ok: false, msg: 'No key saved.' }); return; }
    const r = await testApiKey(k, model);
    setTesting(false);
    setTestResult(r.ok ? { ok: true, msg: 'Key works.' } : { ok: false, msg: r.error });
  };

  const saveModel = async (m: string) => {
    setModel(m);
    await setSetting('claude_model', m);
  };

  const saveRetention = async (r: string) => {
    setRetention(r);
    const num = parseFloat(r);
    if (Number.isNaN(num) || num <= 0 || num >= 1) {
      setRetentionError('Must be between 0 and 1 (e.g. 0.90).');
      return;
    }
    setRetentionError(null);
    await setSetting('default_retention', String(num));
  };

  const saveLeechThreshold = async (v: string) => {
    setLeechThreshold(v);
    const num = parseInt(v, 10);
    if (!Number.isFinite(num) || num < 2 || num > 50) {
      setLeechError('Must be a whole number between 2 and 50.');
      return;
    }
    setLeechError(null);
    await setSetting('leech_threshold', String(num));
  };

  const saveSiblingBury = async (v: string) => {
    setSiblingBuryMin(v);
    const num = parseFloat(v);
    if (!Number.isFinite(num) || num < 0 || num > 60) {
      setSiblingBuryError('Must be a number between 0 and 60 (0 disables).');
      return;
    }
    setSiblingBuryError(null);
    await setSetting('sibling_bury_minutes', String(num));
  };

  const nuke = async () => {
    await db().delete();
    location.reload();
  };

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <h1 className="text-4xl font-extralight tracking-tight mb-8">Settings</h1>

      <Section title="Claude API" subtitle="Stored locally in IndexedDB. Single-user device assumed.">
        <label className="block">
          <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">API key</div>
          <div className="flex gap-2">
            <input
              type={keyStored ? 'text' : 'password'}
              value={keyStored ? maskKey(keyDraft) : keyDraft}
              onChange={e => { setKeyDraft(e.target.value); setKeyStored(false); setTestResult(null); }}
              placeholder="sk-ant-…"
              readOnly={keyStored}
              className="flex-1 bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] font-mono read-only:cursor-default"
            />
            {!keyStored ? (
              <button onClick={saveKey} disabled={!keyDraft.trim()} className="btn-gradient px-4 py-2 rounded-xl text-sm">Save</button>
            ) : (
              <>
                <button onClick={editKey} className="px-4 py-2 rounded-xl text-sm text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition border border-white/[0.06]">
                  Edit
                </button>
                <button onClick={clearKey} className="px-4 py-2 rounded-xl text-sm text-crimson-300 hover:bg-crimson-900/20 transition border border-crimson-800/30">
                  Remove
                </button>
              </>
            )}
            <button onClick={test} disabled={!keyStored || testing} className="px-4 py-2 rounded-xl text-sm text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition border border-white/[0.06]">
              {testing ? 'Testing…' : 'Test'}
            </button>
          </div>
        </label>
        {testResult && (
          <div className={testResult.ok ? 'mt-2 text-sm text-saffron-300' : 'mt-2 text-sm text-crimson-300'}>
            {testResult.msg}
          </div>
        )}

        <label className="block mt-5">
          <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">Model</div>
          <select
            value={model}
            onChange={e => saveModel(e.target.value)}
            className="w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] cursor-pointer"
          >
            {MODEL_OPTIONS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
      </Section>

      <Section title="Study mode" subtitle="How you grade yourself.">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={typeMode}
            onChange={e => saveTypeMode(e.target.checked)}
            className="mt-1 accent-saffron-400"
          />
          <div>
            <div className="text-sm text-dark-100 font-light">Type-answer mode</div>
            <div className="text-xs text-dark-400 font-light mt-0.5">
              Type your answer first; Claude grades it and suggests a rating which you can accept or override. Removes self-rating bias on knowledge you think you have.
            </div>
          </div>
        </label>
        <label className="flex items-start gap-3 cursor-pointer mt-4">
          <input
            type="checkbox"
            checked={confidenceMode}
            onChange={e => saveConfidenceMode(e.target.checked)}
            className="mt-1 accent-saffron-400"
          />
          <div>
            <div className="text-sm text-dark-100 font-light">Confidence mode (binary rating)</div>
            <div className="text-xs text-dark-400 font-light mt-0.5">
              Replace the four buttons with two: <span className="text-dark-200">Knew it</span> / <span className="text-dark-200">Didn&rsquo;t</span>. Maps to FSRS Good (3) / Again (1). Faster, less decision fatigue on long sessions.
            </div>
          </div>
        </label>
      </Section>

      <Section title="Read aloud (TTS)" subtitle="Browser-native speech synthesis. Free, offline, no API key.">
        <TtsPanel />
      </Section>

      <Section title="Scheduling" subtitle="FSRS-5 defaults applied to new decks.">
        <label className="block">
          <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">Default desired retention (0.0–1.0)</div>
          <input
            value={retention}
            onChange={e => saveRetention(e.target.value)}
            className="w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] font-mono"
          />
          {retentionError ? (
            <div className="text-2xs text-crimson-300 mt-1.5 font-light">{retentionError}</div>
          ) : (
            <div className="text-2xs text-dark-500 mt-1.5 font-light">
              Higher = more reviews, longer schedules pulled in. 0.90 is the FSRS-5 default.
            </div>
          )}
        </label>

        <label className="block mt-5">
          <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">Leech threshold (lapses)</div>
          <input
            value={leechThreshold}
            onChange={e => saveLeechThreshold(e.target.value)}
            className="w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] font-mono"
          />
          {leechError ? (
            <div className="text-2xs text-crimson-300 mt-1.5 font-light">{leechError}</div>
          ) : (
            <div className="text-2xs text-dark-500 mt-1.5 font-light">
              When a card&rsquo;s lapses cross this number, it&rsquo;s auto-flagged as broken so you see it in the Trouble lane.
            </div>
          )}
        </label>

        <label className="block mt-5">
          <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">Sibling bury delay (minutes)</div>
          <input
            value={siblingBuryMin}
            onChange={e => saveSiblingBury(e.target.value)}
            className="w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] font-mono"
          />
          {siblingBuryError ? (
            <div className="text-2xs text-crimson-300 mt-1.5 font-light">{siblingBuryError}</div>
          ) : (
            <div className="text-2xs text-dark-500 mt-1.5 font-light">
              After you rate a card, sibling cards on the same note (e.g. c2, c3 on a cloze) hide for this many minutes so they don&rsquo;t appear back-to-back. 5 is the default. 0 disables sibling burying entirely.
            </div>
          )}
        </label>
      </Section>

      <Section title="Backups & export" subtitle="Daily local backup + manual export to JSON or .apkg.">
        <BackupPanel />
      </Section>

      <Section title="Sync (cloud)" subtitle="End-to-end encrypted multi-device sync via your own Supabase.">
        <SyncPanel />
      </Section>

      <Section title="Folder watch" subtitle="Sync .md card-block files from any directory on disk; rescans diff and upsert.">
        <WatchPanel />
      </Section>

      <Section title="Daily summary notifications" subtitle="Browser-native; fires on app open after a 12-hour gap.">
        <NotificationsPanel />
      </Section>

      <Section title="Storage" subtitle="Local IndexedDB; persistence requested on first launch.">
        {storage ? (
          <div className="text-sm text-dark-200 font-light">
            Using {formatBytes(storage.usage)} of {formatBytes(storage.quota)} available
            {storage.quota > 0 && (
              <span className="text-dark-500 font-mono"> ({((storage.usage / storage.quota) * 100).toFixed(2)}%)</span>
            )}
          </div>
        ) : (
          <div className="text-sm text-dark-500">Estimate not available.</div>
        )}
      </Section>

      <Section title="Danger zone" subtitle="Irreversible.">
        {!confirmNuke ? (
          <button
            onClick={() => setConfirmNuke(true)}
            className="text-sm text-crimson-300 hover:text-crimson-200 transition"
          >
            Delete all data
          </button>
        ) : (
          <div className="flex items-center gap-3">
            <span className="text-sm text-dark-200">Permanently delete every deck, note, card, and review log?</span>
            <button onClick={nuke} className="px-4 py-1.5 rounded-lg text-sm bg-crimson-900/40 text-crimson-200 hover:bg-crimson-800/50 transition">
              Yes, wipe
            </button>
            <button onClick={() => setConfirmNuke(false)} className="px-4 py-1.5 rounded-lg text-sm text-dark-300 hover:text-dark-100 transition">
              Cancel
            </button>
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="glass-card rounded-2xl p-6 mb-5">
      <div className="mb-4">
        <h2 className="text-lg font-light tracking-tight text-dark-100">{title}</h2>
        {subtitle && <p className="text-xs text-dark-400 font-light mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function maskKey(k: string): string {
  if (k.length <= 12) return k;
  return `${k.slice(0, 7)}…${k.slice(-4)}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
