'use client';

import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type Variant = 'primary' | 'ghost' | 'subtle' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const VARIANTS: Record<Variant, string> = {
  primary: 'btn-gradient',
  ghost: 'text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] border border-transparent',
  subtle: 'bg-dark-800/40 hover:bg-dark-800/70 text-dark-100 border border-white/[0.04]',
  danger: 'bg-crimson-900/40 hover:bg-crimson-800/50 text-crimson-200 border border-crimson-700/30',
};

const SIZES: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-sm rounded-lg',
  md: 'px-4 py-2 text-sm rounded-xl',
  lg: 'px-6 py-3 text-base rounded-2xl',
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'subtle', size = 'md', className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 font-light tracking-tight transition disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-persian-400',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  );
});

export default Button;
