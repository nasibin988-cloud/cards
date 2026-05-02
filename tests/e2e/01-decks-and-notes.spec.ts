import { test, expect } from '@playwright/test';

test.describe('Deck and note creation', () => {
  test.beforeEach(async ({ page }) => {
    // Wipe IndexedDB between tests so they're isolated.
    await page.goto('/');
    await page.evaluate(async () => {
      const databases = await indexedDB.databases();
      for (const d of databases) {
        if (d.name) indexedDB.deleteDatabase(d.name);
      }
    });
    await page.goto('/');
  });

  test('empty home shows the empty state and CTA', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'No decks yet' })).toBeVisible();
    await expect(page.getByRole('link', { name: /new deck/i }).first()).toBeVisible();
  });

  test('creating a deck navigates to the deck page', async ({ page }) => {
    await page.getByRole('link', { name: /new deck/i }).first().click();
    await page.waitForURL('**/decks/new');
    await page.getByPlaceholder(/MCAT.*Persian/i).fill('Test Deck');
    await page.getByRole('button', { name: /create deck/i }).click();
    await page.waitForURL(/\/deck\/[A-Z0-9]+/);
    await expect(page.getByRole('heading', { name: 'Test Deck' })).toBeVisible();
    await expect(page.getByText('No notes yet')).toBeVisible();
  });

  test('creating a basic note produces 1 card; cloze with c1+c2 produces 2', async ({ page }) => {
    // Create a deck.
    await page.getByRole('link', { name: /new deck/i }).first().click();
    await page.getByPlaceholder(/MCAT.*Persian/i).fill('Mixed');
    await page.getByRole('button', { name: /create deck/i }).click();
    await page.waitForURL(/\/deck\//);
    const deckUrl = page.url();
    const deckId = deckUrl.split('/').pop()!;

    // Add a basic note.
    await page.goto(`/note/new?deckId=${deckId}`);
    await page.getByPlaceholder(/Paris/).fill('What does Dexie wrap?');
    // The textarea for "Back" is the second textarea on the page.
    const textareas = page.locator('textarea');
    await textareas.nth(1).fill('IndexedDB.');
    await page.getByRole('button', { name: /save & add another/i }).click();
    await expect(page.getByText('Saved. Editing a fresh note.')).toBeVisible({ timeout: 5000 });

    // Add a cloze note (same form, fresh).
    await page.locator('textarea').first().fill('{{c1::Paris}} is the capital of {{c2::France}}.');
    await page.getByRole('button', { name: /save & add another/i }).click();
    await expect(page.getByText('Saved. Editing a fresh note.')).toBeVisible({ timeout: 5000 });

    // Go to the deck page and check counts.
    await page.goto(`/deck/${deckId}`);
    await expect(page.getByRole('heading', { name: 'Mixed' })).toBeVisible();

    // Total should be 1 (basic) + 2 (cloze) = 3 cards across 2 notes.
    await expect(page.getByText('Notes (2)')).toBeVisible();

    // Inline stats pill shows three groups; New/Learn/Review. Newly created
    // cards are all `new`, so the New pill should read 3.
    await expect(page.getByText(/^new$/i).first()).toBeVisible();
    const inlineStats = page.locator('div').filter({ hasText: /^\d+\s*new\s*\d+\s*learn\s*\d+\s*review$/i }).first();
    await expect(inlineStats).toContainText('3');
  });

  test('deck card has no nested anchors (HTML-valid stretched link)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(`PAGE ERROR: ${err.message}`));
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(`[error] ${msg.text()}`);
    });

    await page.getByRole('link', { name: /new deck/i }).first().click();
    await page.getByPlaceholder(/MCAT.*Persian/i).fill('NestedLinkTest');
    await page.getByRole('button', { name: /create deck/i }).click();
    await page.waitForURL(/\/deck\//);

    await page.goto('/');
    // Wait for a deck-row link to render — confirms the tree has hydrated.
    await page.waitForSelector('a[href^="/deck/"]');

    // Assert no anchor-inside-anchor in the entire DOM.
    const nested = await page.evaluate(() => {
      let bad = 0;
      document.querySelectorAll('a').forEach(a => {
        if (a.querySelector('a')) bad++;
      });
      return bad;
    });
    expect(nested).toBe(0);

    // Hydration warnings about nested links must not appear in the console.
    expect(
      errors.find(e => /cannot be a descendant of <a>|cannot contain a nested <a>/.test(e)),
    ).toBeUndefined();
  });

  test('cloze preview in the editor shows the right ord count', async ({ page }) => {
    await page.getByRole('link', { name: /new deck/i }).first().click();
    await page.getByPlaceholder(/MCAT.*Persian/i).fill('Preview');
    await page.getByRole('button', { name: /create deck/i }).click();
    await page.waitForURL(/\/deck\//);
    const deckId = page.url().split('/').pop()!;

    await page.goto(`/note/new?deckId=${deckId}`);
    const front = page.locator('textarea').first();
    await front.fill('{{c1::A}} {{c2::B}} {{c3::C}}');
    await expect(page.getByText(/cloze, 3 cards/i)).toBeVisible();
    await expect(page.getByText(/will produce 3 cards/)).toBeVisible();
  });
});
