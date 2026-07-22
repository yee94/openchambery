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

const request = (surface: ChatInputSurface, operation: ChatInputDeliveryRequest['operation'], fields: DeliveryFields = {}): ChatInputDeliveryRequest => ({
  operation,
  surfaceID: surface.surfaceID,
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
      await surface.selection.flush();
      if (surface.kind === 'secondary') await surface.shortcuts!.submit();
      return surface.backend.send(request(surface, 'send', fields) as ChatInputDeliveryRequest & { operation: 'send' });
    },
    sendQueued: async (queueItemID, fields = {}) => {
      await surface.selection.flush();
      const { manual, ...delivery } = fields;
      const queueScope = chatInputQueueScope(surface);
      if (!queueScope) throw new Error('chat-input-queue-scope-incomplete');
      return surface.backend.sendQueued({ ...request(surface, 'send', delivery), queueItemID, manual, queueScope } as ChatInputDeliveryRequest & { operation: 'send' } & { queueItemID: string; manual?: boolean });
    },
    create: async () => { await surface.selection.flush(); return surface.backend.create(request(surface, 'create') as ChatInputDeliveryRequest & { operation: 'create' }); },
    compact: async (fields) => { await surface.selection.flush(); return surface.backend.compact(request(surface, 'compact', fields) as ChatInputDeliveryRequest & { operation: 'compact' }); },
    abort: async () => { await surface.selection.flush(); return surface.backend.abort(request(surface, 'abort') as ChatInputDeliveryRequest & { operation: 'abort' }); },
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
      if (command === 'abort') { await surface.selection.flush(); await surface.backend.abort(request(surface, 'abort') as ChatInputDeliveryRequest & { operation: 'abort' }); return; }
      if (command === 'new') { await surface.selection.flush(); await surface.backend.create(request(surface, 'create') as ChatInputDeliveryRequest & { operation: 'create' }); return; }
      if (command === 'submit') return;
      await surface.shortcuts?.cycle(direction);
    },
    resources: surface.resources ?? null,
  };
};

export const retainResourcesWhenCommandRejected = (wiring: ChatInputControllerWiring | null, command: string): boolean => Boolean(wiring && !wiring.allowsCommand(command));

export const attachmentIDs = (attachments: readonly AttachedFile[]): string[] => attachments.map((attachment) => attachment.id);
