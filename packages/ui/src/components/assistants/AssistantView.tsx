import React from 'react';
import { useEvent } from '@reactuses/core';
import { AgentAvatar } from '@/components/chat/AgentAvatar';
import { resolveModelVariantKeys, type ChatInputSecondarySurface, type ChatInputSurfaceResources } from '@/components/chat/chatInputSurface';
import { resolveComposerVisibleAgents } from '@/components/chat/chatComposerCatalog';
import { getCycledPrimaryAgentName, resolveAgentModelSelection } from '@/components/chat/mobileControlsUtils';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { donateNativeAssistantInteraction } from '@/apps/MobileShareBridge';
import { isMobileShareHandoffMarkerPart } from '@/apps/mobileShareDraftHandoff';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { createUuid } from '@/lib/uuid';
import { cn } from '@/lib/utils';
import { MobileDetailNavigation } from '@/mobile/MobileDetailNavigation';
import { getRuntimeGeneration, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { abortAssistantSession, compactAssistantSession, ensureAssistantSession, fetchAssistantSnapshot, newAssistantSession, readAssistantSnapshot, sendAssistantMessage, updateAssistant, useAssistantCapabilityQuery, useAssistantSnapshotQuery, type AssistantDTO, type AssistantPart, type SessionBinding } from '@/queries/assistantQueries';
import { ascendingIdAfter } from '@/sync/message-id';
import { getSyncMessages } from '@/sync/sync-refs';
import { createPendingUserMessagePresentation, type PendingUserMessagePresentation } from '@/sync/session-ui-store';
import { useSessionMessages, useSessionStatus, useUserMessageHistory } from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { surfaceDraftKey, draftKeyString } from '@/sync/input-draft-types';
import { createDraftAttachmentResourceAdapter } from '@/sync/draft-attachment-resource-adapter';
import { useInputStore } from '@/sync/input-store';
import { useScopedAgentsQuery, useScopedProvidersQuery } from '@/queries/agentQueries';
import { openAssistantSettings, useAssistantUIStore } from '@/stores/useAssistantUIStore';
import { useUIStore } from '@/stores/useUIStore';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { ContextPanel } from '@/components/layout/ContextPanel';
import { AssistantConversationSurface } from './AssistantConversationSurface';
import { toast } from 'sonner';
import { revertToMessage as revertSessionToMessage, stageMessageEdit } from '@/sync/session-actions';
import type { SessionSurfaceMessageEditSnapshot } from '@/components/chat/SessionSurfaceContext';

import { AssistantSelectionCoordinator, AssistantSelectionStaleError, type AssistantSelection, type AssistantSelectionIdentity } from './assistantSelectionCoordinator';
import { commitAssistantSelection } from './assistantSelectionBackend';
import { AssistantDeleteConfirmDialog } from './AssistantDeleteConfirmDialog';
import { getAssistantPresentation } from './assistantPresentation';
import { reconcileAdmittedAssistantBinding, rebindPendingAssistantMessage } from './assistantPendingMessages';
import {
  createAssistantStagedMessageEditRegistry,
  assistantStagedScopeOf,
  type AssistantStagedMessageEditIdentity,
} from './assistantStagedMessageEdit';
import {
  mapSyntheticPartsWithViews,
  mergeSyntheticPartsByPartID,
  projectRootAttachmentViews,
} from './assistantDraftAttachments';
import type { DraftSyntheticPart } from '@/sync/input-draft-types';

const EMPTY_ATTACHMENT_VIEWS: Record<string, AttachedFile> = {};
const EMPTY_ROOT_ATTACHMENTS: AttachedFile[] = [];
const EMPTY_PENDING_MESSAGES: PendingUserMessagePresentation[] = [];
const assistantParts = (text: string | undefined, parts: readonly { text: string; attachments?: readonly AttachedFile[]; synthetic?: boolean }[] | undefined, attachments: readonly AttachedFile[] | undefined): AssistantPart[] => {
  return [
    ...(text === undefined ? [] : [{ type: 'text' as const, text }]),
    ...(parts ?? []).flatMap((part) => [
      { type: 'text' as const, text: part.text, ...(part.synthetic === true ? { synthetic: true as const } : {}) },
      ...(part.attachments ?? []).map((attachment) => ({ type: 'file' as const, mime: attachment.mimeType, url: attachment.dataUrl })),
    ]),
    ...(attachments ?? []).map((attachment) => ({ type: 'file' as const, mime: attachment.mimeType, url: attachment.dataUrl })),
  ];
};

type MobileAssistantConversationHeaderProps = {
  assistant?: { id: string; name: string; mode: 'continuous' | 'stateless' } | null;
  onBack: () => void;
};

const MobileAssistantConversationHeader: React.FC<MobileAssistantConversationHeaderProps> = ({ assistant, onBack }) => {
  const { t } = useI18n();
  const presentation = assistant ? getAssistantPresentation(assistant.name) : null;
  const displayName = assistant && presentation ? presentation.displayName || assistant.name : '';

  return (
    <MobileDetailNavigation
      title={displayName || t('assistants.title')}
      backAriaLabel={t('assistants.actions.backToChat')}
      onBack={onBack}
      overlay
    />
  );
};

type AssistantListItemProps = {
  assistantID: string;
  displayName: string;
  avatarEmoji?: string;
  modeLabel: string;
  selected: boolean;
  enabled: boolean;
  editLabel: string;
  deleteLabel: string;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

const AssistantListItem: React.FC<AssistantListItemProps> = ({
  assistantID,
  displayName,
  avatarEmoji,
  modeLabel,
  selected,
  enabled,
  editLabel,
  deleteLabel,
  onSelect,
  onEdit,
  onDelete,
}) => {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const handleSelect = useEvent(() => onSelect());
  const handleEdit = useEvent(() => {
    setMenuOpen(false);
    onEdit();
  });
  const handleDelete = useEvent(() => {
    setMenuOpen(false);
    onDelete();
  });

  return (
    <ContextMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <ContextMenuTrigger
        render={
          <button
            type="button"
            role="option"
            aria-selected={selected}
            onClick={handleSelect}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenuOpen(true);
            }}
            className={cn(
              'flex w-full min-h-11 items-center gap-3 rounded-xl border px-3 py-3 text-left outline-none transition-[background-color,border-color,opacity] duration-150 ease-out active:bg-interactive-active focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] motion-reduce:transition-none',
              selected
                ? 'border-border/50 bg-[var(--surface-elevated)]'
                : 'border-transparent hover:bg-interactive-hover',
              !enabled && 'opacity-65',
            )}
          />
        }
      >
        <AgentAvatar name={assistantID} emoji={avatarEmoji} size={24} label={displayName} />
        <span className="min-w-0 flex-1">
          <span className="block truncate typography-ui-label font-medium">{displayName}</span>
          <span className="mt-0.5 block truncate typography-micro text-muted-foreground">
            {modeLabel}
          </span>
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[10rem]">
        <ContextMenuItem onClick={handleEdit}>
          <Icon name="edit" className="size-4" />
          {editLabel}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={handleDelete}
          className="text-[var(--status-error)] focus:text-[var(--status-error)] data-[highlighted]:text-[var(--status-error)] [&_svg]:text-[var(--status-error)]"
        >
          <Icon name="delete-bin" className="size-4" />
          {deleteLabel}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

export type AssistantViewProps = {
  /** Dedicated mobile navigation owns whether this mounted detail page is active. */
  activeOverride?: boolean;
  /** When present, mobile renders a second-level conversation header with Back. */
  onMobileBack?: () => void;
};

export const AssistantView: React.FC<AssistantViewProps> = ({ activeOverride, onMobileBack }) => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const mobileActions = useMobileAppActions();
  const transport = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeTransportIdentity, getRuntimeTransportIdentity);
  const runtimeGeneration = getRuntimeGeneration();
  const mainTabActive = useUIStore((state) => state.activeMainTab === 'assistant');
  const active = activeOverride ?? mainTabActive;
  const mobileFromStore = useUIStore((state) => state.isMobile);
  // Dedicated mobile tabs can be rendered in a desktop-width browser during
  // preview. The app-owned mobile state is authoritative for their layout.
  const isMobileSurface = isMobile || mobileFromStore;
  const capabilityQuery = useAssistantCapabilityQuery();
  const snapshotQuery = useAssistantSnapshotQuery();
  const snapshot = snapshotQuery.data;
  const selectedAssistantID = useAssistantUIStore((state) => state.assistantByTransport[transport] ?? null);
  const selectAssistant = useAssistantUIStore((state) => state.selectAssistant);
  const requestCreate = useAssistantUIStore((state) => state.requestCreate);
  const assistant = snapshot?.assistants.find((item) => item.id === selectedAssistantID) ?? null;
  const assistantID = assistant?.id ?? '';
  const sessionID = assistant?.sessionID ?? '';
  const directory = assistant?.effectiveWorkspacePath ?? '';
  const draftKey = React.useMemo(() => surfaceDraftKey({ transportIdentity: transport }, `assistant:${assistantID}`), [assistantID, transport]);
  const draftID = draftKeyString(draftKey);
  // Mirror primary: subscribe DraftRecord + views; project root attachments only (record.attachments order).
  const draftAttachmentViewsMap = useInputStore((state) => state.draftAttachmentViews[draftID] ?? EMPTY_ATTACHMENT_VIEWS);
  const draftRecord = useInputStore((state) => state.drafts[draftID]);
  const attachments = React.useMemo(
    () => {
      const ordered = projectRootAttachmentViews(draftRecord, draftAttachmentViewsMap);
      return ordered.length === 0 ? EMPTY_ROOT_ATTACHMENTS : ordered;
    },
    [draftAttachmentViewsMap, draftRecord],
  );
  // Hydrate when draftKey changes or attachment metadata identity arrives/changes
  // (late metadata after first empty record). Avoid full draft revision so typing
  // does not re-hydrate.
  const draftRootAttachmentMetadata = draftRecord?.attachments;
  const draftSyntheticPartMetadata = draftRecord?.syntheticParts;
  const draftAttachmentMetadataIdentity = React.useMemo(() => {
    if (!draftRootAttachmentMetadata || !draftSyntheticPartMetadata) return '';
    const root = draftRootAttachmentMetadata.map((attachment) => attachment.attachmentRefID).join('\u0001');
    const synthetic = draftSyntheticPartMetadata
      .map((part) => `${part.partID}\u0002${part.attachments.map((attachment) => attachment.attachmentRefID).join('\u0001')}`)
      .join('\u0003');
    return `${root}\u0004${synthetic}`;
  }, [draftRootAttachmentMetadata, draftSyntheticPartMetadata]);
  React.useEffect(() => {
    if (!assistantID) return;
    void useInputStore.getState().hydrateDraftAttachments(draftKey);
  }, [assistantID, draftKey, draftAttachmentMetadataIdentity]);
  const providersQuery = useScopedProvidersQuery(directory || null, { enabled: Boolean(directory) && active });
  const agentsQuery = useScopedAgentsQuery(directory || null, { enabled: Boolean(directory) && active });
  const messages = useSessionMessages(sessionID, directory || undefined);
  const status = useSessionStatus(sessionID, directory || undefined);
  const history = useUserMessageHistory(sessionID);
  const sync = useSync();
  const [pendingMessagesByAssistant, setPendingMessagesByAssistant] = React.useState<Map<string, PendingUserMessagePresentation[]>>(() => new Map());
  const pendingRefreshEpochRef = React.useRef(0);
  /** Per-assistant continuous staged sent-message edit registry; no render subscription. Scope = transport + assistantID. */
  const stagedMessageEditRegistryRef = React.useRef(createAssistantStagedMessageEditRegistry());
  const pendingMessages = pendingMessagesByAssistant.get(assistantID) ?? EMPTY_PENDING_MESSAGES;
  const [, setSelectionSaving] = React.useState(false);
  const selectionErrorRef = React.useRef<(error: unknown) => void>(() => {});
  selectionErrorRef.current = () => { toast.error(t('assistants.composer.selectionSaveFailed')); };
  const selectionCoordinatorRef = React.useRef<AssistantSelectionCoordinator | null>(null);
  if (!selectionCoordinatorRef.current) selectionCoordinatorRef.current = new AssistantSelectionCoordinator(setSelectionSaving, (error) => selectionErrorRef.current(error));
  const selectionIdentity = React.useMemo<AssistantSelectionIdentity>(() => ({ assistantID, transportIdentity: transport, runtimeGeneration }), [assistantID, runtimeGeneration, transport]);
  const selectionCoordinator = selectionCoordinatorRef.current;
  const stagedScope = React.useMemo(() => ({ transport, assistantID }), [assistantID, transport]);

  /** Drop staged identity only (no draft rollback). Serialized so in-flight stage cannot re-register after clear. */
  const clearStagedMessageEdit = useEvent(async (targetAssistantID: string, targetTransport = transport) => {
    await stagedMessageEditRegistryRef.current.clearExclusive({ transport: targetTransport, assistantID: targetAssistantID });
  });
  /**
   * Runtime switch / unmount: best-effort rollback other-transport entries (or all on unmount).
   * Ordinary send clears its current staged marker synchronously and remains independent
   * from these cleanup attempts.
   */
  const invalidateAllStagedMessageEdits = useEvent((options?: { excludeTransport?: string }) => {
    void stagedMessageEditRegistryRef.current.rollbackAllBestEffort(options).catch(() => undefined);
  });

  React.useEffect(() => { if (!selectedAssistantID && snapshot?.assistants[0]) selectAssistant(snapshot.assistants[0].id); }, [selectAssistant, selectedAssistantID, snapshot?.assistants]);
  React.useEffect(() => { if (snapshotQuery.isSuccess && selectedAssistantID && !assistant) selectAssistant(snapshot?.assistants[0]?.id ?? null); }, [assistant, selectAssistant, selectedAssistantID, snapshot?.assistants, snapshotQuery.isSuccess]);
  React.useEffect(() => { if (active && assistantID && !sessionID) void ensureAssistantSession(assistantID); }, [active, assistantID, sessionID]);
  React.useEffect(() => {
    pendingRefreshEpochRef.current++;
    setPendingMessagesByAssistant(new Map());
    // Runtime switch: best-effort rollback entries on other transports.
    invalidateAllStagedMessageEdits({ excludeTransport: transport });
  }, [transport, runtimeGeneration, invalidateAllStagedMessageEdits]);
  React.useEffect(() => () => { pendingRefreshEpochRef.current++; invalidateAllStagedMessageEdits(); }, [invalidateAllStagedMessageEdits]);
  React.useEffect(() => { selectionCoordinator.activate(selectionIdentity); }, [selectionCoordinator, selectionIdentity]);
  React.useEffect(() => () => { selectionCoordinator.dispose(); }, [selectionCoordinator]);
  // Binding identity change: CAS-rollback draft then clear only on safe status (retain on failure).
  // Scope is transport+assistantID so returning to an old transport retries its retained entry.
  React.useEffect(() => {
    if (!assistantID) return;
    void stagedMessageEditRegistryRef.current.rollbackAndClearIfBindingMismatch(stagedScope, {
      assistantID,
      sessionID,
      directory,
      sessionGeneration: assistant?.sessionGeneration ?? -1,
      transport,
      runtimeGeneration,
    }).catch(() => undefined);
  }, [assistant?.sessionGeneration, assistantID, directory, runtimeGeneration, sessionID, stagedScope, transport]);

  const changeSelection = useEvent((selection: AssistantSelection) => {
    if (!selectionIdentity.assistantID) return Promise.reject(new Error('assistant_unavailable'));
    return selectionCoordinator.enqueue(selectionIdentity, selection, async ({ identity, selection: desired, signal }) => {
      await commitAssistantSelection(identity, desired, {
        readSnapshot: () => readAssistantSnapshot(undefined, identity.transportIdentity),
        ensureSnapshot: (snapshotSignal) => fetchAssistantSnapshot(snapshotSignal),
        updateAssistant,
        signal,
        assertAuthoritative: () => {
          selectionCoordinator.assertAuthoritative(identity);
          if (getRuntimeTransportIdentity() !== identity.transportIdentity || getRuntimeGeneration() !== identity.runtimeGeneration) throw new AssistantSelectionStaleError();
        },
      });
    });
  });

  const visibleAgents = React.useMemo(
    () => resolveComposerVisibleAgents(agentsQuery.data),
    [agentsQuery.data],
  );
  const cycle = useEvent((direction: 1 | -1) => {
    if (!assistant) return;
    const next = getCycledPrimaryAgentName(visibleAgents, assistant.agent ?? undefined, direction);
    if (next) {
      const selection = resolveAgentModelSelection({ providerID: assistant.providerID, modelID: assistant.modelID, agent: assistant.agent }, next, visibleAgents, providersQuery.data ?? []);
      const retainsModel = selection.providerID === assistant.providerID && selection.modelID === assistant.modelID;
      void changeSelection({ ...selection, agent: selection.agent ?? undefined, variant: retainsModel ? assistant.variant ?? undefined : undefined });
    }
  });
  const refreshBinding = useEvent(async (binding: SessionBinding, options?: { force?: boolean }) => {
    if (!binding.sessionID) return;
    // Soft ensure after ordinary sends so live sync/SSE can update the transcript in place.
    // Force only when the binding itself changed (/new, compact), on active binding
    // materialization (initial/switch), or the user retries a failed load.
    await sync.ensureSessionRenderable(binding.sessionID, {
      directory: binding.directory,
      ...(options?.force ? { force: true } : {}),
    });
  });
  // Active binding materialization: force TranscriptRepository initial pull so the
  // live OpenCode session loads even when Assistant SQLite history is empty/delayed.
  // Deps are binding identity only — same binding must not re-fire on snapshot churn.
  // Do not swallow ensure failures: request/error state keeps existing retry UI.
  const sessionGeneration = assistant?.sessionGeneration;
  React.useEffect(() => {
    if (!active || !assistantID || !sessionID || !directory || sessionGeneration === undefined) return;
    void refreshBinding(
      { sessionID, directory, sessionGeneration },
      { force: true },
    );
  }, [active, assistantID, directory, refreshBinding, sessionGeneration, sessionID]);
  const removePendingMessages = useEvent((targetAssistantID: string, messageIDs: readonly string[]) => {
    if (messageIDs.length === 0) return;
    const removed = new Set(messageIDs);
    setPendingMessagesByAssistant((current) => {
      const messagesForAssistant = current.get(targetAssistantID);
      if (!messagesForAssistant?.some((message) => removed.has(message.info.id))) return current;
      const next = new Map(current);
      const remaining = messagesForAssistant.filter((message) => !removed.has(message.info.id));
      if (remaining.length > 0) next.set(targetAssistantID, remaining);
      else next.delete(targetAssistantID);
      return next;
    });
  });
  const rebindPendingMessage = useEvent((targetAssistantID: string, messageID: string, targetSessionID: string) => {
    setPendingMessagesByAssistant((current) => {
      const messagesForAssistant = current.get(targetAssistantID);
      if (!messagesForAssistant) return current;
      const rebound = rebindPendingAssistantMessage(messagesForAssistant, messageID, targetSessionID);
      if (rebound === messagesForAssistant) return current;
      const next = new Map(current);
      next.set(targetAssistantID, rebound);
      return next;
    });
  });
  const handlePendingMessagesMaterialized = useEvent((messageIDs: readonly string[]) => {
    removePendingMessages(assistantID, messageIDs);
  });
  const revertAssistantMessage = useEvent(async (messageID: string) => {
    if (!sessionID || !directory) throw new Error('assistant_unavailable');
    // History segments from prior bindings are read-only in the stitched transcript.
    if (!getSyncMessages(sessionID, directory).some((message) => message?.id === messageID)) return;
    // Surface DraftKey isolation: restore into the Assistant partition, not primary.
    await revertSessionToMessage(sessionID, messageID, { directory, draftKey, restorePrimaryInput: false });
    // Revert retires any staged edit for this assistant (same binding may still exist).
    await clearStagedMessageEdit(assistantID);
  });
  const editAssistantMessage = useEvent(async (messageID: string, snapshot: SessionSurfaceMessageEditSnapshot) => {
    // Stateless turns cannot rewrite history; continuous only, live binding only.
    if (!assistant || assistant.mode !== 'continuous') return;
    if (!sessionID || !directory) throw new Error('assistant_unavailable');
    if (!getSyncMessages(sessionID, directory).some((message) => message?.id === messageID)) return;
    if (snapshot.info.id !== messageID || snapshot.info.sessionID !== sessionID || snapshot.info.role !== 'user') {
      throw new Error('The selected user message is unavailable');
    }
    const identity: AssistantStagedMessageEditIdentity = {
      assistantID: assistant.id,
      sessionID,
      directory,
      sessionGeneration: assistant.sessionGeneration,
      messageID,
      transport,
      runtimeGeneration,
    };
    const scope = assistantStagedScopeOf(identity);
    // Exclusive per transport+assistant: retire prior entry, then stage; failed/skipped prior blocks.
    const stageResult = await stagedMessageEditRegistryRef.current.stageExclusive(scope, async () => {
      // Stage into surfaceDraftKey; primary session draft / stagedMessageEdit stay untouched.
      const stageHandle = await stageMessageEdit(sessionID, messageID, snapshot, { directory, draftKey });
      // Re-validate runtime + this assistant's live binding after the async draft commit.
      // Selection may have moved to another assistant; Map still supports A while B is selected.
      const runtimeOk =
        getRuntimeTransportIdentity() === identity.transport
        && getRuntimeGeneration() === identity.runtimeGeneration;
      const live = runtimeOk
        ? readAssistantSnapshot(undefined, identity.transport)?.assistants.find((item) => item.id === identity.assistantID)
        : undefined;
      const bindingOk = Boolean(
        live
        && live.mode === 'continuous'
        && live.sessionID === identity.sessionID
        && live.sessionGeneration === identity.sessionGeneration
        && (live.effectiveWorkspacePath ?? '') === identity.directory,
      );
      if (runtimeOk && bindingOk) {
        return { identity, rollback: () => stageHandle.rollback() };
      }
      // Stale runtime/binding: CAS-rollback the restored draft; conflict keeps user edits.
      // failed/skipped: register handle to protect restored body and signal error to caller.
      const rolled = await stageHandle.rollback();
      if (rolled.status === 'failed' || rolled.status === 'skipped') {
        return {
          identity,
          rollback: () => stageHandle.rollback(),
          protectOnStale: true,
        };
      }
      // rolled-back/conflict: do not keep an entry for a cleanly retired stale stage.
      return null;
    });
    if (stageResult.kind === 'blocked') {
      throw new Error('assistant_stage_message_edit_prior_blocked');
    }
    if (stageResult.kind === 'stale_protected') {
      throw new Error('assistant_stage_message_edit_rollback_failed');
    }
  });
  // selectionSaving must NOT drive composer busy/disabled. Primary Tab agent
  // cycling never disables the textarea; mapping PATCH-in-flight onto resources.busy
  // made Assistant Tab blur the input (browser drops focus from disabled fields).
  const resources = React.useMemo<ChatInputSurfaceResources>(() => {
    const attachmentAdapter = createDraftAttachmentResourceAdapter(draftKey, () => useInputStore.getState());
    return {
    busy: false,
    // Root-only projection: synthetic attachment views never enter resources.attachments.
    attachments,
    addAttachment: (file) => attachmentAdapter.addLocal(file),
    removeAttachment: (id) => attachmentAdapter.removeByAttachmentID(id),
    clearAttachments: () => attachmentAdapter.clearRootAttachments(),
    restoreAttachments: (nextAttachments) => attachmentAdapter.restoreRootAttachments(nextAttachments),
    pendingInput: null,
    consumePendingInput: () => null,
    pendingPreset: null,
    consumePendingPreset: () => null,
    consumeSyntheticParts: () => {
      const input = useInputStore.getState();
      const viewsByRef = input.draftAttachmentViews[draftKeyString(draftKey)] ?? EMPTY_ATTACHMENT_VIEWS;
      // Retain handoff receipt in the draft via retain predicate; only non-marker parts are returned for send.
      const consumed = input.consumeDraftSyntheticParts(draftKey, isMobileShareHandoffMarkerPart);
      if (!consumed) return null;
      return mapSyntheticPartsWithViews(consumed, viewsByRef);
    },
    restoreSyntheticParts: (parts) => {
      void (async () => {
        const input = useInputStore.getState();
        const restored: DraftSyntheticPart[] = parts.map((part) => ({
          partID: part.partID ?? createUuid(),
          text: part.text,
          attachments: [],
          ...(part.synthetic === true ? { synthetic: true as const } : {}),
        }));
        // Merge by partID: keep mobile handoff marker and concurrent parts; replace restored IDs only.
        const current = input.getDraft(draftKey)?.syntheticParts ?? [];
        const merged = mergeSyntheticPartsByPartID(current, restored);
        input.setDraftSyntheticParts(draftKey, merged);
        for (let index = 0; index < restored.length; index++) {
          const partID = restored[index]!.partID;
          for (const attachment of parts[index]?.attachments ?? []) {
            if (attachment.source === 'server' && attachment.dataUrl) input.addDraftDurableAttachment(draftKey, { attachmentID: attachment.id, filename: attachment.filename, mimeType: attachment.mimeType, size: attachment.size, source: 'server', url: attachment.dataUrl, serverPath: attachment.serverPath, partID });
            else await input.addDraftLocalAttachment(draftKey, attachment.file, { attachmentID: attachment.id, filename: attachment.filename, source: attachment.source === 'vscode' ? 'vscode' : 'local', vscodePath: attachment.vscodePath, vscodeSource: attachment.vscodeSource === 'selection' ? 'selection' : undefined, partID });
          }
        }
      })();
    },
    inlineDrafts: [],
    removeInlineDraft: () => {},
    restoreInlineDrafts: () => {},
    history,
    captureRuntime: () => useInputStore.getState().captureDraftRuntime(),
    getDraft: (key) => useInputStore.getState().getDraft(key),
    abortPrompt: { sessionID: null, clear: () => {} },
  };
  }, [attachments, draftKey, history]);

  const variants = React.useMemo(() => {
    const model = (providersQuery.data ?? []).find((provider) => provider.id === assistant?.providerID)?.models?.find((item) => item.id === assistant?.modelID) as { variants?: unknown } | undefined;
    // Provider catalogs project variants as a Record of named configs, not a string[].
    return resolveModelVariantKeys(model);
  }, [assistant?.modelID, assistant?.providerID, providersQuery.data]);
  const hasMessages = messages.length > 0;
  const surface = React.useMemo<ChatInputSecondarySurface | null>(() => {
    if (!assistant || !sessionID || !directory) return null;
    const binding = { sessionID, directory, sessionGeneration: assistant.sessionGeneration };
    return {
      kind: 'secondary', surfaceID: `assistant:${assistant.id}`, active, sessionID, directory, draftKey, transportIdentity: transport, runtimeGeneration, deliveryTarget: { kind: 'assistant', assistantID: assistant.id }, resources,
      // Stateless delivery belongs to the Assistant, not to the disposable
      // OpenCode Session created for one turn. Keep queue lookup stable while
      // the live transcript binding advances after every accepted prompt.
      ...(assistant.mode === 'stateless' ? { queueSessionID: `assistant:${assistant.id}` } : {}),
      selection: { value: { providerID: assistant.providerID, modelID: assistant.modelID, agent: assistant.agent ?? undefined, variant: assistant.variant ?? undefined }, catalog: { providers: providersQuery.data ?? [], agents: visibleAgents, variants, variantsReady: providersQuery.isSuccess, ready: providersQuery.isSuccess && agentsQuery.isSuccess, loading: providersQuery.isPending || agentsQuery.isPending, error: providersQuery.isError || agentsQuery.isError }, change: changeSelection, flush: () => selectionCoordinator.flush(selectionIdentity) },
      // Mirror primary chat: missing status is idle, never `unknown`. Unknown was
      // treated as "not idle" by composer queue/steer gates and diverted idle
      // assistant sends into the queue path before session status hydrated.
      activity: { phase: status?.type === 'busy' ? 'busy' : status?.type === 'retry' ? 'retry' : 'idle', canAbort: status?.type === 'busy' || status?.type === 'retry' },
      commands: { sessionID, hasMessages, hasNewDraft: false },
      commandPolicy: (command) => command.name !== 'fork' && command.name !== 'thread',
      backend: {
        send: async (request) => {
          // OpenCode rejects non-ascending message IDs (`Expected a string starting with "msg"`).
          // Mirror primary chat: generate msg_* above the latest synced message in this session.
          let floor: string | undefined;
          for (const message of getSyncMessages(binding.sessionID, binding.directory)) {
            const id = typeof message?.id === 'string' ? message.id : '';
            if (/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id) && (!floor || id > floor)) floor = id;
          }
          const messageID = ascendingIdAfter('msg', floor);
          // Sent-message restoration is best-effort. Delivery always follows the
          // ordinary send path; a staged identity only marks the restored draft.
          if (request.options?.commitStagedMessageEdit) {
            stagedMessageEditRegistryRef.current.clear({ transport, assistantID: assistant.id });
          }
          const pendingMessage = createPendingUserMessagePresentation({
            messageID,
            sessionID: binding.sessionID,
            providerID: request.providerID ?? assistant.providerID,
            modelID: request.modelID ?? assistant.modelID,
            agent: request.agent ?? assistant.agent ?? undefined,
            text: request.text,
            attachments: request.attachments,
            additionalParts: request.parts,
          });
          setPendingMessagesByAssistant((current) => {
            const next = new Map(current);
            next.set(assistant.id, [...(current.get(assistant.id) ?? []), pendingMessage]);
            return next;
          });
          let result;
          try {
            result = await sendAssistantMessage(assistant.id, binding, messageID, assistantParts(request.text, request.parts, request.attachments));
          } catch (error) {
            removePendingMessages(assistant.id, [messageID]);
            throw error;
          }
          if (capabilityQuery.data?.serverInstanceID) {
            const nativePresentation = getAssistantPresentation(assistant.name);
            void donateNativeAssistantInteraction({
              serverInstanceID: capabilityQuery.data.serverInstanceID,
              assistantID: assistant.id,
              name: nativePresentation.displayName || assistant.name,
              avatarSeed: assistant.id,
              ...(nativePresentation.avatarEmoji ? { avatarEmoji: nativePresentation.avatarEmoji } : {}),
            }).catch(() => undefined);
          }
          // Stateless mode replaces the binding each turn. Move the pending row
          // first so it remains visible while the new binding materializes.
          if (result.binding.sessionID) rebindPendingMessage(assistant.id, messageID, result.binding.sessionID);
          const refreshEpoch = pendingRefreshEpochRef.current;
          reconcileAdmittedAssistantBinding({
            binding: result.binding,
            refresh: (admittedBinding) => refreshBinding(admittedBinding, { force: admittedBinding.sessionID !== binding.sessionID || admittedBinding.sessionGeneration !== binding.sessionGeneration }),
            isCurrent: () => pendingRefreshEpochRef.current === refreshEpoch,
          });
        },
        sendQueued: async () => { throw new Error('assistant-server-queue-required'); },
        create: async () => {
          const next = await newAssistantSession(assistant.id);
          await clearStagedMessageEdit(assistant.id);
          await refreshBinding(next, { force: true });
        },
        compact: async () => {
          const result = await compactAssistantSession(assistant.id, binding);
          await clearStagedMessageEdit(assistant.id);
          await refreshBinding(result.binding, { force: true });
        },
        abort: async () => { await abortAssistantSession(assistant.id, binding); },
      },
      shortcuts: {
        cycle,
        new: async () => {
          const next = await newAssistantSession(assistant.id);
          await clearStagedMessageEdit(assistant.id);
          await refreshBinding(next, { force: true });
        },
        abort: async () => { await abortAssistantSession(assistant.id, binding); },
        submit: () => {},
      },
    };
  }, [active, assistant, capabilityQuery.data?.serverInstanceID, changeSelection, clearStagedMessageEdit, cycle, directory, draftKey, hasMessages, providersQuery.data, providersQuery.isError, providersQuery.isPending, providersQuery.isSuccess, agentsQuery.isError, agentsQuery.isPending, agentsQuery.isSuccess, refreshBinding, rebindPendingMessage, removePendingMessages, resources, runtimeGeneration, selectionCoordinator, selectionIdentity, sessionID, status, transport, variants, visibleAgents]);

  const openCreateSettings = useEvent(() => { requestCreate(); if (mobileActions) { mobileActions.openSettings(); return; } const ui = useUIStore.getState(); ui.setSettingsPage('assistants'); ui.setSettingsDialogOpen(true); });
  const openEditSettings = useEvent((assistantID: string) => {
    openAssistantSettings(assistantID, mobileActions ? { openMobileSettings: mobileActions.openSettings } : undefined);
  });
  const [deleteTarget, setDeleteTarget] = React.useState<AssistantDTO | null>(null);
  const requestDeleteAssistant = useEvent((item: AssistantDTO) => {
    setDeleteTarget(item);
  });
  const handleDeleteDialogOpenChange = useEvent((open: boolean) => {
    if (!open) setDeleteTarget(null);
  });
  const returnToChat = useEvent(() => { useUIStore.getState().setActiveMainTab('chat'); });
  const handleMobileBack = useEvent(() => {
    if (onMobileBack) {
      onMobileBack();
      return;
    }
    returnToChat();
  });
  const renderState = (icon: 'cloud-off' | 'error-warning' | 'ai-agent', title: string, description?: string, action?: React.ReactNode) => <div className="relative flex h-full min-h-0 flex-col">{isMobileSurface ? <MobileAssistantConversationHeader assistant={assistant} onBack={handleMobileBack} /> : null}<div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pt-[calc(max(0.25rem,var(--oc-safe-area-top,0px))+var(--oc-mobile-detail-navigation-height,3.5rem))] text-center"><Icon name={icon} className="size-6 text-muted-foreground" /><h1 className="mt-4 typography-ui-header font-semibold">{title}</h1>{description ? <p className="mt-2 max-w-md typography-ui text-muted-foreground">{description}</p> : null}{action ? <div className="mt-5">{action}</div> : null}</div></div>;
  if (capabilityQuery.isPending || snapshotQuery.isPending) return renderState('ai-agent', t('assistants.state.unavailable'));
  if (capabilityQuery.isError || !capabilityQuery.data?.supported || !capabilityQuery.data.enabled || !snapshot?.enabled) return renderState('cloud-off', t('assistants.state.unavailable'));
  if (!snapshot.assistants.length) return renderState('ai-agent', t('assistants.onboarding.title'), t('assistants.onboarding.description'), <Button onClick={openCreateSettings}>{t('assistants.onboarding.action')}</Button>);
  if (!assistant) return renderState('ai-agent', t('assistants.state.unavailable'));
  if (!surface) return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      {isMobileSurface ? <MobileAssistantConversationHeader assistant={assistant} onBack={handleMobileBack} /> : null}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 pt-[calc(max(0.25rem,var(--oc-safe-area-top,0px))+var(--oc-mobile-detail-navigation-height,3.5rem))]" aria-busy="true" aria-label={t('assistants.state.unavailable')}>
        <div className="size-10 animate-pulse rounded-xl bg-[var(--surface-muted)] motion-reduce:animate-none" />
        <div className="h-3.5 w-36 animate-pulse rounded-md bg-[var(--surface-muted)] motion-reduce:animate-none" />
      </div>
    </div>
  );
  const presentation = getAssistantPresentation(assistant.name);
  // Do not surface model-catalog mismatch as a conversation banner: providers may
  // still be loading or the assistant model may live outside the scoped catalog.
  const warning = !assistant.enabled ? t('assistants.state.assistantDisabled') : snapshotQuery.isError ? t('assistants.state.staleSnapshot') : null;
  return (
    <div className="relative flex h-full min-h-0 overflow-hidden bg-background" data-presentation="workspace">
      {isMobileSurface ? null : (
        <section className="flex h-full min-h-0 w-[clamp(16rem,22vw,20rem)] shrink-0 flex-col overflow-hidden">
          <header className="shrink-0 px-4 pb-3 pt-4 sm:px-5">
            <h1 className="truncate typography-ui-label font-semibold text-foreground">{t('assistants.title')}</h1>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 sm:px-4" role="listbox" aria-label={t('assistants.listAria')}>
            <div className="flex flex-col gap-1 border-t border-border/40 pt-3">
              {snapshot.assistants.map((item) => {
                const selected = item.id === selectedAssistantID;
                const itemPresentation = getAssistantPresentation(item.name);
                return (
                  <AssistantListItem
                    key={item.id}
                    assistantID={item.id}
                    displayName={itemPresentation.displayName}
                    avatarEmoji={itemPresentation.avatarEmoji ?? undefined}
                    modeLabel={item.mode === 'stateless' ? t('assistants.mode.stateless') : t('assistants.mode.continuous')}
                    selected={selected}
                    enabled={item.enabled}
                    editLabel={t('assistants.menu.edit')}
                    deleteLabel={t('assistants.settings.delete')}
                    onSelect={() => selectAssistant(item.id)}
                    onEdit={() => openEditSettings(item.id)}
                    onDelete={() => requestDeleteAssistant(item)}
                  />
                );
              })}
            </div>
          </div>
        </section>
      )}
      <AssistantDeleteConfirmDialog
        assistant={deleteTarget}
        open={deleteTarget !== null}
        onOpenChange={handleDeleteDialogOpenChange}
      />
      <div className={cn('relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background', !isMobileSurface && 'border-l border-border/60')}>
        {isMobileSurface ? (
          <MobileAssistantConversationHeader assistant={assistant} onBack={handleMobileBack} />
        ) : (
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/40 px-4 sm:px-5">
            <AgentAvatar name={assistant.id} emoji={presentation.avatarEmoji} size={24} label={presentation.displayName || assistant.name} />
            <div className="min-w-0 flex-1">
              <div className="truncate typography-ui-label font-medium">{presentation.displayName}</div>
              <div className="mt-0.5 truncate typography-micro leading-none text-muted-foreground/70">
                {assistant.mode === 'stateless'
                  ? t('assistants.conversation.statelessHint')
                  : t('assistants.conversation.continuousHint')}
              </div>
            </div>
          </header>
        )}
        <AssistantConversationSurface
          onRevertMessage={revertAssistantMessage}
          onEditMessage={assistant.mode === 'continuous' ? editAssistantMessage : undefined}
          assistant={assistant}
          sessionID={sessionID}
          warning={warning}
          surface={surface}
          pendingUserMessages={pendingMessages}
          onPendingUserMessagesMaterialized={handlePendingMessagesMaterialized}
        />
      </div>
      {isMobileSurface ? null : <ContextPanel directory={directory || null} />}
    </div>
  );
};
