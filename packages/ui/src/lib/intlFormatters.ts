import { getCurrentIntlLocale } from '@/lib/i18n';

/**
 * Fixed NumberFormat reuse for the three hot number configs (compact, compact-tokens-short, USD).
 * Locale change invalidates the slot cache. Date/time helpers intentionally format per call so
 * system timezone stays dynamic (caching DateTimeFormat would freeze resolvedOptions.timeZone).
 */

type NumberFormatKind = 'compact' | 'compactTokensShort' | 'usd';

const NUMBER_FORMAT_OPTIONS: Record<NumberFormatKind, Intl.NumberFormatOptions> = {
  compact: {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  },
  compactTokensShort: {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
  },
  usd: {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
    minimumFractionDigits: 2,
  },
};

let cachedLocale: string | null = null;
const numberFormatByKind: Partial<Record<NumberFormatKind, Intl.NumberFormat>> = {};

const getNumberFormat = (
  kind: NumberFormatKind,
  locale: string,
): Intl.NumberFormat => {
  if (cachedLocale !== locale) {
    cachedLocale = locale;
    numberFormatByKind.compact = undefined;
    numberFormatByKind.compactTokensShort = undefined;
    numberFormatByKind.usd = undefined;
  }

  const existing = numberFormatByKind[kind];
  if (existing) return existing;

  const created = new Intl.NumberFormat(locale, NUMBER_FORMAT_OPTIONS[kind]);
  numberFormatByKind[kind] = created;
  return created;
};

export const formatCompactNumber = (
  value: number,
  locale: string = getCurrentIntlLocale(),
): string => getNumberFormat('compact', locale).format(value);

/** Mobile model row context label — matches prior `maximumFractionDigits: 1` only options. */
export const formatCompactTokensShort = (
  value: number,
  locale: string = getCurrentIntlLocale(),
): string => getNumberFormat('compactTokensShort', locale).format(value);

export const formatUsdCurrency = (
  value: number,
  locale: string = getCurrentIntlLocale(),
): string => getNumberFormat('usd', locale).format(value);

/** Per-call date format — preserves live system timezone (no DateTimeFormat cache). */
export const formatReleaseDate = (
  value: Date,
  locale: string = getCurrentIntlLocale(),
): string => value.toLocaleDateString(locale, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** Per-call timeline day group — preserves live system timezone. */
export const formatTimelineDateGroup = (
  timestamp: number,
  locale: string = getCurrentIntlLocale(),
): string => new Date(timestamp).toLocaleDateString(locale, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

/** Per-call timeline message time — preserves live system timezone. */
export const formatTimelineMessageTime = (
  timestamp: number,
  locale: string = getCurrentIntlLocale(),
): string => new Date(timestamp).toLocaleTimeString(locale, {
  hour: 'numeric',
  minute: '2-digit',
});
