import { describe, expect, test } from 'bun:test';

import { dict as enDict } from './i18n/messages/en';
import { dict as zhCnDict } from './i18n/messages/zh-CN';
import { canonicalizeBuiltInToolName, isHtmlFile, resolveToolDisplayName } from './toolHelpers';

describe('isHtmlFile', () => {
  test('recognizes html and htm paths', () => {
    expect(isHtmlFile('/tmp/report.html')).toBe(true);
    expect(isHtmlFile('index.HTM')).toBe(true);
    expect(isHtmlFile('/tmp/notes.md')).toBe(false);
    expect(isHtmlFile('/tmp/page.html.bak')).toBe(false);
  });
});

describe('resolveToolDisplayName', () => {
  test('canonicalizes indexed, dotted, and aliased built-in names', () => {
    expect(canonicalizeBuiltInToolName('runtime.grep:3')).toBe('grep');
    expect(canonicalizeBuiltInToolName('shell')).toBe('bash');
    expect(canonicalizeBuiltInToolName('patch')).toBe('apply_patch');
    expect(canonicalizeBuiltInToolName('StructuredOutput')).toBe('structuredoutput');
  });

  test('translates enumerable built-in tools and falls back for unknown names', () => {
    const tEn = (key: keyof typeof enDict) => enDict[key];
    const tZh = (key: keyof typeof zhCnDict) => zhCnDict[key];

    expect(resolveToolDisplayName('read', tEn)).toBe('Read File');
    expect(resolveToolDisplayName('runtime.grep:3', tZh)).toBe('搜索文件');
    expect(resolveToolDisplayName('shell', tZh)).toBe('运行');
    expect(resolveToolDisplayName('patch', tZh)).toBe('批量修改');
    expect(resolveToolDisplayName('execute', tZh)).toBe('执行代码');
    expect(resolveToolDisplayName('session_rename', tZh)).toBe('重命名会话');
    expect(resolveToolDisplayName('session_move', tEn)).toBe('Move Session');
    expect(resolveToolDisplayName('browser', tZh)).toBe('浏览器');
    expect(resolveToolDisplayName('mcp_custom_thing', tZh)).toBe('Mcp custom thing');
  });
});
