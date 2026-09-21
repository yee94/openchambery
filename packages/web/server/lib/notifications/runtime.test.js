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

  it('skips ready notifications for child sessions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      id: 'ses_child',
      parentID: 'ses_parent',
      title: 'Fixer',
      metadata: {},
    })));
    const { runtime, emitDesktopNotification, sendPushToAllUiSessions } = createRuntime();
    await runtime.maybeSendPushForTrigger(completionPayload('ses_child'));
    expect(emitDesktopNotification).not.toHaveBeenCalled();
    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
  });

  it('skips ready notifications for Assistant binding sessions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      id: 'ses_binding',
      parentID: null,
      title: '大小白',
      metadata: { openchamber: { assistant: { assistantID: 'asst_1', name: '大小白' } } },
    })));
    const { runtime, emitDesktopNotification, sendPushToAllUiSessions } = createRuntime();
    await runtime.maybeSendPushForTrigger(completionPayload('ses_binding'));
    expect(emitDesktopNotification).not.toHaveBeenCalled();
    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
  });

  it('skips ready notifications for scheduled-task sessions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      id: 'ses_sched',
      parentID: null,
      title: 'Nightly',
      metadata: { openchamber: { scheduledTask: { taskID: 'task_1' } } },
    })));
    const { runtime, emitDesktopNotification, sendPushToAllUiSessions } = createRuntime();
    await runtime.maybeSendPushForTrigger(completionPayload('ses_sched'));
    expect(emitDesktopNotification).not.toHaveBeenCalled();
    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
  });

  it('still notifies contact-assigned worker sessions that appear in the sidebar', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      id: 'ses_worker',
      parentID: null,
      title: 'Assigned work',
      metadata: { openchamber: { assigned: { from: 'contact', assistantID: 'asst_1', name: '大小白' } } },
    })));
    const { runtime, emitDesktopNotification, sendPushToAllUiSessions } = createRuntime();
    await runtime.maybeSendPushForTrigger(completionPayload('ses_worker'));
    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    expect(sendPushToAllUiSessions).toHaveBeenCalledTimes(1);
  });
});

