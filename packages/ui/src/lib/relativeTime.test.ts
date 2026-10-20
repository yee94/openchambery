import { describe, expect, it } from 'vitest';

import { formatRelativeTime } from './relativeTime';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const ago = (ms: number) => NOW - ms;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatRelativeTime', () => {
  it('returns an empty string for missing or invalid input', () => {
    expect(formatRelativeTime(undefined, { now: NOW, locale: 'en' })).toBe('');
    expect(formatRelativeTime(null, { now: NOW, locale: 'en' })).toBe('');
    expect(formatRelativeTime(Number.NaN, { now: NOW, locale: 'en' })).toBe('');
  });

  it('collapses the just-now window instead of flickering to "1 minute ago"', () => {
    expect(formatRelativeTime(ago(20_000), { now: NOW, locale: 'en' })).toBe('now');
    expect(formatRelativeTime(ago(59_000), { now: NOW, locale: 'en' })).toBe('now');
  });

  it('reports minutes, hours, days and months', () => {
    expect(formatRelativeTime(ago(5 * MINUTE), { now: NOW, locale: 'en' })).toBe('5 minutes ago');
    expect(formatRelativeTime(ago(2 * HOUR), { now: NOW, locale: 'en' })).toBe('2 hours ago');
    expect(formatRelativeTime(ago(3 * DAY), { now: NOW, locale: 'en' })).toBe('3 days ago');
    expect(formatRelativeTime(ago(31 * DAY), { now: NOW, locale: 'en' })).toBe('last month');
  });

  it('follows the requested locale', () => {
    expect(formatRelativeTime(ago(2 * HOUR), { now: NOW, locale: 'zh-CN' })).toBe('2小时前');
    expect(formatRelativeTime(ago(3 * DAY), { now: NOW, locale: 'zh-CN' })).toBe('3天前');
  });

  it('formats future values as a countdown', () => {
    expect(formatRelativeTime(NOW + 5 * MINUTE, { now: NOW, locale: 'en' })).toBe('in 5 minutes');
  });
});
