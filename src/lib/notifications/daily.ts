/**
 * Daily-summary notification. Browser-native via the Notification API.
 *
 * Strategy without a server:
 *   - Settings: user grants permission (once per device).
 *   - On app open, check the gap since the last summary toast. If ≥ the
 *     configured interval (default 12 hours), build a summary line and fire
 *     a notification.
 *   - Avoids spam by tracking the last fire time in IndexedDB settings.
 *
 * True background push (when the app is closed) requires either Push API +
 * VAPID server, or the experimental Periodic Background Sync — neither
 * fits the offline-first, server-less constraint of V1. This best-effort
 * approach surfaces something useful when the user actually returns.
 */

import {
  cardMaturity,
  getDeckCounts,
  getJsonSetting,
  listDecks,
  retentionWindow,
  setJsonSetting,
} from '@/lib/db/queries';

const ENABLED_KEY = 'daily_summary_enabled';
const LAST_FIRE_KEY = 'daily_summary_last_fire_ms';
const DEFAULT_GAP_HOURS = 12;

export async function isEnabled(): Promise<boolean> {
  return getJsonSetting<boolean>(ENABLED_KEY, false);
}

export async function setEnabled(v: boolean): Promise<void> {
  await setJsonSetting<boolean>(ENABLED_KEY, v);
}

export function permissionStatus(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export async function requestPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  const result = await Notification.requestPermission();
  return result;
}

export interface SummaryLine {
  /** Short headline for the OS notification body. */
  body: string;
  /** Total cards due across all decks right now. */
  totalDue: number;
}

/** Compose the summary text. Cheap; safe to call on every app open. */
export async function buildSummary(): Promise<SummaryLine> {
  const decks = await listDecks();
  const counts = await Promise.all(decks.map(d => getDeckCounts(d.id)));
  const totalDue = counts.reduce((sum, c) => sum + c.new + c.learning + c.review, 0);
  const ret = await retentionWindow(30);
  const mat = await cardMaturity();
  const retentionPart = ret.total > 0 ? `${(ret.rate * 100).toFixed(0)}% retention 30d` : null;
  const matPart = mat.total > 0 ? `${mat.mature} mature` : null;
  const tail = [retentionPart, matPart].filter(Boolean).join(' · ');
  const due = totalDue > 0 ? `${totalDue} cards due` : 'Caught up';
  return {
    body: tail ? `${due} · ${tail}` : due,
    totalDue,
  };
}

/**
 * Fire if conditions met:
 *  - feature enabled
 *  - permission granted
 *  - last fire was ≥ gapHours ago
 *  - there's something due (or it's the first ever fire — establish presence)
 *
 * Returns true if a notification was actually shown.
 */
export async function fireDailyIfDue(gapHours = DEFAULT_GAP_HOURS): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  const enabled = await isEnabled();
  if (!enabled) return false;
  if (Notification.permission !== 'granted') return false;

  const last = await getJsonSetting<number>(LAST_FIRE_KEY, 0);
  const gapMs = gapHours * 3_600_000;
  if (Date.now() - last < gapMs) return false;

  const summary = await buildSummary();
  if (summary.totalDue === 0 && last > 0) {
    // Don't nag when nothing's due. Update the timestamp so the gap
    // doesn't stretch indefinitely on a "caught up" deck.
    await setJsonSetting<number>(LAST_FIRE_KEY, Date.now());
    return false;
  }

  try {
    new Notification('Cards', {
      body: summary.body,
      tag: 'cards-daily-summary',
      icon: '/icons/icon-192.png',
    });
  } catch {
    // Some browsers throw outside a user gesture even when permission is
    // granted. Failing silently is fine; the in-app banner still shows.
    return false;
  }
  await setJsonSetting<number>(LAST_FIRE_KEY, Date.now());
  return true;
}
