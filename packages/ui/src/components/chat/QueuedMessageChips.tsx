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
import { getQueueForScope, legacyQueueScope, queueScopeKey, useMessageQueueStore, type QueueDeliveryTarget, type QueueItem, type QueueScope, type QueuedMessage } from '@/stores/messageQueueStore';
import type { DraftKey } from '@/sync/input-draft-types';
import { useMessageQueueServerScope } from '@/sync/use-message-queue-server';
import type { MessageQueueItem } from '@/lib/message-queue-server';
import { isMessageQueuePendingAdmissionItem, type MessageQueueServerDisplayItem, type MessageQueueServerMutationResult, type MessageQueueServerRuntimeCapture } from '@/sync/message-queue-server-runtime';
import type { MessageQueueEditResult } from '@/sync/message-queue-edit-bridge';
import type { ChatInputSurfaceResources } from './chatInputSurface';
import { useI18n } from '@/lib/i18n';
import { useQueueScopeDispatchFlight } from '@/hooks/useQueuedMessageAutoSend';
import { useUIStore } from '@/stores/useUIStore';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { createUuid } from '@/lib/uuid';
import { toast } from '@/components/ui';
import { applyPendingServerQueueOperations, canRemoveQueuedMessage, canSendQueuedMessage, canSendServerQueuedMessage, isServerQueueItemActiveAttempt, isServerQueueItemDispatchPending, mergeQueuedMessageScopes, queueModeAllowsMutations, reorderServerQueueItems, selectPendingServerQueueOperations, serverQueueEditInput, serverQueueItemMutationInput, type ServerQueueOperationIdentity, type ServerQueueOperationKind } from './queuedMessageChipsState';
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
    isMobile: boolean;
    onEdit: (message: QueuedMessage | MessageQueueServerDisplayItem) => void;
    onSend: (message: QueuedMessage | MessageQueueServerDisplayItem) => void;
    onRemove: (message: QueuedMessage | MessageQueueServerDisplayItem) => void;
}

