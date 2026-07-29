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

/**
 * Legacy queue edit: commit restoration first, then remove only when the draft
 * is current+committed. Avoids pop-before-async-restore data loss.
 * Returns true when the queue item may be removed; false keeps the queue item.
 */
export const shouldRemoveQueueItemAfterEditCommit = (result: {
    status: string
    current: boolean
    durable?: boolean
}): boolean => result.status === 'committed' && result.current === true;

/** Snapshot fields needed to restore a queue row into the composer without popping first. */
type LegacyQueueEditRestoreSource = {
    content: string
    attachments?: QueuedMessage['attachments']
    composerDocument?: QueuedMessage['composerDocument']
    composerMentions?: QueuedMessage['composerMentions']
};

export const legacyQueueEditRestoreSource = (message: QueuedMessage): LegacyQueueEditRestoreSource => {
    const recovery = message.failure?.recovery;
    return {
        content: recovery?.content ?? message.content,
        attachments: recovery?.attachments ?? message.attachments,
        composerDocument: recovery?.composerDocument ?? message.composerDocument,
        composerMentions: recovery?.composerMentions ?? message.composerMentions,
    };
};

export const canSendQueuedMessage = (message: QueuedMessage, hasDispatchLock: boolean): boolean => {
    const status = message.status ?? 'queued';
    return !hasDispatchLock && (status === 'queued' || status === 'retrying' || status === 'failed' || status === 'unresolved');
};

export const canSendServerQueuedMessage = (message: MessageQueueServerDisplayItem, hasDispatchLock: boolean): boolean => {
    if (isMessageQueuePendingAdmissionItem(message)) return false;
    if (hasDispatchLock) return false;
    return ['queued', 'retrying', 'failed', 'unresolved'].includes(message.status);
};

export const canEditQueuedMessage = (
    message: QueuedMessage | MessageQueueServerDisplayItem,
    options: { frozen: boolean },
): boolean => !options.frozen && !isMessageQueuePendingAdmissionItem(message);

// Remove is always a client-authoritative discard of queue tracking. Once an
// attempt crossed the POST boundary it cannot unsend the upstream message, but
// a stale sending/reconciling record must never trap the user in a locked chip.
export const canRemoveQueuedMessage = (
    message: QueuedMessage | MessageQueueServerDisplayItem,
    options: { frozen: boolean },
): boolean => {
    if (options.frozen) return false;
    if (isMessageQueuePendingAdmissionItem(message)) return false;
    return true;
};

export const isServerQueueItemActiveAttempt = (item: Pick<MessageQueueItem, 'status'>): boolean => item.status === 'sending' || item.status === 'reconciling';

// Authoritative server item is dispatch-pending when an explicit manual dispatch
// was requested (POST ack acknowledged but the worker has not yet started) or the
// worker has begun the attempt (sending/reconciling). Pending admission rows are
// handled by the component through isMessageQueuePendingAdmissionItem; this only
// inspects authoritative MessageQueueItem rows.
export const isServerQueueItemDispatchPending = (item: MessageQueueItem): boolean => item.manualDispatchRequested === true || item.status === 'sending' || item.status === 'reconciling';

// Tracking rows that already crossed (or are about to cross) the send boundary stay
// durable server-side until exact confirmation/tombstone, but chips hide them so the
// user sees only waiting/recoverable work. failed/unresolved restore visibility.
export const isServerQueueItemHiddenFromChips = (item: MessageQueueItem): boolean => (
    item.manualDispatchRequested === true || item.status === 'sending' || item.status === 'reconciling'
);

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

/** Successful send mutations that still outrank the authoritative scope revision keep hiding their target until the observer converges. */
export type ServerQueueCommittedSendShadow = ServerQueueOperationIdentity & {
    kind: 'send';
    committedRevision: number;
};

type ServerQueueExactScope = { transportIdentity: string; runtimeGeneration: number; directory: string; sessionID: string; scopeID: string };

const matchesExactScope = (operation: ServerQueueOperationIdentity, exactScope: ServerQueueExactScope): boolean => (
    operation.transportIdentity === exactScope.transportIdentity
    && operation.runtimeGeneration === exactScope.runtimeGeneration
    && operation.directory === exactScope.directory
    && operation.sessionID === exactScope.sessionID
    && operation.scopeID === exactScope.scopeID
);

