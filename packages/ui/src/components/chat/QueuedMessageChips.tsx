import React, { memo } from 'react';
import {
    DndContext,
    MouseSensor,
    TouchSensor,
    useSensor,
    useSensors,
    closestCenter,
    type DragEndEvent,
} from '@dnd-kit/core';
import {
    SortableContext,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEvent } from '@reactuses/core';
import { useMutation, useMutationState } from '@tanstack/react-query';
import { getPendingAdmissionsForScope, getQueueForScope, legacyQueueScope, queueScopeKey, useMessageQueueStore, type QueueDeliveryTarget, type QueueItem, type QueuePendingAdmissionItem, type QueueScope, type QueuedMessage } from '@/stores/messageQueueStore';
import type { DraftKey } from '@/sync/input-draft-types';
import { useMessageQueueServerScope } from '@/sync/use-message-queue-server';
import { MessageQueueServerError, type MessageQueueItem } from '@/lib/message-queue-server';
import { isMessageQueuePendingAdmissionItem, type MessageQueueServerDisplayItem, type MessageQueueServerMutationResult, type MessageQueueServerRuntimeCapture } from '@/sync/message-queue-server-runtime';
import type { MessageQueueEditResult } from '@/sync/message-queue-edit-bridge';
import { useI18n } from '@/lib/i18n';
import { useQueueScopeDispatchFlight } from '@/hooks/useQueuedMessageAutoSend';
import { useUIStore } from '@/stores/useUIStore';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { createUuid } from '@/lib/uuid';
import { toast } from '@/components/ui';
import { MessageReferenceChip } from './MessageReferenceChip';
import { canEditQueuedMessage, canRemoveQueuedMessage, canSendQueuedMessage, canSendServerQueuedMessage, buildQueuedMessagePreviewParts, isLegacyQueueItemDispatchPending, isServerQueueItemActiveAttempt, isServerQueueItemDispatchPending, legacyQueueEditRestoreSource, mergeQueuedMessageScopes, projectServerQueueChipItems, queueModeAllowsMutations, queuedMessagePreviewLine, reorderServerQueueItems, resolveQueuedMessagePreviewText, selectCommittedSendShadows, selectPendingServerQueueOperations, SERVER_QUEUE_SEND_PENDING_TIMEOUT_MS, serverQueueEditInput, serverQueueItemMutationInput, type ServerQueueCommittedSendShadow, type ServerQueueOperationIdentity, type ServerQueueOperationKind } from './queuedMessageChipsState';
import { isQueueItemSendPendingByAbortOptimistic, subscribeQueueAbortOptimistic, getQueueAbortOptimisticRevision } from '@/sync/queue-abort-optimistic';
import { enqueueServerQueueScopeMutation, type ServerQueueScopeMutationFlights } from './queueAdmission';

type BoundQueueScope = Extract<QueueScope, { state: 'bound' }> & {
    deliveryTarget: QueueDeliveryTarget;
    runtimeGeneration: number;
};
type ServerQueueEditInput = ReturnType<typeof serverQueueEditInput>;
type ServerQueueItemInput = ReturnType<typeof serverQueueItemMutationInput>;
type ServerQueueReorderInput = NonNullable<ReturnType<typeof reorderServerQueueItems>>;
type ServerQueueMutationResult = MessageQueueEditResult | MessageQueueServerMutationResult;
type ServerQueueMutationIdentity = ServerQueueOperationIdentity & { requestID: string; runtime: MessageQueueServerRuntimeCapture };
type ServerQueueMutationVariables =
    | (ServerQueueMutationIdentity & { kind: Extract<ServerQueueOperationKind, 'edit'>; input: ServerQueueEditInput })
    | (ServerQueueMutationIdentity & { kind: Extract<ServerQueueOperationKind, 'send'>; input: ServerQueueItemInput })
    | (ServerQueueMutationIdentity & { kind: Extract<ServerQueueOperationKind, 'remove'>; input: ServerQueueItemInput })
    | (ServerQueueMutationIdentity & { kind: Extract<ServerQueueOperationKind, 'reorder'>; input: ServerQueueReorderInput });

const isServerQueueOperationIdentity = (value: unknown): value is ServerQueueOperationIdentity => {
    if (!value || typeof value !== 'object') return false;
    const operation = value as Record<string, unknown>;
    return (operation.kind === 'edit' || operation.kind === 'send' || operation.kind === 'remove' || operation.kind === 'reorder')
        && typeof operation.transportIdentity === 'string'
        && typeof operation.runtimeGeneration === 'number'
        && Number.isSafeInteger(operation.runtimeGeneration)
        && operation.runtimeGeneration >= 0
        && typeof operation.directory === 'string'
        && typeof operation.sessionID === 'string'
        && typeof operation.scopeID === 'string'
        && typeof operation.queueItemID === 'string'
        && (operation.queueItemIDs === undefined || (Array.isArray(operation.queueItemIDs) && operation.queueItemIDs.every((item) => typeof item === 'string')));
};

