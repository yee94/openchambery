import { beforeEach, describe, expect, test } from 'bun:test';
import { legacyQueueScope, setMessageQueueMutationFence, useMessageQueueStore, type QueueItem, type QueueScope } from '@/stores/messageQueueStore';
import { applyPendingServerQueueOperation, applyPendingServerQueueOperations, buildQueuedMessagePreviewParts, canEditQueuedMessage, canRemoveQueuedMessage, canSendQueuedMessage, canSendServerQueuedMessage, isServerQueueItemActiveAttempt, isServerQueueItemDispatchPending, isServerQueueItemHiddenFromChips, isServerQueueSendPendingTimedOut, legacyQueueEditRestoreSource, mergeQueuedMessageScopes, popQueuedMessageForEdit, projectServerQueueChipItems, queueModeAllowsMutations, queuedMessagePreviewLine, reorderServerQueueItems, resolveQueuedMessagePreviewText, selectCommittedSendShadows, selectPendingServerQueueOperation, selectPendingServerQueueOperations, SERVER_QUEUE_SEND_PENDING_TIMEOUT_MS, serverQueueEditInput, serverQueueItemMutationInput, shouldRemoveQueueItemAfterEditCommit } from './queuedMessageChipsState';
import type { ServerQueueCommittedSendShadow, ServerQueueOperationIdentity } from './queuedMessageChipsState';
import type { MessageQueueItem, MessageQueueScope } from '@/lib/message-queue-server';
import { DRAFT_COMPOSER_TRIGGER_ICON_SLOT, sessionDraftKey } from '@/sync/input-draft-types';
import { isMessageQueuePendingAdmissionItem, type MessageQueuePendingAdmissionItem } from '@/sync/message-queue-server-runtime';
import { queuedMessageItemScope, selectLegacyQueueDisplayItemsForScope, selectQueuedMessagesForScope } from './QueuedMessageChips';

type CompleteScope = Extract<QueueScope, { state: 'bound' }> & { deliveryTarget: { kind: 'primary' } | { kind: 'assistant'; assistantID: string }; runtimeGeneration: number };