// Select the pending operation whose identity exactly matches the target scope
// (transportIdentity + runtimeGeneration + directory + sessionID + scopeID). Returns undefined when
// no operation targets that exact scope. This isolates optimistic overlays per
// scope so a runtime switch or a different session never inherits another scope's
// pending operation.
export const selectPendingServerQueueOperation = (
    operations: readonly ServerQueueOperationIdentity[],
    exactScope: ServerQueueExactScope,
): ServerQueueOperationIdentity | undefined => operations.find((operation) => matchesExactScope(operation, exactScope));

export const selectPendingServerQueueOperations = (
    operations: readonly ServerQueueOperationIdentity[],
    exactScope: ServerQueueExactScope,
): readonly ServerQueueOperationIdentity[] => operations.filter((operation) => matchesExactScope(operation, exactScope));

/**
 * Keep successful send overlays while the authoritative scope revision is still
 * behind the mutation receipt. Stops when scope.revision >= committedRevision,
 * runtime generation mismatches, or the mutation is gone from the cache.
 * Does not write the revision-pinned Query cache — overlay ownership only.
 */
export const selectCommittedSendShadows = (
    shadows: readonly ServerQueueCommittedSendShadow[],
    exactScope: ServerQueueExactScope,
    authoritativeRevision: number | undefined,
): readonly ServerQueueOperationIdentity[] => shadows.filter((shadow) => (
    matchesExactScope(shadow, exactScope)
    && Number.isSafeInteger(shadow.committedRevision)
    && shadow.committedRevision > 0
    && (authoritativeRevision === undefined || authoritativeRevision < shadow.committedRevision)
));

// Pure optimistic reordering over authoritative server items. Only existing item
// references are reused; no item is recreated and pending admission rows are
// preserved untouched.
//   - send/edit/remove: hide the target immediately; definitive mutation failure
//     clears the pending overlay so waiting/failed/unresolved rows reappear.
//   - reorder: reorders existing items to match queueItemIDs order; returns the
//     original array reference when the existing order already matches.
// When the target is missing or the reorder order already matches, the original
// array reference is returned so React skips re-rendering.
export const applyPendingServerQueueOperation = (
    items: readonly MessageQueueServerDisplayItem[],
    operation: ServerQueueOperationIdentity,
): readonly MessageQueueServerDisplayItem[] => {
    if (operation.kind === 'edit' || operation.kind === 'remove' || operation.kind === 'send') {
        const index = items.findIndex((item) => !isMessageQueuePendingAdmissionItem(item) && item.queueItemID === operation.queueItemID);
        if (index < 0) return items;
        return [...items.slice(0, index), ...items.slice(index + 1)];
    }
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
    return items;
};

export const applyPendingServerQueueOperations = (
    items: readonly MessageQueueServerDisplayItem[],
    operations: readonly ServerQueueOperationIdentity[],
): readonly MessageQueueServerDisplayItem[] => operations.reduce(applyPendingServerQueueOperation, items);

// Chip projection: apply pending + committed-ack-revision send shadows, then hide
// authoritative tracking rows (manual intent / sending / reconciling). Durable
// rows remain on the server until exact message confirmation or tombstone.
// failed/unresolved reappear once the authoritative revision reaches the ack
// (shadow ends) even if a success mutation entry remains briefly in cache.
export const projectServerQueueChipItems = (
    items: readonly MessageQueueServerDisplayItem[],
    operations: readonly ServerQueueOperationIdentity[],
): readonly MessageQueueServerDisplayItem[] => {
    const projected = applyPendingServerQueueOperations(items, operations);
    const visible = projected.filter((item) => isMessageQueuePendingAdmissionItem(item) || !isServerQueueItemHiddenFromChips(item));
    return visible.length === projected.length ? projected : visible;
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
    visibleItems: readonly MessageQueueServerDisplayItem[] = scope.items,
): { requestID: string; scopeID: string; revision: number; queueItemIDs: string[] } | null => {
    const visibleIDs = visibleItems
        .filter((item): item is MessageQueueItem => !isMessageQueuePendingAdmissionItem(item))
        .map((item) => item.queueItemID);
    const from = visibleIDs.indexOf(activeID);
    const to = visibleIDs.indexOf(overID);
    if (from < 0 || to < 0 || from === to) return null;
    const [moved] = visibleIDs.splice(from, 1);
    if (!moved) return null;
    visibleIDs.splice(to, 0, moved);

    const visibleSet = new Set(visibleIDs);
    let visibleIndex = 0;
    const queueItemIDs = scope.items.map((item) => {
        if (!visibleSet.has(item.queueItemID)) return item.queueItemID;
        return visibleIDs[visibleIndex++] ?? item.queueItemID;
    });
    return { requestID, scopeID: scope.scopeID, revision: scope.revision, queueItemIDs };
};
