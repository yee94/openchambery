import { describe, expect, test } from 'bun:test';
import { MessageQueueServerError } from '@/lib/message-queue-server';
import { getQueuedMessageOwnershipGate, setQueuedMessageOwnershipGate } from '@/hooks/useQueuedMessageAutoSend';
import { setMessageQueueMutationFence } from '@/stores/messageQueueStore';
import { createMessageQueueCutover } from './message-queue-cutover';

describe('message queue cutover ownership', () => {
  test('opens the legacy gate only for the 501 unsupported response', async () => {
    setQueuedMessageOwnershipGate('blocked');
    const cutover = createMessageQueueCutover({
      server: { refresh: async () => {} } as never,
      status: async () => { throw new MessageQueueServerError(501, 'unavailable'); },
      capture: () => ({ transportIdentity: 'runtime-a', generation: 1 }),
      current: () => true,
    });
    await cutover.refresh();
    expect(cutover.getSnapshot().ownership).toBe('legacy-unsupported');
    expect(getQueuedMessageOwnershipGate()).toBe('legacy-enabled');
  });

  test('a capability result without the 501 response stays blocked', async () => {
    const cutover = createMessageQueueCutover({
      server: { refresh: async () => {} } as never,
      status: async () => ({ capability: false }),
      capture: () => ({ transportIdentity: 'runtime-a', generation: 1 }),
      current: () => true,
    });
    await cutover.refresh();
    expect(cutover.getSnapshot().ownership).toBe('blocked');
    expect(getQueuedMessageOwnershipGate()).toBe('blocked');
    cutover.stop();
    setMessageQueueMutationFence('open');
  });

  test('blocks before staging when authoritative legacy binding has an unresolved directory', async () => {
    const calls: string[] = [];
    const cutover = createMessageQueueCutover({
      server: { refresh: async () => {} } as never,
      status: async () => ({ capability: true, protocol: 4, authority: 'shadow' }),
      capture: () => ({ transportIdentity: 'cutover-unresolved', generation: 1 }),
      current: () => true,
      quiesce: async () => { calls.push('quiesce'); },
      prepare: () => { calls.push('prepare'); return { ok: false, unresolvedSessionIDs: ['session-a'] }; },
      flush: async () => { calls.push('flush'); },
    });
    await cutover.refresh();
    expect(calls).toEqual(['quiesce', 'prepare']);
    expect(cutover.getSnapshot().ownership).toBe('blocked');
    expect(cutover.getSnapshot().migration).toBe('idle');
    cutover.stop();
  });

  test('runs server refresh before a single status read', async () => {
    const order: string[] = [];
    const cutover = createMessageQueueCutover({
      server: { refresh: async () => { order.push('refresh'); } } as never,
      status: async () => {
        order.push('status');
        throw new MessageQueueServerError(501, 'unavailable');
      },
      capture: () => ({ transportIdentity: 'runtime-order', generation: 1 }),
      current: () => true,
    });
    await cutover.refresh();
    expect(order).toEqual(['refresh', 'status']);
    expect(cutover.getSnapshot().ownership).toBe('legacy-unsupported');
    cutover.stop();
  });
});
