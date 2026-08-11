import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { DEFAULT_LOCALE, type Locale } from './runtime';
import { resetI18nDictionaryCacheForTests, useI18nStore } from './store';

const defaultDictionary = useI18nStore.getState().dictionary;

const resetStore = () => {
  resetI18nDictionaryCacheForTests();
  useI18nStore.setState({
    locale: DEFAULT_LOCALE,
    dictionary: defaultDictionary,
    loadingLocale: null,
  });
};

/**
 * Bun's throw-style mock.module leaves the bare specifier empty after mock.restore().
 * Reinstall the real dictionary export (captured via a query-bypassed import) and keep
 * that mock active so sibling suites like messages.test.ts can still import `dict`.
 */
const reinstallRealKoModule = async () => {
  const realKo = await import(`./messages/ko?__i18n_store_test_restore=${Date.now()}`);
  mock.module('./messages/ko', () => ({ dict: realKo.dict }));
};

const waitForLocaleLoadToSettle = async (locale: Locale) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (useI18nStore.getState().loadingLocale !== locale) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${locale} dictionary load`);
};

describe('i18n store', () => {
  beforeEach(resetStore);

  afterAll(async () => {
    await reinstallRealKoModule();
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
    // Throw at import time so setLocale's loadDictionary promise rejects into the catch path.
    // Do not call mock.restore() alone afterward — it poisons the bare ./messages/ko export.
    mock.module('./messages/ko', () => {
      throw new Error('forced dictionary load failure');
    });

    try {
      useI18nStore.getState().setLocale('ko');

      expect(useI18nStore.getState().loadingLocale).toBe('ko');
      await waitForLocaleLoadToSettle('ko');
      expect(useI18nStore.getState().locale).toBe(DEFAULT_LOCALE);
      expect(useI18nStore.getState().dictionary).toBe(defaultDictionary);
      expect(useI18nStore.getState().loadingLocale).toBeNull();
    } finally {
      await reinstallRealKoModule();
      resetStore();
    }
  });
});
