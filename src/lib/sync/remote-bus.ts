/**
 * In-process pub/sub for the remote-control feature. The phone POSTs to
 * /api/sync/remote, which calls publish(token, action); each laptop's
 * SSE stream is registered as a subscriber and gets the action pushed
 * synchronously. Token-keyed so a stream only sees actions intended for
 * its own pairing.
 *
 * Single-process assumption: Next.js standalone runs as one Node
 * process per container, so the Map below survives across requests.
 * If the deployment ever scales horizontally we'd swap this for Redis
 * pubsub or similar; the API is small enough to swap cleanly.
 */

export type RemoteAction =
  | { type: 'reveal' }
  | { type: 'rate'; rating: 1 | 2 | 3 | 4 }
  | { type: 'undo' }
  | { type: 'snooze-hour' }
  | { type: 'snooze-day' }
  | { type: 'bury' }
  | { type: 'suspend' }
  | { type: 'end-pomodoro-phase' }
  | { type: 'flag-cycle' }
  | { type: 'edit' }
  | { type: 'ask' };

type Subscriber = (action: RemoteAction) => void;

// Module-level so all route handlers in the same process see the same map.
const subscribers = new Map<string, Set<Subscriber>>();

export function subscribe(token: string, fn: Subscriber): () => void {
  let set = subscribers.get(token);
  if (!set) {
    set = new Set();
    subscribers.set(token, set);
  }
  set.add(fn);
  return () => {
    const s = subscribers.get(token);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) subscribers.delete(token);
  };
}

export function publish(token: string, action: RemoteAction): number {
  const set = subscribers.get(token);
  if (!set) return 0;
  let count = 0;
  for (const fn of set) {
    try { fn(action); count++; } catch { /* drop */ }
  }
  return count;
}

export function subscriberCount(token: string): number {
  return subscribers.get(token)?.size ?? 0;
}
