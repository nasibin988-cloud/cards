/**
 * Watchdog timeouts for external API calls.
 *
 * Built on AbortSignal so it composes with the caller's existing signal:
 * the returned child signal aborts when either (a) the parent aborts, or
 * (b) `ms` elapses. The `cleanup` MUST be called after the request
 * settles, otherwise the pending timer fires post-resolution and
 * accumulates phantom abort listeners on the parent signal.
 *
 * Why this is critical: `fetch()` has no built-in timeout. A hung
 * OpenAI TTS or Anthropic call without a watchdog stalls the build
 * orchestrator forever — exactly the bug that froze a podcast at
 * segment 5/7 in prod. Every external call wraps through this helper.
 */

export interface TimeoutHandle {
  signal: AbortSignal;
  cleanup: () => void;
}

export function timeoutSignal(parent: AbortSignal | undefined, ms: number): TimeoutHandle {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort(new DOMException(`Request timed out after ${ms}ms`, 'TimeoutError'));
  }, ms);

  let onParentAbort: (() => void) | null = null;
  if (parent) {
    if (parent.aborted) {
      clearTimeout(timer);
      ctrl.abort(parent.reason);
    } else {
      onParentAbort = () => ctrl.abort(parent.reason);
      parent.addEventListener('abort', onParentAbort);
    }
  }

  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (parent && onParentAbort) parent.removeEventListener('abort', onParentAbort);
    },
  };
}

/**
 * Concurrency pool. Up to `cap` tasks run simultaneously; the rest queue
 * FIFO. Used to gate script-pass and render-pass throughput so we don't
 * accidentally fire 200 simultaneous OpenAI requests on a 4hr podcast.
 *
 * `run` returns whatever the task returns. Errors propagate to the
 * caller without affecting other queued tasks.
 */
export class Pool {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private cap: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.cap) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
