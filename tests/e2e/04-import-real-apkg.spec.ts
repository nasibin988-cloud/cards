import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const FIXTURES = path.resolve(__dirname, '../fixtures');

async function wipe(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    for (const d of databases) {
      if (d.name) await new Promise<void>((resolve, reject) => { const req = indexedDB.deleteDatabase(d.name!); req.onsuccess = () => resolve(); req.onerror = () => reject(req.error); req.onblocked = () => resolve(); });
    }
  });
  await page.goto('/');
}

test.describe('.apkg import (real fixtures)', () => {
  test('imports a v3 (Anki 23.10+, zstd) .apkg via the new schema path', async ({ page }) => {
    test.setTimeout(120_000);
    const fixture = path.join(FIXTURES, 'synthetic-v3.apkg');
    test.skip(!fs.existsSync(fixture), 'synthetic v3 fixture not built; run scripts/build-zstd-fixture.mjs');

    await wipe(page);
    await page.goto('/import');
    await page.locator('input[type="file"]').setInputFiles(fixture);

    // The progress message should mention zstd decompression at some point.
    await expect(page.getByText(/^Imported\.$/)).toBeVisible({ timeout: 60_000 });

    const counts = await page.evaluate(async () => {
      const req = indexedDB.open('cards-v1');
      return new Promise<{ notes: number; cards: number }>((resolve, reject) => {
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['notes', 'cards'], 'readonly');
          const out: any = { notes: 0, cards: 0 };
          tx.objectStore('notes').count().onsuccess = (e: any) => { out.notes = e.target.result; };
          tx.objectStore('cards').count().onsuccess = (e: any) => { out.cards = e.target.result; };
          tx.oncomplete = () => resolve(out);
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });
    });
    expect(counts.notes).toBeGreaterThan(0);
    expect(counts.cards).toBeGreaterThan(0);
  });


  test('imports a small Anki deck (zoroastrian, ~684KB)', async ({ page }) => {
    test.setTimeout(180_000);
    const fixture = path.join(FIXTURES, 'zoroastrian.apkg');
    test.skip(!fs.existsSync(fixture), 'fixture not present');

    await wipe(page);
    await page.goto('/import');
    await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible();

    const input = page.locator('input[type="file"]');
    await input.setInputFiles(fixture);

    // Wait for the success card.
    await expect(page.getByText(/^Imported\.$/)).toBeVisible({ timeout: 120_000 });

    const summary = await page.evaluate(async () => {
      const req = indexedDB.open('cards-v1');
      return new Promise<{ decks: number; notes: number; cards: number; media: number; sampleNote: any }>(
        (resolve, reject) => {
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction(['decks', 'notes', 'cards', 'media'], 'readonly');
            const counts: any = { decks: 0, notes: 0, cards: 0, media: 0, sampleNote: null };
            tx.objectStore('decks').count().onsuccess = (e: any) => { counts.decks = e.target.result; };
            tx.objectStore('notes').count().onsuccess = (e: any) => { counts.notes = e.target.result; };
            tx.objectStore('cards').count().onsuccess = (e: any) => { counts.cards = e.target.result; };
            tx.objectStore('media').count().onsuccess = (e: any) => { counts.media = e.target.result; };
            tx.objectStore('notes').openCursor().onsuccess = (e: any) => {
              const cursor = e.target.result;
              if (cursor && !counts.sampleNote) counts.sampleNote = cursor.value;
            };
            tx.oncomplete = () => resolve(counts);
            tx.onerror = () => reject(tx.error);
          };
          req.onerror = () => reject(req.error);
        },
      );
    });

    expect(summary.decks).toBeGreaterThan(0);
    expect(summary.notes).toBeGreaterThan(0);
    expect(summary.cards).toBeGreaterThanOrEqual(summary.notes); // at least one card per note
    expect(summary.sampleNote).not.toBeNull();
    expect(summary.sampleNote.fields.front).toBeTruthy();
    expect(['basic', 'cloze']).toContain(summary.sampleNote.modelId);

    // Home now lists at least one deck.
    await page.goto('/');
    await expect(page.locator('a[href^="/deck/"]').first()).toBeVisible();
    // Deck row shows either count chips (digits) or "caught up". Either works.
    await expect(page.getByText(/^\d+$|caught up|empty/i).first()).toBeVisible();
  });

  test('imports MCAT V5 Core (~1.8MB, ~5000 cards) and study works', async ({ page }) => {
    test.setTimeout(180_000);
    const fixture = path.join(FIXTURES, 'mcat-v5-core.apkg');
    test.skip(!fs.existsSync(fixture), 'fixture not present');

    await wipe(page);
    await page.goto('/import');
    const input = page.locator('input[type="file"]');
    await input.setInputFiles(fixture);

    await expect(page.getByText(/^Imported\.$/)).toBeVisible({ timeout: 120_000 });

    const counts = await page.evaluate(async () => {
      const req = indexedDB.open('cards-v1');
      return new Promise<{ notes: number; cards: number; clozeCards: number; basicCards: number }>(
        (resolve, reject) => {
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction(['notes', 'cards'], 'readonly');
            const out: any = { notes: 0, cards: 0, clozeCards: 0, basicCards: 0 };
            tx.objectStore('notes').count().onsuccess = (e: any) => { out.notes = e.target.result; };
            tx.objectStore('cards').count().onsuccess = (e: any) => { out.cards = e.target.result; };
            tx.objectStore('cards').openCursor().onsuccess = (e: any) => {
              const cursor = e.target.result;
              if (cursor) {
                if (cursor.value.clozeOrd != null) out.clozeCards++;
                else out.basicCards++;
                cursor.continue();
              }
            };
            tx.oncomplete = () => resolve(out);
            tx.onerror = () => reject(tx.error);
          };
          req.onerror = () => reject(req.error);
        },
      );
    });

    expect(counts.notes).toBeGreaterThan(100);
    expect(counts.cards).toBeGreaterThan(counts.notes);
    expect(counts.clozeCards).toBeGreaterThan(0);

    // Go to primary deck via the success-card link, then start studying.
    const openLink = page.getByRole('link', { name: /open primary deck/i });
    if (await openLink.isVisible()) await openLink.click();

    const studyBtn = page.getByRole('link', { name: /^Study/i }).first();
    await expect(studyBtn).toBeVisible();
    await studyBtn.click();

    // The study front should render some content from the imported note.
    await expect(page.getByRole('button', { name: 'Reveal', exact: true })).toBeVisible({ timeout: 15_000 });

    // Reveal and verify rating buttons appear with interval labels.
    await page.getByRole('button', { name: 'Reveal', exact: true }).click();
    for (const label of ['Again', 'Hard', 'Good', 'Easy']) {
      await expect(page.getByRole('button', { name: new RegExp(label) })).toBeVisible();
    }

    // Rate Good and verify the next card loads (or empty state if there were exactly 1 due).
    await page.keyboard.press('3');
    // Either a new front, or "Nothing due" — both are valid.
    await expect(
      page.locator('text=/Reveal|Nothing due/').first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
