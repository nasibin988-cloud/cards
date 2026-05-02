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

async function addBasicNote(page: import('@playwright/test').Page, deckId: string, front: string, back: string) {
  await page.goto(`/note/new?deckId=${deckId}`);
  await page.locator('textarea').first().fill(front);
  await page.locator('textarea').nth(1).fill(back);
  await page.getByRole('button', { name: /save & add another/i }).click();
  await expect(page.getByText('Saved. Editing a fresh note.')).toBeVisible({ timeout: 5000 });
}

test.describe('Undo last review (Cmd+Z)', () => {
  test('after rating a card and advancing, Cmd+Z brings back the just-rated card on the front', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'UndoCardE2E');
    // Two cards so there's a "next" to advance to after rating the first.
    await addBasicNote(page, deckId, 'first-card-front', 'first-card-back');
    await addBasicNote(page, deckId, 'second-card-front', 'second-card-back');

    await page.goto(`/study/${deckId}`);
    // First card visible.
    await expect(page.getByText('first-card-front').first()).toBeVisible();

    // Reveal back, then rate Good.
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: /Good/i })).toBeVisible();
    await page.keyboard.press('3');

    // Now the second card should be visible.
    await expect(page.getByText('second-card-front').first()).toBeVisible({ timeout: 4000 });

    // Cmd+Z: should rewind to the FIRST card, in front-phase.
    await page.keyboard.press('Meta+z');
    await expect(page.getByText('first-card-front').first()).toBeVisible({ timeout: 4000 });
    // Must be on the front phase — Show-answer / Reveal affordance present.
    // The Reveal button is the "Reveal/Show answer" affordance the front
    // phase always offers (clicking the card reveals it). We assert that the
    // rating buttons are NOT visible — back-phase only renders those.
    await expect(page.getByRole('button', { name: /^Good$/ })).not.toBeVisible();
  });

  test('Cmd+Z is a no-op with a flash when there is nothing to undo', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'UndoNothingE2E');
    await addBasicNote(page, deckId, 'only-card', 'a');

    await page.goto(`/study/${deckId}`);
    await expect(page.getByText('only-card').first()).toBeVisible();
    await page.keyboard.press('Meta+z');
    // Flash text — keep loose since the message wording could shift.
    await expect(page.getByText(/Nothing to undo/i)).toBeVisible({ timeout: 3000 });
  });
});
