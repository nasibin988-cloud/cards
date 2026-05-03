/**
 * Cross-module helper for the auto-sync layer. Mutating writes to user-data
 * tables fire `cards:dirty` on `window`; the auto-sync hook listens for it
 * and debounces a push.
 *
 * Lives in its own module so both `lib/db/dexie.ts` (where the per-table
 * hooks are wired up) and `lib/db/queries.ts` (for any explicit calls) can
 * import it without creating an import cycle.
 */

let suspended = 0;

/**
 * Temporarily suppress dirty events. Used by importSnapshot so the tens of
 * thousands of bulkPut rows don't each fire a window event + churn the
 * debounce timer — that storm was making the iPad unresponsive on a 100MB
 * snapshot import. Reentrant via a counter so nested suspend()s compose
 * correctly. ALWAYS pair with resumeDirty in a try/finally.
 */
export function suspendDirty(): void {
  suspended++;
}
export function resumeDirty(): void {
  if (suspended > 0) suspended--;
}

export function markDirty(): void {
  if (suspended > 0) return;
  if (typeof window === 'undefined') return;
  try { window.dispatchEvent(new Event('cards:dirty')); } catch { /* ignore */ }
}
