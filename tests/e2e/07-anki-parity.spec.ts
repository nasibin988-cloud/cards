import { test, expect, type Page } from '@playwright/test';

/**
 * E2E coverage for the 9-chunk Anki-parity build:
 *  1. Bulk ops in deck browser
 *  2. Card actions on note edit
 *  3. URL search syntax
 *  4. Per-deck Tuning panel
 *  5. Flags
 *  6. Sibling cards
 *  7. Find & replace
 *  8. Note-type conversion
 *  9. Type-the-answer cloze
 */

async function wipe(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    for (const d of databases) {
      if (d.name) await new Promise<void>((resolve, reject) => { const req = indexedDB.deleteDatabase(d.name!); req.onsuccess = () => resolve(); req.onerror = () => reject(req.error); req.onblocked = () => resolve(); });
    }
  });
  await page.goto('/');
}

async function createDeck(page: Page, name: string): Promise<string> {
  await page.getByRole('link', { name: /new deck/i }).first().click();
  await page.getByPlaceholder(/MCAT.*Persian/i).fill(name);
  await page.getByRole('button', { name: /create deck/i }).click();
  await page.waitForURL(/\/deck\//);
  return page.url().split('/').pop()!;
}

async function addBasicNote(page: Page, deckId: string, front: string, back: string) {
  await page.goto(`/note/new?deckId=${deckId}`);
  await page.locator('textarea').first().fill(front);
  await page.locator('textarea').nth(1).fill(back);
  await page.getByRole('button', { name: /save & add another/i }).click();
  await expect(page.getByText('Saved.').first()).toBeVisible({ timeout: 5000 });
}

test.describe('Chunk 1 — bulk ops in deck browser', () => {
  test('multi-select a row and the floating action bar appears', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'BulkE2E');
    await addBasicNote(page, deckId, 'A', 'a');
    await addBasicNote(page, deckId, 'B', 'b');
    await addBasicNote(page, deckId, 'C', 'c');

    await page.goto(`/deck/${deckId}`);
    // Click the first row's checkbox.
    await page.getByRole('button', { name: /select note/i }).first().click();
    await expect(page.getByText(/^1 selected$/)).toBeVisible();
    await expect(page.getByRole('button', { name: /^Suspend$/ })).toBeVisible();
  });

  test('suspend then undo restores the note', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'BulkUndoE2E');
    await addBasicNote(page, deckId, 'A', 'a');
    await page.goto(`/deck/${deckId}`);

    await page.getByRole('button', { name: /select note/i }).first().click();
    await page.getByRole('button', { name: /^Suspend$/ }).click();
    // Toast appears with Undo affordance.
    await expect(page.getByText(/Suspended 1 note/)).toBeVisible({ timeout: 3000 });
    await page.getByRole('button', { name: /^Undo$/ }).click();
    // Toast goes away after undo.
    await expect(page.getByText(/Suspended 1 note/)).not.toBeVisible();
  });
});

test.describe('Chunk 2 — card actions on note page', () => {
  test('renders the card actions block with state badge', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'NoteActions');
    await addBasicNote(page, deckId, 'unique-card-actions-target', 'x');
    await page.goto(`/deck/${deckId}`);
    await page.getByText('unique-card-actions-target').first().click();
    await expect(page.getByRole('heading', { name: 'Card actions' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Reset$/ }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Reschedule$/ }).first()).toBeVisible();
  });
});

test.describe('Chunk 3 — search syntax in URL', () => {
  test('typing tag:foo updates ?q= in the URL', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'URLSearch');
    await addBasicNote(page, deckId, 'note A', 'a');

    await page.goto(`/deck/${deckId}`);
    const searchInput = page.locator('input[placeholder*="Search"]').first();
    await searchInput.fill('tag:foo');
    // Wait for the URL replace.
    await page.waitForURL(/\?q=tag/, { timeout: 3000 });
  });

  test('loading with ?q=tag:bar populates the search input', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'URLLoad');
    await addBasicNote(page, deckId, 'X', 'x');
    await page.goto(`/deck/${deckId}?q=${encodeURIComponent('tag:bar')}`);
    const searchInput = page.locator('input[placeholder*="Search"]').first();
    await expect(searchInput).toHaveValue('tag:bar');
  });
});

test.describe('Chunk 4 — per-deck Tuning', () => {
  test('Tuning inputs are interactive; user changes auto-flip the override', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'TuningE2E');
    await page.goto(`/deck/${deckId}/edit`);
    await page.getByRole('button', { name: /^Tuning$/ }).click();
    // Before any change, the right-hand label reads "Default · 90%".
    await expect(page.getByText(/Default · 90%/)).toBeVisible();

    // Direct-manipulation: change the New cards / day input. No prior
    // "override" toggle click required — this is the fix for users who
    // previously thought the field was broken because clicking it did nothing.
    const newCardsInput = page.locator('input[type="number"]').first();
    await newCardsInput.fill('42');
    await newCardsInput.press('Tab');

    // After a user change, that row's right-hand affordance becomes a Reset.
    const resetButton = page.getByRole('button', { name: /↺ Reset/ }).first();
    await expect(resetButton).toBeVisible();

    // Reset reverts the row back to its default chip.
    await resetButton.click();
    // No more Reset visible after reverting the only override.
    await expect(page.getByRole('button', { name: /↺ Reset/ })).toHaveCount(0);
  });
});

