import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

export function formatInterval(days: number): string {
  if (days < 1 / 1440) return '<1m';
  if (days < 1 / 24) return `${Math.round(days * 1440)}m`;
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${(days / 30).toFixed(1)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

export function formatDate(d: Date | number): string {
  const date = typeof d === 'number' ? new Date(d) : d;
  return date.toISOString().split('T')[0];
}

export function relativeFromNow(d: Date | number): string {
  const date = typeof d === 'number' ? new Date(d) : d;
  const diffMs = date.getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  const sign = diffMs < 0 ? -1 : 1;
  const days = absMs / 86_400_000;
  const value = formatInterval(days);
  return sign < 0 ? `${value} ago` : `in ${value}`;
}

export function todayKey(d: Date = new Date()): string {
  return d.toISOString().split('T')[0];
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
