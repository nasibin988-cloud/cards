/**
 * Targeted screenshots for the hierarchy + back-side redesign. Creates a
 * realistic dataset (multi-level deck tree, a cloze note with every back
 * field populated and the noisy MCAT-style tag set) so the screenshots
 * actually exercise the new visual code paths.
 *
 *   npx playwright test tests/e2e/98-redesign-screenshots.spec.ts
 */

import { test } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const SHOTS = path.resolve(__dirname, '../screenshots');

async function shot(page: import('@playwright/test').Page, name: string) {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

async function wipe(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    for (const d of databases) if (d.name) await new Promise<void>((resolve, reject) => { const req = indexedDB.deleteDatabase(d.name!); req.onsuccess = () => resolve(); req.onerror = () => reject(req.error); req.onblocked = () => resolve(); });
  });
  await page.goto('/');
}

/**
 * Seed decks + a richly-populated cloze note directly into IndexedDB so we
 * don't have to drive the editor for every field.
 */
async function seedHierarchy(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const open = (name: string, version?: number) =>
      new Promise<IDBDatabase>((res, rej) => {
        const r = version ? indexedDB.open(name, version) : indexedDB.open(name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    const db = await open('cards-v1');
    const ulid = () => {
      const t = Date.now().toString(36).toUpperCase().padStart(10, '0');
      const r = Array.from({ length: 16 }, () =>
        '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.charAt(Math.floor(Math.random() * 32))
      ).join('');
      return (t + r).slice(0, 26);
    };
    const tx = db.transaction(['decks', 'notes', 'cards'], 'readwrite');
    const decks = tx.objectStore('decks');
    const notes = tx.objectStore('notes');
    const cards = tx.objectStore('cards');
    const now = Date.now();

    // Three sibling chapters under MCAT V5 Core::Behavioral Sciences. The
    // tree builder synthesizes the missing "MCAT V5 Core" + "Behavioral
    // Sciences" parents from the `::` segments — only the leaf decks are
    // real records.
    const leafIds: { name: string; id: string }[] = [
      { name: 'MCAT V5 Core::Behavioral Sciences::Ch01 Behavioral Neuroscience', id: ulid() },
      { name: 'MCAT V5 Core::Behavioral Sciences::Ch02 Sensation & Perception',  id: ulid() },
      { name: 'MCAT V5 Core::Behavioral Sciences::Ch03 Learning & Memory',       id: ulid() },
      { name: 'MCAT V5 Core::Biology::Ch04 Nervous System',                       id: ulid() },
    ];
    for (const d of leafIds) {
      decks.put({
        id: d.id,
        name: d.name,
        description: '',
        desiredRetention: 0.9,
        createdAt: now,
        modifiedAt: now,
      });
    }

    // A richly-populated cloze note in the first leaf so the back screenshot
    // can show every block: cloze answer, back, extra, context, source, tags.
    const noteId = ulid();
    const ord = 1;
    const front =
      'The {{c1::prefrontal cortex}} governs executive function: planning, ' +
      'working memory, decision-making, and inhibition of prepotent responses.';
    notes.put({
      id: noteId,
      deckId: leafIds[0].id,
      modelId: 'cloze',
      fields: {
        front,
        back: 'Anterior to the motor cortex within the frontal lobe. Damage disinhibits impulse and degrades goal-directed behavior.',
        extra:
          'PFC is the last brain region to myelinate, with development continuing into the mid-twenties; this timing underlies adolescent risk-taking, because the limbic reward system (the mesolimbic dopamine circuit running from VTA to nucleus accumbens, which rewards salient stimuli and drives approach behavior) matures by puberty while the PFC that would veto its drives is still wiring up. Functional subdivisions: dorsolateral PFC governs working memory and cognitive control, ventromedial and orbitofrontal PFC handle value-based decisions and emotional regulation. These subregions support cognitive control as a set; damage to any one produces a distinct frontal syndrome rather than a global executive loss.',
        mnemonic: 'PFC = "Personal Future Controller" — plans, predicts, prevents.',
        context: 'Prefrontal cortex',
        source: 'core::PS::behavsci::ch01_behavioral_neuroscience::brain-anatomy::prefrontal-cortex',
      },
      tags: [
        'core::PS::behavsci::ch01_behavioral_neuroscience::brain-anatomy::prefrontal-cortex',
        'skill::mechanism',
        'HY::high',
        'xref::BB::bio::ch04_nervous_system::prefrontal-cortex',
      ],
      createdAt: now,
      modifiedAt: now,
    });

    cards.put({
      id: ulid(),
      noteId,
      deckId: leafIds[0].id,
      clozeOrd: ord,
      due: new Date(now - 86_400_000), // overdue so it's the next-up card
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      reps: 0,
      lapses: 0,
      state: 'new',
      suspended: false,
      buried: false,
      createdAt: now,
      modifiedAt: now,
    });

    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
    return leafIds[0].id;
  });
}

test('hierarchy + back-side redesign', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });

  await wipe(page);
  await seedHierarchy(page);

  // Home with hierarchy expanded: top-level "MCAT V5 Core" section,
  // Behavioral Sciences + Biology subsections, leaf chapters.
  await page.goto('/');
  await page.waitForSelector('h2:has-text("MCAT V5 Core")');
  // Let count queries finish.
  await page.waitForTimeout(800);
  await shot(page, '20-home-hierarchy');

  // Drill into the leaf and take front + back screenshots with every field.
  const studyLink = page.locator('a[href^="/study/"]').first();
  await studyLink.click();
  await page.waitForURL(/\/study\//);
  await page.waitForSelector('button:has-text("Reveal")');
  await page.waitForTimeout(400);
  await shot(page, '21-study-front-rich');

  await page.keyboard.press('Space');
  await page.waitForSelector('button:has-text("Good")');
  await page.waitForTimeout(400);
  await shot(page, '22-study-back-rich');
});
