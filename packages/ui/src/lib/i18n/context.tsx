import React from 'react';

import { setDesktopMenuLocale } from '@/lib/desktopNative';
import { useI18nStore, formatMessage, type I18nKey, type I18nParams } from './store';
import { I18nContext, type I18nContextValue } from './react-context';
import { LOCALE_LABEL_KEYS, LOCALES } from './runtime';

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const locale = useI18nStore((state) => state.locale);
  const dictionary = useI18nStore((state) => state.dictionary);
  const loadingLocale = useI18nStore((state) => state.loadingLocale);
  const setLocale = useI18nStore((state) => state.setLocale);

  React.useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    document.documentElement.lang = locale;
  }, [locale]);

  // Native menu locale is local-shell only; remote/non-desktop calls are safely ignored by desktopNative.
  React.useEffect(() => {
    if (loadingLocale !== null) {
      return;
    }
    void setDesktopMenuLocale(locale);
  }, [locale, loadingLocale]);

  const value = React.useMemo<I18nContextValue>(() => {
    const t = (key: I18nKey, params?: I18nParams) => formatMessage(dictionary, key, params);
    return {
      locale,
      locales: LOCALES,
      setLocale,
      label: (targetLocale) => t(LOCALE_LABEL_KEYS[targetLocale]),
      t,
    };
  }, [dictionary, locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};
