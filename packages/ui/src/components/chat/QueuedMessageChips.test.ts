import { beforeEach, describe, expect, test } from 'bun:test';
import { legacyQueueScope, setMessageQueueMutationFence, useMessageQueueStore, type QueueItem, type QueueScope } from '@/stores/messageQueueStore';
import { applyPendingServerQueueOperation, canSendQueuedMessage, canSendServerQueuedMessage, isServerQueueItemDispatchPending, mergeQueuedMessageScopes, popQueuedMessageForEdit, queueModeAllowsMutations, reorderServerQueueItems, selectPendingServerQueueOperation, serverQueueEditInput, serverQueueItemMutationInput } from './queuedMessageChipsState';
import type { ServerQueueOperationIdentity } from './queuedMessageChipsState';
import type { MessageQueueItem, MessageQueueScope } from '@/lib/message-queue-server';
import { sessionDraftKey } from '@/sync/input-draft-types';
import type { MessageQueuePendingAdmissionItem } from '@/sync/message-queue-server-runtime';

const scope: Extract<QueueScope, { state: 'bound' }> = {
    state: 'bound',
    transportIdentity: 'runtime-a',
    directory: '/project',
    sessionID: 'session-a',
};
const add = (target: QueueScope, content: string): QueueItem => {
    const result = useMessageQueueStore.getState().addToQueue(target, { content });
    if (!result.ok) throw new Error(result.reason);
    return result.item;
};
const serverItem = (queueItemID: string, status = 'queued', rowVersion = 1): MessageQueueItem => ({ queueItemID, operationID: `operation-${queueItemID}`, messageID: `msg_${queueItemID}`, content: queueItemID, status, attemptCount: 0, position: 0, rowVersion, createdAt: 1 });
const serverScope = (items: MessageQueueItem[]): MessageQueueScope => ({ scopeID: 'scope-a', revision: 7, directory: '/project', sessionID: 'session-a', worktreeState: 'active', items, itemCount: items.length });
const pendingAdmissionItem: MessageQueuePendingAdmissionItem = { kind: 'pending-admission', phase: 'admitting', requestID: 'request-pending', queueItemID: 'pending', operationID: 'operation-pending', messageID: 'msg_pending', content: 'pending', createdAt: 1, attachmentCount: 2 };

