/**
 * End-to-end encryption for cloud sync.
 *
 * Design:
 *   - User sets a sync passphrase. We derive a 256-bit AES-GCM key with
 *     PBKDF2(SHA-256, 200_000 iterations, per-device salt persisted in IDB).
 *   - On push: serialize snapshot, encrypt, upload ciphertext + iv to Supabase.
 *     The server stores `bytea` blobs; never sees plaintext or the passphrase.
 *   - On pull: download ciphertext, decrypt with the same passphrase.
 *
 * The salt is per-device on purpose — losing the device means re-deriving the
 * key on the next device with a fresh salt. The passphrase itself is what
 * matters; rotating salt is a layered defense, not the load-bearing secret.
 */

import { getSetting, setSetting } from '@/lib/db/queries';

const PBKDF2_ITER = 200_000;
const KEY_LEN = 256;
const SALT_BYTES = 16;
const IV_BYTES = 12;

async function getOrCreateSalt(): Promise<Uint8Array> {
  const existing = await getSetting('sync_salt_b64');
  if (existing) return base64ToBytes(existing);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  await setSetting('sync_salt_b64', bytesToBase64(salt));
  return salt;
}

export async function deriveKey(passphrase: string): Promise<CryptoKey> {
  const salt = await getOrCreateSalt();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const ab = new ArrayBuffer(salt.byteLength);
  new Uint8Array(ab).set(salt);
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
  v: 1;                // version
}

export async function encryptJson<T>(data: T, key: CryptoKey): Promise<EncryptedBlob> {
  const json = JSON.stringify(data);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ivBuf = new ArrayBuffer(iv.byteLength);
  new Uint8Array(ivBuf).set(iv);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivBuf },
    key,
    new TextEncoder().encode(json),
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
  return JSON.parse(new TextDecoder().decode(plain)) as T;
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
