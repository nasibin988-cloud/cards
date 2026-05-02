'use client';

import * as RadixTooltip from '@radix-ui/react-tooltip';
import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Side = 'top' | 'right' | 'bottom' | 'left';
type Align = 'start' | 'center' | 'end';

interface TooltipProps {
  /** Trigger element. Wrapped in `Tooltip.Trigger asChild`, so it must accept a ref and forward DOM props. */
  children: ReactNode;
  /** Tooltip body. Falsy values render no tooltip at all (the trigger is returned bare). */
  content: ReactNode;
  side?: Side;
  align?: Align;
  /** Override the shared Provider delay (ms). */
  delayDuration?: number;
  /** Distance from trigger in px. */
  sideOffset?: number;
  className?: string;
}

export function TooltipProvider({
  children,
  delayDuration = 120,
  skipDelayDuration = 250,
}: {
  children: ReactNode;
  delayDuration?: number;
  skipDelayDuration?: number;
}) {
  return (
    <RadixTooltip.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration}>
      {children}
    </RadixTooltip.Provider>
  );
}

export function Tooltip({
  children,
  content,
  side = 'top',
  align = 'center',
  delayDuration,
  sideOffset = 6,
  className,
}: TooltipProps) {
  if (content === null || content === undefined || content === false || content === '') {
    return <>{children}</>;
  }
  return (
    <RadixTooltip.Root delayDuration={delayDuration}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          className={cn(
            'z-50 max-w-xs px-2.5 py-1.5 rounded-lg',
            'bg-dark-900/95 backdrop-blur-md border border-white/[0.06] shadow-glass',
            'text-2xs leading-snug font-light tracking-tight text-dark-100',
            'select-none pointer-events-none',
            'data-[state=delayed-open]:animate-fade-in',
            'data-[state=instant-open]:animate-fade-in',
            className,
          )}
        >
          {content}
          <RadixTooltip.Arrow
            className="fill-dark-900/95"
            width={10}
            height={5}
          />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