describe('notification trigger runtime llm system-session suppression', () => {
  const llmSessionResponse = (purpose = 'chat-completions') => jsonResponse({
    id: 'ses_llm',
    parentID: null,
    title: '[openchamber-llm] generate',
    metadata: { openchamber: { llm: { purpose } } },
  });

  const expectAllOutletsSilent = ({
    emitDesktopNotification,
    broadcastUiNotification,
    sendPushToAllUiSessions,
    sendApnsToAllUiSessions,
    sendLiveActivityEnd,
  }) => {
    expect(emitDesktopNotification).not.toHaveBeenCalled();
    expect(broadcastUiNotification).not.toHaveBeenCalled();
    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
    expect(sendApnsToAllUiSessions).not.toHaveBeenCalled();
    expect(sendLiveActivityEnd).not.toHaveBeenCalled();
  };

  it('skips ready notifications for llm sessions fetched by id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => llmSessionResponse()));
    const outlets = createRuntime();
    await outlets.runtime.maybeSendPushForTrigger(completionPayload('ses_llm'));
    expectAllOutletsSilent(outlets);
  });

  it('skips ready notifications synthesized from session.idle for llm sessions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => llmSessionResponse()));
    const outlets = createRuntime();
    await outlets.runtime.maybeSendPushForTrigger({
      type: 'session.idle',
      properties: {
        directory: '/repo',
        sessionID: 'ses_llm',
      },
    });
    expectAllOutletsSilent(outlets);
  });

  it('skips error notifications and live-activity end for llm sessions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => llmSessionResponse()));
    const outlets = createRuntime();
    await outlets.runtime.maybeSendPushForTrigger({
      type: 'session.error',
      properties: {
        directory: '/repo',
        sessionID: 'ses_llm',
        error: 'boom',
      },
    });
    expectAllOutletsSilent(outlets);
  });

  it('skips question notifications for llm sessions', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => llmSessionResponse()));
    const outlets = createRuntime();
    await outlets.runtime.maybeSendPushForTrigger({
      type: 'question.asked',
      properties: {
        directory: '/repo',
        sessionID: 'ses_llm',
        questions: [{ header: 'Input needed', question: 'Continue?' }],
      },
    });
    await vi.runAllTimersAsync();
    expectAllOutletsSilent(outlets);
  });

  it('skips permission notifications for llm sessions', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => llmSessionResponse()));
    const outlets = createRuntime();
    await outlets.runtime.maybeSendPushForTrigger({
      type: 'permission.asked',
      properties: {
        directory: '/repo',
        sessionID: 'ses_llm',
        id: 'perm_llm',
        permission: 'edit',
      },
    });
    await vi.runAllTimersAsync();
    expectAllOutletsSilent(outlets);
  });

  it('uses session.updated event cache so later idle stays suppressed without llm on fetch', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      id: 'ses_llm',
      parentID: null,
      title: 'Ordinary after strip',
      metadata: {},
    }));
    vi.stubGlobal('fetch', fetchMock);
    const outlets = createRuntime();
    await outlets.runtime.maybeSendPushForTrigger({
      type: 'session.updated',
      properties: {
        directory: '/repo',
        info: {
          id: 'ses_llm',
          sessionID: 'ses_llm',
          parentID: null,
          title: '[openchamber-llm] generate',
          metadata: { openchamber: { llm: { purpose: 'chat-completions' } } },
        },
      },
    });
    await outlets.runtime.maybeSendPushForTrigger({
      type: 'session.idle',
      properties: {
        directory: '/repo',
        sessionID: 'ses_llm',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expectAllOutletsSilent(outlets);
  });

  it('does not treat empty llm.purpose as a hidden system session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      id: 'ses_llm_empty',
      parentID: null,
      title: 'Looks like llm',
      metadata: { openchamber: { llm: { purpose: '' } } },
    })));
    const {
      runtime,
      emitDesktopNotification,
      sendPushToAllUiSessions,
      sendApnsToAllUiSessions,
      sendLiveActivityEnd,
    } = createRuntime();
    await runtime.maybeSendPushForTrigger(completionPayload('ses_llm_empty'));
    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    expect(sendPushToAllUiSessions).toHaveBeenCalledTimes(1);
    expect(sendApnsToAllUiSessions).toHaveBeenCalledTimes(1);
    expect(sendLiveActivityEnd).toHaveBeenCalledWith({ sessionId: 'ses_llm_empty', status: 'complete' });
  });
});

