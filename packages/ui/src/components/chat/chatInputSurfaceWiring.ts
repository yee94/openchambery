import type { AttachedFile } from '@/stores/types/sessionTypes';
import { chatInputQueueScope, isChatInputCommandAllowed, type ChatInputDeliveryRequest, type ChatInputSurface } from './chatInputSurface';

type DeliveryFields = Pick<ChatInputDeliveryRequest, 'text' | 'attachments' | 'providerID' | 'modelID' | 'agent' | 'agentMention' | 'variant' | 'parts' | 'systemContext' | 'inputMode' | 'options'>;

export type ChatInputControllerWiring = {
  send: (fields: DeliveryFields) => Promise<unknown>;
  sendQueued: (queueItemID: string, fields?: DeliveryFields & { manual?: boolean }) => Promise<unknown>;
  create: () => Promise<unknown>;
  compact: (fields: Pick<DeliveryFields, 'providerID' | 'modelID' | 'agent' | 'variant'>) => Promise<unknown>;
  abort: () => Promise<unknown>;
  queueScope: ReturnType<typeof chatInputQueueScope>;
  canAbort: boolean;
  canQueue: boolean;
  allowsCommand: (name: string) => boolean;
  shortcut: (command: 'new' | 'abort' | 'cycle' | 'submit', direction?: 1 | -1) => Promise<void>;
  resources: NonNullable<ChatInputSurface['resources']> | null;
};

/** Reject delivery when the surface capture no longer matches the live runtime. */
export const assertDeliveryRequestRuntimeCurrent = (
  request: Pick<ChatInputDeliveryRequest, 'transportIdentity' | 'runtimeGeneration'>,
  current: { transportIdentity: string; runtimeGeneration: number },
): void => {
  if (
    request.transportIdentity !== current.transportIdentity
    || request.runtimeGeneration !== current.runtimeGeneration
  ) {
    throw new Error('chat-input-delivery-runtime-stale');
  }
};

/**
 * Pin session/directory identity from the delivery request into sendMessage options.
 * Existing sessions always pass sessionId + directoryHint; draft (null session) keeps
 * materialization on the current draft path without a forced session pin.
 * First-submit options.sessionId (handleSubmit capture) wins over live surface identity.
 */
export const primarySendOptionsFromDeliveryRequest = (
  request: Pick<ChatInputDeliveryRequest, 'sessionID' | 'directory' | 'options'>,
): {
  sessionId?: string;
  directoryHint?: string | null;
  delivery?: 'steer';
  commitStagedMessageEdit?: boolean;
  messageID?: string;
} => {
  const base = {
    ...(request.options?.delivery === 'steer' ? { delivery: 'steer' as const } : {}),
    ...(request.options?.commitStagedMessageEdit !== undefined
      ? { commitStagedMessageEdit: request.options.commitStagedMessageEdit }
      : {}),
    ...(request.options?.messageID ? { messageID: request.options.messageID } : {}),
  };
  const sessionId = request.options?.sessionId ?? request.sessionID ?? undefined;
  if (!sessionId) {
    return base;
  }
  const directoryHint = request.options?.directoryHint !== undefined
    ? request.options.directoryHint
    : (request.directory || null);
  return {
    ...base,
    sessionId,
    directoryHint,
  };
};

const request = (surface: ChatInputSurface, operation: ChatInputDeliveryRequest['operation'], fields: DeliveryFields = {}): ChatInputDeliveryRequest => ({
  operation,
  surfaceID: surface.surfaceID,
  // Pin surface identity before any await so a mid-flight session switch cannot
  // rewrite the delivery target after flush re-resolves selection.
  transportIdentity: surface.transportIdentity,
  runtimeGeneration: surface.runtimeGeneration,
  sessionID: surface.sessionID,
  directory: surface.directory ?? '',
  draftKey: surface.draftKey!,
  deliveryTarget: surface.deliveryTarget,
  ...fields,
});

/** Builds event-time wiring from one active surface capture. */
export const createChatInputControllerWiring = (surface: ChatInputSurface): ChatInputControllerWiring | null => {
  if (!surface.active || !surface.draftKey || !surface.directory) return null;
  const activity = surface.activity?.phase ?? 'idle';
  const canAbort = surface.activity?.canAbort ?? (activity === 'busy' || activity === 'retry');
  return {
    send: async (fields) => {
      // Capture identity before flush so primary dispatch cannot mix first-submit
      // config with a later Session after the user switches mid-flight.
      const delivery = request(surface, 'send', fields);
      await surface.selection.flush();
      if (surface.kind === 'secondary') await surface.shortcuts!.submit();
      return surface.backend.send(delivery as ChatInputDeliveryRequest & { operation: 'send' });
    },
    sendQueued: async (queueItemID, fields = {}) => {
      const { manual, ...deliveryFields } = fields;
      const delivery = request(surface, 'send', deliveryFields);
      const queueScope = chatInputQueueScope(surface);
      await surface.selection.flush();
      if (!queueScope) throw new Error('chat-input-queue-scope-incomplete');
      return surface.backend.sendQueued({ ...delivery, queueItemID, manual, queueScope } as ChatInputDeliveryRequest & { operation: 'send' } & { queueItemID: string; manual?: boolean });
    },
    create: async () => {
      const delivery = request(surface, 'create');
      await surface.selection.flush();
      return surface.backend.create(delivery as ChatInputDeliveryRequest & { operation: 'create' });
    },
    compact: async (fields) => {
      const delivery = request(surface, 'compact', fields);
      await surface.selection.flush();
      return surface.backend.compact(delivery as ChatInputDeliveryRequest & { operation: 'compact' });
    },
    abort: async () => {
      const delivery = request(surface, 'abort');
      await surface.selection.flush();
      return surface.backend.abort(delivery as ChatInputDeliveryRequest & { operation: 'abort' });
    },
    queueScope: chatInputQueueScope(surface),
    canAbort,
    canQueue: activity === 'busy' || activity === 'retry',
    allowsCommand: (name) => isChatInputCommandAllowed(surface, { name, source: 'openchamber' }),
    shortcut: async (command, direction = 1) => {
      if (surface.kind === 'secondary') {
        if (command === 'cycle') await surface.shortcuts!.cycle(direction);
        else if (command === 'new') await surface.shortcuts!.new();
        else if (command === 'abort') await surface.shortcuts!.abort();
        else await surface.shortcuts!.submit();
        return;
      }
      if (command === 'abort') {
        const delivery = request(surface, 'abort');
        await surface.selection.flush();
        await surface.backend.abort(delivery as ChatInputDeliveryRequest & { operation: 'abort' });
        return;
      }
      if (command === 'new') {
        const delivery = request(surface, 'create');
        await surface.selection.flush();
        await surface.backend.create(delivery as ChatInputDeliveryRequest & { operation: 'create' });
        return;
      }
      if (command === 'submit') return;
      await surface.shortcuts?.cycle(direction);
    },
    resources: surface.resources ?? null,
  };
};

export const retainResourcesWhenCommandRejected = (wiring: ChatInputControllerWiring | null, command: string): boolean => Boolean(wiring && !wiring.allowsCommand(command));

export const attachmentIDs = (attachments: readonly AttachedFile[]): string[] => attachments.map((attachment) => attachment.id);
