import React from 'react';
import type { DraftKey, DraftRecord } from '@/sync/input-draft-types';
import type { CommandInfo } from './CommandAutocomplete';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import type { SyntheticContextPart } from '@/sync/input-store';
import type { Agent } from '@opencode-ai/sdk/v2';

export type ChatInputDeliveryTarget = { kind: 'primary' } | { kind: 'assistant'; assistantID: string };

export type ChatInputSelection = {
  value: { providerID?: string; modelID?: string; agent?: string; variant?: string };
  catalog?: {
    providers: Array<{ id: string; name?: string; models: Array<Record<string, unknown> & { id: string; name?: string }> }>;
    agents: Agent[];
    /** Variants for the selection value's provider/model pair. */
    variants?: readonly string[];
    /** False while the surface is resolving the selected model's variants. */
    variantsReady?: boolean;
    ready: boolean;
    loading?: boolean;
    error?: boolean;
  };
  change?: (selection: { providerID?: string; modelID?: string; agent?: string; variant?: string }) => Promise<void> | void;
  flush: () => Promise<void>;
};

/** Provider catalogs expose variants as a Record; tolerate string[] too. */
export const resolveModelVariantKeys = (model: { variants?: unknown } | undefined | null): string[] => {
  const variants = model?.variants;
  if (!variants) {
    return [];
  }
  if (Array.isArray(variants)) {
    return variants.filter((variant): variant is string => typeof variant === 'string' && variant.length > 0);
  }
  if (typeof variants === 'object') {
    return Object.keys(variants);
  }
  return [];
};

export const resolveChatInputSelectionVariantOptions = (
  selection: Pick<ChatInputSelection['value'], 'providerID' | 'modelID'>,
  catalog: ChatInputSelection['catalog'] | undefined,
  providerID: string,
  modelID: string,
): string[] => {
  if (
    selection.providerID !== providerID
    || selection.modelID !== modelID
    || catalog?.variantsReady === false
  ) {
    return [];
  }
  if (catalog?.variants) {
    return [...catalog.variants];
  }
  // Surfaces may omit an explicit variants array and only ship providers.
  const provider = catalog?.providers?.find((entry) => entry.id === providerID);
  const model = provider?.models?.find((entry) => entry.id === modelID) as { variants?: unknown } | undefined;
  return resolveModelVariantKeys(model);
};

/**
 * Queue scope/delivery target and draft resource adapter supplied to the
 * queue chips. Surfaces own this scope end-to-end so the chips never read
 * primary session/directory stores to construct a bound scope.
 */
export type ChatInputQueueChips = {
  scope: ChatInputQueueScope | null;
  draftResourceAdapter: {
    getDraftRevision: () => string;
  };
};

/**
 * Explicit command availability context for CommandAutocomplete. Surfaces
 * supply sessionID plus message/new-draft availability so the autocomplete
 * never reads the primary session store or messages to decide which commands
 * are eligible.
 */
export type ChatInputCommandContext = {
  sessionID: string | null;
  hasMessages: boolean;
  hasNewDraft: boolean;
};

export type ChatInputDeliveryRequest = {
  operation: 'send' | 'create' | 'compact' | 'abort';
  surfaceID: string;
  transportIdentity: string;
  runtimeGeneration: number;
  sessionID: string | null;
  directory: string;
  draftKey: DraftKey;
  deliveryTarget: ChatInputDeliveryTarget;
  providerID?: string;
  modelID?: string;
  agent?: string;
  variant?: string;
  text?: string;
  attachments?: readonly AttachedFile[];
  agentMention?: string;
  parts?: readonly { text: string; attachments?: readonly AttachedFile[]; synthetic?: boolean }[];
  systemContext?: readonly { text: string; synthetic?: boolean }[];
  inputMode?: 'normal' | 'shell';
  options?: {
    delivery?: string;
    commitStagedMessageEdit?: boolean;
    /** First-submit pin; preferred over live surface session when present. */
    sessionId?: string;
    directoryHint?: string | null;
    messageID?: string;
  };
  queueScope?: ChatInputQueueScope;
};

export type ChatInputBackend = {
  send: (request: ChatInputDeliveryRequest & { operation: 'send' }) => Promise<unknown>;
  sendQueued: (request: ChatInputDeliveryRequest & { operation: 'send' } & { queueItemID: string; manual?: boolean }) => Promise<unknown>;
  create: (request: ChatInputDeliveryRequest & { operation: 'create' }) => Promise<unknown>;
  compact: (request: ChatInputDeliveryRequest & { operation: 'compact' }) => Promise<unknown>;
  abort: (request: ChatInputDeliveryRequest & { operation: 'abort' }) => Promise<unknown>;
};

/**
 * Composer-owned values supplied by an embedded surface.  A secondary surface
 * owns these resources and never needs the primary input-store bucket.
 */
