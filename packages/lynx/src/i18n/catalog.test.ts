import { describe, expect, test } from 'vitest';

import { LYNX_LOCALES, LYNX_MESSAGES, lynxT, tabLabel } from './catalog';

describe('Lynx shell catalog', () => {
  test('every locale has a real translation for every key', () => {
    const keys = Object.keys(LYNX_MESSAGES.en);
    expect(LYNX_LOCALES).toHaveLength(10);
    for (const locale of LYNX_LOCALES) {
      expect(Object.keys(LYNX_MESSAGES[locale])).toEqual(keys);
      for (const key of keys) {
        const value = LYNX_MESSAGES[locale][key as keyof typeof LYNX_MESSAGES.en];
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });

  test('non-English locales do not paste the English stub sentences', () => {
    for (const locale of LYNX_LOCALES) {
      if (locale === 'en') continue;
      expect(LYNX_MESSAGES[locale]['lynx.shell.stub.body']).not.toBe(LYNX_MESSAGES.en['lynx.shell.stub.body']);
    }
  });

  test('tab labels reuse Cap mobile.tabs keys', () => {
    expect(tabLabel('zh-CN', 'projects')).toBe('项目');
    expect(lynxT('ja', 'mobile.tabs.assistant')).toBe('助手');
    expect(lynxT('en', 'mobile.nav.aria')).toBe('Mobile navigation');
  });
});
