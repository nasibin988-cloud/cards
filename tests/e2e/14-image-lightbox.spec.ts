import { test, expect } from '@playwright/test';

async function wipe(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    for (const d of databases) {
      if (d.name) {
        await new Promise<void>(resolve => {
          const req = indexedDB.deleteDatabase(d.name!);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
          req.onblocked = () => resolve();
        });
      }
    }
  });
  await page.goto('/');
}

async function createDeck(page: import('@playwright/test').Page, name: string): Promise<string> {
  await page.getByRole('link', { name: /new deck/i }).first().click();
  await page.getByPlaceholder(/MCAT.*Persian/i).fill(name);
  await page.getByRole('button', { name: /create deck/i }).click();
  await page.waitForURL(/\/deck\//);
  return page.url().split('/').pop()!;
}

test.describe('Image lightbox (Option A)', () => {
  test('image is hidden on the front, visible on the back, click opens lightbox', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'ImageLightboxE2E');

    // Seed a note + media row directly in IndexedDB so we don't depend on
    // the .apkg importer in this test. The renderer reads `note.fields.image`
    // and resolves it via `getMediaUrl(filename)` against the media table.
    await page.evaluate(async ({ deckId }) => {
      const w = window as unknown as { __cards_test?: { media?: unknown } };
      const dbReq = indexedDB.open('cards-v1');
      await new Promise<void>((resolve) => { dbReq.onsuccess = () => resolve(); });
      const db = dbReq.result;
      // Insert a tiny SVG as the test image (10×10 saffron square).
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="orange"/></svg>';
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const tx = db.transaction(['media', 'notes', 'cards'], 'readwrite');
      // Media row keyed by filename so getMediaUrl finds it.
      tx.objectStore('media').put({
        id: 'test-media-1',
        filename: 'test-image.svg',
        mimeType: 'image/svg+xml',
        blob,
      });
      const noteId = 'test-note-1';
      tx.objectStore('notes').put({
        id: noteId,
        deckId,
        modelId: 'cloze',
        fields: {
          front: 'The capital of France is {{c1::Paris}}.',
          back: '',
          image: 'test-image.svg',
        },
        tags: [],
        createdAt: Date.now(),
        modifiedAt: Date.now(),
      });
      // FSRS-default 'new' card so the picker returns it immediately.
      tx.objectStore('cards').put({
        id: 'test-card-1',
        noteId,
        deckId,
        clozeOrd: 1,
        due: Date.now(),
        stability: 0,
        difficulty: 0,
        elapsedDays: 0,
        scheduledDays: 0,
        learningSteps: 0,
        reps: 0,
        lapses: 0,
        state: 'new',
        suspended: false,
        buried: false,
        createdAt: Date.now(),
        modifiedAt: Date.now(),
      });
      await new Promise<void>((resolve) => { tx.oncomplete = () => resolve(); });
      db.close();
    }, { deckId });

    await page.goto(`/study/${deckId}`);

    // Front: cloze visible; image MUST NOT be in the card body. There may
    // be unrelated <img> tags in the page chrome, so scope by the card's
    // image button.
    await expect(page.getByText('capital of France').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enlarge image' })).toHaveCount(0);

    // Reveal back. Image is now present as a thumb (button).
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Enlarge image' })).toBeVisible({ timeout: 4000 });

    // Click thumb → lightbox dialog appears.
    await page.getByRole('button', { name: 'Enlarge image' }).click();
    const dialog = page.getByRole('dialog', { name: 'Image preview' });
    await expect(dialog).toBeVisible();

    // ESC closes the lightbox.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Image preview' })).toHaveCount(0);
  });
});
