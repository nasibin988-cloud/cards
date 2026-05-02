import { describe, it, expect } from 'vitest';
import { cn, formatInterval, todayKey, clamp, relativeFromNow } from '@/lib/utils';

describe('cn', () => {
  it('joins truthy classes', () => {
    expect(cn('a', 'b', false && 'c', undefined, 'd')).toBe('a b d');
  });
});

describe('formatInterval', () => {
  it('handles sub-minute', () => {
    expect(formatInterval(0)).toBe('<1m');
    expect(formatInterval(0.0005)).toBe('<1m');
  });
  it('handles minutes', () => {
    expect(formatInterval(10 / 1440)).toBe('10m');
    expect(formatInterval(45 / 1440)).toBe('45m');
  });
  it('handles hours', () => {
    expect(formatInterval(2 / 24)).toBe('2h');
    expect(formatInterval(12 / 24)).toBe('12h');
  });
  it('handles days', () => {
    expect(formatInterval(1)).toBe('1d');
    expect(formatInterval(7)).toBe('7d');
    expect(formatInterval(15)).toBe('15d');
  });
  it('handles months', () => {
    expect(formatInterval(60)).toBe('2.0mo');
    expect(formatInterval(300)).toBe('10.0mo');
  });
  it('handles years', () => {
    expect(formatInterval(400)).toBe('1.1y');
    expect(formatInterval(800)).toBe('2.2y');
  });
});

describe('clamp', () => {
  it('bounds value', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });
});

describe('todayKey', () => {
  it('formats as YYYY-MM-DD', () => {
    const d = new Date('2026-04-25T15:30:00Z');
    expect(todayKey(d)).toBe('2026-04-25');
  });
});

describe('relativeFromNow', () => {
  it('describes future and past', () => {
    const future = new Date(Date.now() + 5 * 86_400_000);
    expect(relativeFromNow(future)).toMatch(/in /);
    const past = new Date(Date.now() - 5 * 86_400_000);
    expect(relativeFromNow(past)).toMatch(/ ago/);
  });
});
