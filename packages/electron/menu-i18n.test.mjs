import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  DEFAULT_MENU_LOCALE,
  SUPPORTED_MENU_LOCALES,
  getMenuLabels,
  normalizeMenuLocale,
} from './menu-i18n.mjs';

test('supported locales match the UI runtime contract', () => {
  assert.deepEqual(SUPPORTED_MENU_LOCALES, [
    'en',
    'fr',
    'zh-CN',
    'zh-TW',
    'uk',
    'es',
    'pt-BR',
    'ko',
    'pl',
    'ja',
  ]);
  assert.equal(DEFAULT_MENU_LOCALE, 'en');
});

test('normalizeMenuLocale maps variants and falls back to English', () => {
  assert.equal(normalizeMenuLocale('en'), 'en');
  assert.equal(normalizeMenuLocale('en-US'), 'en');
  assert.equal(normalizeMenuLocale('zh-CN'), 'zh-CN');
  assert.equal(normalizeMenuLocale('zh'), 'zh-CN');
  assert.equal(normalizeMenuLocale('zh-Hans'), 'zh-CN');
  assert.equal(normalizeMenuLocale('zh-TW'), 'zh-TW');
  assert.equal(normalizeMenuLocale('zh_HK'), 'zh-TW');
  assert.equal(normalizeMenuLocale('zh-Hant'), 'zh-TW');
  assert.equal(normalizeMenuLocale('pt'), 'pt-BR');
  assert.equal(normalizeMenuLocale('pt-BR'), 'pt-BR');
  assert.equal(normalizeMenuLocale('ua'), 'uk');
  assert.equal(normalizeMenuLocale('fr-FR'), 'fr');
  assert.equal(normalizeMenuLocale('ja-JP'), 'ja');
  assert.equal(normalizeMenuLocale('not-a-locale'), 'en');
  assert.equal(normalizeMenuLocale(undefined), 'en');
  assert.equal(normalizeMenuLocale(null), 'en');
  assert.equal(normalizeMenuLocale(''), 'en');
});

test('getMenuLabels returns English for the default and invalid locales', () => {
  const en = getMenuLabels('en');
  const fallback = getMenuLabels('xx-YY');

  assert.equal(en.settings, 'Settings');
  assert.equal(en.newSession, 'New Session');
  assert.equal(en.aboutOpenChamber, 'About OpenChamber');
  assert.equal(en.newMiniChat, 'New Mini Chat');
  assert.equal(en.joinDiscord, 'Join Discord');
  assert.equal(en.trayUntitledSession, 'Untitled session');
  assert.equal(en.trayNeedsYourAttention, 'Needs your attention');
  assert.equal(en.trayUsageWithMode, 'Usage ({mode})');
  assert.equal(en.trayShowOpenChamber, 'Show OpenChamber');
  assert.equal(en.quit, 'Quit OpenChamber');
  assert.equal(fallback.settings, en.settings);
  assert.equal(fallback.newWindow, en.newWindow);
  assert.equal(fallback.file, 'File');
  assert.equal(fallback.help, 'Help');
  assert.equal(fallback.trayNoActiveSessions, en.trayNoActiveSessions);
});

test('getMenuLabels returns zh-CN translations for key menu and tray items', () => {
  const labels = getMenuLabels('zh-CN');

  assert.equal(labels.settings, '设置');
  assert.equal(labels.newSession, '新建会话');
  assert.equal(labels.newWindow, '新建窗口');
  assert.equal(labels.aboutOpenChamber, '关于 OpenChamber');
  assert.equal(labels.commandPalette, '命令面板');
  assert.equal(labels.toggleReviewPanel, '切换审阅面板');
  assert.equal(labels.keyboardShortcuts, '键盘快捷键');
  assert.equal(labels.newMiniChat, '新建 Mini Chat');
  assert.equal(labels.joinDiscord, '加入 Discord');
  assert.equal(labels.trayNeedsYourAttention, '需要你的注意');
  assert.equal(labels.trayAllowOnce, '允许一次');
  assert.equal(labels.trayNoActiveSessions, '暂无活动会话');
  assert.equal(labels.trayShowOpenChamber, '显示 OpenChamber');
  assert.equal(labels.trayMoreCount, '还有 {count} 项…');
  assert.notEqual(labels.settings, getMenuLabels('en').settings);
  assert.notEqual(labels.trayNeedsYourAttention, getMenuLabels('en').trayNeedsYourAttention);
});

test('getMenuLabels returns French translations for key menu and tray items', () => {
  const labels = getMenuLabels('fr');

  assert.equal(labels.settings, 'Réglages');
  assert.equal(labels.newSession, 'Nouvelle session');
  assert.equal(labels.newWindow, 'Nouvelle fenêtre');
  assert.equal(labels.file, 'Fichier');
  assert.equal(labels.help, 'Aide');
  assert.equal(labels.aboutOpenChamber, 'À propos d’OpenChamber');
  assert.equal(labels.commandPalette, 'Palette de commandes');
  assert.equal(labels.newMiniChat, 'Nouveau Mini Chat');
  assert.equal(labels.joinDiscord, 'Rejoindre Discord');
  assert.equal(labels.trayNeedsYourAttention, 'Nécessite votre attention');
  assert.equal(labels.trayAllowAlways, 'Toujours autoriser');
  assert.equal(labels.trayShowOpenChamber, 'Afficher OpenChamber');
  assert.equal(labels.trayUsageWithMode, 'Utilisation ({mode})');
  assert.notEqual(labels.settings, getMenuLabels('en').settings);
  assert.notEqual(labels.trayShowOpenChamber, getMenuLabels('en').trayShowOpenChamber);
});

test('every supported locale defines the full English label set including tray keys', () => {
  const englishKeys = Object.keys(getMenuLabels('en')).sort();
  const requiredTrayKeys = [
    'trayUntitledSession',
    'traySession',
    'trayPermissionRequest',
    'trayQuestion',
    'trayNeedsYourAttention',
    'trayAllowOnce',
    'trayAllowAlways',
    'trayDeny',
    'trayOpenInApp',
    'trayMoreCount',
    'traySessions',
    'trayNoActiveSessions',
    'trayRemaining',
    'trayUsed',
    'trayUsageWithMode',
    'trayShowOpenChamber',
    'trayTooltipEmpty',
    'trayTooltipAwaitingApproval',
    'trayTooltipWithErrors',
    'trayTooltipWorking',
    'trayTooltipUnread',
    'trayTooltipIdle',
    'trayTooltipSessionsOne',
    'trayTooltipSessionsMany',
  ];

  for (const key of requiredTrayKeys) {
    assert.ok(englishKeys.includes(key), `English labels missing tray key ${key}`);
  }

  for (const locale of SUPPORTED_MENU_LOCALES) {
    const labels = getMenuLabels(locale);
    assert.deepEqual(Object.keys(labels).sort(), englishKeys, `locale ${locale} is missing keys`);
    for (const key of englishKeys) {
      assert.equal(typeof labels[key], 'string', `${locale}.${key} must be a string`);
      assert.ok(labels[key].trim().length > 0, `${locale}.${key} must be non-empty`);
    }
  }
});
