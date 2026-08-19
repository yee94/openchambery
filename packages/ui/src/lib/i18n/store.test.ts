import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_LOCALE, type Locale } from './runtime';

const { shouldFailKo } = vi.hoisted(() => ({
  shouldFailKo: { value: false },
}));

vi.mock('./messages/ko', async (importOriginal) => {
  if (shouldFailKo.value) {
    throw new Error('forced dictionary load failure');
  }
  return importOriginal();
});
vi.mock('@/lib/i18n/messages/ko', async (importOriginal) => {
  if (shouldFailKo.value) {
    throw new Error('forced dictionary load failure');
  }
  return importOriginal();
});

const { resetI18nDictionaryCacheForTests, useI18nStore } = await import('./store');

const defaultDictionary = useI18nStore.getState().dictionary;

const resetStore = () => {
  resetI18nDictionaryCacheForTests();
  useI18nStore.setState({
    locale: DEFAULT_LOCALE,
    dictionary: defaultDictionary,
    loadingLocale: null,
  });
};

const waitForLocaleLoadToSettle = async (locale: Locale) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (useI18nStore.getState().loadingLocale !== locale) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${locale} dictionary load`);
};

describe('i18n store', () => {
  beforeEach(() => {
    shouldFailKo.value = false;
    resetStore();
  });

  afterAll(() => {
    shouldFailKo.value = false;
    resetStore();
  });

  test('retries loading the active locale when it is not cached', async () => {
    useI18nStore.setState({
      locale: 'es',
      dictionary: defaultDictionary,
      loadingLocale: null,
    });

    try {
      useI18nStore.getState().setLocale('es');

      expect(useI18nStore.getState().loadingLocale).toBe('es');
      await waitForLocaleLoadToSettle('es');
    } finally {
      resetStore();
    }
  });

  test('loads the french dictionary', async () => {
    try {
      useI18nStore.getState().setLocale('fr');

      expect(useI18nStore.getState().loadingLocale).toBe('fr');
      await waitForLocaleLoadToSettle('fr');
      expect(useI18nStore.getState().dictionary['common.language.french']).toBe('Français');
    } finally {
      resetStore();
    }
  });

  test('reports DEFAULT_LOCALE after a failed non-English dictionary load', async () => {
    shouldFailKo.value = true;

    try {
      useI18nStore.getState().setLocale('ko');

      expect(useI18nStore.getState().loadingLocale).toBe('ko');
      await waitForLocaleLoadToSettle('ko');
      expect(useI18nStore.getState().locale).toBe(DEFAULT_LOCALE);
      expect(useI18nStore.getState().dictionary).toBe(defaultDictionary);
      expect(useI18nStore.getState().loadingLocale).toBeNull();
    } finally {
      shouldFailKo.value = false;
      resetStore();
    }
  });
});
