import { afterEach, describe, expect, test } from 'vitest';

import {
  formatCompactNumber,
  formatCompactTokensShort,
  formatReleaseDate,
  formatTimelineDateGroup,
  formatTimelineMessageTime,
  formatUsdCurrency,
} from './intlFormatters';

const OriginalNumberFormat = Intl.NumberFormat;

afterEach(() => {
  Intl.NumberFormat = OriginalNumberFormat;
});

describe('intlFormatters', () => {
  test('reuses NumberFormat for the three fixed configs and invalidates on locale change', () => {
    let constructed = 0;
    Intl.NumberFormat = function NumberFormatSpy(
      this: Intl.NumberFormat,
      locales?: string | string[],
      options?: Intl.NumberFormatOptions,
    ) {
      constructed += 1;
      return new OriginalNumberFormat(locales, options);
    } as typeof Intl.NumberFormat;
    Object.defineProperty(Intl.NumberFormat, 'supportedLocalesOf', {
      value: OriginalNumberFormat.supportedLocalesOf.bind(OriginalNumberFormat),
    });

    // Unique locales avoid pollution from other modules that may have warmed the cache.
    const localeA = 'en-US-x-oc-fmt-a';
    const localeB = 'zh-CN-x-oc-fmt-b';

    formatCompactNumber(1_000, localeA);
    formatCompactNumber(2_000, localeA);
    formatCompactTokensShort(3_000, localeA);
    formatCompactTokensShort(4_000, localeA);
    formatUsdCurrency(1.23, localeA);
    formatUsdCurrency(4.56, localeA);
    expect(constructed).toBe(3);

    formatCompactNumber(5_000, localeB);
    formatCompactTokensShort(6_000, localeB);
    formatUsdCurrency(7.89, localeB);
    expect(constructed).toBe(6);

    formatCompactNumber(8_000, localeB);
    formatUsdCurrency(0.5, localeB);
    expect(constructed).toBe(6);
  });

  test('number helpers match direct Intl output for fixed options', () => {
    const locale = 'en-US';
    const value = 128_000;

    expect(formatCompactNumber(value, locale)).toBe(
      new Intl.NumberFormat(locale, {
        notation: 'compact',
        compactDisplay: 'short',
        maximumFractionDigits: 1,
        minimumFractionDigits: 0,
      }).format(value),
    );

    expect(formatCompactTokensShort(value, locale)).toBe(
      new Intl.NumberFormat(locale, {
        notation: 'compact',
        compactDisplay: 'short',
        maximumFractionDigits: 1,
      }).format(value),
    );

    expect(formatUsdCurrency(0.0123, locale)).toBe(
      new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 4,
        minimumFractionDigits: 2,
      }).format(0.0123),
    );
  });

  test('date helpers match per-call toLocale output (timezone-preserving, no formatter cache)', () => {
    const locale = 'en-US';
    const date = new Date(Date.UTC(2024, 5, 15, 14, 30));
    const ts = date.getTime();

    expect(formatReleaseDate(date, locale)).toBe(
      date.toLocaleDateString(locale, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
    );
    expect(formatTimelineDateGroup(ts, locale)).toBe(
      new Date(ts).toLocaleDateString(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }),
    );
    expect(formatTimelineMessageTime(ts, locale)).toBe(
      new Date(ts).toLocaleTimeString(locale, {
        hour: 'numeric',
        minute: '2-digit',
      }),
    );
  });
});
