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
