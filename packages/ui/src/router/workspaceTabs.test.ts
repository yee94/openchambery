import { describe, expect, test } from 'bun:test';
import { serializeAppPath } from '@/lib/router/serializeRoute';
import type { AppRouteState } from '@/lib/router/serializeRoute';
import { SESSION_TOOL_TABS } from './pathContract';
import { routeStateFromPath } from '@/lib/router/parseRoute';

const base = (over: Partial<AppRouteState> = {}): AppRouteState => ({
  sessionId: 'ses_1',
  tab: 'chat',
  isSettingsOpen: false,
  settingsPath: 'home',
  diffFile: null,
  ...over,
});

describe('session tools under /session only', () => {
  test('session tools serialize under session id', () => {
    for (const tab of SESSION_TOOL_TABS) {
      expect(serializeAppPath(base({ tab }))).toBe(`/session/ses_1/${tab}`);
    }
  });

  test('schedule and assistant are top-level (no session id)', () => {
    expect(serializeAppPath(base({ tab: 'schedule', sessionId: 'ses_1' }))).toBe('/schedule');
    expect(serializeAppPath(base({ tab: 'assistant', sessionId: 'ses_1' }))).toBe('/assistant');
    expect(serializeAppPath(base({ tab: 'schedule', scheduleView: 'history' }))).toBe(
      '/schedule/history',
    );
  });

  test('chat is default; legacy /plan segment silently falls back to chat', () => {
    expect(serializeAppPath(base({ tab: 'chat' }))).toBe('/session/ses_1');
    // plan feature is removed — /plan path segment normalizes to chat (tab null in route state).
    expect(routeStateFromPath('/session/ses_1/plan').tab).toBeNull();
  });

  test('parse top-level schedule does not attach sessionId', () => {
    expect(routeStateFromPath('/schedule').sessionId).toBeNull();
    expect(routeStateFromPath('/schedule').tab).toBe('schedule');
    expect(routeStateFromPath('/assistant').tab).toBe('assistant');
  });
});