const rootSessionResponse = (sessionId = 'ses_root') => jsonResponse({
  id: sessionId,
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

describe('contact turn notifications', () => {
  it('sends an SMS-style title and body when a contact turn completes', async () => {
    const { runtime, emitDesktopNotification, broadcastUiNotification, sendPushToAllUiSessions, sendApnsToAllUiSessions } = createRuntime();
    await runtime.sendContactTurnNotification({
      assistantID: 'asst_1',
      name: '大小白',
      body: '我去找一下',
      status: 'complete',
    });
    expect(emitDesktopNotification).toHaveBeenCalledWith(expect.objectContaining({
      title: '大小白',
      body: '我去找一下',
      tag: 'contact-asst_1',
      kind: 'contact',
      assistantID: 'asst_1',
    }));
    expect(broadcastUiNotification).toHaveBeenCalled();
    expect(sendPushToAllUiSessions).toHaveBeenCalledWith(expect.objectContaining({
      title: '大小白',
      body: '我去找一下',
      data: expect.objectContaining({ assistantID: 'asst_1', type: 'contact', url: '/assistant/asst_1' }),
    }), expect.objectContaining({ requireNoSse: true, preserveAlert: true }));
    expect(sendApnsToAllUiSessions).toHaveBeenCalledWith(expect.objectContaining({
      title: '大小白',
      body: '我去找一下',
      data: expect.objectContaining({
        assistantID: 'asst_1',
        url: 'openchamber://assistant/asst_1',
      }),
    }), expect.objectContaining({ preserveAlert: true }));
    expect(sendApnsToAllUiSessions.mock.calls[0][0].type).toBeUndefined();
  });

  it('skips contact notifications when assistant notices are disabled', async () => {
    const { runtime, emitDesktopNotification, sendPushToAllUiSessions } = createRuntime({
      readSettingsFromDisk: vi.fn(async () => ({ ...defaultSettings, notifyOnAssistants: false })),
    });
    await runtime.sendContactTurnNotification({
      assistantID: 'asst_1',
      name: '大小白',
      body: 'hi',
      status: 'complete',
    });
    expect(emitDesktopNotification).not.toHaveBeenCalled();
    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
  });

  it('keeps contact notifications on when only completion notices are disabled', async () => {
    const { runtime, emitDesktopNotification } = createRuntime({
      readSettingsFromDisk: vi.fn(async () => ({ ...defaultSettings, notifyOnCompletion: false })),
    });
    await runtime.sendContactTurnNotification({
      assistantID: 'asst_1',
      name: '大小白',
      body: 'hi',
      status: 'complete',
    });
    expect(emitDesktopNotification).toHaveBeenCalled();
  });
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

  it('still sends native push when another client is visible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rootSessionResponse()));
    const { runtime, sendLiveActivityEnd, sendApnsToAllUiSessions, sendPushToAllUiSessions } = createRuntime();
    await runtime.maybeSendPushForTrigger(completionPayload());
    expect(sendLiveActivityEnd).toHaveBeenCalledWith({ sessionId: 'ses_root', status: 'complete' });
    expect(sendPushToAllUiSessions).toHaveBeenCalledTimes(1);
    expect(sendApnsToAllUiSessions).toHaveBeenCalledTimes(1);
  });

  it('does not patch live activity titles for child sessions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      id: 'ses_child',
      parentID: 'ses_parent',
      metadata: {},
    })));
    const { runtime, sendLiveActivityEnd } = createRuntime();
    await runtime.maybeSendPushForTrigger({
      type: 'session.updated',
      properties: {
        directory: '/repo',
        info: {
          id: 'ses_child',
          sessionID: 'ses_child',
          parentID: 'ses_parent',
          title: 'Fixer',
        },
      },
    });
    expect(sendLiveActivityEnd).not.toHaveBeenCalled();
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

describe('notification event toggles', () => {
  it('skips permission notifications when permission notices are disabled', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => rootSessionResponse('ses_perm_toggle')));
    const { runtime, emitDesktopNotification, sendPushToAllUiSessions } = createRuntime({
      readSettingsFromDisk: vi.fn(async () => ({ ...defaultSettings, notifyOnPermission: false })),
    });
    await runtime.maybeSendPushForTrigger({
      type: 'permission.asked',
      properties: {
        directory: '/repo',
        sessionID: 'ses_perm_toggle',
        id: 'perm_1',
        permission: 'edit',
      },
    });
    await vi.runAllTimersAsync();
    expect(emitDesktopNotification).not.toHaveBeenCalled();
    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
  });

  it('keeps permission notifications independent of the question toggle', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => rootSessionResponse('ses_perm_indep')));
    const { runtime, emitDesktopNotification } = createRuntime({
      readSettingsFromDisk: vi.fn(async () => ({ ...defaultSettings, notifyOnQuestion: false })),
    });
    await runtime.maybeSendPushForTrigger({
      type: 'permission.asked',
      properties: {
        directory: '/repo',
        sessionID: 'ses_perm_indep',
        id: 'perm_2',
        permission: 'edit',
      },
    });
    await vi.runAllTimersAsync();
    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    expect(emitDesktopNotification.mock.calls[0][0]).toMatchObject({ kind: 'permission' });
  });

  it('skips goal settle push when goal notices are disabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ id: 'ses_goal', title: 'Goal run' })));
    const { runtime, sendPushToAllUiSessions } = createRuntime({
      readSettingsFromDisk: vi.fn(async () => ({ ...defaultSettings, notifyOnGoals: false })),
    });
    await runtime.sendGoalSettlePush({
      sessionId: 'ses_goal',
      status: 'complete',
      title: 'Goal completed',
      body: 'all done',
    });
    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
  });

  it('still sends goal settle push by default', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ id: 'ses_goal', title: 'Goal run' })));
    const { runtime, sendPushToAllUiSessions } = createRuntime();
    await runtime.sendGoalSettlePush({
      sessionId: 'ses_goal',
      status: 'complete',
      title: 'Goal completed',
      body: 'all done',
    });
    expect(sendPushToAllUiSessions).toHaveBeenCalledTimes(1);
    expect(sendPushToAllUiSessions.mock.calls[0][0]).toMatchObject({ tag: 'goal-ses_goal' });
  });
});

