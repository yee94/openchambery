import { describe, expect, test } from 'bun:test';

import { dict as enDict } from './i18n/messages/en';
import { dict as zhCnDict } from './i18n/messages/zh-CN';
import { canonicalizeBuiltInToolName, resolveToolDisplayName } from './toolHelpers';

describe('resolveToolDisplayName', () => {
  test('canonicalizes indexed, dotted, and aliased built-in names', () => {
    expect(canonicalizeBuiltInToolName('runtime.grep:3')).toBe('grep');
    expect(canonicalizeBuiltInToolName('shell')).toBe('bash');
    expect(canonicalizeBuiltInToolName('StructuredOutput')).toBe('structuredoutput');
  });

  test('translates enumerable built-in tools and falls back for unknown names', () => {
    const tEn = (key: keyof typeof enDict) => enDict[key];
    const tZh = (key: keyof typeof zhCnDict) => zhCnDict[key];

    expect(resolveToolDisplayName('read', tEn)).toBe('Read File');
    expect(resolveToolDisplayName('runtime.grep:3', tZh)).toBe('搜索文件');
    expect(resolveToolDisplayName('shell', tZh)).toBe('运行');
    expect(resolveToolDisplayName('mcp_custom_thing', tZh)).toBe('Mcp custom thing');
  });
});
