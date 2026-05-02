/**
 * Cross-module helper for the auto-sync layer. Mutating writes to user-data
 * tables fire `cards:dirty` on `window`; the auto-sync hook listens for it
 * and debounces a push.
 *
 * Lives in its own module so both `lib/db/dexie.ts` (where the per-table
 * hooks are wired up) and `lib/db/queries.ts` (for any explicit calls) can
 * import it without creating an import cycle.
 */
export function markDirty(): void {
  if (typeof window === 'undefined') return;
  try { window.dispatchEvent(new Event('cards:dirty')); } catch { /* ignore */ }
}