describe('scheduled task run notifications', () => {
  it('notifies on a scheduled success run across desktop, UI, and push channels', async () => {
    const { runtime, emitDesktopNotification, broadcastUiNotification, sendPushToAllUiSessions, sendApnsToAllUiSessions } = createRuntime();
    await runtime.sendScheduledTaskRunNotification({
      projectID: 'proj_1',
      taskID: 'task_1',
      taskName: 'Nightly digest',
      status: 'success',
      sessionId: 'ses_task',
      reason: 'scheduled',
    });
    expect(emitDesktopNotification).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'task-complete',
      title: 'Scheduled task completed',
      body: 'Nightly digest',
      tag: 'scheduled-proj_1-task_1',
    }));
    expect(broadcastUiNotification).toHaveBeenCalledTimes(1);
    expect(sendPushToAllUiSessions).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Scheduled task completed',
      data: expect.objectContaining({ type: 'task_complete', sessionName: 'Nightly digest', sessionId: 'ses_task' }),
    }), expect.objectContaining({ requireNoSse: true }));
    expect(sendApnsToAllUiSessions).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task_complete',
      sessionName: 'Nightly digest',
    }), expect.objectContaining({ requireNoSse: true }));
  });

  it('includes the error text on failure for desktop/web push only', async () => {
    const { runtime, emitDesktopNotification, sendPushToAllUiSessions, sendApnsToAllUiSessions } = createRuntime();
    await runtime.sendScheduledTaskRunNotification({
      projectID: 'proj_1',
      taskID: 'task_1',
      taskName: 'Nightly digest',
      status: 'error',
      reason: 'scheduled',
      errorMessage: 'agent aborted',
    });
    expect(emitDesktopNotification).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'task-error',
      body: 'Nightly digest: agent aborted',
    }));
    expect(sendPushToAllUiSessions).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Scheduled task failed',
      body: 'Nightly digest: agent aborted',
      data: expect.objectContaining({ type: 'task_error' }),
    }), expect.anything());
    // APNs keeps the generic contract: scenario title + task name only, no error text.
    expect(sendApnsToAllUiSessions).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task_error',
      sessionName: 'Nightly digest',
    }), expect.anything());
    expect(JSON.stringify(sendApnsToAllUiSessions.mock.calls[0][0])).not.toContain('agent aborted');
  });

  it('skips manual runs and the disabled toggle', async () => {
    const { runtime, emitDesktopNotification, sendPushToAllUiSessions } = createRuntime();
    await runtime.sendScheduledTaskRunNotification({
      projectID: 'proj_1',
      taskID: 'task_1',
      taskName: 'Nightly digest',
      status: 'success',
      reason: 'manual',
    });
    expect(emitDesktopNotification).not.toHaveBeenCalled();

    const disabled = createRuntime({
      readSettingsFromDisk: vi.fn(async () => ({ ...defaultSettings, notifyOnScheduledTasks: false })),
    });
    await disabled.runtime.sendScheduledTaskRunNotification({
      projectID: 'proj_1',
      taskID: 'task_1',
      taskName: 'Nightly digest',
      status: 'success',
      reason: 'scheduled',
    });
    expect(disabled.emitDesktopNotification).not.toHaveBeenCalled();
    expect(disabled.sendPushToAllUiSessions).not.toHaveBeenCalled();
  });
});
