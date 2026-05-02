import { test, expect } from '@playwright/test';

async function wipeAndSeed(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    for (const d of databases) {
      if (d.name) {
        await new Promise<void>((resolve, reject) => {
          const req = indexedDB.deleteDatabase(d.name!);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
          req.onblocked = () => resolve();
        });
      }
    }
    try { localStorage.clear(); } catch { /* ignore */ }
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

async function addClozeNote(page: import('@playwright/test').Page, deckId: string, body: string) {
  await page.goto(`/note/new?deckId=${deckId}`);
  await page.locator('textarea').first().fill(body);
  await page.getByRole('button', { name: /save & add another/i }).click();
  await expect(page.getByText('Saved.')).toBeVisible({ timeout: 5000 });
}

async function addBasicNote(page: import('@playwright/test').Page, deckId: string, front: string, back: string) {
  await page.goto(`/note/new?deckId=${deckId}`);
  await page.locator('textarea').first().fill(front);
  await page.locator('textarea').nth(1).fill(back);
  await page.getByRole('button', { name: /save & add another/i }).click();
  await expect(page.getByText('Saved.')).toBeVisible({ timeout: 5000 });
}

test.describe('Sibling burying', () => {
  test('rating c1 buries c2/c3; with only siblings left, study queue is empty', async ({ page }) => {
    await wipeAndSeed(page);
    const deckId = await createDeck(page, 'SiblingBury');

    // One cloze note with three siblings c1/c2/c3.
    await addClozeNote(
      page,
      deckId,
      '{{c1::Apple}} and {{c2::Banana}} and {{c3::Cherry}}.',
    );

    await page.goto(`/study/${deckId}`);

    // First sibling shown — the picker walks ords in order, so c1 first.
    await expect(page.locator('.cloze-blank').first()).toBeVisible();

    // Reveal and rate Good.
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: /Good/ })).toBeVisible();
    await page.keyboard.press('3');

    // c2 and c3 must be buried. Since they are the only remaining cards in
    // the deck, the empty state should appear instead of c2 jumping in.
    // (Pre-fix behavior: c2 jumped in via the prefetch cache.)
    await expect(
      page.getByText(/Nothing due|No cards due right now/),
    ).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Reset progress', () => {
  test('reset clears resume state so study restarts from card #1', async ({ page }) => {
    await wipeAndSeed(page);
    const deckId = await createDeck(page, 'ResetTest');

    // Add three cards in known order.
    await addBasicNote(page, deckId, 'Card 1 front', 'Card 1 back');
    await addBasicNote(page, deckId, 'Card 2 front', 'Card 2 back');
    await addBasicNote(page, deckId, 'Card 3 front', 'Card 3 back');

    // Study the first card, but DO NOT rate it — this writes a resume entry
    // pinned to card #1. Then we move further by rating it.
    await page.goto(`/study/${deckId}`);
    await expect(page.getByText('Card 1 front')).toBeVisible();
    await page.keyboard.press('Space');
    await page.keyboard.press('3'); // Good — moves to card #2

    await expect(page.getByText('Card 2 front')).toBeVisible({ timeout: 5000 });
    // Reveal card #2 so the resume key now points at card #2.
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: /Good/ })).toBeVisible();

    // Walk back to deck page and reset.
    await page.goto(`/deck/${deckId}`);
    await page.getByRole('button', { name: /more deck actions/i }).click();
    await page.getByRole('menuitem', { name: /Reset progress/ }).click();
    await page.getByRole('button', { name: /Confirm reset/ }).click();
    await expect(page.getByText(/Reset \d+ cards?\./)).toBeVisible({ timeout: 5000 });

    // Re-enter study. Without the fix the Reviewer's bootstrap restores the
    // saved card #2; with the fix the resume is cleared and we get card #1.
    await page.goto(`/study/${deckId}`);
    await expect(page.getByText('Card 1 front')).toBeVisible({ timeout: 5000 });
    // Card 2/3 should NOT be the first thing shown.
    await expect(page.getByText('Card 2 front')).not.toBeVisible();
  });
});