const QueuedMessageChip = memo(({ message, server, frozen, hasDispatchLock, pendingOperationKinds, isMobile, onEdit, onSend, onRemove }: QueuedMessageChipProps) => {
    const { t } = useI18n();
    const pendingAdmission = isMessageQueuePendingAdmissionItem(message);
    const queueItemID = message.queueItemID || (message as QueuedMessage).id;
    const editPending = server && pendingOperationKinds.has('edit');
    const removePending = server && pendingOperationKinds.has('remove');
    const reorderPending = server && pendingOperationKinds.has('reorder');
    const authoritativeDispatchPending = server && !pendingAdmission && isServerQueueItemDispatchPending(message as MessageQueueItem);
    const activeAttempt = server && !pendingAdmission && isServerQueueItemActiveAttempt(message as MessageQueueItem);
    const sendPending = (server && pendingOperationKinds.has('send')) || authoritativeDispatchPending;
    // Only the row whose POST already crossed the boundary is immutable. A
    // manual intent is still a waiting row, so client edit/remove/reorder wins.
    const isReadOnly = frozen || pendingAdmission || activeAttempt;
    const canRemove = canRemoveQueuedMessage(message, { frozen });
    const legacyMessage = server ? undefined : message as QueuedMessage;
    const isDragDisabled = legacyMessage?.owner?.state === 'unbound-legacy' || isReadOnly;
    const canSend = !isReadOnly && (server ? canSendServerQueuedMessage(message as MessageQueueServerDisplayItem, hasDispatchLock) : canSendQueuedMessage(message as QueuedMessage, hasDispatchLock));
    const recovery = legacyMessage?.failure?.recovery;
    const visibleContent = recovery?.content ?? message.content;
    const visibleAttachments = pendingAdmission ? undefined : recovery?.attachments ?? message.attachments;
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: queueItemID,
        disabled: isDragDisabled,
    });

    // Get first line of message, truncated
    const firstLine = React.useMemo(() => {
        const lines = visibleContent.split('\n');
        const first = lines[0] || '';
        const maxLength = 100;
        if (first.length > maxLength) {
            return first.substring(0, maxLength) + '...';
        }
        return first + (lines.length > 1 ? '...' : '');
    }, [visibleContent]);

    const attachmentCount = pendingAdmission ? message.attachmentCount : visibleAttachments?.length ?? 0;

    const removeAction = (
        <button
            type="button"
            onClick={() => onRemove(message)}
            disabled={!canRemove}
            aria-busy={removePending || undefined}
            className={cn(
                'inline-flex shrink-0 items-center justify-center bg-transparent text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
                isMobile ? 'size-[1.625rem]' : 'size-7',
            )}
            aria-label={t('chat.queuedMessage.removeAria')}
        >
            <Icon name={removePending ? 'loader-4' : 'delete-bin'} className={cn('size-3.5', removePending && 'animate-spin')} aria-hidden="true" />
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
                    ? 'gap-0 py-0'
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
                    isMobile ? '!h-[1.625rem] !w-3.5 !min-h-[1.625rem] !min-w-3.5' : 'size-auto',
                    'transition-colors',
                    isDragDisabled ? 'cursor-default opacity-50' : 'cursor-grab hover:text-foreground active:cursor-grabbing',
                )}
                aria-label={t('chat.queuedMessage.reorderAria')}
            >
                <Icon name={reorderPending ? 'loader-4' : 'draggable'} className={cn(isMobile ? 'size-3' : 'size-3.5', reorderPending && 'animate-spin')} aria-hidden="true" />
            </button>
            {isMobile ? removeAction : null}
            <span className={cn(
                'min-w-0 flex-1 truncate text-foreground',
                isMobile ? 'text-xs leading-4' : 'typography-ui-label leading-5',
            )}>
                {firstLine || t('chat.queuedMessage.empty')}
                {attachmentCount > 0 && (
                    <span className="ml-1 text-muted-foreground">{t('chat.queuedMessage.attachments', { count: attachmentCount })}</span>
                )}
            </span>
            <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                <button
                    type="button"
                    onClick={() => onEdit(message)}
                    disabled={isReadOnly}
                    aria-busy={editPending || undefined}
                    aria-label={t('chat.queuedMessage.edit')}
                    className={cn(
                        'inline-flex items-center bg-transparent text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
                        isMobile ? 'h-[1.625rem] gap-1.5 px-0 text-[11px]' : 'h-7 gap-1 px-0.5',
                    )}
                >
                    <Icon
                        name={pendingAdmission || editPending ? 'loader-4' : 'edit'}
                        className={cn(isMobile ? 'size-3' : 'size-3.5', (pendingAdmission || editPending) && 'animate-spin')}
                        aria-hidden="true"
                    />
                    <span className={cn('font-medium', isMobile ? 'leading-none' : 'typography-ui-label')}>
                        {t('chat.queuedMessage.edit')}
                    </span>
                </button>
                <button
                    type="button"
                    onClick={() => onSend(message)}
                    disabled={!canSend}
                    aria-busy={sendPending || undefined}
                    aria-label={t('chat.queuedMessage.send')}
                    className={cn(
                        'inline-flex items-center bg-transparent text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
                        isMobile ? 'h-[1.625rem] gap-1.5 px-0 text-[11px]' : 'h-7 gap-1 px-0.5',
                    )}
                >
                    <Icon
                        name={pendingAdmission || sendPending ? 'loader-4' : 'send-plane'}
                        className={cn(isMobile ? 'size-3' : 'size-3.5', (pendingAdmission || sendPending) && 'animate-spin')}
                        aria-hidden="true"
                    />
                    <span className={cn('font-medium', isMobile ? 'leading-none' : 'typography-ui-label')}>
                        {t('chat.queuedMessage.send')}
                    </span>
                </button>
                {!isMobile ? removeAction : null}
            </div>
        </div>
    );
});

QueuedMessageChip.displayName = 'QueuedMessageChip';

interface QueuedMessageChipsProps {
    onEditMessage: (content: string, attachments?: QueuedMessage['attachments'], composerDocument?: QueuedMessage['composerDocument'], composerMentions?: QueuedMessage['composerMentions']) => void;
    onSendMessage: (messageId: string) => void;
    draftKey: DraftKey | null;
    scope: BoundQueueScope | null;
    draftResources: Pick<ChatInputSurfaceResources, 'attachments' | 'getDraft' | 'setAttachments'>;
}

