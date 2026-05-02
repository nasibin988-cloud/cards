import { test, expect } from '@playwright/test';

async function wipeAndSeed(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    for (const d of databases) {
      if (d.name) await new Promise<void>((resolve, reject) => { const req = indexedDB.deleteDatabase(d.name!); req.onsuccess = () => resolve(); req.onerror = () => reject(req.error); req.onblocked = () => resolve(); });
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

test.describe('Study session', () => {
  test('reveals back, rates Good, advances FSRS state', async ({ page }) => {
    await wipeAndSeed(page);
    const deckId = await createDeck(page, 'StudyTest');
    await addBasicNote(page, deckId, 'What is 2 + 2?', 'Four.');

    await page.goto(`/study/${deckId}`);

    // Front should show.
    await expect(page.getByText('What is 2 + 2?').first()).toBeVisible();

    // Back is hidden initially.
    await expect(page.getByRole('button', { name: 'Reveal', exact: true })).toBeVisible();
    await expect(page.getByText('Four.')).not.toBeVisible();

    // Reveal.
    await page.getByRole('button', { name: 'Reveal', exact: true }).click();
    await expect(page.getByText('Four.').first()).toBeVisible();

    // 4 rating buttons should be visible with interval labels.
    for (const label of ['Again', 'Hard', 'Good', 'Easy']) {
      const btn = page.getByRole('button', { name: new RegExp(label) });
      await expect(btn).toBeVisible();
    }

    // Rate Good.
    await page.getByRole('button', { name: /Good/ }).click();

    // No more cards → empty state.
    await expect(page.getByText(/Nothing due|No cards due right now/)).toBeVisible({ timeout: 5000 });
  });

  test('keyboard: Space reveals, 1-4 rates', async ({ page }) => {
    await wipeAndSeed(page);
    const deckId = await createDeck(page, 'KeyTest');
    await addBasicNote(page, deckId, 'Front A', 'Back A');
    await addBasicNote(page, deckId, 'Front B', 'Back B');

    await page.goto(`/study/${deckId}`);
    await expect(page.locator('main').getByText(/Front [AB]/).first()).toBeVisible();

    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: /Good/ })).toBeVisible();

    await page.keyboard.press('3');
    // Should have advanced to next card (front of second).
    await expect(page.getByRole('button', { name: 'Reveal', exact: true })).toBeVisible({ timeout: 5000 });

    await page.keyboard.press('Space');
    await page.keyboard.press('3');

    await expect(page.getByText(/Nothing due|No cards due right now/)).toBeVisible({ timeout: 5000 });
  });

  test('cloze front masks the matching ord, back highlights it', async ({ page }) => {
    await wipeAndSeed(page);
    const deckId = await createDeck(page, 'ClozeTest');

    await page.goto(`/note/new?deckId=${deckId}`);
    await page.locator('textarea').first().fill('{{c1::Paris}} is the capital of {{c2::France}}.');
    await page.getByRole('button', { name: /save & add another/i }).click();
    await expect(page.getByText('Saved.')).toBeVisible({ timeout: 5000 });

    await page.goto(`/study/${deckId}`);

    // Front for some ord: one cloze should be a blank, the other revealed (still readable).
    const card = page.locator('.glass-card').first();
    // At least one cloze-blank visible
    await expect(page.locator('.cloze-blank').first()).toBeVisible();

    await page.keyboard.press('Space');

    // Back: revealed cloze
    await expect(page.locator('.cloze-revealed').first()).toBeVisible();
  });
});
