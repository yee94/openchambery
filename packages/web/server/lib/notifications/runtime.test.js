import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNotificationTriggerRuntime } from './runtime.js';

const defaultSettings = {
  notifyOnCompletion: true,
  notifyOnQuestion: true,
  notificationMode: 'always',
  nativeNotificationsEnabled: true,
};

const createRuntime = (overrides = {}) => {
  const emitDesktopNotification = vi.fn(() => true);
  const broadcastUiNotification = vi.fn();
  const sendPushToAllUiSessions = vi.fn(async () => {});
  const sendApnsToAllUiSessions = vi.fn(async () => {});
  const sendLiveActivityEnd = vi.fn(async () => {});
  const runtime = createNotificationTriggerRuntime({
    readSettingsFromDisk: vi.fn(async () => defaultSettings),
    prepareNotificationLastMessage: vi.fn(async ({ message }) => message || ''),
    buildTemplateVariables: vi.fn(async () => ({ session_name: 'Session' })),
    extractLastMessageText: vi.fn(() => ''),
    fetchLastAssistantMessageText: vi.fn(async () => ''),
    resolveNotificationTemplate: vi.fn((template) => template),
    shouldApplyResolvedTemplateMessage: vi.fn(() => true),
    emitDesktopNotification,
    broadcastUiNotification,
    sendPushToAllUiSessions,
    sendApnsToAllUiSessions,
    sendLiveActivityEnd,
    isAnyInteractiveClientVisible: () => false,
    buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    getIsWindowFocused: () => false,
    ...overrides,
  });
  return {
    runtime,
    emitDesktopNotification,
    broadcastUiNotification,
    sendPushToAllUiSessions,
    sendApnsToAllUiSessions,
    sendLiveActivityEnd,
  };
};

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('notification trigger runtime smallModel suppression', () => {
  it('skips ready notifications for smallModel sessions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      id: 'ses_small',
      parentID: null,
      metadata: { openchamber: { smallModel: { purpose: 'session-title' } } },
    })));

    const { runtime, emitDesktopNotification, sendPushToAllUiSessions } = createRuntime();
    await runtime.maybeSendPushForTrigger({
      type: 'message.updated',
      properties: {
        directory: '/repo',
        info: {
          id: 'msg_1',
          sessionID: 'ses_small',
          role: 'assistant',
          finish: 'stop',
          mode: 'build',
          modelID: 'small',
        },
      },
    });

    expect(emitDesktopNotification).not.toHaveBeenCalled();
    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
  });

  it('skips ready notifications synthesized from session.idle for smallModel sessions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      id: 'ses_small',
      parentID: null,
      metadata: { openchamber: { smallModel: { purpose: 'commit' } } },
    })));

    const { runtime, emitDesktopNotification, sendPushToAllUiSessions } = createRuntime();
    await runtime.maybeSendPushForTrigger({
      type: 'session.idle',
      properties: {
        directory: '/repo',
        sessionID: 'ses_small',
      },
    });

    expect(emitDesktopNotification).not.toHaveBeenCalled();
    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
  });

  it('skips question notifications for smallModel sessions', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      id: 'ses_small',
      parentID: null,
      metadata: { openchamber: { smallModel: { purpose: 'session-title' } } },
    })));

    const { runtime, emitDesktopNotification, sendPushToAllUiSessions } = createRuntime();
    await runtime.maybeSendPushForTrigger({
      type: 'question.asked',
      properties: {
        directory: '/repo',
        sessionID: 'ses_small',
        questions: [{ header: 'Input needed', question: 'Continue?' }],
      },
    });
    await vi.runAllTimersAsync();

    expect(emitDesktopNotification).not.toHaveBeenCalled();
    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
  });

  it('skips permission notifications for smallModel sessions', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      id: 'ses_small',
      parentID: null,
      metadata: { openchamber: { smallModel: { purpose: 'session-title' } } },
    })));

    const { runtime, emitDesktopNotification, sendPushToAllUiSessions } = createRuntime();
    await runtime.maybeSendPushForTrigger({
      type: 'permission.asked',
      properties: {
        directory: '/repo',
        sessionID: 'ses_small',
        id: 'perm_1',
        permission: 'edit',
      },
    });
    await vi.runAllTimersAsync();

    expect(emitDesktopNotification).not.toHaveBeenCalled();
    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
  });

  it('still notifies ordinary root sessions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      id: 'ses_root',
      parentID: null,
      title: 'Ordinary',
      metadata: {},
    })));

    const { runtime, emitDesktopNotification, sendPushToAllUiSessions } = createRuntime();
    await runtime.maybeSendPushForTrigger({
      type: 'message.updated',
      properties: {
        directory: '/repo',
        info: {
          id: 'msg_2',
          sessionID: 'ses_root',
          role: 'assistant',
          finish: 'stop',
          mode: 'build',
          modelID: 'gpt',
        },
      },
    });

    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    expect(sendPushToAllUiSessions).toHaveBeenCalledTimes(1);
  });
});

