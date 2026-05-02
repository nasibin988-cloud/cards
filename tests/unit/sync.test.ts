/**
 * @vitest-environment jsdom
 *
 * Tests for the encryption pipeline using the LoopbackAdapter so we exercise
 * the full push/pull cycle without a network. We rely on the SubtleCrypto
 * implementation provided by Node 20+ via the WebCrypto API.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LoopbackAdapter } from '@/lib/sync/adapter';
import { push, pull, status, verifyPassphrase } from '@/lib/sync/sync';
import { encryptJson, decryptJson, deriveKey } from '@/lib/sync/crypto';
import { db } from '@/lib/db/dexie';
import { createDeck, createNote } from '@/lib/db/queries';

beforeEach(async () => {
  const dbi = db();
  await dbi.transaction(
    'rw',
    [dbi.notes, dbi.cards, dbi.decks, dbi.reviewLogs, dbi.media, dbi.settings],
    async () => {
      await Promise.all([
        dbi.notes.clear(), dbi.cards.clear(), dbi.decks.clear(),
        dbi.reviewLogs.clear(), dbi.media.clear(), dbi.settings.clear(),
      ]);
    },
  );
  localStorage.clear();
});

describe('crypto pipeline', () => {
  it('roundtrips an arbitrary JSON object', async () => {
    const key = await deriveKey('test-passphrase');
    const blob = await encryptJson({ a: 1, b: 'two', c: [3, 4] }, key);
    expect(blob.iv).toBeTruthy();
    expect(blob.ct).toBeTruthy();
    const back = await decryptJson<{ a: number; b: string; c: number[] }>(blob, key);
    expect(back).toEqual({ a: 1, b: 'two', c: [3, 4] });
  });

  it('refuses to decrypt with the wrong passphrase', async () => {
    const k1 = await deriveKey('correct');
    const k2 = await deriveKey('wrong');
    const blob = await encryptJson({ secret: 'hello' }, k1);
    await expect(decryptJson(blob, k2)).rejects.toThrow();
  });

  it('verifyPassphrase returns true for any string (only checks key derivation works)', async () => {
    expect(await verifyPassphrase('anything')).toBe(true);
  });
});

describe('end-to-end sync via LoopbackAdapter', () => {
  it('push then pull restores the snapshot', async () => {
    const a = await createDeck({ name: 'A' });
    await createNote({ deckId: a.id, fields: { front: 'q1', back: 'a1' } });
    await createNote({ deckId: a.id, fields: { front: 'q2', back: 'a2' } });

    const adapter = new LoopbackAdapter();
    const after = await push(adapter, 'pass-123');
    expect(after.state).toBe('in-sync');
    expect(after.localVersion).toBeGreaterThan(0);
    expect(after.remoteVersion).toBe(after.localVersion);

    // Wipe local and pull.
    const dbi = db();
    await dbi.notes.clear();
    await dbi.cards.clear();
    await dbi.decks.clear();
    expect(await dbi.notes.count()).toBe(0);

    const pulled = await pull(adapter, 'pass-123');
    expect(pulled.state).toBe('in-sync');
    expect(await dbi.notes.count()).toBe(2);
    expect(await dbi.decks.count()).toBe(1);
  });

  it('rejects pull with the wrong passphrase', async () => {
    const a = await createDeck({ name: 'A' });
    await createNote({ deckId: a.id, fields: { front: 'q', back: '' } });

    const adapter = new LoopbackAdapter();
    await push(adapter, 'right');
    await expect(pull(adapter, 'wrong')).rejects.toThrow(/Decryption failed/i);
  });

  it('reports "untouched" when no remote exists', async () => {
    const adapter = new LoopbackAdapter();
    const s = await status(adapter);
    expect(s.state).toBe('untouched');
    expect(s.remoteVersion).toBeNull();
  });

  it('reports "in-sync" right after a push', async () => {
    const adapter = new LoopbackAdapter();
    await createDeck({ name: 'A' });
    await push(adapter, 'pass');
    const s = await status(adapter);
    expect(s.state).toBe('in-sync');
  });
});
