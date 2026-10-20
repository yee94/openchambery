/**
 * Human relative time ("2 hours ago", "in 3 days") for compact list rows.
 *
 * Uses `Intl.RelativeTimeFormat` so every shipped locale reads naturally
 * without adding per-locale message keys.
 */
export type RelativeTimeBuckets = {
  justNowMinutes: number;
  minutes: number;
  hours: number;
  days: number;
  months: number;
};

/** Largest unit first: at or above the threshold, that unit is used. */
export const RELATIVE_TIME_BUCKETS: RelativeTimeBuckets = {
  justNowMinutes: 1,
  minutes: 60,
  hours: 24,
  days: 30,
  months: 12,
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;

/**
 * Formats `value` (ms epoch) relative to `now`. Anything inside the just-now
 * window reads as "just now" so rows do not flicker between "just now" and
 * "1 minute ago" while the list polls.
 */
export function formatRelativeTime(
  value: number | undefined | null,
  options: { now?: number; locale?: string; buckets?: RelativeTimeBuckets } = {},
): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const now = options.now ?? Date.now();
  const buckets = options.buckets ?? RELATIVE_TIME_BUCKETS;
  const diff = value - now;
  const abs = Math.abs(diff);

  const formatter = new Intl.RelativeTimeFormat(options.locale, { numeric: 'auto' });

  if (abs < buckets.justNowMinutes * MINUTE_MS) {
    return formatter.format(0, 'second');
  }
  if (abs < buckets.minutes * MINUTE_MS) {
    return formatter.format(Math.round(diff / MINUTE_MS), 'minute');
  }
  if (abs < buckets.hours * HOUR_MS) {
    return formatter.format(Math.round(diff / HOUR_MS), 'hour');
  }
  if (abs < buckets.days * DAY_MS) {
    return formatter.format(Math.round(diff / DAY_MS), 'day');
  }
  if (abs < buckets.months * MONTH_MS) {
    return formatter.format(Math.round(diff / MONTH_MS), 'month');
  }
  return formatter.format(Math.round(diff / (12 * MONTH_MS)), 'year');
}