interface QueuedMessageChipProps {
    message: QueuedMessage | MessageQueueServerDisplayItem;
    server: boolean;
    frozen: boolean;
    hasDispatchLock: boolean;
    pendingOperationKinds: ReadonlySet<ServerQueueOperationKind>;
    /** Client send-pending presentation timed out; restore Send/Edit until a fresh pending cycle. */
    sendPendingTimedOut: boolean;
    /** Abort-after-queue keeps the chip in "Sending…" until OpenCode actually consumes it. */
    abortSendPending: boolean;
    isMobile: boolean;
    onEdit: (message: QueuedMessage | MessageQueueServerDisplayItem) => void;
    onSend: (message: QueuedMessage | MessageQueueServerDisplayItem) => void;
    onRemove: (message: QueuedMessage | MessageQueueServerDisplayItem) => void;
}

const QueuedMessageChip = memo(({ message, server, frozen, hasDispatchLock, pendingOperationKinds, sendPendingTimedOut, abortSendPending, isMobile, onEdit, onSend, onRemove }: QueuedMessageChipProps) => {
    const { t } = useI18n();
    const pendingAdmission = isMessageQueuePendingAdmissionItem(message);
    const queueItemID = message.queueItemID || (message as QueuedMessage).id;
    const editPending = server && pendingOperationKinds.has('edit');
    const removePending = server && pendingOperationKinds.has('remove');
    const reorderPending = server && pendingOperationKinds.has('reorder');
    const legacyMessage = server || pendingAdmission ? undefined : message as QueuedMessage;
    const authoritativeDispatchPending = server && !pendingAdmission && isServerQueueItemDispatchPending(message as MessageQueueItem);
    const legacyDispatchPending = Boolean(legacyMessage && isLegacyQueueItemDispatchPending(legacyMessage));
    const activeAttempt = server && !pendingAdmission && isServerQueueItemActiveAttempt(message as MessageQueueItem);
    const rawSendPending = (server && pendingOperationKinds.has('send')) || authoritativeDispatchPending || legacyDispatchPending;
    const sendPending = abortSendPending || (rawSendPending && !sendPendingTimedOut);
    // Client edit/remove remains authoritative even when delivery tracking is
    // stale. Sending and dragging an already-started attempt stay unavailable
    // because they would imply a second POST or a movable active slot.
    const clientMutationBlocked = frozen || pendingAdmission;
    const canEdit = canEditQueuedMessage(message, { frozen });
    const canRemove = canRemoveQueuedMessage(message, { frozen });
    const isDragDisabled = legacyMessage?.owner?.state === 'unbound-legacy' || clientMutationBlocked || activeAttempt;
    const canSend = !clientMutationBlocked && !sendPending && (server
        ? canSendServerQueuedMessage(message as MessageQueueServerDisplayItem, hasDispatchLock, { allowManualDispatchRetry: sendPendingTimedOut })
        : canSendQueuedMessage(message as QueuedMessage, hasDispatchLock));
    const recovery = legacyMessage?.failure?.recovery;
    const visibleContent = resolveQueuedMessagePreviewText(message);
    const visibleAttachments = pendingAdmission ? undefined : recovery?.attachments ?? message.attachments;
    const visibleComposerDocument = recovery?.composerDocument ?? ('composerDocument' in message ? message.composerDocument : undefined);
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: queueItemID,
        disabled: isDragDisabled,
    });

    // First line only; CSS truncation owns overflow. Reference tokens render as chips
    // so reserved-slot placeholders like `[␠image-1.png]` never show raw.
    const firstLine = React.useMemo(() => queuedMessagePreviewLine(visibleContent), [visibleContent]);
    const previewParts = React.useMemo(() => buildQueuedMessagePreviewParts(visibleContent, {
        attachments: visibleAttachments,
        composerDocument: visibleComposerDocument,
    }), [visibleAttachments, visibleComposerDocument, visibleContent]);

    const attachmentCount = pendingAdmission ? message.attachmentCount : visibleAttachments?.length ?? 0;

    const removeAction = (
        <button
            type="button"
            onClick={() => onRemove(message)}
            disabled={!canRemove}
            aria-busy={removePending || undefined}
            className={cn(
                'inline-flex shrink-0 items-center justify-center bg-transparent text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
                // Mobile: compact hit target; slightly taller than pure icon size.
                isMobile ? 'h-7 w-3' : 'size-7',
            )}
            aria-label={t('chat.queuedMessage.removeAria')}
        >
            <Icon name={removePending ? 'loader-4' : 'delete-bin'} className={cn(isMobile ? 'size-3' : 'size-3.5', removePending && 'animate-spin')} aria-hidden="true" />
        </button>
    );

    return (
        <div
            ref={setNodeRef}
            // Translate only (no scaleX/scaleY) so the lifted row keeps its size.
            style={{ transform: CSS.Translate.toString(transform), transition }}
            className={cn(
                'flex min-w-0 items-center',
                isMobile
                    // Uniform gap; light vertical padding for a slightly taller row.
                    ? 'gap-1 py-0.5'
                    : 'flex gap-1.5 md:gap-2',
                isDragging && 'z-10 opacity-60',
            )}
        >
            <button
                type="button"
                {...attributes}
                {...listeners}
                disabled={isDragDisabled}
                aria-busy={reorderPending || undefined}
                className={cn(
                    'flex flex-shrink-0 touch-none select-none items-center justify-center text-muted-foreground',
                    isMobile ? 'h-7 w-3' : 'size-auto',
                    'transition-colors',
                    isDragDisabled ? 'cursor-default opacity-50' : 'cursor-grab hover:text-foreground active:cursor-grabbing',
                )}
                aria-label={t('chat.queuedMessage.reorderAria')}
            >
                <Icon name={reorderPending ? 'loader-4' : 'draggable'} className={cn(isMobile ? 'size-3' : 'size-3.5', reorderPending && 'animate-spin')} aria-hidden="true" />
            </button>
            {isMobile ? removeAction : null}
            <span className={cn(
                // items-baseline keeps chip labels on the same line as plain text
                // ("hey") / "+N files". MessageReferenceChip exposes its label baseline
                // (icon is a separate 1em well), matching sent-message rendering.
                'flex min-w-0 flex-1 items-baseline overflow-hidden whitespace-nowrap text-foreground',
                isMobile ? 'text-xs leading-5' : 'typography-ui-label leading-5',
            )}>
                {previewParts ? previewParts.map((part, index) => (
                    part.type === 'text'
                        ? <span key={`text-${index}`} className="min-w-0 truncate">{part.text}</span>
                        : (
                            <MessageReferenceChip
                                key={`ref-${index}-${part.span.start}`}
                                decoration={part.decoration}
                                interactive={false}
                            />
                        )
                )) : (firstLine || t('chat.queuedMessage.empty'))}
                {attachmentCount > 0 && (
                    <span className="ml-1 shrink-0 text-muted-foreground">{t('chat.queuedMessage.attachments', { count: attachmentCount })}</span>
                )}
            </span>
            <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                {pendingAdmission ? (
                    <span
                        className={cn(
                            'inline-flex items-center gap-1 font-medium text-muted-foreground',
                            isMobile ? 'h-7 text-[11px] leading-none' : 'h-7 typography-ui-label',
                        )}
                        aria-live="polite"
                        aria-label={t('chat.queuedMessage.queuingAria')}
                    >
                        <Icon name="loader-4" className={cn(isMobile ? 'size-3' : 'size-3.5', 'animate-spin')} aria-hidden="true" />
                        <span>{t('chat.queuedMessage.queuing')}</span>
                    </span>
                ) : sendPending ? (
                    <span
                        className={cn(
                            'inline-flex items-center gap-1 font-medium text-muted-foreground',
                            isMobile ? 'h-7 text-[11px] leading-none' : 'h-7 typography-ui-label',
                        )}
                        aria-live="polite"
                        aria-label={t('chat.queuedMessage.sendingAria')}
                    >
                        <Icon name="loader-4" className={cn(isMobile ? 'size-3' : 'size-3.5', 'animate-spin')} aria-hidden="true" />
                        <span>{t('chat.queuedMessage.sending')}</span>
                    </span>
                ) : (
                    <>
                        <button
                            type="button"
                            onClick={() => onEdit(message)}
                            disabled={!canEdit}
                            aria-busy={editPending || undefined}
                            aria-label={t('chat.queuedMessage.edit')}
                            className={cn(
                                'inline-flex items-center bg-transparent text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
                                isMobile ? 'h-7 gap-1.5 px-0 text-[11px]' : 'h-7 gap-1 px-0.5',
                            )}
                        >
                            <Icon
                                name={editPending ? 'loader-4' : 'edit'}
                                className={cn(isMobile ? 'size-3' : 'size-3.5', editPending && 'animate-spin')}
                                aria-hidden="true"
                            />
                            <span className={cn('font-medium', isMobile ? 'leading-none' : 'typography-ui-label')}>
                                {t('chat.queuedMessage.edit')}
                            </span>
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                if (sendPending) return;
                                onSend(message);
                            }}
                            disabled={!canSend || sendPending}
                            aria-busy={sendPending || undefined}
                            aria-label={t('chat.queuedMessage.send')}
                            className={cn(
                                'inline-flex items-center bg-transparent text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
                                isMobile ? 'h-7 gap-1.5 px-0 text-[11px]' : 'h-7 gap-1 px-0.5',
                            )}
                        >
                            <Icon
                                name="send-plane"
                                className={cn(isMobile ? 'size-3' : 'size-3.5')}
                                aria-hidden="true"
                            />
                            <span className={cn('font-medium', isMobile ? 'leading-none' : 'typography-ui-label')}>
                                {t('chat.queuedMessage.send')}
                            </span>
                        </button>
                    </>
                )}
                {!isMobile && !pendingAdmission ? removeAction : null}
            </div>
        </div>
    );
});

