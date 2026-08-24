import type { QueueScope, QueuedMessage } from '@/stores/messageQueueStore';
import type { MessageQueueItem, MessageQueueScope } from '@/lib/message-queue-server';
import type { DraftKey } from '@/sync/input-draft-types';
import type { DraftCommitInput } from '@/sync/input-store';
import { isMessageQueuePendingAdmissionItem, type MessageQueueServerDisplayItem } from '@/sync/message-queue-server-runtime';
import { isInlineAttachmentCitation } from '@/composer/inline-attachment-sync';
import { normalizeDirectoryKey } from '@/lib/pathNormalization';
import {
    buildMessageReferenceParts,
    type MessageReferenceDetectContext,
    type MessageTextPart,
} from '@/lib/messages/references';

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

export const canSendServerQueuedMessage = (
    message: MessageQueueServerDisplayItem,
    hasDispatchLock: boolean,
    options?: { allowManualDispatchRetry?: boolean },
): boolean => {
    if (isMessageQueuePendingAdmissionItem(message)) return false;
    if (hasDispatchLock) return false;
    if (message.manualDispatchRequested === true && !options?.allowManualDispatchRetry) return false;
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

/** Legacy queue row is dispatch-pending while an optimistic/in-flight attempt owns the transcript paint. */
export const isLegacyQueueItemDispatchPending = (item: QueuedMessage): boolean => item.status === 'sending' || item.status === 'reconciling';

// Authoritative server item is dispatch-pending when an explicit manual dispatch
// was requested (POST ack acknowledged but the worker has not yet started) or the
// worker has begun the attempt (sending/reconciling). Pending admission rows are
// handled by the component through isMessageQueuePendingAdmissionItem; this only
// inspects authoritative MessageQueueItem rows.
export const isServerQueueItemDispatchPending = (item: MessageQueueItem): boolean => item.manualDispatchRequested === true || item.status === 'sending' || item.status === 'reconciling';

// Chips hide only after the worker truly starts consuming the row (sending/reconciling).
// Pending client send, committed-ack send shadows, and authoritative
// `manualDispatchRequested` keep the waiting row visible in a "Sending…" state.
// failed/unresolved restore normal Send/Edit once tracking ends.
export const isServerQueueItemHiddenFromChips = (item: MessageQueueItem): boolean => (
    item.status === 'sending' || item.status === 'reconciling'
);

/** Client presentation timeout for optimistic/manual send-pending before restoring Send. */
export const SERVER_QUEUE_SEND_PENDING_TIMEOUT_MS = 8_000;

export const isServerQueueSendPendingTimedOut = (
    startedAtMs: number,
    nowMs: number,
    timeoutMs = SERVER_QUEUE_SEND_PENDING_TIMEOUT_MS,
): boolean => {
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs) || !Number.isFinite(timeoutMs)) return false;
    if (timeoutMs < 0) return false;
    return nowMs - startedAtMs >= timeoutMs;
};

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

/** Successful send mutations that still outrank the authoritative scope revision keep the waiting row in send-pending UI until the observer converges. */
export type ServerQueueCommittedSendShadow = ServerQueueOperationIdentity & {
    kind: 'send';
    committedRevision: number;
};

type ServerQueueExactScope = { transportIdentity: string; runtimeGeneration: number; directory: string; sessionID: string; scopeID: string };

