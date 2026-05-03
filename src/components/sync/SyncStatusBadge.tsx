'use client';

import { useState } from 'react';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils';
import type { AutoSyncState } from '@/lib/sync/useAutoSync';

/**
 * Compact pill in the AppShell header showing the auto-sync state. Hidden
 * when sync isn't configured so non-sync users don't see it.
 *
 * On error, tapping the pill expands a detail panel below it so the user
 * can read the actual error message — tooltips are unreachable on iPad.
 */
export default function SyncStatusBadge({ state }: { state: AutoSyncState }) {
  const [expanded, setExpanded] = useState(false);

  if (state.kind === 'disabled') return null;

  let label = '';
  let tooltip = '';
  let tone: 'idle' | 'busy' | 'warn' | 'err' = 'idle';
  let detail: string | null = null;

  if (state.kind === 'syncing') {
    label = state.phase === 'pull' ? '↓ syncing' : '↑ syncing';
    tooltip = state.phase === 'pull'
      ? 'Pulling latest snapshot from sync server.'
      : 'Pushing your changes to the sync server.';
    tone = 'busy';
  } else if (state.kind === 'diverged') {
    label = 'diverged';
    tooltip = 'Local and remote have both changed since the last sync. Open Settings → Sync (cloud) and pick which side wins.';
    detail = tooltip;
    tone = 'warn';
  } else {
    if (state.lastError) {
      label = 'sync error · tap';
      tooltip = state.lastError;
      detail = state.lastError;
      tone = 'err';
    } else if (state.lastStatus) {
      const ts = state.lastStatus.lastSyncMs;
      const ago = ts ? formatAgo(Date.now() - ts) : 'never';
      label = `synced ${ago}`;
      tooltip = `${state.lastStatus.state} · last synced ${ts ? new Date(ts).toLocaleString() : 'never'}`;
      tone = 'idle';
    } else {
      label = 'sync ready';
      tooltip = 'Auto-sync is configured. Changes push automatically.';
      tone = 'idle';
    }
  }

  const palette: Record<typeof tone, string> = {
    idle: 'bg-persian-900/30 text-persian-200 border-persian-800/40',
    busy: 'bg-saffron-900/30 text-saffron-200 border-saffron-800/40',
    warn: 'bg-saffron-900/40 text-saffron-100 border-saffron-700/50',
    err:  'bg-crimson-900/40 text-crimson-200 border-crimson-800/40',
  };

  return (
    <>
      <Tooltip content={tooltip} side="bottom">
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          className={cn(
            'hidden sm:inline-flex items-center px-2 py-0.5 rounded-md text-2xs font-mono uppercase tracking-widest border tabular-nums transition',
            palette[tone],
            detail && 'cursor-pointer hover:brightness-110',
          )}
        >
          {label}
        </button>
      </Tooltip>
      {expanded && detail && (
        <div className="absolute top-14 right-3 md:right-6 z-50 max-w-md">
          <div className="glass-card rounded-xl p-3 text-xs text-dark-100 font-light leading-relaxed border border-crimson-800/30 bg-crimson-900/20 break-words shadow-xl">
            <div className="flex items-baseline justify-between gap-3 mb-1">
              <span className="text-2xs uppercase tracking-widest text-crimson-300">Sync detail</span>
              <button onClick={() => setExpanded(false)} className="text-2xs text-dark-400 hover:text-dark-100">
                close
              </button>
            </div>
            <pre className="whitespace-pre-wrap font-mono text-2xs text-dark-200">{detail}</pre>
          </div>
        </div>
      )}
    </>
  );
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
