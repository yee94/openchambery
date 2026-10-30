import { describe, expect, test } from 'vitest';

import { dict as enDict } from './messages/en';
import { dict as esDict } from './messages/es';
import { dict as frDict } from './messages/fr';
import { dict as jaDict } from './messages/ja';
import { dict as koDict } from './messages/ko';
import { dict as plDict } from './messages/pl';
import { dict as ptBrDict } from './messages/pt-BR';
import { dict as ukDict } from './messages/uk';
import { dict as zhCnDict } from './messages/zh-CN';
import { dict as zhTwDict } from './messages/zh-TW';
import { AVATAR_SHAPES } from '../assistant-avatar/recipe';

const localeDictionaries = {
  en: enDict,
  fr: frDict,
  es: esDict,
  ja: jaDict,
  'pt-BR': ptBrDict,
  uk: ukDict,
  ko: koDict,
  pl: plDict,
  'zh-CN': zhCnDict,
  'zh-TW': zhTwDict,
} as const;

describe('i18n dictionaries', () => {
  test('all locales stay in key parity with english', () => {
    const englishKeys = Object.keys(enDict).sort();

    for (const dictionary of Object.values(localeDictionaries)) {
      expect(Object.keys(dictionary).sort()).toEqual(englishKeys);
    }
  });

  test('all locales expose language label keys', () => {
    for (const [, dictionary] of Object.entries(localeDictionaries)) {
      expect(dictionary['common.language.french']).toBeTruthy();
      expect(dictionary['common.language.japanese']).toBeTruthy();
    }
  });

  test('every selectable avatar silhouette has a translated accessible name in every locale', () => {
    for (const dictionary of Object.values(localeDictionaries)) {
      for (const shape of AVATAR_SHAPES) {
        expect(dictionary[`assistants.avatar.shape.${shape}`]).toBeTruthy();
      }
    }
  });

  test('uses the organized display label in Chinese settings', () => {
    const key = 'settings.yuri.visual.option.chatRenderMode.sorted.label';
    expect(zhCnDict[key]).toBe('整理后显示');
    expect(zhTwDict[key]).toBe('整理後顯示');
  });

  test('names the contact feature Bots in English without renaming other locales or chat roles', () => {
    for (const key of ['assistants.title', 'settings.page.assistants.title', 'assistants.settings.listTitle', 'mobile.tabs.assistant'] as const) {
      expect(enDict[key]).toBe('Bots');
    }
    expect(enDict['assistants.settings.save']).toBe('Save bot');
    expect(enDict['assistants.settings.create']).toBe('New bot');
    expect(enDict['assistants.contact.card.assistant.aria']).toBe('Bot {name}');
    for (const [key, value] of Object.entries(enDict)) {
      if (key.startsWith('assistants.') || key === 'settings.page.assistants.title'
        || key.startsWith('settings.notifications.page.events.assistants')
        || key === 'settings.yuri.defaults.summary.providerDescription') {
        expect(value, key).not.toMatch(/\bassistan(?:ts?|ce)\b/i);
      }
    }
    expect(zhCnDict['assistants.title']).toBe('助理');
    expect(enDict['contextSidebar.breakdown.assistant']).toBe('Assistant');
    expect(enDict['commandPalette.message.assistant']).toBe('Assistant');
  });
});
