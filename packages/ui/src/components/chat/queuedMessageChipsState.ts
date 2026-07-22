import type { QueueScope, QueuedMessage } from '@/stores/messageQueueStore';
import type { MessageQueueItem, MessageQueueScope } from '@/lib/message-queue-server';
import type { DraftKey } from '@/sync/input-draft-types';
import type { DraftCommitInput } from '@/sync/input-store';
import { isMessageQueuePendingAdmissionItem, type MessageQueueServerDisplayItem } from '@/sync/message-queue-server-runtime';

export const queueModeAllowsMutations = (mode: 'legacy' | 'server' | 'frozen'): boolean => mode !== 'frozen';

export const mergeQueuedMessageScopes = (
    legacyQueuedMessages: QueuedMessage[],
    boundQueuedMessages: QueuedMessage[],
): QueuedMessage[] => {
    if (legacyQueuedMessages.length === 0) return boundQueuedMessages;
    if (boundQueuedMessages.length === 0) return legacyQueuedMessages;
    return [...legacyQueuedMessages, ...boundQueuedMessages];
};

export const popQueuedMessageForEdit = (
    message: QueuedMessage,
    popToInput: (scope: QueueScope, queueItemID: string, operationID: string | undefined) => QueuedMessage | null,
): QueuedMessage | null => {
    if (!message.owner) return null;
    return popToInput(message.owner, message.queueItemID ?? message.id, message.operationID);
};

export const canSendQueuedMessage = (message: QueuedMessage, hasDispatchLock: boolean): boolean => {
    const status = message.status ?? 'queued';
    return !hasDispatchLock && (status === 'queued' || status === 'retrying' || status === 'failed' || status === 'unresolved');
};

export const canSendServerQueuedMessage = (message: MessageQueueServerDisplayItem, hasDispatchLock: boolean): boolean => {
    if (isMessageQueuePendingAdmissionItem(message)) return false;
    if (hasDispatchLock) return false;
    if (message.manualDispatchRequested === true) return false;
    return ['queued', 'retrying', 'failed', 'unresolved'].includes(message.status);
};

// Remove stays available while a manual dispatch is only requested (still queued).
// Server remove is blocked solely for in-flight dispatch statuses; keep edit/send
// locked separately via isReadOnly / canSend*.
export const canRemoveQueuedMessage = (
    message: QueuedMessage | MessageQueueServerDisplayItem,
    options: { frozen: boolean; scopeOperationPending?: boolean },
): boolean => {
    if (options.frozen) return false;
    if (options.scopeOperationPending) return false;
    if (isMessageQueuePendingAdmissionItem(message)) return false;
    const status = ('status' in message ? message.status : undefined) ?? 'queued';
    return status !== 'sending' && status !== 'reconciling';
};

// Authoritative server item is dispatch-pending when an explicit manual dispatch
// was requested (POST ack acknowledged but the worker has not yet started) or the
// worker has begun the attempt (sending/reconciling). Pending admission rows are
// handled by the component through isMessageQueuePendingAdmissionItem; this only
// inspects authoritative MessageQueueItem rows.
export const isServerQueueItemDispatchPending = (item: MessageQueueItem): boolean => item.manualDispatchRequested === true || item.status === 'sending' || item.status === 'reconciling';

export type ServerQueueOperationKind = 'edit' | 'send' | 'remove' | 'reorder';

export type ServerQueueOperationIdentity = {
    kind: ServerQueueOperationKind;
    transportIdentity: string;
    runtimeGeneration: number;
    directory: string;
    sessionID: string;
    scopeID: string;
    queueItemID: string;
    queueItemIDs?: string[];
};

type ServerQueueExactScope = { transportIdentity: string; runtimeGeneration: number; directory: string; sessionID: string; scopeID: string };