export type ChatInputSurfaceResources = {
  /** Explicit busy state for a secondary surface's send and input controls. */
  busy?: boolean;
  attachments: readonly AttachedFile[];
  addAttachment: (file: File) => Promise<void>;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  setAttachments: (attachments: readonly AttachedFile[]) => void;
  pendingInput: { text: string; mode: 'replace' | 'append' | 'append-inline' } | null;
  consumePendingInput: () => { text: string; mode: 'replace' | 'append' | 'append-inline' } | null;
  pendingPreset: string | null;
  consumePendingPreset: () => string | null;
  consumeSyntheticParts: () => SyntheticContextPart[] | null;
  restoreSyntheticParts: (parts: readonly SyntheticContextPart[]) => void;
  inlineDrafts: readonly InlineCommentDraft[];
  removeInlineDraft: (id: string) => void;
  restoreInlineDrafts: (drafts: readonly InlineCommentDraft[]) => void;
  history: readonly string[];
  captureRuntime: () => { transportIdentity: string; generation: number };
  getDraft: (key: DraftKey) => DraftRecord | undefined;
  /** Abort-prompt state belongs to the composer surface that owns the operation. */
  abortPrompt: { sessionID: string | null; clear: () => void };
};

export type ChatInputQueueScope = {
  deliveryTarget: ChatInputDeliveryTarget;
  sessionID: string;
  directory: string;
  transportIdentity: string;
  runtimeGeneration: number;
};

type ChatInputSurfaceBase = {
  surfaceID: string;
  active: boolean;
  selection: ChatInputSelection;
  queue?: ChatInputQueueChips;
  commands?: ChatInputCommandContext;
  backend: ChatInputBackend;
  commandPolicy?: (command: Pick<CommandInfo, 'name' | 'source' | 'isBuiltIn' | 'isSkill'>) => boolean;
  activity?: { phase: 'idle' | 'busy' | 'retry' | 'unknown'; canAbort?: boolean };
  /** Required for secondary surfaces so every mutable composer resource is scoped. */
  resources?: ChatInputSurfaceResources;
  shortcuts?: {
    cycle: (direction: 1 | -1) => void | Promise<void>;
    new: () => void | Promise<void>;
    abort: () => void | Promise<void>;
    submit: () => void | Promise<void>;
  };
  deliveryTarget: ChatInputDeliveryTarget;
};

export type ChatInputPrimarySurface = ChatInputSurfaceBase & {
  kind: 'primary';
  sessionID: string | null;
  directory: string | null;
  draftKey: DraftKey | null;
  transportIdentity: string;
  runtimeGeneration: number;
};

export type ChatInputSecondarySurface = ChatInputSurfaceBase & {
  kind: 'secondary';
  sessionID: string;
  directory: string;
  draftKey: DraftKey;
  transportIdentity: string;
  runtimeGeneration: number;
};

export type ChatInputSurface = ChatInputPrimarySurface | ChatInputSecondarySurface;

export const allowChatInputCommand = (): boolean => true;

export const isChatInputCommandAllowed = (
  surface: Pick<ChatInputSurface, 'commandPolicy'>,
  command: Pick<CommandInfo, 'name' | 'source' | 'isBuiltIn' | 'isSkill'>,
): boolean => (surface.commandPolicy ?? allowChatInputCommand)(command);

export const ChatInputSurfaceContext = React.createContext<ChatInputSurface | null>(null);

export const useChatInputSurfaceContext = (): ChatInputSurface | null => React.useContext(ChatInputSurfaceContext);

/** Maps the established primary stores/actions into the shared surface contract. */
export const usePrimaryChatInputSurface = (surface: ChatInputPrimarySurface): ChatInputPrimarySurface => surface;

export const resolveChatInputSurface = (
  primary: ChatInputPrimarySurface,
  surface?: ChatInputSurface | null,
): ChatInputSurface => surface ?? primary;

/** Secondary surfaces have no primary-store recovery path. */
export const assertChatInputSurfaceReady = (surface: ChatInputSurface): void => {
  if (surface.kind === 'primary') return;
  if (!surface.sessionID || !surface.directory || !surface.draftKey || !surface.transportIdentity || !Number.isSafeInteger(surface.runtimeGeneration) || !surface.resources || typeof surface.resources.busy !== 'boolean' || !surface.activity || !surface.commands || !surface.shortcuts) {
    throw new Error('chat-input-secondary-surface-incomplete');
  }
};

export const resolveChatInputDraftBusy = (
  surface: ChatInputSurface,
  primaryDraftBusy: boolean,
): boolean => surface.kind === 'secondary' ? surface.resources?.busy ?? false : primaryDraftBusy;

export const chatInputQueueScope = (surface: Pick<ChatInputSurface, 'deliveryTarget' | 'sessionID' | 'directory' | 'transportIdentity' | 'runtimeGeneration'>): ChatInputQueueScope | null => {
  if (!surface.sessionID || !surface.directory) return null;
  return {
    deliveryTarget: surface.deliveryTarget,
    sessionID: surface.sessionID,
    directory: surface.directory,
    transportIdentity: surface.transportIdentity,
    runtimeGeneration: surface.runtimeGeneration,
  };
};

/** Resolves the command availability context from a surface, defaulting to primary semantics. */
export const resolveChatInputCommandContext = (surface: ChatInputSurface, primaryHasMessages: boolean, primaryHasNewDraft: boolean): ChatInputCommandContext => {
  if (surface.kind === 'secondary') {
    if (!surface.commands) throw new Error('chat-input-secondary-commands-incomplete');
    return surface.commands;
  }
  if (surface.commands) return surface.commands;
  return {
    sessionID: surface.sessionID,
    hasMessages: primaryHasMessages,
    hasNewDraft: primaryHasNewDraft,
  };
};