const matchesExactScope = (operation: ServerQueueOperationIdentity, exactScope: ServerQueueExactScope): boolean => (
    operation.transportIdentity === exactScope.transportIdentity
    && operation.runtimeGeneration === exactScope.runtimeGeneration
    && normalizeDirectoryKey(operation.directory) === normalizeDirectoryKey(exactScope.directory)
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
//   - edit/remove: hide the target immediately; definitive mutation failure
//     clears the pending overlay so waiting/failed/unresolved rows reappear.
//   - send: leave the target visible (chip shows "Sending…"); definitive mutation
//     failure clears the pending overlay so Send/Edit return.
//   - reorder: reorders existing items to match queueItemIDs order; returns the
//     original array reference when the existing order already matches.
// When the target is missing or the reorder order already matches, the original
// array reference is returned so React skips re-rendering.
export const applyPendingServerQueueOperation = (
    items: readonly MessageQueueServerDisplayItem[],
    operation: ServerQueueOperationIdentity,
): readonly MessageQueueServerDisplayItem[] => {
    if (operation.kind === 'send') {
        return items;
    }
    if (operation.kind === 'edit' || operation.kind === 'remove') {
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
// only authoritative sending/reconciling rows. Pending/committed send overlays and
// `manualDispatchRequested` leave the waiting row visible for "Sending…" UI.
// Durable rows remain on the server until exact message confirmation or tombstone.
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

type QueuePreviewAttachment = {
    filename?: string;
    mimeType?: string;
    source?: 'local' | 'server' | 'vscode';
    vscodeSource?: 'file' | 'selection';
};

type QueuePreviewComposerReference = {
    kind?: unknown;
    sessionId?: unknown;
    skillName?: unknown;
    commandName?: unknown;
    display?: unknown;
};

type QueuePreviewComposerDocument = {
    text?: string;
    references?: readonly QueuePreviewComposerReference[];
};

/** Prefer composer display text so reserved-slot citations/mentions stay chip-decoratable. */
export const resolveQueuedMessagePreviewText = (message: {
    content: string;
    composerDocument?: QueuePreviewComposerDocument | null;
    failure?: { recovery?: { content?: string; composerDocument?: QueuePreviewComposerDocument | null } };
}): string => {
    const recovery = message.failure?.recovery;
    const display = recovery?.composerDocument?.text ?? message.composerDocument?.text;
    if (typeof display === 'string' && display.length > 0) return display;
    return recovery?.content ?? message.content;
};

export const buildCitationIconsFromQueueAttachments = (
    attachments: readonly QueuePreviewAttachment[] | undefined,
): Map<string, 'image' | 'attachment'> => {
    const icons = new Map<string, 'image' | 'attachment'>();
    for (const attachment of attachments ?? []) {
        const filename = typeof attachment.filename === 'string' ? attachment.filename.trim() : '';
        if (!filename) continue;
        const key = filename.toLowerCase();
        if (attachment.mimeType?.startsWith('image/')) {
            icons.set(key, 'image');
            continue;
        }
        if (
            isInlineAttachmentCitation({
                source: attachment.source ?? 'local',
                vscodeSource: attachment.vscodeSource,
                mimeType: attachment.mimeType,
            })
        ) {
            icons.set(key, 'attachment');
        }
    }
    return icons;
};

export const buildQueuedMessagePreviewSessionMentions = (
    composerDocument: QueuePreviewComposerDocument | null | undefined,
): MessageReferenceDetectContext['sessionMentions'] => {
    const mentions: Array<{ sessionId: string; sessionLabel: string }> = [];
    for (const reference of composerDocument?.references ?? []) {
        if (reference.kind !== 'session' || typeof reference.sessionId !== 'string') continue;
        const display = typeof reference.display === 'string' ? reference.display : '';
        const sessionLabel = display.replace(/^@\u2003?/, '').trim() || reference.sessionId;
        mentions.push({ sessionId: reference.sessionId, sessionLabel });
    }
    return mentions;
};

/** Known slash names from composer sidecars so queue preview can decorate skills/commands without a live catalog. */
export const buildQueuedMessagePreviewSlashNames = (
    composerDocument: QueuePreviewComposerDocument | null | undefined,
): Pick<MessageReferenceDetectContext, 'skillNames' | 'commandNames'> => {
    const skillNames = new Set<string>();
    const commandNames = new Set<string>();
    for (const reference of composerDocument?.references ?? []) {
        if (reference.kind === 'skill' && typeof reference.skillName === 'string' && reference.skillName) {
            skillNames.add(reference.skillName);
            continue;
        }
        if (reference.kind === 'command' && typeof reference.commandName === 'string' && reference.commandName) {
            commandNames.add(reference.commandName);
        }
    }
    return {
        skillNames: skillNames.size > 0 ? skillNames : undefined,
        commandNames: commandNames.size > 0 ? commandNames : undefined,
    };
};

/** First visual line for the queue chip; CSS truncation owns overflow. */
export const queuedMessagePreviewLine = (text: string): string => {
    const first = text.split('\n')[0] ?? '';
    return first + (text.includes('\n') ? '...' : '');
};

/**
 * Decorated preview parts for a queue chip. Returns null when the line has no
 * reference tokens so the caller can keep a plain-text fast path.
 */
export const buildQueuedMessagePreviewParts = (
    text: string,
    options: {
        attachments?: readonly QueuePreviewAttachment[];
        composerDocument?: QueuePreviewComposerDocument | null;
    } = {},
): MessageTextPart[] | null => {
    const line = queuedMessagePreviewLine(text);
    if (!line) return null;
    const slashNames = buildQueuedMessagePreviewSlashNames(options.composerDocument);
    return buildMessageReferenceParts(line, {
        citationIcons: buildCitationIconsFromQueueAttachments(options.attachments),
        sessionMentions: buildQueuedMessagePreviewSessionMentions(options.composerDocument),
        skillNames: slashNames.skillNames,
        commandNames: slashNames.commandNames,
        allowPathHeuristics: true,
    });
};
