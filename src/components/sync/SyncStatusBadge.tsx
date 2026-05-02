'use client';

import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils';
import type { AutoSyncState } from '@/lib/sync/useAutoSync';

/**
 * Compact pill in the AppShell header showing the auto-sync state. Hidden
 * when sync isn't configured so non-sync users don't see it.
 */
export default function SyncStatusBadge({ state }: { state: AutoSyncState }) {
  if (state.kind === 'disabled') return null;

  let label = '';
  let tooltip = '';
  let tone: 'idle' | 'busy' | 'warn' | 'err' = 'idle';

  if (state.kind === 'syncing') {
    label = state.phase === 'pull' ? '↓ syncing' : '↑ syncing';
    tooltip = state.phase === 'pull'
      ? 'Pulling latest snapshot from sync server.'
      : 'Pushing your changes to the sync server.';
    tone = 'busy';
  } else if (state.kind === 'diverged') {
    label = 'diverged';
    tooltip = `Local and remote have both changed since the last sync. Open Settings → Sync (cloud) and pick which side wins.`;
    tone = 'warn';
  } else {
    if (state.lastError) {
      label = 'sync error';
      tooltip = state.lastError;
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
    <Tooltip content={tooltip} side="bottom">
      <span
        className={cn(
          'hidden sm:inline-flex items-center px-2 py-0.5 rounded-md text-2xs font-mono uppercase tracking-widest border tabular-nums',
          palette[tone],
        )}
      >
        {label}
      </span>
    </Tooltip>
  );
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