const scope: CompleteScope = {
    state: 'bound',
    transportIdentity: 'runtime-a',
    directory: '/project',
    sessionID: 'session-a',
    deliveryTarget: { kind: 'primary' },
    runtimeGeneration: 1,
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
        useMessageQueueStore.setState({ queuedMessages: {}, followUpBehavior: 'queue', pendingAdmissions: {} });
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

    test('legacy queue edit removes only after committed+current; restores recovery content without pop-first', () => {
        expect(shouldRemoveQueueItemAfterEditCommit({ status: 'committed', current: true })).toBe(true);
        expect(shouldRemoveQueueItemAfterEditCommit({ status: 'committed', current: false })).toBe(false);
        expect(shouldRemoveQueueItemAfterEditCommit({ status: 'stale', current: false, durable: true })).toBe(false);
        expect(shouldRemoveQueueItemAfterEditCommit({ status: 'conflict', current: true })).toBe(false);
        const withRecovery = {
            id: 'q1',
            content: 'visible',
            failure: { recovery: { content: 'recovered', attachments: undefined, composerDocument: { text: 'recovered', references: [] }, composerMentions: [] } },
        } as unknown as QueueItem;
        expect(legacyQueueEditRestoreSource(withRecovery).content).toBe('recovered');
        expect(legacyQueueEditRestoreSource({ id: 'q2', content: 'plain' } as unknown as QueueItem).content).toBe('plain');
    });

    test('selects rows only from the supplied complete surface scope', () => {
        const secondaryScope: CompleteScope = {
            ...scope,
            deliveryTarget: { kind: 'assistant', assistantID: 'assistant-a' },
            runtimeGeneration: 4,
        };
        const primaryScope: CompleteScope = {
            ...scope,
            deliveryTarget: { kind: 'primary' },
            runtimeGeneration: 4,
        };
        const legacy = add(legacyQueueScope(scope.sessionID), 'legacy');
        const secondary = add(secondaryScope, 'secondary');
        add(primaryScope, 'primary');

        expect(selectQueuedMessagesForScope(useMessageQueueStore.getState(), secondaryScope)).toEqual([legacy, secondary]);
    });

    test('resolves edit, remove, and reorder ownership from the supplied scope', () => {
        const secondaryScope: CompleteScope = {
            ...scope,
            deliveryTarget: { kind: 'assistant', assistantID: 'assistant-b' },
            runtimeGeneration: 6,
        };
        const item = add(secondaryScope, 'secondary');
        // runtimeGeneration is staleness metadata, not part of the ledger address,
        // so an A→B→A transport bounce still owns the rows it persisted.
        const bounced = add({ ...secondaryScope, runtimeGeneration: 7 }, 'bounced');
        const foreign = add({ ...secondaryScope, deliveryTarget: { kind: 'assistant', assistantID: 'assistant-c' } }, 'foreign');
        const legacy = add(legacyQueueScope(scope.sessionID), 'legacy');

        expect(queuedMessageItemScope(item, secondaryScope)).toBe(secondaryScope);
        expect(queuedMessageItemScope(bounced, secondaryScope)).toBe(secondaryScope);
        expect(queuedMessageItemScope(foreign, secondaryScope)).toBeNull();
        expect(queuedMessageItemScope(legacy, secondaryScope)).toEqual(legacyQueueScope(scope.sessionID));
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

    test('manual dispatch intent blocks Send until client timeout allows retry; active attempts retain dispatch identity', () => {
        const queued = serverItem('queue-a', 'queued');
        const manual = { ...queued, manualDispatchRequested: true };
        expect(canSendServerQueuedMessage(queued, false)).toBe(true);
        expect(canSendServerQueuedMessage(manual, false)).toBe(false);
        expect(canSendServerQueuedMessage(manual, false, { allowManualDispatchRetry: true })).toBe(true);
        expect(isServerQueueItemDispatchPending(manual)).toBe(true);
        expect(isServerQueueItemDispatchPending(queued)).toBe(false);
        expect(isServerQueueItemDispatchPending(serverItem('sending', 'sending'))).toBe(true);
        expect(isServerQueueItemDispatchPending(serverItem('reconciling', 'reconciling'))).toBe(true);
        expect(isServerQueueItemActiveAttempt(manual)).toBe(false);
        expect(isServerQueueItemActiveAttempt(serverItem('sending', 'sending'))).toBe(true);
    });

    test('isServerQueueSendPendingTimedOut uses an 8s client timeout and rejects invalid inputs', () => {
        expect(SERVER_QUEUE_SEND_PENDING_TIMEOUT_MS).toBe(8_000);
        expect(isServerQueueSendPendingTimedOut(1_000, 9_000)).toBe(true);
        expect(isServerQueueSendPendingTimedOut(1_000, 8_999)).toBe(false);
        expect(isServerQueueSendPendingTimedOut(Number.NaN, 9_000)).toBe(false);
        expect(isServerQueueSendPendingTimedOut(1_000, Number.POSITIVE_INFINITY)).toBe(false);
        expect(isServerQueueSendPendingTimedOut(1_000, 2_000, Number.NaN)).toBe(false);
    });

    test('an active server attempt does not globally disable waiting-row send', () => {
        const waiting = serverItem('waiting');
        expect(canSendServerQueuedMessage(waiting, false)).toBe(true);
    });

    test('keeps Remove available for manual intent and stale active attempts', () => {
        const queued = serverItem('queue-a', 'queued');
        const manual = { ...queued, manualDispatchRequested: true };
        expect(canRemoveQueuedMessage(queued, { frozen: false })).toBe(true);
        expect(canRemoveQueuedMessage(manual, { frozen: false })).toBe(true);
        expect(canRemoveQueuedMessage(serverItem('sending', 'sending'), { frozen: false })).toBe(true);
        expect(canRemoveQueuedMessage(serverItem('reconciling', 'reconciling'), { frozen: false })).toBe(true);
        expect(canRemoveQueuedMessage(manual, { frozen: true })).toBe(false);
        expect(canRemoveQueuedMessage(pendingAdmissionItem, { frozen: false })).toBe(false);
    });

    test('keeps Edit available for stale active attempts but not pending admission', () => {
        expect(canEditQueuedMessage(serverItem('sending', 'sending'), { frozen: false })).toBe(true);
        expect(canEditQueuedMessage(serverItem('reconciling', 'reconciling'), { frozen: false })).toBe(true);
        expect(canEditQueuedMessage(pendingAdmissionItem, { frozen: false })).toBe(false);
        expect(canEditQueuedMessage(serverItem('queued'), { frozen: true })).toBe(false);
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
        expect(selectPendingServerQueueOperations([
            ...sameScope,
            { kind: 'remove', ...exact, queueItemID: 'queue-b' },
            { kind: 'edit', ...exact, sessionID: 'session-b', queueItemID: 'foreign' },
        ], exact).map((operation) => operation.queueItemID)).toEqual(['queue-a', 'queue-b']);
    });

    test('applyPendingServerQueueOperation leaves the send target visible (edit/remove still hide)', () => {
        const first = serverItem('first');
        const second = serverItem('second');
        const third = serverItem('third');
        const items: readonly (MessageQueueItem | MessageQueuePendingAdmissionItem)[] = [first, second, third];
        const send: ServerQueueOperationIdentity = { kind: 'send', transportIdentity: 'runtime-a', runtimeGeneration: 1, directory: '/project', sessionID: 'session-a', scopeID: 'scope-a', queueItemID: 'second' };
        const result = applyPendingServerQueueOperation(items, send);
        expect(result).toBe(items);
        expect(result.map((item) => item.queueItemID)).toEqual(['first', 'second', 'third']);
        // Missing target also returns original reference.
        const missingTargetResult = applyPendingServerQueueOperation(items, { ...send, queueItemID: 'missing' });
        expect(missingTargetResult).toBe(items);
        // Source array is never mutated.
        expect(items.map((item) => item.queueItemID)).toEqual(['first', 'second', 'third']);
        // edit/remove still hide immediately.
        expect(applyPendingServerQueueOperation(items, { ...send, kind: 'edit' }).map((item) => item.queueItemID)).toEqual(['first', 'third']);
        expect(applyPendingServerQueueOperation(items, { ...send, kind: 'remove' }).map((item) => item.queueItemID)).toEqual(['first', 'third']);
    });

    test('projectServerQueueChipItems keeps pending send and manualDispatchRequested visible; hides only sending/reconciling', () => {
        const waiting = serverItem('waiting');
        const manual = { ...serverItem('manual'), manualDispatchRequested: true };
        const sending = serverItem('sending', 'sending');
        const reconciling = serverItem('reconciling', 'reconciling');
        const failed = serverItem('failed', 'failed');
        const unresolved = serverItem('unresolved', 'unresolved');
        const pending: MessageQueuePendingAdmissionItem = { ...pendingAdmissionItem };
        const exact = { transportIdentity: 'runtime-a', runtimeGeneration: 1, directory: '/project', sessionID: 'session-a', scopeID: 'scope-a' };
        expect(isServerQueueItemHiddenFromChips(manual)).toBe(false);
        expect(isServerQueueItemHiddenFromChips(sending)).toBe(true);
        expect(isServerQueueItemHiddenFromChips(reconciling)).toBe(true);
        expect(isServerQueueItemHiddenFromChips(failed)).toBe(false);
        expect(isServerQueueItemHiddenFromChips(unresolved)).toBe(false);
        expect(isServerQueueItemHiddenFromChips(waiting)).toBe(false);

        const authoritative = [waiting, manual, sending, reconciling, failed, unresolved, pending];
        expect(projectServerQueueChipItems(authoritative, []).map((item) => item.queueItemID)).toEqual(['waiting', 'manual', 'failed', 'unresolved', 'pending']);

        const pendingSend: ServerQueueOperationIdentity = { kind: 'send', ...exact, queueItemID: 'waiting' };
        expect(projectServerQueueChipItems(authoritative, [pendingSend]).map((item) => item.queueItemID)).toEqual(['waiting', 'manual', 'failed', 'unresolved', 'pending']);
        // Definitive failure clears the mutation overlay; waiting/manual rows remain visible.
        expect(projectServerQueueChipItems(authoritative, []).map((item) => item.queueItemID)).toEqual(['waiting', 'manual', 'failed', 'unresolved', 'pending']);
    });

    test('committed send shadow keeps waiting row visible for Sending UI while scope lags', () => {
        const exact = { transportIdentity: 'runtime-a', runtimeGeneration: 1, directory: '/project', sessionID: 'session-a', scopeID: 'scope-a' };
        const waiting = serverItem('waiting');
        const failed = serverItem('failed', 'failed');
        const unresolved = serverItem('unresolved', 'unresolved');
        const shadow: ServerQueueCommittedSendShadow = { kind: 'send', ...exact, queueItemID: 'waiting', committedRevision: 5 };
        // pending → success with lagging authoritative scope keeps shadow selected for pending UI ownership.
        expect(selectCommittedSendShadows([shadow], exact, 3).map((entry) => entry.queueItemID)).toEqual(['waiting']);
        expect(projectServerQueueChipItems([waiting, failed, unresolved], selectCommittedSendShadows([shadow], exact, 3)).map((item) => item.queueItemID)).toEqual(['waiting', 'failed', 'unresolved']);
        // Once scope reaches the receipt revision, shadow ends and recoverable rows stay visible.
        expect(selectCommittedSendShadows([shadow], exact, 5)).toEqual([]);
        expect(projectServerQueueChipItems([waiting, failed, unresolved], selectCommittedSendShadows([shadow], exact, 5)).map((item) => item.queueItemID)).toEqual(['waiting', 'failed', 'unresolved']);
        // Runtime generation isolation: foreign generation never shadows.
        expect(selectCommittedSendShadows([shadow], { ...exact, runtimeGeneration: 2 }, 3)).toEqual([]);
        expect(selectCommittedSendShadows([{ ...shadow, runtimeGeneration: 2 }], exact, 3)).toEqual([]);
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

    test('reorderServerQueueItems keeps hidden tracking rows in the complete server order', () => {
        const reconciling = serverItem('reconciling', 'reconciling');
        const first = serverItem('first');
        const sending = serverItem('sending', 'sending');
        const second = serverItem('second');
        const complete = serverScope([reconciling, first, sending, second]);

        const result = reorderServerQueueItems(complete, 'second', 'first', 'request-reorder', [first, second]);

        expect(result?.queueItemIDs).toEqual(['reconciling', 'second', 'sending', 'first']);
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

    test('applyPendingServerQueueOperation edit and remove hide the target immediately without mutating source', () => {
        const first = serverItem('first');
        const second = serverItem('second');
        const items: readonly MessageQueueItem[] = [first, second];
        const edit: ServerQueueOperationIdentity = { kind: 'edit', transportIdentity: 'runtime-a', runtimeGeneration: 1, directory: '/project', sessionID: 'session-a', scopeID: 'scope-a', queueItemID: 'first' };
        const remove: ServerQueueOperationIdentity = { kind: 'remove', transportIdentity: 'runtime-a', runtimeGeneration: 1, directory: '/project', sessionID: 'session-a', scopeID: 'scope-a', queueItemID: 'second' };
        const editResult = applyPendingServerQueueOperation(items, edit);
        const removeResult = applyPendingServerQueueOperation(items, remove);
        expect(editResult).toEqual([second]);
        expect(removeResult).toEqual([first]);
        expect(items).toEqual([first, second]);
    });

    test('applies rapid client operations in order so the visible queue is latest-intent-first', () => {
        const first = serverItem('first');
        const sending = serverItem('sending', 'sending');
        const second = serverItem('second');
        const third = serverItem('third');
        const exact = { transportIdentity: 'runtime-a', runtimeGeneration: 1, directory: '/project', sessionID: 'session-a', scopeID: 'scope-a' };
        const operations: ServerQueueOperationIdentity[] = [
            { kind: 'send', ...exact, queueItemID: 'third' },
            { kind: 'remove', ...exact, queueItemID: 'first' },
            { kind: 'reorder', ...exact, queueItemID: 'second', queueItemIDs: ['sending', 'second'] },
        ];

        const result = applyPendingServerQueueOperations([first, sending, second, third], operations);

        // send leaves third visible; remove hides first; reorder rearranges remaining authoritative rows.
        expect(result.map((item) => item.queueItemID)).toEqual(['sending', 'second', 'third']);
        expect(result[0]).toBe(sending);
        // Chip projection still hides authoritative sending/reconciling tracking rows.
        expect(projectServerQueueChipItems([first, sending, second, third], operations).map((item) => item.queueItemID)).toEqual(['second', 'third']);
    });
});


describe('QueuedMessageChips legacy pending admission display', () => {
    beforeEach(() => {
        setMessageQueueMutationFence('open');
        useMessageQueueStore.setState({ queuedMessages: {}, followUpBehavior: 'queue', pendingAdmissions: {} });
    });

    test('selectLegacyQueueDisplayItemsForScope appends ephemeral pending chips after durable rows', () => {
        const durable = add(scope, 'durable');
        useMessageQueueStore.getState().stageAdmission(scope, {
            requestID: 'request-pending',
            queueItemID: 'pending-local',
            operationID: 'operation-pending-local',
            messageID: 'msg_pending_local',
            content: 'queuing body',
            createdAt: 9,
            attachmentCount: 1,
        });
        const display = selectLegacyQueueDisplayItemsForScope(useMessageQueueStore.getState(), scope);
        expect(display).toHaveLength(2);
        expect(display[0]).toBe(durable);
        const pendingChip = display[1]!;
        expect(isMessageQueuePendingAdmissionItem(pendingChip)).toBe(true);
        if (!isMessageQueuePendingAdmissionItem(pendingChip)) throw new Error('expected pending admission');
        expect(pendingChip.kind).toBe('pending-admission');
        expect(pendingChip.queueItemID).toBe('pending-local');
        expect(pendingChip.content).toBe('queuing body');
        expect(pendingChip.attachmentCount).toBe(1);
        // Durable selector stays free of temporary markers.
        expect(selectQueuedMessagesForScope(useMessageQueueStore.getState(), scope)).toEqual([durable]);
    });

    test('pending admission disables edit/remove/send for legacy chips', () => {
        useMessageQueueStore.getState().stageAdmission(scope, {
            requestID: 'request-pending',
            queueItemID: 'pending-local',
            operationID: 'operation-pending-local',
            messageID: 'msg_pending_local',
            content: 'queuing body',
            createdAt: 9,
        });
        const pending = selectLegacyQueueDisplayItemsForScope(useMessageQueueStore.getState(), scope)[0]!;
        expect(isMessageQueuePendingAdmissionItem(pending)).toBe(true);
        expect(canEditQueuedMessage(pending, { frozen: false })).toBe(false);
        expect(canRemoveQueuedMessage(pending, { frozen: false })).toBe(false);
        expect(canSendServerQueuedMessage(pending as MessageQueuePendingAdmissionItem, false)).toBe(false);
    });
});

describe('QueuedMessageChips preview decoration', () => {
    test('prefers composer display text over canonical queue content', () => {
        const display = `[${DRAFT_COMPOSER_TRIGGER_ICON_SLOT}image-1.png] review`;
        expect(resolveQueuedMessagePreviewText({
            content: '[image-1.png] review',
            composerDocument: { text: display, references: [] },
        })).toBe(display);
        expect(resolveQueuedMessagePreviewText({
            content: 'visible',
            failure: { recovery: { content: 'recovered', composerDocument: { text: 'recovered display', references: [] } } },
        })).toBe('recovered display');
    });

    test('decorates reserved-slot image citations as chips instead of raw placeholders', () => {
        const text = `[${DRAFT_COMPOSER_TRIGGER_ICON_SLOT}image-1.png] please review`;
        const parts = buildQueuedMessagePreviewParts(text, {
            attachments: [{ filename: 'image-1.png', mimeType: 'image/png', source: 'local' }],
        });
        expect(parts?.[0]?.type).toBe('reference');
        if (parts?.[0]?.type !== 'reference') throw new Error('expected image reference');
        expect([parts[0].decoration.kind, parts[0].decoration.label, parts[0].decoration.icon]).toEqual([
            'image',
            'image-1.png',
            'file-image',
        ]);
        expect(parts?.[1]).toEqual({ type: 'text', text: ' please review' });
    });

    test('decorates reserved-slot document citations with the attachment icon', () => {
        const text = `[${DRAFT_COMPOSER_TRIGGER_ICON_SLOT}openchamber-diagnostics.json] 你看一下日志`;
        const parts = buildQueuedMessagePreviewParts(text, {
            attachments: [{ filename: 'openchamber-diagnostics.json', mimeType: 'application/json', source: 'local' }],
        });
        expect(parts?.[0]?.type).toBe('reference');
        if (parts?.[0]?.type !== 'reference') throw new Error('expected attachment reference');
        expect([parts[0].decoration.kind, parts[0].decoration.label, parts[0].decoration.icon]).toEqual([
            'attachment',
            'openchamber-diagnostics.json',
            'attachment-2',
        ]);
        expect(parts?.[1]).toEqual({ type: 'text', text: ' 你看一下日志' });
    });

    test('decorates session mentions from composer document sidecars', () => {
        const label = `MessageReferenceChip`;
        const text = `@${DRAFT_COMPOSER_TRIGGER_ICON_SLOT}${label} follow up`;
        const parts = buildQueuedMessagePreviewParts(text, {
            composerDocument: {
                text,
                references: [{ kind: 'session', sessionId: 'ses_1', display: `@${DRAFT_COMPOSER_TRIGGER_ICON_SLOT}${label}` }],
            },
        });
        expect(parts?.[0]?.type).toBe('reference');
        if (parts?.[0]?.type !== 'reference') throw new Error('expected session reference');
        expect([parts[0].decoration.kind, parts[0].decoration.label, parts[0].decoration.icon]).toEqual([
            'session',
            label,
            'chat-thread',
        ]);
    });

    test('decorates skill slash tokens from composer document sidecars', () => {
        const skillName = 'improve-codebase-architecture';
        const text = `使用 /${DRAFT_COMPOSER_TRIGGER_ICON_SLOT}${skillName} 再次审查`;
        const parts = buildQueuedMessagePreviewParts(text, {
            composerDocument: {
                text,
                references: [{
                    kind: 'skill',
                    skillName,
                    display: `/${DRAFT_COMPOSER_TRIGGER_ICON_SLOT}${skillName}`,
                }],
            },
        });
        expect(parts?.[0]?.type).toBe('text');
        expect(parts?.[0]).toEqual({ type: 'text', text: '使用 ' });
        expect(parts?.[1]?.type).toBe('reference');
        if (parts?.[1]?.type !== 'reference') throw new Error('expected skill reference');
        expect([parts[1].decoration.kind, parts[1].decoration.label, parts[1].decoration.icon, parts[1].decoration.skillName]).toEqual([
            'skill',
            `/${skillName}`,
            'book-open',
            skillName,
        ]);
        expect(parts?.[2]).toEqual({ type: 'text', text: ' 再次审查' });
    });

    test('decorates command slash tokens from composer document sidecars', () => {
        const commandName = 'release';
        const text = `run /${DRAFT_COMPOSER_TRIGGER_ICON_SLOT}${commandName} now`;
        const parts = buildQueuedMessagePreviewParts(text, {
            composerDocument: {
                text,
                references: [{
                    kind: 'command',
                    commandName,
                    display: `/${DRAFT_COMPOSER_TRIGGER_ICON_SLOT}${commandName}`,
                }],
            },
        });
        expect(parts?.[0]).toEqual({ type: 'text', text: 'run ' });
        expect(parts?.[1]?.type).toBe('reference');
        if (parts?.[1]?.type !== 'reference') throw new Error('expected command reference');
        expect([parts[1].decoration.kind, parts[1].decoration.label, parts[1].decoration.icon]).toEqual([
            'command',
            `/${commandName}`,
            'command',
        ]);
        expect(parts?.[2]).toEqual({ type: 'text', text: ' now' });
    });

    test('keeps a single-line preview marker for multiline content', () => {
        expect(queuedMessagePreviewLine('first\nsecond')).toBe('first...');
        expect(queuedMessagePreviewLine('only')).toBe('only');
    });
});