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

async function addBasic(page: import('@playwright/test').Page, deckId: string, front: string) {
  await page.goto(`/note/new?deckId=${deckId}`);
  await page.locator('textarea').first().fill(front);
  await page.locator('textarea').nth(1).fill(`answer-${front}`);
  await page.getByRole('button', { name: /save & add another/i }).click();
  await expect(page.getByText('Saved. Editing a fresh note.')).toBeVisible({ timeout: 5000 });
}

test.describe('Virtual-parent study (G1)', () => {
  test('study-group button on /decks/path drives a Reviewer that pulls from every leaf', async ({ page }) => {
    await wipe(page);

    // Two leaves under a virtual "Group" parent — no "Group" deck row.
    const a = await createDeck(page, 'Group::Alpha');
    const b = await createDeck(page, 'Group::Beta');
    await addBasic(page, a, 'A1');
    await addBasic(page, b, 'B1');

    await page.goto('/decks/path/Group');
    await expect(page.getByRole('heading', { name: /^Group$/ })).toBeVisible();

    // Visit the study route directly. Either A1 or B1 must show — the queue
    // is order-independent across leaves but contains both.
    await page.goto('/study/path/Group');
    const front = page.locator('text=/^A1$|^B1$/');
    await expect(front.first()).toBeVisible({ timeout: 5000 });

    // Reveal + rate Good. The Reviewer should advance to the next leaf's card.
    await page.keyboard.press('Space');
    // Wait for back to render (the rating bar is only on the back).
    await expect(page.getByRole('button', { name: /Good/i })).toBeVisible({ timeout: 4000 });
    await page.keyboard.press('3'); // Good

    // Now the OTHER card should show.
    await expect(page.locator('text=/^A1$|^B1$/').first()).toBeVisible({ timeout: 5000 });
  });

  test('parent-study indicator shows scope size in the Reviewer header', async ({ page }) => {
    await wipe(page);

    // Real parent + two leaves under it.
    const parent = await createDeck(page, 'Bio');
    await createDeck(page, 'Bio::Cell');
    await createDeck(page, 'Bio::Genetics');
    await addBasic(page, parent, 'P1'); // parent has its own card too

    await page.goto(`/study/${parent}`);
    // The "↧" indicator with a count appears when scope size > 1. Bio + Cell + Genetics = 3.
    const scope = page.locator('[aria-label^="Parent study"]');
    await expect(scope).toBeVisible({ timeout: 5000 });
    await expect(scope).toContainText('3');
  });
});
