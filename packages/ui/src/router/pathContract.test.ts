import { describe, expect, test } from 'bun:test';
import {
  SESSION_TOOL_TABS,
  buildNewSessionPath,
  buildSchedulePath,
  buildSessionPath,
  buildSettingsPath,
  normalizeSettingsSlug,
  normalizeWorkspaceTab,
  parseAppPath,
} from './pathContract';

describe('pathContract — session paths', () => {
  test('chat is default and does not occupy a path segment', () => {
    expect(buildSessionPath({ sessionId: 'abc' })).toBe('/session/abc');
    expect(buildSessionPath({ sessionId: 'abc', tab: 'chat' })).toBe('/session/abc');
  });

  test('session tool tabs under session', () => {
    for (const tab of SESSION_TOOL_TABS) {
      expect(buildSessionPath({ sessionId: 's1', tab })).toBe(`/session/s1/${tab}`);
    }
  });

  test('diff file search', () => {
    expect(
      buildSessionPath({ sessionId: 's1', tab: 'diff', file: 'src/main.ts' }),
    ).toBe('/session/s1/diff?file=src%2Fmain.ts');
  });

  test('illegal tab normalizes to chat', () => {
    expect(normalizeWorkspaceTab('nope')).toBe('chat');
    expect(buildSessionPath({ sessionId: 's1', tab: 'nope' as 'git' })).toBe('/session/s1');
  });

  test('new session path', () => {
    expect(buildNewSessionPath()).toBe('/session/new');
  });
});

describe('pathContract — exclusive primaries top-level', () => {
  test('schedule is top-level', () => {
    expect(buildSchedulePath()).toBe('/schedule');
    expect(buildSessionPath({ sessionId: 's1', tab: 'schedule' })).toBe('/schedule');
  });

  test('settings', () => {
    expect(buildSettingsPath('providers')).toBe('/settings/providers');
    expect(normalizeSettingsSlug('not-a-page')).toBe('home');
  });
});

describe('pathContract — parseAppPath', () => {
  test('parses session and top-level primaries', () => {
    expect(parseAppPath('/session/abc')).toEqual({
      kind: 'session',
      sessionId: 'abc',
      tab: 'chat',
      file: null,
      scope: null,
    });
    expect(parseAppPath('/schedule').kind).toBe('schedule');
    expect(parseAppPath('/assistant').kind).toBe('assistant');
    expect(parseAppPath('/settings/providers')).toEqual({
      kind: 'settings',
      slug: 'providers',
      entityId: null,
    });
    expect(parseAppPath('/session/new')).toEqual({ kind: 'new' });
    expect(parseAppPath('/new')).toEqual({ kind: 'new' });
  });

  test('legacy nested schedule under session promotes', () => {
    expect(parseAppPath('/session/abc/schedule').kind).toBe('schedule');
  });

  test('legacy query is unknown', () => {
    expect(parseAppPath('/?session=abc').kind).toBe('unknown');
  });
});
