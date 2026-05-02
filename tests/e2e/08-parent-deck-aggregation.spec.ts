import { test, expect } from '@playwright/test';

/**
 * Phase 5 regression specs for the parent-deck aggregation paths shipped
 * 2026-04-26 — a parent like "TestParent" must surface notes/cards from
 * every `::` descendant, both for browsing and for study.
 *
 * Decks + notes are seeded through the UI to keep this test resilient to
 * Dexie-version bumps without depending on bundler internals.
 */

async function createDeck(page: import('@playwright/test').Page, name: string): Promise<string> {
  await page.goto('/decks/new');
  await page.getByPlaceholder(/MCAT.*Persian/i).fill(name);
  await page.getByRole('button', { name: /create deck/i }).click();
  await page.waitForURL(/\/deck\/[A-Z0-9]+/);
  return page.url().split('/').pop()!;
}

async function addBasicNote(page: import('@playwright/test').Page, deckId: string, front: string, back: string) {
  await page.goto(`/note/new?deckId=${deckId}`);
  await page.getByPlaceholder(/Paris/).fill(front);
  await page.locator('textarea').nth(1).fill(back);
  await page.getByRole('button', { name: /save & add another/i }).click();
  await expect(page.getByText('Saved. Editing a fresh note.')).toBeVisible({ timeout: 5000 });
}

test.describe('Parent-deck aggregation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      const databases = await indexedDB.databases();
      for (const d of databases) {
        if (d.name) indexedDB.deleteDatabase(d.name);
      }
    });
    await page.goto('/');
  });

  test('browsing a parent deck shows notes from descendants', async ({ page }) => {
    const parentId = await createDeck(page, 'AggParent');
    const childAId = await createDeck(page, 'AggParent::ChildA');
    const childBId = await createDeck(page, 'AggParent::ChildB');
    await addBasicNote(page, childAId, 'AlphaQuestion', 'AlphaAnswer');
    await addBasicNote(page, childBId, 'BravoQuestion', 'BravoAnswer');

    await page.goto(`/deck/${parentId}`);
    await expect(page.getByRole('heading', { name: 'AggParent' })).toBeVisible();
    await expect(page.getByText('AlphaQuestion')).toBeVisible();
    await expect(page.getByText('BravoQuestion')).toBeVisible();
  });

  test('studying a parent deck pulls cards from descendants', async ({ page }) => {
    const parentId = await createDeck(page, 'StudyParent');
    const childAId = await createDeck(page, 'StudyParent::ChildA');
    const childBId = await createDeck(page, 'StudyParent::ChildB');
    await addBasicNote(page, childAId, 'AlphaStudy', 'AlphaStudyAnswer');
    await addBasicNote(page, childBId, 'BravoStudy', 'BravoStudyAnswer');

    await page.goto(`/study/${parentId}`);
    // The first card should be from one of the two children (priority tied
    // for new cards; either is acceptable, the point is "not Nothing due").
    await expect(page.getByText(/AlphaStudy|BravoStudy/)).toBeVisible({ timeout: 8000 });
    // And the empty-state should NOT appear (any of its title variants).
    await expect(page.getByText(/Nothing due|No cards due right now|Daily cap reached/)).not.toBeVisible();
  });
});