QueuedMessageChip.displayName = 'QueuedMessageChip';

interface QueuedMessageChipsProps {
    /**
     * Legacy queue edit: commit into the target DraftKey.
     * Resolves true only when the draft is status=committed and current=true;
     * the chip removes the queue item only after a successful true result.
     */
    onEditMessage: (content: string, attachments?: QueuedMessage['attachments'], composerDocument?: QueuedMessage['composerDocument'], composerMentions?: QueuedMessage['composerMentions']) => boolean | Promise<boolean>;
    onSendMessage: (messageId: string) => void;
    /** After draft restore succeeds (server or legacy), focus the composer for immediate editing. */
    onEditCommitted?: () => void;
    draftKey: DraftKey | null;
    scope: BoundQueueScope | null;
    /** Explicit draft target for server queue edit CAS (revision only). */
    draftTarget: { key: DraftKey; expectedRevision: () => number | 'absent' } | null;
    /**
     * Client-only pending-admission chips (e.g. establishing-session follow-ups).
     * Rendered with the same "Queuing…" treatment as legacy/server pending admissions.
     */
    clientPendingItems?: readonly QueuePendingAdmissionItem[];
    /** Remove a client-only pending chip (restoring content is caller-owned). */
    onRemoveClientPending?: (requestID: string) => void;
    /**
     * Optional trailing strip inside the same shell as queue chips (e.g. session goal).
     * Renders below the queue with a divider when both are present; shell still
     * opens when only this strip exists.
     */
    trailing?: React.ReactNode;
}

