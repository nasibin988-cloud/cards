import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '@/lib/db/dexie';
import {
  createDeck,
  getEffectiveDeckSettings,
  updateDeck,
} from '@/lib/db/queries';

beforeEach(async () => {
  const dbi = db();
  await dbi.transaction(
    'rw',
    [dbi.notes, dbi.cards, dbi.decks, dbi.reviewLogs, dbi.media, dbi.settings, dbi.searchTokens],
    async () => {
      await Promise.all([
        dbi.notes.clear(),
        dbi.cards.clear(),
        dbi.decks.clear(),
        dbi.reviewLogs.clear(),
        dbi.media.clear(),
        dbi.settings.clear(),
        dbi.searchTokens.clear(),
      ]);
    },
  );
});

describe('getEffectiveDeckSettings — inheritance chain', () => {
  it('a leaf with no overrides falls back to module defaults', async () => {
    const d = await createDeck({ name: 'Solo' });
    const eff = await getEffectiveDeckSettings(d.id);
    expect(eff.desiredRetention.isDefault).toBe(true);
    expect(eff.desiredRetention.isOwn).toBe(false);
    expect(eff.desiredRetention.value).toBeCloseTo(0.9);
    expect(eff.desiredRetention.sourceId).toBeNull();
  });

  it('a deck with own value reports isOwn and not isDefault', async () => {
    const d = await createDeck({ name: 'Solo' });
    await updateDeck(d.id, { desiredRetention: 0.85 });
    const eff = await getEffectiveDeckSettings(d.id);
    expect(eff.desiredRetention.value).toBe(0.85);
    expect(eff.desiredRetention.isOwn).toBe(true);
    expect(eff.desiredRetention.sourceId).toBe(d.id);
  });

  it('a leaf inherits from a name-prefix ancestor when own is unset', async () => {
    const parent = await createDeck({ name: 'MCAT' });
    await updateDeck(parent.id, { desiredRetention: 0.85, newCardsPerDay: 50 });
    const leaf = await createDeck({ name: 'MCAT::Biology::Ch01' });

    const eff = await getEffectiveDeckSettings(leaf.id);
    expect(eff.desiredRetention.value).toBe(0.85);
    expect(eff.desiredRetention.isOwn).toBe(false);
    expect(eff.desiredRetention.isDefault).toBe(false);
    expect(eff.desiredRetention.sourceId).toBe(parent.id);
    expect(eff.desiredRetention.sourceName).toBe('MCAT');

    expect(eff.newCardsPerDay.value).toBe(50);
    expect(eff.newCardsPerDay.sourceId).toBe(parent.id);
  });

  it('a leaf overrides a name-prefix ancestor', async () => {
    const parent = await createDeck({ name: 'MCAT' });
    await updateDeck(parent.id, { desiredRetention: 0.85 });
    const leaf = await createDeck({ name: 'MCAT::Biology::Ch01' });
    await updateDeck(leaf.id, { desiredRetention: 0.95 });

    const eff = await getEffectiveDeckSettings(leaf.id);
    expect(eff.desiredRetention.value).toBe(0.95);
    expect(eff.desiredRetention.isOwn).toBe(true);
    expect(eff.desiredRetention.sourceId).toBe(leaf.id);
  });

  it('intermediate ancestor wins over deeper ancestor', async () => {
    const root = await createDeck({ name: 'MCAT' });
    const mid = await createDeck({ name: 'MCAT::Biology' });
    const leaf = await createDeck({ name: 'MCAT::Biology::Ch01' });
    await updateDeck(root.id, { desiredRetention: 0.85 });
    await updateDeck(mid.id, { desiredRetention: 0.92 });

    const eff = await getEffectiveDeckSettings(leaf.id);
    expect(eff.desiredRetention.value).toBe(0.92);
    expect(eff.desiredRetention.sourceId).toBe(mid.id);
  });

  it('explicit parentId is followed when it points at a deck', async () => {
    const parent = await createDeck({ name: 'A' });
    await updateDeck(parent.id, { newCardsPerDay: 7 });
    const child = await createDeck({ name: 'B' });
    await db().decks.update(child.id, { parentId: parent.id });

    const eff = await getEffectiveDeckSettings(child.id);
    expect(eff.newCardsPerDay.value).toBe(7);
    expect(eff.newCardsPerDay.sourceId).toBe(parent.id);
  });

  it('different fields can come from different sources in the same chain', async () => {
    const root = await createDeck({ name: 'X' });
    await updateDeck(root.id, { desiredRetention: 0.85 });
    const mid = await createDeck({ name: 'X::Y' });
    await updateDeck(mid.id, { newCardsPerDay: 30 });
    const leaf = await createDeck({ name: 'X::Y::Z' });

    const eff = await getEffectiveDeckSettings(leaf.id);
    expect(eff.desiredRetention.sourceName).toBe('X');
    expect(eff.newCardsPerDay.sourceName).toBe('X::Y');
    expect(eff.maxInterval.isDefault).toBe(true); // nobody set it
  });

  it('handles a missing leaf gracefully', async () => {
    const eff = await getEffectiveDeckSettings('not-a-real-id');
    expect(eff.desiredRetention.isDefault).toBe(true);
    expect(eff.ancestors).toEqual([]);
  });

  it('handles a parentId cycle without infinite-looping', async () => {
    // Build a cycle by hand: A -> B -> A.
    const a = await createDeck({ name: 'A' });
    const b = await createDeck({ name: 'B' });
    await db().decks.update(a.id, { parentId: b.id });
    await db().decks.update(b.id, { parentId: a.id });
    await updateDeck(a.id, { desiredRetention: 0.7 });

    // From B's perspective, A is the immediate parent. Walking from B → A → B
    // would loop; the helper bails on cycles.
    const eff = await getEffectiveDeckSettings(b.id);
    expect(eff.desiredRetention.value).toBe(0.7);
    expect(eff.desiredRetention.sourceId).toBe(a.id);
  });
});
