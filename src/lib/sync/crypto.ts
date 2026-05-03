/**
 * End-to-end encryption for cloud sync.
 *
 * Design:
 *   - User sets a sync passphrase. We derive a 256-bit AES-GCM key with
 *     PBKDF2(SHA-256, 200_000 iterations, per-snapshot salt).
 *   - On push: serialize snapshot, encrypt, upload ciphertext + iv + the
 *     salt that produced this key. The server stores opaque ciphertext +
 *     the (non-secret) salt; never sees plaintext or the passphrase.
 *   - On pull: download ciphertext + salt, derive the same key from the
 *     user's passphrase + that salt, decrypt.
 *
 * Salt has to travel with the snapshot, NOT live per-device — that was a
 * bug in v1 of this module that made cross-device decrypt fail with
 * "wrong passphrase" even when the passphrase was correct. Salt isn't
 * secret; its job is to defeat rainbow tables, which it still does at
 * 200K PBKDF2 iterations regardless of who knows the salt.
 */

import { getSetting, setSetting } from '@/lib/db/queries';

const PBKDF2_ITER = 200_000;
const KEY_LEN = 256;
const SALT_BYTES = 16;
const IV_BYTES = 12;

/**
 * Read the locally-cached salt; create one if this device has never
 * encrypted before. The cached salt is what we'll attach to the next
 * push. Pulls overwrite this with whatever salt rode along with the
 * remote snapshot, so all devices converge on the same value.
 */
export async function getOrCreateLocalSalt(): Promise<Uint8Array> {
  const existing = await getSetting('sync_salt_b64');
  if (existing) return base64ToBytes(existing);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  await setSetting('sync_salt_b64', bytesToBase64(salt));
  return salt;
}

/** Replace the cached salt — called after a successful pull so the next
 *  push uses the same salt the rest of the fleet expects. */
export async function persistSalt(salt: Uint8Array): Promise<void> {
  await setSetting('sync_salt_b64', bytesToBase64(salt));
}

export function saltToBase64(salt: Uint8Array): string {
  return bytesToBase64(salt);
}

export function saltFromBase64(b64: string): Uint8Array {
  return base64ToBytes(b64);
}

/**
 * Derive an AES-GCM key from passphrase + salt. The salt parameter is
 * required when decrypting a remote snapshot (use the salt that came
 * with it); it's optional when encrypting a fresh push (defaults to
 * the local cached salt).
 */
export async function deriveKey(passphrase: string, salt?: Uint8Array): Promise<CryptoKey> {
  const useSalt = salt ?? await getOrCreateLocalSalt();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const ab = new ArrayBuffer(useSalt.byteLength);
  new Uint8Array(ab).set(useSalt);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: ab, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: KEY_LEN },
    false,
    ['encrypt', 'decrypt'],
  );
}

export interface EncryptedBlob {
  iv: string;          // base64
  ct: string;          // base64
  /**
   * Format version of the blob.
   *  - 1: plaintext is JSON.stringify(data) bytes, AES-GCM encrypted.
   *  - 2: plaintext is gzip(JSON.stringify(data)), AES-GCM encrypted.
   *       Cuts a 20MB JSON snapshot to ~3MB on the wire.
   * Decrypt path branches on this so existing v:1 blobs on the server
   * still decrypt cleanly until a new push migrates them.
   */
  v: 1 | 2;
}

export async function encryptJson<T>(data: T, key: CryptoKey): Promise<EncryptedBlob> {
  const json = JSON.stringify(data);
  // Always emit v:1 (uncompressed). Gzip via CompressionStream silently
  // hung pull on iPad Safari (likely <17), and the bandwidth saving
  // wasn't worth a flaky pipeline. v:2 decrypt is still implemented so
  // any previously-pushed v:2 snapshots in the wild continue to work.
  const plaintext = new TextEncoder().encode(json);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ivBuf = new ArrayBuffer(iv.byteLength);
  new Uint8Array(ivBuf).set(iv);
  const ctBuf = new ArrayBuffer(plaintext.byteLength);
  new Uint8Array(ctBuf).set(plaintext);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivBuf },
    key,
    ctBuf,
  );
  return {
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ct)),
    v: 1,
  };
}

export async function decryptJson<T>(blob: EncryptedBlob, key: CryptoKey): Promise<T> {
  const iv = base64ToBytes(blob.iv);
  const ivBuf = new ArrayBuffer(iv.byteLength);
  new Uint8Array(ivBuf).set(iv);
  const ct = base64ToBytes(blob.ct);
  const ctBuf = new ArrayBuffer(ct.byteLength);
  new Uint8Array(ctBuf).set(ct);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBuf },
    key,
    ctBuf,
  );
  if (blob.v === 2) {
    const text = await gunzipToString(new Uint8Array(plain));
    return JSON.parse(text) as T;
  }
  // Legacy v:1: plaintext is raw JSON bytes.
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/** gzip a string via the browser's CompressionStream. Available in
 *  Chrome 80+ / Safari 17+ / Firefox 113+ — covers everything we run on. */
async function gzipString(s: string): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip');
  const stream = new Blob([s]).stream().pipeThrough(cs);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function gunzipToString(bytes: Uint8Array): Promise<string> {
  const ds = new DecompressionStream('gzip');
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const stream = new Blob([ab]).stream().pipeThrough(ds);
  return new Response(stream).text();
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 32768;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