const EMPTY_QUEUE: QueueItem[] = [];
const EMPTY_LEGACY_DISPLAY: Array<QueuedMessage | QueuePendingAdmissionItem> = [];
const EMPTY_PENDING_CLIENT: readonly QueuePendingAdmissionItem[] = [];
const EMPTY_PENDING_OPERATION_KINDS: ReadonlySet<ServerQueueOperationKind> = new Set();

// eslint-disable-next-line react-refresh/only-export-components
export const selectQueuedMessagesForScope = (
    state: Pick<ReturnType<typeof useMessageQueueStore.getState>, 'queuedMessages'>,
    scope: BoundQueueScope | null,
): QueuedMessage[] => {
    if (!scope) return EMPTY_QUEUE;
    const legacyMessages = getQueueForScope(state, legacyQueueScope(scope.sessionID));
    const boundMessages = getQueueForScope(state, scope);
    return mergeQueuedMessageScopes(legacyMessages, boundMessages);
};

/**
 * Durable legacy/bound rows plus ephemeral pending-admission chips for the scope.
 * Pending markers are display-only and never come from queuedMessages.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const selectLegacyQueueDisplayItemsForScope = (
    state: Pick<ReturnType<typeof useMessageQueueStore.getState>, 'queuedMessages' | 'pendingAdmissions'>,
    scope: BoundQueueScope | null,
): Array<QueuedMessage | QueuePendingAdmissionItem> => {
    if (!scope) return EMPTY_LEGACY_DISPLAY;
    const durable = selectQueuedMessagesForScope(state, scope);
    const pending = [
        ...getPendingAdmissionsForScope(state, legacyQueueScope(scope.sessionID)),
        ...getPendingAdmissionsForScope(state, scope),
    ];
    if (pending.length === 0) return durable;
    return [...durable, ...pending];
};

// eslint-disable-next-line react-refresh/only-export-components
export const queuedMessageItemScope = (message: QueuedMessage, scope: BoundQueueScope): QueueScope | null => {
    const owner = message.owner;
    if (!owner) return null;
    if (owner.state === 'unbound-legacy') return owner.sessionID === scope.sessionID ? legacyQueueScope(scope.sessionID) : null;
    return queueScopeKey(owner) === queueScopeKey(scope) ? scope : null;
};

export const QueuedMessageChips = memo(({ onEditMessage, onSendMessage, onEditCommitted, draftKey, scope: queueScope, draftTarget, clientPendingItems = EMPTY_PENDING_CLIENT, onRemoveClientPending, trailing }: QueuedMessageChipsProps) => {
    const { t } = useI18n();
    const isMobile = useUIStore((state) => state.isMobile);
    const serverQueue = useMessageQueueServerScope({
        transportIdentity: queueScope?.transportIdentity ?? '',
        directory: queueScope?.directory ?? '',
        sessionID: queueScope?.sessionID ?? '',
    });
    const serverMutationFlightRef = React.useRef<ServerQueueScopeMutationFlights>(new Map());
    const serverMutationKey = React.useMemo(
        () => [queueScope?.transportIdentity ?? '', 'messageQueue', 'scopeMutation', queueScope?.runtimeGeneration ?? -1] as const,
        [queueScope?.runtimeGeneration, queueScope?.transportIdentity],
    );
    const serverMutation = useMutation<ServerQueueMutationResult, unknown, ServerQueueMutationVariables>({
        mutationKey: serverMutationKey,
        mutationFn: (variables: ServerQueueMutationVariables) => enqueueServerQueueScopeMutation<ServerQueueMutationResult>(
            serverMutationFlightRef,
            `${variables.transportIdentity}\u0000${variables.runtimeGeneration}\u0000${variables.directory}\u0000${variables.sessionID}\u0000${variables.scopeID}`,
            () => {
                if (variables.transportIdentity !== variables.runtime.transportIdentity || variables.runtimeGeneration !== variables.runtime.generation) {
                    return Promise.resolve({ status: 'stale' as const });
                }
                const runtime = serverQueue.actions.captureRuntime();
                if (runtime.transportIdentity !== variables.runtime.transportIdentity || runtime.generation !== variables.runtime.generation) {
                    return Promise.resolve({ status: 'stale' as const });
                }
                switch (variables.kind) {
                    case 'edit':
                        return serverQueue.actions.editIntoDraft(variables.input);
                    case 'send':
                        return serverQueue.actions.manualSend(variables.input);
                    case 'remove':
                        return serverQueue.actions.remove(variables.input);
                    case 'reorder':
                        return serverQueue.actions.reorder(variables.input);
                }
                throw new Error('Unsupported server queue operation');
            },
        ),
        onSuccess: (result, variables) => {
            const runtime = serverQueue.actions.captureRuntime();
            if (runtime.transportIdentity !== variables.runtime.transportIdentity || runtime.generation !== variables.runtime.generation) return;
            if (result.status === 'stale') return;
            if (variables.kind === 'edit' && result.status !== 'committed') {
                toast.error(t('chat.chatInput.toast.queueOperationFailed'));
            }
        },
        onError: (error, variables) => {
            const runtime = serverQueue.actions.captureRuntime();
            if (runtime.transportIdentity !== variables.runtime.transportIdentity || runtime.generation !== variables.runtime.generation) return;
            toast.error(t(error instanceof MessageQueueServerError && error.code === 'unavailable'
                ? 'chat.chatInput.toast.queueOperationStatusUnknown'
                : 'chat.chatInput.toast.queueOperationFailed'));
        },
    });
    const pendingServerMutationVariables = useMutationState<unknown>({
        filters: { mutationKey: serverMutationKey, exact: true, status: 'pending' },
        select: (mutation) => mutation.state.variables,
    });
    // Successful send mutations carry committedRevision from the receipt so chips
    // stay hidden after the pending overlay ends while scope reload lags.
    const successSendShadows = useMutationState<ServerQueueCommittedSendShadow | undefined>({
        filters: { mutationKey: serverMutationKey, exact: true, status: 'success' },
        select: (mutation) => {
            const variables = mutation.state.variables;
            if (!isServerQueueOperationIdentity(variables) || variables.kind !== 'send') return undefined;
            const data = mutation.state.data as ServerQueueMutationResult | undefined;
            if (!data || data.status !== 'committed') return undefined;
            const fromReceipt = 'committedRevision' in data && typeof data.committedRevision === 'number' && Number.isSafeInteger(data.committedRevision)
                ? data.committedRevision
                : undefined;
            const fromScope = 'scope' in data && data.scope && typeof data.scope.revision === 'number' && Number.isSafeInteger(data.scope.revision)
                ? data.scope.revision
                : undefined;
            const committedRevision = fromReceipt ?? fromScope;
            if (committedRevision === undefined || committedRevision <= 0) return undefined;
            return { ...variables, kind: 'send' as const, committedRevision };
        },
    });
    const exactServerScope = React.useMemo(() => {
        if (!queueScope || !serverQueue.scope) return null;
        return {
            transportIdentity: queueScope.transportIdentity,
            directory: queueScope.directory,
            sessionID: queueScope.sessionID,
            scopeID: serverQueue.scope.scopeID,
            runtimeGeneration: queueScope.runtimeGeneration ?? serverQueue.runtimeCapture.generation,
        };
    }, [queueScope, serverQueue.runtimeCapture.generation, serverQueue.scope]);
    const pendingServerOperations = React.useMemo(() => {
        if (!exactServerScope) return [];
        return selectPendingServerQueueOperations(pendingServerMutationVariables.filter((operation): operation is ServerQueueOperationIdentity => (
            isServerQueueOperationIdentity(operation) && operation.scopeID === exactServerScope.scopeID
        )), exactServerScope);
    }, [exactServerScope, pendingServerMutationVariables]);
    const committedSendOverlays = React.useMemo(() => {
        if (!exactServerScope) return [];
        return selectCommittedSendShadows(
            successSendShadows.filter((shadow): shadow is ServerQueueCommittedSendShadow => shadow !== undefined),
            exactServerScope,
            serverQueue.scope?.revision,
        );
    }, [exactServerScope, serverQueue.scope?.revision, successSendShadows]);
    const chipOverlayOperations = React.useMemo(
        () => [...pendingServerOperations, ...committedSendOverlays],
        [committedSendOverlays, pendingServerOperations],
    );
    const legacyQueueSelector = React.useMemo(
        () => (state: ReturnType<typeof useMessageQueueStore.getState>) => selectLegacyQueueDisplayItemsForScope(state, queueScope),
        [queueScope],
    );
    const legacyMessages = useMessageQueueStore(legacyQueueSelector);
    const abortOptimisticRevision = React.useSyncExternalStore(
        subscribeQueueAbortOptimistic,
        getQueueAbortOptimisticRevision,
        getQueueAbortOptimisticRevision,
    );
    const queuedMessages = React.useMemo(() => {
        const base = serverQueue.mode === 'server'
            ? projectServerQueueChipItems(serverQueue.items, chipOverlayOperations)
            : legacyMessages;
        return clientPendingItems.length === 0 ? base : [...base, ...clientPendingItems];
    }, [chipOverlayOperations, clientPendingItems, legacyMessages, serverQueue.items, serverQueue.mode]);
    const abortSendPendingIDs = React.useMemo(() => {
        const sessionID = queueScope?.sessionID;
        const ids = new Set<string>();
        if (!sessionID) return ids;
        for (const item of queuedMessages) {
            const queueItemID = item.queueItemID || (item as QueuedMessage).id;
            if (queueItemID && isQueueItemSendPendingByAbortOptimistic(sessionID, queueItemID)) ids.add(queueItemID);
        }
        return ids;
    }, [abortOptimisticRevision, queuedMessages, queueScope?.sessionID]);
    const pendingKindsByItem = React.useMemo(() => {
        const result = new Map<string, Set<ServerQueueOperationKind>>();
        for (const operation of chipOverlayOperations) {
            const kinds = result.get(operation.queueItemID) ?? new Set<ServerQueueOperationKind>();
            kinds.add(operation.kind);
            result.set(operation.queueItemID, kinds);
        }
        return result;
    }, [chipOverlayOperations]);
    // queueItemIDs currently in optimistic/manual/legacy send-pending presentation.
    const sendPendingItemIDs = React.useMemo(() => {
        const ids = new Set<string>();
        if (serverQueue.mode === 'server') {
            for (const operation of chipOverlayOperations) {
                if (operation.kind === 'send') ids.add(operation.queueItemID);
            }
            for (const item of queuedMessages) {
                if (isMessageQueuePendingAdmissionItem(item)) continue;
                const queueItemID = item.queueItemID;
                if (!queueItemID) continue;
                if (isServerQueueItemDispatchPending(item as MessageQueueItem)) {
                    ids.add(queueItemID);
                }
            }
            return ids;
        }
        for (const item of queuedMessages) {
            if (isMessageQueuePendingAdmissionItem(item)) continue;
            const legacy = item as QueuedMessage;
            if (!isLegacyQueueItemDispatchPending(legacy)) continue;
            ids.add(legacy.queueItemID || legacy.id);
        }
        return ids;
    }, [chipOverlayOperations, queuedMessages, serverQueue.mode]);
    const [sendPendingTimedOutIDs, setSendPendingTimedOutIDs] = React.useState<ReadonlySet<string>>(() => new Set());
    const sendPendingStartedAtRef = React.useRef<Map<string, number>>(new Map());
    React.useEffect(() => {
        const startedAt = sendPendingStartedAtRef.current;
        const now = Date.now();
        // Drop bookkeeping for IDs that left send-pending (natural progress / failure / removal).
        for (const queueItemID of [...startedAt.keys()]) {
            if (!sendPendingItemIDs.has(queueItemID)) {
                startedAt.delete(queueItemID);
            }
        }
        setSendPendingTimedOutIDs((previous) => {
            let changed = false;
            const next = new Set<string>();
            for (const queueItemID of previous) {
                if (sendPendingItemIDs.has(queueItemID)) {
                    next.add(queueItemID);
                } else {
                    changed = true;
                }
            }
            return changed ? next : previous;
        });
        const timers: Array<ReturnType<typeof setTimeout>> = [];
        for (const queueItemID of sendPendingItemIDs) {
            if (!startedAt.has(queueItemID)) {
                startedAt.set(queueItemID, now);
                // Fresh pending cycle clears a prior timeout for this ID.
                setSendPendingTimedOutIDs((previous) => {
                    if (!previous.has(queueItemID)) return previous;
                    const next = new Set(previous);
                    next.delete(queueItemID);
                    return next;
                });
            }
            // Already timed out for this pending cycle — keep Send restored until a fresh cycle.
            if (sendPendingTimedOutIDs.has(queueItemID)) continue;
            const elapsed = now - (startedAt.get(queueItemID) ?? now);
            const remaining = SERVER_QUEUE_SEND_PENDING_TIMEOUT_MS - elapsed;
            if (remaining <= 0) {
                setSendPendingTimedOutIDs((previous) => {
                    if (previous.has(queueItemID)) return previous;
                    const next = new Set(previous);
                    next.add(queueItemID);
                    return next;
                });
                continue;
            }
            timers.push(setTimeout(() => {
                if (!sendPendingStartedAtRef.current.has(queueItemID)) return;
                setSendPendingTimedOutIDs((previous) => {
                    if (previous.has(queueItemID)) return previous;
                    const next = new Set(previous);
                    next.add(queueItemID);
                    return next;
                });
            }, remaining));
        }
        return () => {
            for (const timer of timers) clearTimeout(timer);
        };
    }, [sendPendingItemIDs, sendPendingTimedOutIDs]);
    const frozen = !queueModeAllowsMutations(serverQueue.mode);
    const hasScopeDispatchFlight = useQueueScopeDispatchFlight(queueScope);
    const hasDispatchLock = serverQueue.mode === 'server'
        ? false
        : hasScopeDispatchFlight || queuedMessages.some((item) => !isMessageQueuePendingAdmissionItem(item) && ((item as QueuedMessage).status === 'sending' || (item as QueuedMessage).status === 'reconciling'));

    const reorderQueue = useMessageQueueStore((state) => state.reorderQueue);

    const sensors = useSensors(
        // Desktop: drag after a small move so other clicks still register.
        useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
        // Touch: long-press to drag (tap still hits buttons, swipe scrolls).
        useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    );

    const handleDragEnd = useEvent((event: DragEndEvent) => {
        if (frozen) return;
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        if (serverQueue.mode === 'server') {
            if (!queueScope || !serverQueue.scope) return;
            const visibleServerMessages = queuedMessages as readonly MessageQueueServerDisplayItem[];
            const activeMessage = visibleServerMessages.find((message) => message.queueItemID === active.id);
            const overMessage = visibleServerMessages.find((message) => message.queueItemID === over.id);
            if (!activeMessage || !overMessage || isMessageQueuePendingAdmissionItem(activeMessage) || isMessageQueuePendingAdmissionItem(overMessage)) return;
            if (isServerQueueItemActiveAttempt(activeMessage) || isServerQueueItemActiveAttempt(overMessage)) return;
            const scope = serverQueue.scope;
            const runtime = serverQueue.actions.captureRuntime();
            if (runtime.transportIdentity !== queueScope.transportIdentity || runtime.generation !== queueScope.runtimeGeneration) return;
            const requestID = createUuid();
            const input = reorderServerQueueItems(scope, String(active.id), String(over.id), requestID, visibleServerMessages);
            if (!input) return;
            void serverMutation.mutateAsync({
                kind: 'reorder',
                transportIdentity: runtime.transportIdentity,
                directory: scope.directory,
                sessionID: scope.sessionID,
                scopeID: scope.scopeID,
                queueItemID: String(active.id),
                queueItemIDs: input.queueItemIDs,
                requestID,
                runtime,
                runtimeGeneration: runtime.generation,
                input,
            }).catch(() => {});
            return;
        }
        const legacyQueueMessages = queuedMessages.filter((message): message is QueuedMessage => !isMessageQueuePendingAdmissionItem(message));
        const activeMessage = legacyQueueMessages.find((message) => (message.queueItemID ?? message.id) === active.id);
        const overMessage = legacyQueueMessages.find((message) => (message.queueItemID ?? message.id) === over.id);
        if (!activeMessage || !overMessage) return;
        if (!queueScope) return;
        const activeScope = queuedMessageItemScope(activeMessage, queueScope);
        const overScope = queuedMessageItemScope(overMessage, queueScope);
        if (!activeScope || !overScope || queueScopeKey(activeScope) !== queueScopeKey(overScope)) return;
        reorderQueue(activeScope, String(active.id), String(over.id), activeMessage.operationID);
    });

    const handleEdit = useEvent((message: QueuedMessage | MessageQueueServerDisplayItem) => {
        if (frozen || isMessageQueuePendingAdmissionItem(message)) return;
        if (serverQueue.mode === 'server') {
            if (!queueScope || !serverQueue.scope || !draftKey || !draftTarget) return;
            const serverMessage = message as MessageQueueItem;
            const expectedRevision = draftTarget.expectedRevision();
            const scope = serverQueue.scope;
            const runtime = serverQueue.actions.captureRuntime();
            if (runtime.transportIdentity !== queueScope.transportIdentity || runtime.generation !== queueScope.runtimeGeneration) return;
            void serverMutation.mutateAsync({
                kind: 'edit',
                transportIdentity: runtime.transportIdentity,
                directory: scope.directory,
                sessionID: scope.sessionID,
                scopeID: scope.scopeID,
                queueItemID: serverMessage.queueItemID,
                requestID: createUuid(),
                runtime,
                runtimeGeneration: runtime.generation,
                input: serverQueueEditInput(scope, serverMessage, draftTarget.key, expectedRevision),
            }).then((result) => {
                // Text is already in the draft when durable; focus so the user can keep typing.
                if (result.status === 'committed' || ('draftDurable' in result && result.draftDurable)) {
                    onEditCommitted?.();
                }
            }).catch(() => {});
            return;
        }
        if (!queueScope) return;
        const legacyMessage = message as QueuedMessage;
        const itemScope = queuedMessageItemScope(legacyMessage, queueScope);
        if (!itemScope) return;
        const queueItemID = legacyMessage.queueItemID ?? legacyMessage.id;
        const operationID = legacyMessage.operationID;
        // Restore from the live queue item first; only remove after a current committed draft.
        const restore = legacyQueueEditRestoreSource(legacyMessage);
        void (async () => {
            let ok = false;
            try {
                ok = await Promise.resolve(onEditMessage(
                    restore.content,
                    restore.attachments,
                    restore.composerDocument,
                    restore.composerMentions,
                ));
            } catch {
                ok = false;
            }
            if (!ok) return;
            onEditCommitted?.();
            // Safe against concurrent remove/edit races: remove is idempotent when already gone.
            useMessageQueueStore.getState().removeFromQueue(itemScope, queueItemID, operationID);
        })();
    });

    const handleSend = useEvent((message: QueuedMessage | MessageQueueServerDisplayItem) => {
        if (frozen || isMessageQueuePendingAdmissionItem(message)) return;
        if (serverQueue.mode === 'server') {
            if (!queueScope || !serverQueue.scope) return;
            const serverMessage = message as MessageQueueItem;
            const scope = serverQueue.scope;
            const runtime = serverQueue.actions.captureRuntime();
            if (runtime.transportIdentity !== queueScope.transportIdentity || runtime.generation !== queueScope.runtimeGeneration) return;
            // Fresh send cycle after a client timeout: clear timed-out flag and restart the 8s clock.
            const retryID = serverMessage.queueItemID;
            sendPendingStartedAtRef.current.delete(retryID);
            setSendPendingTimedOutIDs((previous) => {
                if (!previous.has(retryID)) return previous;
                const next = new Set(previous);
                next.delete(retryID);
                return next;
            });
            const requestID = createUuid();
            void serverMutation.mutateAsync({
                kind: 'send',
                transportIdentity: runtime.transportIdentity,
                directory: scope.directory,
                sessionID: scope.sessionID,
                scopeID: scope.scopeID,
                queueItemID: serverMessage.queueItemID,
                requestID,
                runtime,
                runtimeGeneration: runtime.generation,
                input: serverQueueItemMutationInput(scope, serverMessage, requestID),
            }).catch(() => {});
            return;
        }
        if (!queueScope) return;
        const legacyMessage = message as QueuedMessage;
        if (!queuedMessageItemScope(legacyMessage, queueScope)) return;
        // Fresh send cycle after a client timeout: clear timed-out flag and restart the 8s clock.
        const retryID = legacyMessage.queueItemID ?? legacyMessage.id;
        sendPendingStartedAtRef.current.delete(retryID);
        setSendPendingTimedOutIDs((previous) => {
            if (!previous.has(retryID)) return previous;
            const next = new Set(previous);
            next.delete(retryID);
            return next;
        });
        onSendMessage(retryID);
    });

    const handleRemove = useEvent((message: QueuedMessage | MessageQueueServerDisplayItem) => {
        if (isMessageQueuePendingAdmissionItem(message)) {
            if (clientPendingItems.some((item) => item.requestID === message.requestID)) {
                onRemoveClientPending?.(message.requestID);
            }
            return;
        }
        if (frozen) return;
        if (serverQueue.mode === 'server') {
            if (!queueScope || !serverQueue.scope) return;
            const serverMessage = message as MessageQueueItem;
            const scope = serverQueue.scope;
            const runtime = serverQueue.actions.captureRuntime();
            if (runtime.transportIdentity !== queueScope.transportIdentity || runtime.generation !== queueScope.runtimeGeneration) return;
            const requestID = createUuid();
            void serverMutation.mutateAsync({
                kind: 'remove',
                transportIdentity: runtime.transportIdentity,
                directory: scope.directory,
                sessionID: scope.sessionID,
                scopeID: scope.scopeID,
                queueItemID: serverMessage.queueItemID,
                requestID,
                runtime,
                runtimeGeneration: runtime.generation,
                input: serverQueueItemMutationInput(scope, serverMessage, requestID),
            }).catch(() => {});
            return;
        }
        if (!queueScope) return;
        const legacyMessage = message as QueuedMessage;
        const itemScope = queuedMessageItemScope(legacyMessage, queueScope);
        if (itemScope) useMessageQueueStore.getState().removeFromQueue(itemScope, legacyMessage.queueItemID ?? legacyMessage.id, legacyMessage.operationID);
    });

    const hasQueue = queuedMessages.length > 0;
    // Session-bound queue actions need a scope; establishing client-pending chips
    // may render before the draft materializes into a session.
    const hasQueueSurface = hasQueue && (queueScope || clientPendingItems.length > 0);
    if (!hasQueueSurface && !trailing) {
        return null;
    }

    return (
        <div className={cn(
            'oc-composer-queue relative z-0 -mb-5 w-full',
            isMobile ? 'px-2' : 'px-4',
        )}>
            <div
                data-oc-queue-card=""
                className={cn(
                    // Match composer surface (subtle + border, no elevation shadow). PC radius = chat input 1.5rem.
                    'overflow-hidden border border-border/60 bg-[var(--surface-subtle)] text-foreground',
                    isMobile ? 'rounded-[1.25rem]' : 'rounded-3xl',
                )}
            >
                <div
                    data-oc-queue-card-body=""
                    className={cn(
                        'flex flex-col',
                        isMobile
                            // Match composer footer left inset.
                            ? 'px-1.5 py-1'
                            : 'gap-0.5 px-3 pb-1 pt-1.5',
                    )}
                >
                    {hasQueueSurface ? (
                        <DndContext
                            sensors={sensors}
                            collisionDetection={closestCenter}
                            onDragEnd={handleDragEnd}
                        >
                            <SortableContext
                                items={queuedMessages.map((message) => message.queueItemID || (message as QueuedMessage).id)}
                                strategy={verticalListSortingStrategy}
                            >
                                {queuedMessages.map((message) => {
                                    const chipID = message.queueItemID || (message as QueuedMessage).id;
                                    return (
                                    <QueuedMessageChip
                                        key={chipID}
                                        message={message}
                                        server={serverQueue.mode === 'server'}
                                        frozen={frozen}
                                        hasDispatchLock={hasDispatchLock}
                                        pendingOperationKinds={pendingKindsByItem.get(chipID) ?? EMPTY_PENDING_OPERATION_KINDS}
                                        sendPendingTimedOut={sendPendingTimedOutIDs.has(chipID)}
                                        abortSendPending={abortSendPendingIDs.has(chipID)}
                                        isMobile={isMobile}
                                        onEdit={handleEdit}
                                        onSend={handleSend}
                                        onRemove={handleRemove}
                                    />
                                    );
                                })}
                            </SortableContext>
                        </DndContext>
                    ) : null}
                    {trailing ? (
                        <>
                            {hasQueueSurface ? (
                                <div
                                    aria-hidden="true"
                                    className="my-0.5 border-t border-border/40"
                                />
                            ) : null}
                            {trailing}
                        </>
                    ) : null}
                </div>
                <div
                    data-oc-queue-composer-overlap=""
                    aria-hidden="true"
                    className={isMobile ? 'h-4' : 'h-5'}
                />
            </div>
        </div>
    );
});

QueuedMessageChips.displayName = 'QueuedMessageChips';