const rootSessionResponse = () => jsonResponse({
  id: 'ses_root',
  parentID: null,
  title: 'Ordinary',
  metadata: {},
});

const completionPayload = (sessionId = 'ses_root', finish = 'stop') => ({
  type: 'message.updated',
  properties: {
    directory: '/repo',
    info: {
      id: 'msg_2',
      sessionID: sessionId,
      role: 'assistant',
      finish,
      mode: 'build',
      modelID: 'gpt',
    },
  },
});

describe('notification trigger live activity end', () => {
  it('ends the live activity on top-level completion and error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rootSessionResponse()));
    const { runtime, sendLiveActivityEnd } = createRuntime();
    await runtime.maybeSendPushForTrigger(completionPayload('ses_root', 'stop'));
    await runtime.maybeSendPushForTrigger({
      type: 'session.error',
      properties: { directory: '/repo', sessionID: 'ses_err', error: 'boom' },
    });
    expect(sendLiveActivityEnd).toHaveBeenNthCalledWith(1, { sessionId: 'ses_root', status: 'complete' });
    expect(sendLiveActivityEnd).toHaveBeenNthCalledWith(2, { sessionId: 'ses_err', status: 'error' });
  });

  it('still ends the live activity when ordinary notifications are disabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rootSessionResponse()));
    const { runtime, sendLiveActivityEnd, sendPushToAllUiSessions, sendApnsToAllUiSessions } = createRuntime({
      readSettingsFromDisk: vi.fn(async () => ({ ...defaultSettings, notifyOnCompletion: false })),
    });
    await runtime.maybeSendPushForTrigger(completionPayload());
    expect(sendLiveActivityEnd).toHaveBeenCalledWith({ sessionId: 'ses_root', status: 'complete' });
    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
    expect(sendApnsToAllUiSessions).not.toHaveBeenCalled();
  });

  it('ends the live activity even when an interactive client is visible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rootSessionResponse()));
    const { runtime, sendLiveActivityEnd, sendApnsToAllUiSessions } = createRuntime({
      isAnyInteractiveClientVisible: () => true,
    });
    await runtime.maybeSendPushForTrigger(completionPayload());
    expect(sendLiveActivityEnd).toHaveBeenCalledWith({ sessionId: 'ses_root', status: 'complete' });
    expect(sendApnsToAllUiSessions).not.toHaveBeenCalled();
  });

  it('suppresses live activity end for child and small-model sessions', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('ses_child')) {
        return jsonResponse({ id: 'ses_child', parentID: 'ses_parent', metadata: {} });
      }
      return jsonResponse({
        id: 'ses_small',
        parentID: null,
        metadata: { openchamber: { smallModel: { purpose: 'session-title' } } },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { runtime, sendLiveActivityEnd, sendPushToAllUiSessions } = createRuntime();
    await runtime.maybeSendPushForTrigger(completionPayload('ses_child'));
    await runtime.maybeSendPushForTrigger(completionPayload('ses_small', 'error'));
    expect(sendLiveActivityEnd).not.toHaveBeenCalled();
    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
  });

  it('isolates live activity end failure from ordinary push', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rootSessionResponse()));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sendLiveActivityEnd = vi.fn(async () => {
      throw new Error('live-activity failed');
    });
    const { runtime, sendPushToAllUiSessions, sendApnsToAllUiSessions } = createRuntime({
      sendLiveActivityEnd,
    });
    try {
      await runtime.maybeSendPushForTrigger(completionPayload());
      expect(sendLiveActivityEnd).toHaveBeenCalledTimes(1);
      expect(sendPushToAllUiSessions).toHaveBeenCalledTimes(1);
      expect(sendApnsToAllUiSessions).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('repeats terminal delivery on duplicate completion events', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rootSessionResponse()));
    const { runtime, sendLiveActivityEnd } = createRuntime();
    await runtime.maybeSendPushForTrigger(completionPayload());
    await runtime.maybeSendPushForTrigger(completionPayload());
    expect(sendLiveActivityEnd).toHaveBeenCalledTimes(2);
    expect(sendLiveActivityEnd).toHaveBeenNthCalledWith(1, { sessionId: 'ses_root', status: 'complete' });
    expect(sendLiveActivityEnd).toHaveBeenNthCalledWith(2, { sessionId: 'ses_root', status: 'complete' });
  });
});
