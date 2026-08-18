import { beforeEach, describe, expect, mock, test } from 'bun:test';

const beginCalls: Array<{ sessionId: string; messageID?: string; content: string }> = [];
const rollbackCalls: string[] = [];
let directory: string | null = '/project';
let ownership = 'server-active';
let serverItems: Array<{ queueItemID: string; status: string; content: string; sendConfig?: { providerID: string; modelID: string }; deliveryTarget?: { kind: string } }> = [];
let legacyItems: Array<{ queueItemID: string; operationID: string; status: string; content: string; sendConfig?: { providerID: string; modelID: string }; owner: { state: string } }> = [];
let syncMessages: Array<{ id: string; role?: string }> = [];

mock.module('@/sync/session-actions', () => ({
  beginOptimisticSend: (input: { sessionId: string; messageID?: string; content: string }) => {
    beginCalls.push({ sessionId: input.sessionId, messageID: input.messageID, content: input.content });
    return {
      messageID: input.messageID ?? 'msg_opt',
      sessionId: input.sessionId,
      directory: '/project',
      capture: {},
      transport: {},
    };
  },
  rollbackOptimisticSend: (ticket: { messageID: string }) => { rollbackCalls.push(ticket.messageID); },
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      getDirectoryForSession: () => directory,
      clearMessageSending: () => {},
    }),
  },
}));

mock.module('@/sync/message-queue-cutover', () => ({
  getMessageQueueCutover: () => ({ getSnapshot: () => ({ ownership }) }),
}));

mock.module('@/sync/message-queue-server-runtime', () => ({
  getMessageQueueServerRuntime: () => ({
    getScope: () => serverItems.length ? { items: serverItems } : undefined,
    subscribe: () => () => {},
  }),
}));

mock.module('@/stores/messageQueueStore', () => ({
  getQueueForScope: (_state: unknown, scope: { state?: string }) => scope.state === 'unbound-legacy' ? [] : legacyItems,
  legacyQueueScope: (sessionID: string) => ({ state: 'unbound-legacy', sessionID }),
  useMessageQueueStore: Object.assign((selector: (state: { queuedMessages: Record<string, unknown> }) => unknown) => selector({ queuedMessages: {} }), {
    getState: () => ({
      getQueueForScope: (scope: { state?: string }) => scope.state === 'unbound-legacy' ? [] : legacyItems,
      queuedMessages: {},
    }),
  }),
}));

mock.module('@/sync/sync-refs', () => ({
  getSyncMessages: () => syncMessages,
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => 'runtime-a',
  subscribeRuntimeEndpointChanged: () => () => {},
}));

const {
  confirmQueueAbortOptimistic,
  getQueueAbortOptimisticPresentation,
  isQueueItemHiddenByAbortOptimistic,
  planQueueAbortOptimisticReconcile,
  promoteQueueHeadOnAbort,
  reconcileQueueAbortOptimistic,
  resetQueueAbortOptimisticForTests,
  rollbackQueueAbortOptimistic,
} = await import('./queue-abort-optimistic');