const EMPTY_QUEUE: QueueItem[] = [];
const EMPTY_PENDING_OPERATION_KINDS: ReadonlySet<ServerQueueOperationKind> = new Set();

export const selectQueuedMessagesForScope = (
    state: Pick<ReturnType<typeof useMessageQueueStore.getState>, 'queuedMessages'>,
    scope: BoundQueueScope | null,
): QueuedMessage[] => {
    if (!scope) return EMPTY_QUEUE;
    const legacyMessages = getQueueForScope(state, legacyQueueScope(scope.sessionID));
    const boundMessages = getQueueForScope(state, scope);
    return mergeQueuedMessageScopes(legacyMessages, boundMessages);
};

export const queuedMessageItemScope = (message: QueuedMessage, scope: BoundQueueScope): QueueScope | null => {
    const owner = message.owner;
    if (!owner) return null;
    if (owner.state === 'unbound-legacy') return owner.sessionID === scope.sessionID ? legacyQueueScope(scope.sessionID) : null;
    return queueScopeKey(owner) === queueScopeKey(scope) ? scope : null;
};

export const QueuedMessageChips = memo(({ onEditMessage, onSendMessage, draftKey, scope: queueScope, draftResources }: QueuedMessageChipsProps) => {
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
                toast.error(t('chat.chatInput.toast.messageSendFailed'));
            }
        },
        onError: (_error, variables) => {
            const runtime = serverQueue.actions.captureRuntime();
            if (runtime.transportIdentity !== variables.runtime.transportIdentity || runtime.generation !== variables.runtime.generation) return;
            toast.error(t('chat.chatInput.toast.messageSendFailed'));
        },
    });
    const pendingServerMutationVariables = useMutationState<unknown>({
        filters: { mutationKey: serverMutationKey, exact: true, status: 'pending' },
        select: (mutation) => mutation.state.variables,
    });
    const pendingServerOperations = React.useMemo(() => {
        if (!queueScope || !serverQueue.scope) return [];
        const exactScope = {
            transportIdentity: queueScope.transportIdentity,
            directory: queueScope.directory,
            sessionID: queueScope.sessionID,
            scopeID: serverQueue.scope.scopeID,
            runtimeGeneration: queueScope.runtimeGeneration ?? serverQueue.runtimeCapture.generation,
        };
        return selectPendingServerQueueOperations(pendingServerMutationVariables.filter((operation): operation is ServerQueueOperationIdentity => (
            isServerQueueOperationIdentity(operation) && operation.scopeID === serverQueue.scope?.scopeID
        )), exactScope);
    }, [pendingServerMutationVariables, queueScope, serverQueue.runtimeCapture.generation, serverQueue.scope]);
    const legacyQueueSelector = React.useMemo(
        () => (state: ReturnType<typeof useMessageQueueStore.getState>) => selectQueuedMessagesForScope(state, queueScope),
        [queueScope],
    );
    const legacyMessages = useMessageQueueStore(legacyQueueSelector);
    const queuedMessages = React.useMemo(() => serverQueue.mode === 'server'
        ? applyPendingServerQueueOperations(serverQueue.items, pendingServerOperations)
        : legacyMessages, [legacyMessages, pendingServerOperations, serverQueue.items, serverQueue.mode]);
    const pendingKindsByItem = React.useMemo(() => {
        const result = new Map<string, Set<ServerQueueOperationKind>>();
        for (const operation of pendingServerOperations) {
            const kinds = result.get(operation.queueItemID) ?? new Set<ServerQueueOperationKind>();
            kinds.add(operation.kind);
            result.set(operation.queueItemID, kinds);
        }
        return result;
    }, [pendingServerOperations]);
    const frozen = !queueModeAllowsMutations(serverQueue.mode);
    const hasScopeDispatchFlight = useQueueScopeDispatchFlight(queueScope);
    const hasDispatchLock = serverQueue.mode === 'server'
        ? false
        : hasScopeDispatchFlight || queuedMessages.some((item) => !isMessageQueuePendingAdmissionItem(item) && (item.status === 'sending' || item.status === 'reconciling'));
    const popToInput = useMessageQueueStore((state) => state.popToInput);
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
        const legacyQueueMessages = queuedMessages as QueuedMessage[];
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
        if (frozen) return;
        if (serverQueue.mode === 'server') {
            if (!queueScope || !serverQueue.scope || !draftKey || isMessageQueuePendingAdmissionItem(message)) return;
            const serverMessage = message as MessageQueueItem;
            const currentDraft = draftResources.getDraft(draftKey);
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
                input: serverQueueEditInput(scope, serverMessage, draftKey, currentDraft?.revision ?? 'absent'),
            }).catch(() => {});
            return;
        }
        if (!queueScope) return;
        const legacyMessage = message as QueuedMessage;
        const itemScope = queuedMessageItemScope(legacyMessage, queueScope);
        if (!itemScope) return;
        const popped = popToInput(itemScope, legacyMessage.queueItemID ?? legacyMessage.id, legacyMessage.operationID);
        if (popped) {
            const recovery = popped.failure?.recovery;
            const content = recovery?.content ?? popped.content;
            const attachments = recovery?.attachments ?? popped.attachments;
            if (attachments && attachments.length > 0) {
                draftResources.setAttachments([...draftResources.attachments, ...attachments]);
            }
            onEditMessage(content, attachments, recovery?.composerDocument ?? popped.composerDocument, recovery?.composerMentions ?? popped.composerMentions);
        }
    });

    const handleSend = useEvent((message: QueuedMessage | MessageQueueServerDisplayItem) => {
        if (frozen) return;
        if (serverQueue.mode === 'server') {
            if (!queueScope || !serverQueue.scope || isMessageQueuePendingAdmissionItem(message)) return;
            const serverMessage = message as MessageQueueItem;
            const scope = serverQueue.scope;
            const runtime = serverQueue.actions.captureRuntime();
            if (runtime.transportIdentity !== queueScope.transportIdentity || runtime.generation !== queueScope.runtimeGeneration) return;
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
        onSendMessage(legacyMessage.queueItemID ?? legacyMessage.id);
    });

    const handleRemove = useEvent((message: QueuedMessage | MessageQueueServerDisplayItem) => {
        if (frozen) return;
        if (serverQueue.mode === 'server') {
            if (!queueScope || !serverQueue.scope || isMessageQueuePendingAdmissionItem(message)) return;
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

    if (queuedMessages.length === 0 || !queueScope) {
        return null;
    }

    return (
        <div className={cn(
            'oc-composer-queue relative z-0 -mb-5 w-full',
            isMobile ? 'px-2' : 'px-4',
        )}>
            <div className={cn(
                'overflow-hidden border border-border/60 bg-[var(--surface-elevated)] text-[var(--surface-elevated-foreground)] shadow-sm dark:shadow-none',
                isMobile ? 'rounded-[1.25rem]' : 'rounded-2xl',
            )}>
                <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                >
                    <SortableContext
                        items={queuedMessages.map((message) => message.queueItemID || (message as QueuedMessage).id)}
                        strategy={verticalListSortingStrategy}
                    >
                        <div className={cn(
                            'flex flex-col',
                            isMobile
                                ? 'px-2 py-1'
                                : 'gap-0.5 px-3 pb-1 pt-1.5',
                        )}>
                            {queuedMessages.map((message) => (
                                <QueuedMessageChip
                                    key={message.queueItemID || (message as QueuedMessage).id}
                                    message={message}
                                    server={serverQueue.mode === 'server'}
                                    frozen={frozen}
                                    hasDispatchLock={hasDispatchLock}
                                    pendingOperationKinds={pendingKindsByItem.get(message.queueItemID || (message as QueuedMessage).id) ?? EMPTY_PENDING_OPERATION_KINDS}
                                    isMobile={isMobile}
                                    onEdit={handleEdit}
                                    onSend={handleSend}
                                    onRemove={handleRemove}
                                />
                            ))}
                        </div>
                    </SortableContext>
                </DndContext>
                <div aria-hidden="true" className={isMobile ? 'h-4' : 'h-5'} />
            </div>
        </div>
    );
});

QueuedMessageChips.displayName = 'QueuedMessageChips';
