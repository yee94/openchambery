export const assistantContractFixtures = Object.freeze({
  assistant: Object.freeze({
    id: 'assistant_fixture',
    revision: 4,
    enabled: true,
    name: 'Fixture',
    defaultPrompt: '',
    workspacePath: null,
    managedWorkspacePath: '/data/assistant-workspaces/assistant_fixture',
    effectiveWorkspacePath: '/workspace',
    providerID: 'provider_fixture',
    modelID: 'model_fixture',
    agent: null,
    variant: null,
    mode: 'continuous',
    sessionID: 'ses_fixture',
    sessionGeneration: 4,
    historySessionIDs: Object.freeze([]),
    historySessionCount: 0,
    assignedSessionIDs: Object.freeze([]),
    working: false,
    activeContactTurn: null,
    /** Last visible contact bubble for list desc; null when transcript empty. */
    latestMessagePreview: Object.freeze({
      messageID: 'msg_contact_fixture',
      ordinal: 2,
      role: 'assistant',
      text: 'Fixture reply',
      fallbackKind: null,
    }),
    /** Countable assistant/peer replies after the shared read watermark. */
    unreadCount: 0,
    /** Persisted shared read watermark (multi-client). */
    readWatermark: Object.freeze({
      generation: 0,
      ordinal: 2,
      messageID: 'msg_contact_fixture',
    }),
    /** Highest safe mark-read tip (transcript head + generation). */
    readTip: Object.freeze({
      generation: 0,
      ordinal: 2,
      messageID: 'msg_contact_fixture',
    }),
    createdAt: 1234,
    updatedAt: 1234,
    tombstoneAt: null,
  }),
  /** Frozen POST /assistants/:id/contact/read response. */
  contactReadResponse: Object.freeze({
    assistantID: 'assistant_fixture',
    changed: true,
    unreadCount: 0,
    readWatermark: Object.freeze({
      generation: 0,
      ordinal: 2,
      messageID: 'msg_contact_fixture',
    }),
    readTip: Object.freeze({
      generation: 0,
      ordinal: 2,
      messageID: 'msg_contact_fixture',
    }),
    revision: 4,
  }),
  sessionBinding: Object.freeze({ sessionID: 'ses_fixture', directory: '/workspace', sessionGeneration: 4 }),
  compactResponse: Object.freeze({ binding: Object.freeze({ sessionID: 'ses_fixture', directory: '/workspace', sessionGeneration: 4 }), summarized: true }),
  messageAdmission: Object.freeze({ binding: Object.freeze({ sessionID: 'ses_fixture', directory: '/workspace', sessionGeneration: 4 }), messageID: 'msg_fixture', admitted: true, revision: 4 }),
  abortResponse: Object.freeze({ binding: Object.freeze({ sessionID: 'ses_fixture', directory: '/workspace', sessionGeneration: 4 }), aborted: true }),
  shareOperation: Object.freeze({ operationID: 'share_fixture', assistantID: 'assistant_fixture', sessionID: 'ses_fixture', messageID: 'msg_fixture', state: 'running', phase: 'submitted', attempt: 1, leaseExpiresAt: 1234, errorCode: null }),
  historicalMessages: Object.freeze({ entries: Object.freeze([Object.freeze({ sessionID: 'ses_fixture', directory: null, info: Object.freeze({ id: 'msg_fixture', sessionID: 'ses_fixture', role: 'assistant', time: Object.freeze({ created: 1234 }) }), parts: Object.freeze([]) })]), nextCursor: null, complete: true }),
  /** Frozen GET /assistants/:id/contact/messages page envelope (UI contract). */
  contactMessagesPage: Object.freeze({
    messages: Object.freeze([]),
    nextCursor: null,
    complete: true,
    generation: 0,
    revision: 1,
  }),
  assistantScheduledTasks: Object.freeze({
    tasks: Object.freeze([
      Object.freeze({
        assistantID: 'assistant_fixture',
        projectID: 'proj_fixture',
        taskID: 'task_fixture',
        createdAt: 1234,
        projectPath: '/workspace',
        projectLabel: 'Fixture',
        task: Object.freeze({
          id: 'task_fixture',
          name: 'Daily ping',
          enabled: true,
          schedule: Object.freeze({ kind: 'daily', time: '18:00', timezone: 'Asia/Shanghai' }),
          execution: Object.freeze({ prompt: 'ping', providerID: 'provider_fixture', modelID: 'model_fixture' }),
        }),
      }),
    ]),
  }),
});