describe('QueuedMessageChips production queue boundary', () => {
    beforeEach(() => {
        setMessageQueueMutationFence('open');
        useMessageQueueStore.setState({ queuedMessages: {}, followUpBehavior: 'queue' });
    });

    test('merges a visible legacy row before bound rows and edits from its owner scope', () => {
        const actions = useMessageQueueStore.getState();
        const legacyScope = legacyQueueScope(scope.sessionID);
        const legacy = add(legacyScope, 'legacy');
        const bound = add(scope, 'bound');
        const visible = mergeQueuedMessageScopes(
            actions.getQueueForScope(legacyScope),
            actions.getQueueForScope(scope),
        );

        expect(visible).toEqual([legacy, bound]);
        expect(popQueuedMessageForEdit(visible[0]!, actions.popToInput)).toBe(legacy);
        expect(actions.getQueueForScope(legacyScope)).toEqual([]);
        expect(actions.getQueueForScope(scope)).toEqual([bound]);
    });
    test('enables Send for each recoverable row and disables all rows for a visible dispatch lock', () => {
        const item = add(scope, 'queued');
        expect(canSendQueuedMessage(item, false)).toBe(true);
        expect(canSendQueuedMessage({ ...item, status: 'retrying' }, false)).toBe(true);
        expect(canSendQueuedMessage({ ...item, status: 'failed' }, false)).toBe(true);
        expect(canSendQueuedMessage({ ...item, status: 'unresolved' }, false)).toBe(true);
        expect(canSendQueuedMessage(item, true)).toBe(false);
    });

    test('keeps server order and status locks aligned with the legacy chip behavior', () => {
        const items = [serverItem('first'), serverItem('sending', 'sending'), serverItem('failed', 'failed'), serverItem('unresolved', 'unresolved')];
        expect(items.map((item) => item.queueItemID)).toEqual(['first', 'sending', 'failed', 'unresolved']);
        expect(canSendServerQueuedMessage(items[0]!, false)).toBe(true);
        expect(canSendServerQueuedMessage(items[1]!, false)).toBe(false);
        expect(canSendServerQueuedMessage(items[2]!, false)).toBe(true);
        expect(canSendServerQueuedMessage(items[3]!, false)).toBe(true);
        expect(canSendServerQueuedMessage(items[0]!, true)).toBe(false);
        expect(canSendServerQueuedMessage(pendingAdmissionItem, false)).toBe(false);
    });

    test('builds remove and manual-send CAS input from scope revision and row version', () => {
        const item = serverItem('queue-a', 'failed', 11);
        const input = serverQueueItemMutationInput(serverScope([item]), item, '00000000-0000-4000-8000-000000000001');
        expect(input).toEqual({ requestID: '00000000-0000-4000-8000-000000000001', scopeID: 'scope-a', revision: 7, item });
        expect(input.item.rowVersion).toBe(11);
    });

    test('builds a revision-pinned server reorder without changing source items', () => {
        const scope = serverScope([serverItem('first'), serverItem('second'), serverItem('third')]);
        expect(reorderServerQueueItems(scope, 'first', 'third', '00000000-0000-4000-8000-000000000002')).toEqual({
            requestID: '00000000-0000-4000-8000-000000000002',
            scopeID: 'scope-a',
            revision: 7,
            queueItemIDs: ['second', 'third', 'first'],
        });
        expect(scope.items.map((item) => item.queueItemID)).toEqual(['first', 'second', 'third']);
    });

    test('passes the current draft key and expected revision to server edit', () => {
        const item = serverItem('queue-a');
        const key = sessionDraftKey({ transportIdentity: 'runtime-a' }, 'session-a');
        expect(serverQueueEditInput(serverScope([item]), item, key, 9)).toEqual({ scopeID: 'scope-a', scopeRevision: 7, item, targetKey: key, expectedRevision: 9 });
    });

    test('freezes every queue control while legacy and server ownership keep controls available', () => {
        expect(queueModeAllowsMutations('frozen')).toBe(false);
        expect(queueModeAllowsMutations('legacy')).toBe(true);
        expect(queueModeAllowsMutations('server')).toBe(true);
    });

    test('manual dispatch intent and dispatched statuses keep server Send disabled and mark dispatch pending', () => {
        const queued = serverItem('queue-a', 'queued');
        const manual = { ...queued, manualDispatchRequested: true };
        expect(canSendServerQueuedMessage(queued, false)).toBe(true);
        expect(canSendServerQueuedMessage(manual, false)).toBe(false);
        expect(isServerQueueItemDispatchPending(manual)).toBe(true);
        expect(isServerQueueItemDispatchPending(queued)).toBe(false);
        expect(isServerQueueItemDispatchPending(serverItem('sending', 'sending'))).toBe(true);
        expect(isServerQueueItemDispatchPending(serverItem('reconciling', 'reconciling'))).toBe(true);
    });

    test('selectPendingServerQueueOperation filters by exact scope and isolates runtime switches', () => {
        const exact = { transportIdentity: 'runtime-a', runtimeGeneration: 1, directory: '/project', sessionID: 'session-a', scopeID: 'scope-a' };
        const sameScope: ServerQueueOperationIdentity[] = [
            { kind: 'send', ...exact, scopeID: 'scope-a', queueItemID: 'queue-a' },
        ];
        expect(selectPendingServerQueueOperation(sameScope, exact)?.queueItemID).toBe('queue-a');
        expect(selectPendingServerQueueOperation(sameScope, { ...exact, sessionID: 'session-b' })).toBe(undefined);
        expect(selectPendingServerQueueOperation(sameScope, { ...exact, directory: '/other' })).toBe(undefined);
        expect(selectPendingServerQueueOperation(sameScope, { ...exact, transportIdentity: 'runtime-b' })).toBe(undefined);
        expect(selectPendingServerQueueOperation(sameScope, { ...exact, runtimeGeneration: 2 })).toBe(undefined);
        expect(selectPendingServerQueueOperation(sameScope, { ...exact, scopeID: 'scope-b' })).toBe(undefined);
        expect(selectPendingServerQueueOperation([], exact)).toBe(undefined);
    });

    test('applyPendingServerQueueOperation optimistically moves the target to first on send and keeps stable references', () => {
        const first = serverItem('first');
        const second = serverItem('second');
        const third = serverItem('third');
        const items: readonly (MessageQueueItem | MessageQueuePendingAdmissionItem)[] = [first, second, third];
        const send: ServerQueueOperationIdentity = { kind: 'send', transportIdentity: 'runtime-a', runtimeGeneration: 1, directory: '/project', sessionID: 'session-a', scopeID: 'scope-a', queueItemID: 'second' };
        const result = applyPendingServerQueueOperation(items, send);
        expect(result.map((item) => item.queueItemID)).toEqual(['second', 'first', 'third']);
        // Existing references are reused; no item recreated.
        expect(result[0]).toBe(second);
        expect(result[1]).toBe(first);
        expect(result[2]).toBe(third);
        // Target already first returns original reference.
        const alreadyFirst: readonly MessageQueueItem[] = [first, second];
        const alreadyFirstResult = applyPendingServerQueueOperation(alreadyFirst, { ...send, queueItemID: 'first' });
        expect(alreadyFirstResult).toBe(alreadyFirst);
        // Missing target returns original reference.
        const missingTargetResult = applyPendingServerQueueOperation(items, { ...send, queueItemID: 'missing' });
        expect(missingTargetResult).toBe(items);
    });

    test('applyPendingServerQueueOperation reorder reorders authoritative items and preserves pending admission rows', () => {
        const first = serverItem('first');
        const second = serverItem('second');
        const third = serverItem('third');
        const pending: MessageQueuePendingAdmissionItem = { kind: 'pending-admission', phase: 'admitting', requestID: 'request-pending', queueItemID: 'pending', operationID: 'operation-pending', messageID: 'msg_pending', content: 'pending', createdAt: 1, attachmentCount: 0 };
        const items: readonly (MessageQueueItem | MessageQueuePendingAdmissionItem)[] = [first, second, third, pending];
        const reorder: ServerQueueOperationIdentity = { kind: 'reorder', transportIdentity: 'runtime-a', runtimeGeneration: 1, directory: '/project', sessionID: 'session-a', scopeID: 'scope-a', queueItemID: 'third', queueItemIDs: ['third', 'first', 'second'] };
        const result = applyPendingServerQueueOperation(items, reorder);
        expect(result.map((item) => item.queueItemID)).toEqual(['third', 'first', 'second', 'pending']);
        expect(result[0]).toBe(third);
        expect(result[3]).toBe(pending);
        // Existing order already matches returns original reference.
        const alreadyOrdered: readonly MessageQueueItem[] = [first, second];
        const alreadyOrderedResult = applyPendingServerQueueOperation(alreadyOrdered, { ...reorder, queueItemIDs: ['first', 'second'] });
        expect(alreadyOrderedResult).toBe(alreadyOrdered);
    });

    test('applyPendingServerQueueOperation reorder ignores duplicate and unknown IDs while retaining authoritative and pending order', () => {
        const first = serverItem('first');
        const second = serverItem('second');
        const third = serverItem('third');
        const pending = { ...pendingAdmissionItem, queueItemID: 'pending-second' };
        const items: readonly (MessageQueueItem | MessageQueuePendingAdmissionItem)[] = [first, second, third, pendingAdmissionItem, pending];
        const reorder: ServerQueueOperationIdentity = { kind: 'reorder', transportIdentity: 'runtime-a', runtimeGeneration: 1, directory: '/project', sessionID: 'session-a', scopeID: 'scope-a', queueItemID: 'third', queueItemIDs: ['third', 'unknown', 'third', 'first', 'missing'] };

        const result = applyPendingServerQueueOperation(items, reorder);

        expect(result.map((item) => item.queueItemID)).toEqual(['third', 'first', 'second', 'pending', 'pending-second']);
        expect(result[0]).toBe(third);
        expect(result[2]).toBe(second);
        expect(result[3]).toBe(pendingAdmissionItem);
        expect(result[4]).toBe(pending);
    });

    test('applyPendingServerQueueOperation reorder constructs a 2048-item authoritative projection with stable references', () => {
        const items: readonly MessageQueueItem[] = Array.from({ length: 2048 }, (_, index) => serverItem(`item-${index}`));
        const queueItemIDs = items.map((item) => item.queueItemID).reverse();
        const reorder: ServerQueueOperationIdentity = { kind: 'reorder', transportIdentity: 'runtime-a', runtimeGeneration: 1, directory: '/project', sessionID: 'session-a', scopeID: 'scope-a', queueItemID: queueItemIDs[0]!, queueItemIDs };

        const result = applyPendingServerQueueOperation(items, reorder);

        expect(result.map((item) => item.queueItemID)).toEqual(queueItemIDs);
        expect(result[0]).toBe(items[2047]);
        expect(result[1024]).toBe(items[1023]);
        expect(result[2047]).toBe(items[0]);
    });

    test('applyPendingServerQueueOperation edit and remove return the original array reference without mutation', () => {
        const first = serverItem('first');
        const second = serverItem('second');
        const items: readonly MessageQueueItem[] = [first, second];
        const edit: ServerQueueOperationIdentity = { kind: 'edit', transportIdentity: 'runtime-a', runtimeGeneration: 1, directory: '/project', sessionID: 'session-a', scopeID: 'scope-a', queueItemID: 'first' };
        const remove: ServerQueueOperationIdentity = { kind: 'remove', transportIdentity: 'runtime-a', runtimeGeneration: 1, directory: '/project', sessionID: 'session-a', scopeID: 'scope-a', queueItemID: 'second' };
        const editResult = applyPendingServerQueueOperation(items, edit);
        const removeResult = applyPendingServerQueueOperation(items, remove);
        expect(editResult).toBe(items);
        expect(removeResult).toBe(items);
    });
});
