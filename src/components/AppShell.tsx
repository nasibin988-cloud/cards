'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import CommandPalette from '@/components/CommandPalette';
import KeyboardHelp from '@/components/study/KeyboardHelp';
import QuickCapture from '@/components/QuickCapture';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { fireDailyIfDue } from '@/lib/notifications/daily';
import { useAutoSync } from '@/lib/sync/useAutoSync';
import SyncStatusBadge from '@/components/sync/SyncStatusBadge';

interface NavItem {
  href: string;
  label: string;
}

const NAV: NavItem[] = [
  { href: '/', label: 'Decks' },
  { href: '/read', label: 'Read' },
  { href: '/import', label: 'Import' },
  { href: '/generate', label: 'Generate' },
  { href: '/sessions', label: 'Sessions' },
  { href: '/tags', label: 'Tags' },
  { href: '/audit', label: 'Audit' },
  { href: '/trouble', label: 'Trouble' },
  { href: '/stats', label: 'Stats' },
  { href: '/settings', label: 'Settings' },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Routes that take over the full viewport — no app-nav header. Study
  // already did this; the phone-remote page wants the same treatment so
  // its two tap-zones can span the whole screen without an iOS chrome
  // strip eating thumb space at the top.
  const isFullViewport = pathname?.startsWith('/study/') || pathname === '/remote' || pathname?.startsWith('/remote/');
  const isStudying = isFullViewport;
  const [helpOpen, setHelpOpen] = useState(false);
  // Mounted once globally — pulls on app open if behind, debounce-pushes
  // after writes, and flushes on tab hide.
  const autoSyncState = useAutoSync();

  // Best-effort daily notification on app open. The helper is no-op when the
  // feature is disabled, permission isn't granted, or we fired recently.
  useEffect(() => {
    fireDailyIfDue().catch(() => { /* silent: notifications are best-effort */ });
  }, []);

  // Global `?` toggles the keyboard help panel. Skip when typing in any
  // editable surface so power users can write `?` in their notes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?') return;
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (tgt?.isContentEditable) return;
      e.preventDefault();
      setHelpOpen(o => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <TooltipProvider>
    <div className="relative z-10 min-h-screen flex flex-col">
      {!isStudying && (
        <header className="border-b border-white/[0.04] backdrop-blur-md bg-dark-950/40 sticky top-0 z-40">
          <div className="max-w-6xl mx-auto px-3 md:px-6 h-14 flex items-center gap-3 md:gap-4">
            {/* Horizontal-scroll nav on mobile so 9 items don't crush the layout. */}
            <nav className="flex-1 min-w-0 overflow-x-auto no-scrollbar">
              <div className="flex items-center gap-1 w-max">
                {NAV.map(item => {
                  const active =
                    item.href === '/'
                      ? pathname === '/'
                      : pathname?.startsWith(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        'shrink-0 px-3 py-1.5 rounded-lg text-sm transition',
                        active
                          ? 'text-saffron-300 bg-saffron-900/20'
                          : 'text-dark-300 hover:text-dark-100 hover:bg-white/[0.03]',
                      )}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </nav>
            <div className="flex items-center gap-1.5 md:gap-2 shrink-0">
              <SyncStatusBadge state={autoSyncState} />
              <Link
                href="/occlusion/new"
                className="hidden sm:inline-flex px-3 py-1.5 rounded-lg text-sm text-dark-300 hover:text-dark-100 hover:bg-white/[0.04] transition"
              >
                Occlusion
              </Link>
              <Link
                href="/decks/new"
                className="btn-gradient px-3 md:px-4 py-1.5 rounded-lg text-sm whitespace-nowrap"
                aria-label="New deck"
              >
                <span className="hidden sm:inline">+ New deck</span>
                <span className="sm:hidden">+ Deck</span>
              </Link>
            </div>
          </div>
        </header>
      )}
      <main className="flex-1">{children}</main>
      <CommandPalette />
      <KeyboardHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <QuickCapture />
    </div>
    </TooltipProvider>
  );
}
