import { describe, expect, it } from 'vitest';

import {
  APNS_DEFAULT_LOCALE,
  APNS_LOCALES,
  localizeApnsPayload,
  normalizeApnsLocale,
  resolveApnsSessionFallback,
  resolveApnsTitle,
} from './apns-titles.js';

describe('apns-titles', () => {
  it('normalizes BCP-47 tags onto supported app locales', () => {
    expect(normalizeApnsLocale('zh-Hans-CN')).toBe('zh-CN');
    expect(normalizeApnsLocale('zh_TW')).toBe('zh-TW');
    expect(normalizeApnsLocale('pt-PT')).toBe('pt-BR');
    expect(normalizeApnsLocale('ja-JP')).toBe('ja');
    expect(normalizeApnsLocale('nope')).toBe(APNS_DEFAULT_LOCALE);
    expect(normalizeApnsLocale(undefined)).toBe(APNS_DEFAULT_LOCALE);
  });

  it('resolves every scenario type for every supported locale', () => {
    const types = ['ready', 'error', 'question', 'permission', 'goal_complete', 'goal_blocked', 'goal_budget', 'update'];
    for (const locale of APNS_LOCALES) {
      for (const type of types) {
        const title = resolveApnsTitle(type, locale);
        expect(typeof title).toBe('string');
        expect(title.length).toBeGreaterThan(0);
      }
      expect(resolveApnsSessionFallback(locale).length).toBeGreaterThan(0);
    }
  });

  it('localizes payload title by type and keeps session name as body', () => {
    expect(localizeApnsPayload({ type: 'question', sessionName: 'Build fix' }, 'zh-CN')).toEqual({
      title: '智能体需要你的输入',
      body: 'Build fix',
      badge: undefined,
      tag: undefined,
      data: undefined,
    });
    expect(localizeApnsPayload({ type: 'ready' }, 'fr').body).toBe('Session');
    expect(localizeApnsPayload({ type: 'ready' }, 'zh-CN').body).toBe('会话');
  });

  it('keeps explicit legacy title/body when type is absent', () => {
    expect(localizeApnsPayload({ title: 'Custom', body: 'Body' }, 'ja')).toEqual({
      title: 'Custom',
      body: 'Body',
      badge: undefined,
      tag: undefined,
      data: undefined,
    });
  });
});