describe('queue abort optimistic presentation', () => {
  beforeEach(() => {
    beginCalls.length = 0;
    rollbackCalls.length = 0;
    directory = '/project';
    ownership = 'server-active';
    serverItems = [];
    legacyItems = [];
    syncMessages = [];
    resetQueueAbortOptimisticForTests();
  });

  test('planner keeps a waiting or in-flight head until the pinned row or a later user lands', () => {
    expect(planQueueAbortOptimisticReconcile({ queueItemID: 'q', status: 'queued' }, { hasPinnedMessage: false, hasLaterUserMessage: false })).toBe('keep');
    expect(planQueueAbortOptimisticReconcile({ queueItemID: 'q', status: 'sending' }, { hasPinnedMessage: true, hasLaterUserMessage: false })).toBe('confirm');
    expect(planQueueAbortOptimisticReconcile({ queueItemID: 'q', status: 'failed' }, { hasPinnedMessage: false, hasLaterUserMessage: false })).toBe('rollback');
    expect(planQueueAbortOptimisticReconcile(null, { hasPinnedMessage: true, hasLaterUserMessage: false })).toBe('confirm');
    expect(planQueueAbortOptimisticReconcile(null, { hasPinnedMessage: false, hasLaterUserMessage: true })).toBe('rollback');
    expect(planQueueAbortOptimisticReconcile(null, { hasPinnedMessage: false, hasLaterUserMessage: false })).toBe('keep');
  });

  test('promote paints the server head and hides only that chip', () => {
    serverItems = [{
      queueItemID: 'queue-a',
      status: 'queued',
      content: 'follow up',
      sendConfig: { providerID: 'openai', modelID: 'gpt' },
    }];
    const presentation = promoteQueueHeadOnAbort('session-a');
    expect(presentation?.queueItemID).toBe('queue-a');
    expect(beginCalls).toHaveLength(1);
    expect(beginCalls[0]?.content).toBe('follow up');
    expect(isQueueItemHiddenByAbortOptimistic('session-a', 'queue-a')).toBe(true);
    expect(isQueueItemHiddenByAbortOptimistic('session-a', 'queue-b')).toBe(false);
    expect(promoteQueueHeadOnAbort('session-a')?.messageID).toBe(presentation?.messageID);
  });

  test('promote skips assistant targets, missing config, and empty queues', () => {
    serverItems = [{
      queueItemID: 'queue-a',
      status: 'queued',
      content: 'assistant',
      sendConfig: { providerID: 'openai', modelID: 'gpt' },
      deliveryTarget: { kind: 'assistant' },
    }];
    expect(promoteQueueHeadOnAbort('session-a')).toBeNull();
    serverItems = [{ queueItemID: 'queue-a', status: 'queued', content: 'no-config' }];
    expect(promoteQueueHeadOnAbort('session-a')).toBeNull();
    serverItems = [];
    ownership = 'legacy-unsupported';
    expect(promoteQueueHeadOnAbort('session-a')).toBeNull();
    expect(beginCalls).toEqual([]);
  });

  test('legacy waiting heads paint when the server is not authoritative', () => {
    ownership = 'legacy-unsupported';
    legacyItems = [{
      queueItemID: 'legacy-a',
      operationID: 'op-a',
      status: 'queued',
      content: 'legacy follow up',
      sendConfig: { providerID: 'openai', modelID: 'gpt' },
      owner: { state: 'bound' },
    }];
    const presentation = promoteQueueHeadOnAbort('session-a');
    expect(presentation?.source).toBe('legacy');
    expect(presentation?.queueItemID).toBe('legacy-a');
    expect(getQueueAbortOptimisticPresentation('session-a')?.queueItemID).toBe('legacy-a');
    expect(beginCalls[0]?.content).toBe('legacy follow up');
  });

  test('rollback removes the optimistic row and unhides the chip', () => {
    serverItems = [{
      queueItemID: 'queue-a',
      status: 'queued',
      content: 'follow up',
      sendConfig: { providerID: 'openai', modelID: 'gpt' },
    }];
    const presentation = promoteQueueHeadOnAbort('session-a');
    rollbackQueueAbortOptimistic('session-a');
    expect(rollbackCalls).toEqual([presentation?.messageID]);
    expect(getQueueAbortOptimisticPresentation('session-a')).toBeUndefined();
    expect(isQueueItemHiddenByAbortOptimistic('session-a', 'queue-a')).toBe(false);
  });

  test('reconcile confirms when the pinned message is already in the transcript', () => {
    serverItems = [{
      queueItemID: 'queue-a',
      status: 'queued',
      content: 'follow up',
      sendConfig: { providerID: 'openai', modelID: 'gpt' },
    }];
    const presentation = promoteQueueHeadOnAbort('session-a')!;
    serverItems = [{ ...serverItems[0]!, status: 'sending' }];
    syncMessages = [{ id: presentation.messageID, role: 'user' }];
    reconcileQueueAbortOptimistic('session-a');
    expect(getQueueAbortOptimisticPresentation('session-a')).toBeUndefined();
    expect(rollbackCalls).toEqual([]);
  });

  test('reconcile rolls back a failed head and a completed dispatch that used another id', () => {
    serverItems = [{
      queueItemID: 'queue-a',
      status: 'queued',
      content: 'follow up',
      sendConfig: { providerID: 'openai', modelID: 'gpt' },
    }];
    const first = promoteQueueHeadOnAbort('session-a')!;
    serverItems = [{ ...serverItems[0]!, status: 'failed' }];
    reconcileQueueAbortOptimistic('session-a');
    expect(rollbackCalls).toEqual([first.messageID]);

    serverItems = [{
      queueItemID: 'queue-b',
      status: 'queued',
      content: 'next',
      sendConfig: { providerID: 'openai', modelID: 'gpt' },
    }];
    const second = promoteQueueHeadOnAbort('session-a')!;
    serverItems = [];
    syncMessages = [{ id: 'msg_later_user_zzzzzzzzzzzzABCDEFGHIJKLMN', role: 'user' }];
    reconcileQueueAbortOptimistic('session-a');
    expect(rollbackCalls).toEqual([first.messageID, second.messageID]);
  });

  test('confirm forgets the shadow without rolling back the painted row', () => {
    serverItems = [{
      queueItemID: 'queue-a',
      status: 'queued',
      content: 'follow up',
      sendConfig: { providerID: 'openai', modelID: 'gpt' },
    }];
    promoteQueueHeadOnAbort('session-a');
    confirmQueueAbortOptimistic('session-a');
    expect(rollbackCalls).toEqual([]);
    expect(getQueueAbortOptimisticPresentation('session-a')).toBeUndefined();
  });
});