// Select the pending operation whose identity exactly matches the target scope
// (transportIdentity + runtimeGeneration + directory + sessionID + scopeID). Returns undefined when
// no operation targets that exact scope. This isolates optimistic overlays per
// scope so a runtime switch or a different session never inherits another scope's
// pending operation.
export const selectPendingServerQueueOperation = (
    operations: readonly ServerQueueOperationIdentity[],
    exactScope: ServerQueueExactScope,
): ServerQueueOperationIdentity | undefined => operations.find((operation) =>
    operation.transportIdentity === exactScope.transportIdentity
    && operation.runtimeGeneration === exactScope.runtimeGeneration
    && operation.directory === exactScope.directory
    && operation.sessionID === exactScope.sessionID
    && operation.scopeID === exactScope.scopeID
);

// Pure optimistic reordering over authoritative server items. Only existing item
// references are reused; no item is recreated and pending admission rows are
// preserved untouched.
//   - send: moves the existing target item reference to position 0.
//   - reorder: reorders existing items to match queueItemIDs order; returns the
//     original array reference when the existing order already matches.
//   - edit/remove: return the original array reference (overlay-only).
// When the target is missing or the reorder order already matches, the original
// array reference is returned so React skips re-rendering.
export const applyPendingServerQueueOperation = (
    items: readonly MessageQueueServerDisplayItem[],
    operation: ServerQueueOperationIdentity,
): readonly MessageQueueServerDisplayItem[] => {
    if (operation.kind === 'edit' || operation.kind === 'remove') return items;
    if (operation.kind === 'reorder') {
        const order = operation.queueItemIDs;
        if (!order) return items;
        // Only authoritative items are reordered; pending admission rows and any
        // items not listed in the requested order keep their relative positions
        // after the reordered authoritative subset. When the existing authoritative
        // order already matches the requested order, return the original reference.
        const authoritativeByID = new Map<string, MessageQueueItem>();
        const authoritative: MessageQueueItem[] = [];
        const pending: MessageQueueServerDisplayItem[] = [];
        for (const item of items) {
            if (isMessageQueuePendingAdmissionItem(item)) {
                pending.push(item);
                continue;
            }
            authoritative.push(item);
            authoritativeByID.set(item.queueItemID, item);
        }
        const ordered: MessageQueueItem[] = [];
        const orderedIDs = new Set<string>();
        for (const queueItemID of order) {
            const item = authoritativeByID.get(queueItemID);
            if (item && !orderedIDs.has(queueItemID)) {
                ordered.push(item);
                orderedIDs.add(queueItemID);
            }
        }
        const remainder = authoritative.filter((item) => !orderedIDs.has(item.queueItemID));
        const next = [...ordered, ...remainder, ...pending];
        if (next.every((item, index) => item === items[index])) return items;
        return next;
    }
    // send: move the existing target item reference to the front.
    const index = items.findIndex((item) => !isMessageQueuePendingAdmissionItem(item) && item.queueItemID === operation.queueItemID);
    if (index <= 0) return items;
    const next = [...items];
    const [moved] = next.splice(index, 1);
    if (!moved) return items;
    next.unshift(moved);
    return next;
};

export const serverQueueItemMutationInput = (scope: MessageQueueScope, item: MessageQueueItem, requestID: string) => ({
    requestID,
    scopeID: scope.scopeID,
    revision: scope.revision,
    item,
});

export const serverQueueEditInput = (scope: MessageQueueScope, item: MessageQueueItem, targetKey: DraftKey, expectedRevision: DraftCommitInput['expectedRevision']) => ({
    scopeID: scope.scopeID,
    scopeRevision: scope.revision,
    item,
    targetKey,
    expectedRevision,
});

export const reorderServerQueueItems = (
    scope: MessageQueueScope,
    activeID: string,
    overID: string,
    requestID: string,
): { requestID: string; scopeID: string; revision: number; queueItemIDs: string[] } | null => {
    const from = scope.items.findIndex((item) => item.queueItemID === activeID);
    const to = scope.items.findIndex((item) => item.queueItemID === overID);
    if (from < 0 || to < 0 || from === to) return null;
    const queueItemIDs = scope.items.map((item) => item.queueItemID);
    const [moved] = queueItemIDs.splice(from, 1);
    if (!moved) return null;
    queueItemIDs.splice(to, 0, moved);
    return { requestID, scopeID: scope.scopeID, revision: scope.revision, queueItemIDs };
};
