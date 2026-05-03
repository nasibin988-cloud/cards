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

import { exportSnapshotForSync, importSnapshot, type Snapshot } from '@/lib/backup/snapshot';
import {
  encryptJson, decryptJson, deriveKey,
  getOrCreateLocalSalt, persistSalt,
  saltToBase64, saltFromBase64,
} from './crypto';
import type { SyncAdapter } from './adapter';
import { getJsonSetting, setJsonSetting } from '@/lib/db/queries';
import { db } from '@/lib/db/dexie';

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

/**
 * Push: upload missing media files to the server first, then push the
 * (small) JSON snapshot. The snapshot now carries `mediaRefs` instead of
 * inline base64 bytes, so the encrypted blob stays small even with
 * thousands of card images. The full bytes round-trip via individual
 * /api/sync/media/<id> requests, idempotent and skippable when the
 * server already has them.
 *
 * Optional progress callback fires per stage so the UI can show "uploaded
 * 47/120 media".
 */
export async function push(
  adapter: SyncAdapter,
  passphrase: string,
  onProgress?: (p: SyncProgress) => void,
): Promise<SyncStatus> {
  // Salt rides along with the encrypted blob so any device on the same
  // passphrase can re-derive the key. Use the local cached salt; future
  // pulls on the same device will keep using it (and other devices will
  // adopt it after their first pull).
  const salt = await getOrCreateLocalSalt();
  const key = await deriveKey(passphrase, salt);

  // Stage 1: media diff + upload.
  await syncMediaUpload(adapter, onProgress);

  // Stage 2: push the small snapshot.
  onProgress?.({ phase: 'snapshot', kind: 'push', current: 0, total: 1 });
  const snap = await exportSnapshotForSync();
  const blob = await encryptJson(snap, key);
  const meta = await getMeta();
  const newVersion = meta.version + 1;
  const { remoteVersion } = await adapter.push(blob, newVersion, saltToBase64(salt));
  const newMeta: LocalMeta = {
    version: newVersion,
    lastSyncedRemoteVersion: remoteVersion,
    lastSyncMs: Date.now(),
  };
  await setMeta(newMeta);
  onProgress?.({ phase: 'snapshot', kind: 'push', current: 1, total: 1 });
  return status(adapter);
}

/**
 * Pull: fetch the small snapshot, import it, then backfill media files
 * that aren't yet local. Snapshot import is fast (~MBs); media backfill
 * runs sequentially in the background so the UI is responsive.
 *
 * Cards whose media isn't yet downloaded fall through to a server-fetch
 * via getMediaUrl, so the user can study right away.
 */
export async function pull(
  adapter: SyncAdapter,
  passphrase: string,
  onProgress?: (p: SyncProgress) => void,
): Promise<SyncStatus> {
  onProgress?.({ phase: 'snapshot', kind: 'pull', current: 0, total: 1 });
  const remote = await adapter.pull();
  if (!remote) throw new Error('No remote snapshot to pull.');
  // Use the salt that came with the snapshot so the key matches what the
  // pushing device used. If the server is on the older format that didn't
  // include salt, fall back to the local salt (this device's first push
  // would have set it). Still works for single-device, fails the same
  // "wrong passphrase" way for cross-device until the source pushes new.
  const remoteSalt = remote.salt ? saltFromBase64(remote.salt) : undefined;
  const key = await deriveKey(passphrase, remoteSalt);
  let snap: Snapshot;
  try {
    snap = await decryptJson<Snapshot>(remote.blob, key);
  } catch (err) {
    throw new Error('Decryption failed. Wrong passphrase?');
  }
  // Successful decrypt — adopt the remote salt locally so subsequent
  // pushes from this device use the same one and other devices stay
  // in sync.
  if (remoteSalt) await persistSalt(remoteSalt);
  await importSnapshot(snap, 'replace');
  await setMeta({
    version: remote.remoteVersion,
    lastSyncedRemoteVersion: remote.remoteVersion,
    lastSyncMs: Date.now(),
  });
  onProgress?.({ phase: 'snapshot', kind: 'pull', current: 1, total: 1 });

  // Backfill media. Run in the background so the caller's UI is
  // responsive: we don't await this — the caller resolves as soon as
  // the data tables are populated. Cards with not-yet-downloaded media
  // lazy-load via getMediaUrl's server fallback.
  if (snap.mediaRefs && snap.mediaRefs.length) {
    void syncMediaDownload(adapter, snap.mediaRefs, onProgress);
  }

  return status(adapter);
}

export interface SyncProgress {
  phase: 'snapshot' | 'media';
  kind: 'push' | 'pull';
  current: number;
  total: number;
}

/* ─── Media transfer (one HTTP request per file) ────────────────── */