test.describe('Chunk 5 — flags', () => {
  test('flag a note from edit page; flag glyph shows in deck browse', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'FlagsE2E');
    await addBasicNote(page, deckId, 'unique-flagged-front-text', 'b');

    // Open the note and set the broken flag. The picker buttons expose their
    // label via aria-label (visible text is the glyph "!").
    await page.goto(`/deck/${deckId}`);
    await page.getByText('unique-flagged-front-text').first().click();
    await page.getByRole('button', { name: 'Broken', exact: true }).click();

    // Back on the deck page, the flag glyph (!) appears next to the note.
    await page.goto(`/deck/${deckId}`);
    await expect(page.locator('[aria-label="Broken"]').first()).toBeVisible();
  });
});

test.describe('Chunk 6 — sibling cards', () => {
  test('Front ↔ Back preset creates two cards on a basic note', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'Sib');
    // Manually fill the note editor (don't use addBasicNote helper because we
    // need to click the sibling preset before saving).
    await page.goto(`/note/new?deckId=${deckId}`);
    await page.locator('textarea').first().fill('word');
    await page.locator('textarea').nth(1).fill('definition');

    // Scroll to siblings panel and click the preset.
    await page.getByRole('button', { name: /Front ↔ Back/ }).click();

    await page.getByRole('button', { name: /save & add another/i }).click();
    await expect(page.getByText('Saved.').first()).toBeVisible({ timeout: 5000 });

    // Two cards should now exist for the deck. Easiest check: open the note
    // edit page and confirm 2 rows in Card actions.
    await page.goto(`/deck/${deckId}`);
    await page.getByText('word').first().click();
    await expect(page.getByRole('heading', { name: 'Card actions' })).toBeVisible();
    // Two state-badge rows for two cards.
    await expect(page.locator('text=/^new$/').nth(1)).toBeVisible();
  });
});

test.describe('Chunk 7 — find and replace', () => {
  test('Find button opens the sheet, search shows matches', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'FindE2E');
    await addBasicNote(page, deckId, 'the quick brown fox', 'jumps');
    await addBasicNote(page, deckId, 'lazy dog', 'naps');

    await page.goto(`/deck/${deckId}`);
    // Find lives in the overflow menu now; open it first.
    await page.getByRole('button', { name: /more deck actions/i }).click();
    await page.getByRole('menuitem', { name: /find & replace/i }).click();
    await expect(page.getByRole('heading', { name: /find & replace/i })).toBeVisible();

    await page.getByPlaceholder(/^Find…$/).fill('quick');
    // Match counter updates.
    await expect(page.getByText(/1 match in 1 note/)).toBeVisible({ timeout: 3000 });
  });

  test('Replace all rewrites text and closes the sheet', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'ReplaceE2E');
    await addBasicNote(page, deckId, 'replace me here', 'b');

    await page.goto(`/deck/${deckId}`);
    // Find lives in the overflow menu now; open it first.
    await page.getByRole('button', { name: /more deck actions/i }).click();
    await page.getByRole('menuitem', { name: /find & replace/i }).click();
    await page.getByPlaceholder(/^Find…$/).fill('replace me');
    await page.getByPlaceholder(/^Replace with…$/).fill('REPLACED');
    await expect(page.getByText(/1 match in 1 note/)).toBeVisible({ timeout: 3000 });
    await page.getByRole('button', { name: /^Replace all$/ }).click();
    // Sheet closes.
    await expect(page.getByRole('heading', { name: /find & replace/i })).not.toBeVisible();
    // Note browse shows the replaced text.
    await expect(page.getByText(/REPLACED here/)).toBeVisible({ timeout: 3000 });
  });
});

test.describe('Chunk 8 — change note type', () => {
  test('basic → cloze conversion regenerates the front field', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'ConvertE2E');
    await addBasicNote(page, deckId, 'capital of France', 'Paris');

    await page.goto(`/deck/${deckId}`);
    await page.getByText('capital of France').first().click();
    await page.getByRole('button', { name: /Convert: basic → cloze/ }).click();
    await expect(page.getByRole('heading', { name: /Convert: basic → cloze/ })).toBeVisible();
    await page.getByRole('button', { name: /^Convert to cloze$/ }).click();

    // After conversion the convert button now offers the reverse direction.
    await expect(page.getByRole('button', { name: /Convert: cloze → basic/ })).toBeVisible({ timeout: 3000 });
    // The front textarea should now contain the cloze syntax.
    const frontBox = page.locator('textarea').first();
    await expect(frontBox).toHaveValue(/\{\{c1::Paris\}\}/);
  });
});

test.describe('Chunk 9 — type-the-answer cloze', () => {
  test('renders an inline input on the front and a diff on the back', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'TypeClozeE2E');
    await page.goto(`/note/new?deckId=${deckId}`);
    await page.locator('textarea').first().fill('Capital of France: {{type::Paris}}');
    await page.locator('textarea').nth(1).fill('');
    await page.getByRole('button', { name: /save & add another/i }).click();
    await expect(page.getByText('Saved.').first()).toBeVisible({ timeout: 5000 });

    await page.goto(`/study/${deckId}`);
    await expect(page.getByRole('button', { name: 'Reveal', exact: true })).toBeVisible();
    // The type-cloze input is rendered on the front.
    const typeInput = page.locator('input.type-cloze');
    await expect(typeInput).toBeVisible();
    await typeInput.fill('Paris');

    await page.getByRole('button', { name: 'Reveal', exact: true }).click();
    // On reveal the diff display marks the input as correct.
    await expect(page.locator('span.type-cloze-correct')).toBeVisible({ timeout: 3000 });
  });
});
