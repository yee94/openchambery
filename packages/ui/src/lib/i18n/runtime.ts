import '@/lib/brand-storage-bootstrap';
export type Locale = 'en' | 'fr' | 'zh-CN' | 'zh-TW' | 'uk' | 'es' | 'pt-BR' | 'ko' | 'pl' | 'ja';

export const LOCALES = ['en', 'fr', 'zh-CN', 'zh-TW', 'uk', 'es', 'pt-BR', 'ko', 'pl', 'ja'] as const satisfies readonly Locale[];

export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_LABEL_KEYS: Record<Locale, 'common.language.english' | 'common.language.french' | 'common.language.simplifiedChinese' | 'common.language.traditionalChinese' | 'common.language.ukrainian' | 'common.language.spanish' | 'common.language.brazilianPortuguese' | 'common.language.korean' | 'common.language.polish' | 'common.language.japanese'> = {
  en: 'common.language.english',
  fr: 'common.language.french',
  'zh-CN': 'common.language.simplifiedChinese',
  'zh-TW': 'common.language.traditionalChinese',
  uk: 'common.language.ukrainian',
  es: 'common.language.spanish',
  'pt-BR': 'common.language.brazilianPortuguese',
  ko: 'common.language.korean',
  pl: 'common.language.polish',
  ja: 'common.language.japanese',
};

export const LOCALE_STORAGE_KEY = 'yuri.i18n.v1';

type StoredLocale = {
  locale?: unknown;
};

function matchSupportedLocale(value: string | undefined | null): Locale | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.toLowerCase().replace(/_/g, '-');
  if (
    normalized === 'zh-tw'
    || normalized.startsWith('zh-tw-')
    || normalized === 'zh-hk'
    || normalized.startsWith('zh-hk-')
    || normalized === 'zh-mo'
    || normalized.startsWith('zh-mo-')
    || normalized === 'zh-hant'
    || normalized.startsWith('zh-hant-')
  ) {
    return 'zh-TW';
  }
  if (normalized.startsWith('zh')) {
    return 'zh-CN';
  }
  if (normalized.startsWith('en')) {
    return 'en';
  }
  if (normalized === 'fr' || normalized.startsWith('fr-')) {
    return 'fr';
  }
  if (normalized === 'uk' || normalized.startsWith('uk-') || normalized === 'ua' || normalized.startsWith('ua-')) {
    return 'uk';
  }
  if (normalized === 'es' || normalized.startsWith('es-')) {
    return 'es';
  }
  if (normalized === 'pt' || normalized.startsWith('pt-')) {
    return 'pt-BR';
  }
  if (normalized === 'ko' || normalized.startsWith('ko-')) {
    return 'ko';
  }
  if (normalized === 'ja' || normalized.startsWith('ja-')) {
    return 'ja';
  }
  if (normalized === 'pl' || normalized.startsWith('pl-')) {
    return 'pl';
  }
  return undefined;
}

export function normalizeLocale(value: string | undefined | null): Locale {
  return matchSupportedLocale(value) ?? DEFAULT_LOCALE;
}

function readStoredLocale(): Locale | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as StoredLocale;
    return typeof parsed.locale === 'string' ? normalizeLocale(parsed.locale) : undefined;
  } catch {
    return undefined;
  }
}

export function writeStoredLocale(locale: Locale): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, JSON.stringify({ locale }));
  } catch {
    return;
  }
}

export function detectInitialLocale(): Locale {
  const stored = readStoredLocale();
  if (stored) {
    return stored;
  }

  if (typeof navigator !== 'undefined') {
    try {
      const preferredLocales = [...(navigator.languages ?? []), navigator.language];
      for (const preferredLocale of preferredLocales) {
        const matched = matchSupportedLocale(preferredLocale);
        if (matched) {
          return matched;
        }
      }
    } catch {
      return DEFAULT_LOCALE;
    }
  }

  return DEFAULT_LOCALE;
}
