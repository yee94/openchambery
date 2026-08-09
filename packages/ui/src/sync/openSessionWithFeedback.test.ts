import { beforeEach, describe, expect, mock, test } from 'bun:test';

const calls = {
  toastError: [] as string[],
  setCurrentSession: [] as Array<[string, string]>,
  setActiveMainTab: [] as string[],
  openSessionMobile: [] as Array<{ sessionId: string; directory: string }>,
  setActiveMainTabResult: true as boolean,
};

mock.module('@/components/ui', () => ({
  toast: {
    error: (msg: string) => {
      calls.toastError.push(msg);
    },
    success: () => {},
    info: () => {},
  },
}));

mock.module('@/lib/i18n/store', () => ({
  useI18nStore: {
    getState: () => ({
      dictionary: {
        'sessions.toast.openFailed': 'Unable to load conversation {sessionId}',
        'sessions.toast.openFailedMissingDirectory':
          'Unable to load conversation {sessionId}. Workspace path is missing.',
        'sessions.toast.openFailedMissingSessionId':
          'Unable to open conversation. Session id is missing.',
      },
    }),
  },
  formatMessage: (
    dictionary: Record<string, string>,
    key: string,
    params?: Record<string, string | number>,
  ) => {
    let template = dictionary[key] ?? key;
    if (!params) return template;
    return template.replace(/\{([^{}]+)\}/g, (_m, raw) => {
      const value = params[String(raw).trim()];
      return value === null || value === undefined ? `{${raw}}` : String(value);
    });
  },
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      setCurrentSession: (id: string, dir: string) => {
        calls.setCurrentSession.push([id, dir]);
      },
    }),
  },
}));

mock.module('@/stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({
      setActiveMainTab: (tab: string) => {
        calls.setActiveMainTab.push(tab);
        return calls.setActiveMainTabResult;
      },
    }),
  },
}));

mock.module('@/mobile/useMobileNavigationStore', () => ({
  useMobileNavigationStore: {
    getState: () => ({
      openSession: (args: { sessionId: string; directory: string }) => {
        calls.openSessionMobile.push(args);
      },
    }),
  },
}));

mock.module('@/lib/platform', () => ({
  isIPadApp: () => false,
}));

const {
  formatSessionIdForDisplay,
  openSessionWithFeedback,
  notifySessionOpenFailed,
} = await import('./openSessionWithFeedback');

describe('openSessionWithFeedback', () => {
  beforeEach(() => {
    calls.toastError.length = 0;
    calls.setCurrentSession.length = 0;
    calls.setActiveMainTab.length = 0;
    calls.openSessionMobile.length = 0;
    calls.setActiveMainTabResult = true;
  });

  test('formatSessionIdForDisplay shortens long ids', () => {
    expect(formatSessionIdForDisplay('ses_short')).toBe('ses_short');
    const long = 'ses_01e172f6fffeKWSKyIoNw9hwsk';
    expect(formatSessionIdForDisplay(long).includes('…')).toBe(true);
    expect(formatSessionIdForDisplay(long).length < long.length).toBe(true);
  });

  test('missing session id shows toast and does not open', () => {
    const result = openSessionWithFeedback(null, '/repo');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing-session-id');
    expect(calls.toastError.length).toBe(1);
    expect(calls.setCurrentSession.length).toBe(0);
  });

  test('missing directory shows toast with session id', () => {
    const result = openSessionWithFeedback('ses_01e172f6fffeKWSKyIoNw9hwsk', '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing-directory');
    expect(calls.toastError.length).toBe(1);
    expect(calls.toastError[0]!.includes('ses_01e172')).toBe(true);
    expect(calls.setCurrentSession.length).toBe(0);
  });

  test('valid id+directory opens chat and sets session', () => {
    const result = openSessionWithFeedback('ses_abc', '/repo/app');
    expect(result).toEqual({ ok: true, sessionId: 'ses_abc', directory: '/repo/app' });
    expect(calls.setActiveMainTab).toEqual(['chat']);
    expect(calls.setCurrentSession).toEqual([['ses_abc', '/repo/app']]);
    expect(calls.toastError.length).toBe(0);
  });

  test('phoneShell uses mobile navigation store', () => {
    openSessionWithFeedback('ses_phone', '/repo', { phoneShell: true });
    expect(calls.openSessionMobile).toEqual([
      { sessionId: 'ses_phone', directory: '/repo' },
    ]);
    expect(calls.setCurrentSession.length).toBe(0);
  });

  test('notifySessionOpenFailed surfaces abbreviated id', () => {
    notifySessionOpenFailed('ses_01e172f6fffeKWSKyIoNw9hwsk', 'missing-directory');
    expect(calls.toastError.length).toBe(1);
  });
});