/**
 * Find local media not on the server and upload them. Skips files the
 * server already has (HEAD check). Concurrency is conservative — Safari
 * caps simultaneous fetches per origin and aggressive parallelism just
 * stalls without helping throughput.
 */
async function syncMediaUpload(
  adapter: SyncAdapter,
  onProgress?: (p: SyncProgress) => void,
): Promise<void> {
  const mediaUrl = adapterMediaIndexUrl(adapter);
  const token = adapterToken(adapter);
  if (!mediaUrl || !token) return; // Adapter doesn't support per-file media
  // Bind to locals so the worker closures don't have to re-narrow on each iteration.
  const url: string = mediaUrl;
  const tok: string = token;

  const local = await db().media.toArray();
  if (local.length === 0) return;

  const remoteList = await fetchRemoteMediaIndex(url, tok);
  const remoteIds = new Set(remoteList.map(r => r.id));
  const missing = local.filter(m => !remoteIds.has(m.id) && m.blob.size > 0);

  if (missing.length === 0) return;

  let done = 0;
  onProgress?.({ phase: 'media', kind: 'push', current: done, total: missing.length });

  const PARALLEL = 4;
  const queue = [...missing];
  async function worker() {
    while (queue.length > 0) {
      const m = queue.shift();
      if (!m) return;
      try {
        await uploadMedia(url, tok, m.id, m.filename, m.mimeType, m.blob);
      } catch { /* fail soft per-file; user can retry. */ }
      done++;
      onProgress?.({ phase: 'media', kind: 'push', current: done, total: missing.length });
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, () => worker()));
}

async function syncMediaDownload(
  adapter: SyncAdapter,
  refs: Array<{ id: string; filename: string; mimeType: string }>,
  onProgress?: (p: SyncProgress) => void,
): Promise<void> {
  const mediaUrl = adapterMediaIndexUrl(adapter);
  const token = adapterToken(adapter);
  if (!mediaUrl || !token) return;
  const url: string = mediaUrl;
  const tok: string = token;

  const local = await db().media.toArray();
  // A row exists for every ref (we put placeholders during importSnapshot);
  // fetch when the placeholder is empty.
  const placeholderIds = new Set(local.filter(m => m.blob.size === 0).map(m => m.id));
  const todo = refs.filter(r => placeholderIds.has(r.id));
  if (todo.length === 0) return;

  let done = 0;
  onProgress?.({ phase: 'media', kind: 'pull', current: done, total: todo.length });

  const PARALLEL = 4;
  const queue = [...todo];
  async function worker() {
    while (queue.length > 0) {
      const r = queue.shift();
      if (!r) return;
      try {
        const blob = await downloadMedia(url, tok, r.id);
        if (blob) {
          await db().media.update(r.id, {
            blob: new Blob([blob], { type: r.mimeType }),
          });
        }
      } catch { /* fail soft per-file. */ }
      done++;
      onProgress?.({ phase: 'media', kind: 'pull', current: done, total: todo.length });
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, () => worker()));
}

/**
 * Derive the media-index URL from the snapshot URL. The adapter doesn't
 * expose its URL directly, so we duck-type: SelfHostedAdapter has a
 * `mediaIndexUrl` getter we add below; other adapters return null and
 * the media-sync becomes a no-op.
 */
function adapterMediaIndexUrl(adapter: SyncAdapter): string | null {
  const a = adapter as unknown as { mediaIndexUrl?: () => string };
  return typeof a.mediaIndexUrl === 'function' ? a.mediaIndexUrl() : null;
}
function adapterToken(adapter: SyncAdapter): string | null {
  const a = adapter as unknown as { bearerToken?: () => string };
  return typeof a.bearerToken === 'function' ? a.bearerToken() : null;
}

/** AbortController-backed fetch timeout. Same pattern as adapter.ts —
 *  duplicated rather than exported so the sync module stays standalone. */
async function timedFetch(url: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function fetchRemoteMediaIndex(
  mediaUrl: string,
  token: string,
): Promise<Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }>> {
  const r = await timedFetch(mediaUrl, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`media index fetch failed (${r.status})`);
  const data = (await r.json()) as { items?: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }> };
  return data.items ?? [];
}

async function uploadMedia(
  mediaUrl: string,
  token: string,
  id: string,
  filename: string,
  mimeType: string,
  blob: Blob,
): Promise<void> {
  const r = await timedFetch(`${mediaUrl}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': mimeType,
      'x-mime-type': mimeType,
      'x-filename': encodeURIComponent(filename),
    },
    body: blob,
  });
  if (!r.ok) throw new Error(`upload failed for ${id} (${r.status})`);
}

async function downloadMedia(
  mediaUrl: string,
  token: string,
  id: string,
): Promise<ArrayBuffer | null> {
  const r = await timedFetch(`${mediaUrl}/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`download failed for ${id} (${r.status})`);
  return r.arrayBuffer();
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
