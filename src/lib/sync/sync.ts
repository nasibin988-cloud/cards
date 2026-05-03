/**
 * High-level sync orchestration.
 *
 * State machine:
 *   - "untouched": no remote, no local version → pushing creates baseline.
 *   - "in-sync": local version === remote version → no-op pull/push.
 *   - "ahead": local version > remote version → pushing wins.
 *   - "behind": local version < remote version → pulling overwrites local.
 *   - "diverged": both sides have advanced past the last common ancestor.
 *     We surface this to the user with explicit "Push (overwrite remote)" or
 *     "Pull (overwrite local)" choices. No silent merges; preserves audit
 *     trail of which side won.
 *
 * Snapshots use the same `Snapshot` shape as the local backup so the export/
 * restore code path is shared.
 */

import { exportSnapshot, importSnapshot, type Snapshot } from '@/lib/backup/snapshot';
import { encryptJson, decryptJson, deriveKey, type EncryptedBlob } from './crypto';
import type { SyncAdapter, RemoteSnapshot } from './adapter';
import { getJsonSetting, setJsonSetting } from '@/lib/db/queries';

export type SyncState = 'untouched' | 'in-sync' | 'ahead' | 'behind' | 'diverged';

export interface SyncStatus {
  state: SyncState;
  localVersion: number;
  remoteVersion: number | null;
  lastSyncMs: number | null;
  remoteUpdatedAt: number | null;
}

interface LocalMeta {
  version: number;
  lastSyncedRemoteVersion: number;
  lastSyncMs: number;
}

const ZERO_META: LocalMeta = { version: 0, lastSyncedRemoteVersion: 0, lastSyncMs: 0 };

async function getMeta(): Promise<LocalMeta> {
  return getJsonSetting<LocalMeta>('sync_meta', ZERO_META);
}
async function setMeta(m: LocalMeta) {
  await setJsonSetting('sync_meta', m);
}

/** Bumped on every meaningful change; used to detect "ahead". */
export async function bumpLocalVersion() {
  const m = await getMeta();
  await setMeta({ ...m, version: m.version + 1 });
}

export async function status(adapter: SyncAdapter): Promise<SyncStatus> {
  const meta = await getMeta();
  // Prefer the cheap metadata endpoint when the adapter has it. Falls back
  // to a full pull for adapters without that capability (Loopback, legacy
  // Supabase) — fine for small data, painful at 100MB+. SelfHostedAdapter
  // implements pullMetadata, so the production path stays fast.
  let remoteVersion: number | null = null;
  let remoteUpdatedAt: number | null = null;
  if (adapter.pullMetadata) {
    const m = await adapter.pullMetadata();
    if (m) { remoteVersion = m.remoteVersion; remoteUpdatedAt = m.updatedAt; }
  } else {
    const r = await adapter.pull();
    if (r) { remoteVersion = r.remoteVersion; remoteUpdatedAt = r.updatedAt; }
  }
  if (remoteVersion === null) {
    return {
      state: 'untouched',
      localVersion: meta.version,
      remoteVersion: null,
      lastSyncMs: meta.lastSyncMs || null,
      remoteUpdatedAt: null,
    };
  }
  let state: SyncState;
  if (meta.version === meta.lastSyncedRemoteVersion && remoteVersion === meta.lastSyncedRemoteVersion) {
    state = 'in-sync';
  } else if (meta.version > meta.lastSyncedRemoteVersion && remoteVersion === meta.lastSyncedRemoteVersion) {
    state = 'ahead';
  } else if (meta.version === meta.lastSyncedRemoteVersion && remoteVersion > meta.lastSyncedRemoteVersion) {
    state = 'behind';
  } else {
    state = 'diverged';
  }
  return {
    state,
    localVersion: meta.version,
    remoteVersion,
    lastSyncMs: meta.lastSyncMs || null,
    remoteUpdatedAt,
  };
}

/** Force-push local snapshot to remote (overwrites whatever's there). */
export async function push(adapter: SyncAdapter, passphrase: string): Promise<SyncStatus> {
  const key = await deriveKey(passphrase);
  const snap = await exportSnapshot();
  const blob = await encryptJson(snap, key);
  const meta = await getMeta();
  const newVersion = meta.version + 1;
  const { remoteVersion } = await adapter.push(blob, newVersion);
  const newMeta: LocalMeta = {
    version: newVersion,
    lastSyncedRemoteVersion: remoteVersion,
    lastSyncMs: Date.now(),
  };
  await setMeta(newMeta);
  return status(adapter);
}

/** Force-pull from remote (overwrites local). */
export async function pull(adapter: SyncAdapter, passphrase: string): Promise<SyncStatus> {
  const remote = await adapter.pull();
  if (!remote) throw new Error('No remote snapshot to pull.');
  const key = await deriveKey(passphrase);
  let snap: Snapshot;
  try {
    snap = await decryptJson<Snapshot>(remote.blob, key);
  } catch (err) {
    throw new Error('Decryption failed. Wrong passphrase?');
  }
  await importSnapshot(snap, 'replace');
  await setMeta({
    version: remote.remoteVersion,
    lastSyncedRemoteVersion: remote.remoteVersion,
    lastSyncMs: Date.now(),
  });
  return status(adapter);
}

/** Self-test: encrypt + decrypt a tiny payload to verify the key works. */
export async function verifyPassphrase(passphrase: string): Promise<boolean> {
  try {
    const key = await deriveKey(passphrase);
    const round = await decryptJson<{ ok: true }>(
      await encryptJson({ ok: true }, key),
      key,
    );
    return round.ok === true;
  } catch {
    return false;
  }
}
