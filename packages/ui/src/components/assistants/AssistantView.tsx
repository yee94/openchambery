import React from 'react';
import { useEvent } from '@reactuses/core';
import { AgentAvatar } from '@/components/chat/AgentAvatar';
import { resolveModelVariantKeys, type ChatInputSecondarySurface, type ChatInputSurfaceResources } from '@/components/chat/chatInputSurface';
import { resolveComposerVisibleAgents } from '@/components/chat/chatComposerCatalog';
import { getCycledPrimaryAgentName, resolveAgentModelSelection } from '@/components/chat/mobileControlsUtils';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { donateNativeAssistantInteraction } from '@/apps/MobileShareBridge';
import { isMobileShareHandoffMarkerPart } from '@/apps/mobileShareDraftHandoff';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { createUuid } from '@/lib/uuid';
import { cn } from '@/lib/utils';
import { MobileDetailNavigation } from '@/mobile/MobileDetailNavigation';
import { getRuntimeGeneration, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { abortAssistantSession, compactAssistantSession, ensureAssistantSession, fetchAssistantSnapshot, newAssistantSession, readAssistantSnapshot, sendAssistantMessage, updateAssistant, useAssistantCapabilityQuery, useAssistantSnapshotQuery, type AssistantPart, type SessionBinding } from '@/queries/assistantQueries';
import { ascendingIdAfter } from '@/sync/message-id';
import { getSyncMessages } from '@/sync/sync-refs';
import { createPendingUserMessagePresentation, type PendingUserMessagePresentation } from '@/sync/session-ui-store';
import { useSessionMessages, useSessionStatus, useUserMessageHistory } from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { surfaceDraftKey, draftKeyString } from '@/sync/input-draft-types';
import { useInputStore } from '@/sync/input-store';
import { useScopedAgentsQuery, useScopedProvidersQuery } from '@/queries/agentQueries';
import { useAssistantUIStore } from '@/stores/useAssistantUIStore';
import { useUIStore } from '@/stores/useUIStore';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { AssistantConversationSurface } from './AssistantConversationSurface';
import { toast } from 'sonner';
import { revertToMessage as revertSessionToMessage } from '@/sync/session-actions';
import { createAssistantRevertDraftSnapshot } from './assistantRevertDraft';
import { AssistantSelectionCoordinator, AssistantSelectionStaleError, type AssistantSelection, type AssistantSelectionIdentity } from './assistantSelectionCoordinator';
import { commitAssistantSelection } from './assistantSelectionBackend';
import { getAssistantPresentation } from './assistantPresentation';
import { reconcileAdmittedAssistantBinding, rebindPendingAssistantMessage } from './assistantPendingMessages';

const EMPTY_ATTACHMENTS: Record<string, AttachedFile> = {};
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
    />
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
  const attachmentViews = useInputStore((state) => state.draftAttachmentViews[draftID] ?? EMPTY_ATTACHMENTS);
  const attachments = React.useMemo(() => Object.values(attachmentViews), [attachmentViews]);
  const providersQuery = useScopedProvidersQuery(directory || null, { enabled: Boolean(directory) && active });
  const agentsQuery = useScopedAgentsQuery(directory || null, { enabled: Boolean(directory) && active });
  const messages = useSessionMessages(sessionID, directory || undefined);
  const status = useSessionStatus(sessionID, directory || undefined);
  const history = useUserMessageHistory(sessionID);
  const sync = useSync();
  const [pendingMessagesByAssistant, setPendingMessagesByAssistant] = React.useState<Map<string, PendingUserMessagePresentation[]>>(() => new Map());
  const pendingRefreshEpochRef = React.useRef(0);
  const pendingMessages = pendingMessagesByAssistant.get(assistantID) ?? EMPTY_PENDING_MESSAGES;
  const [, setSelectionSaving] = React.useState(false);
  const selectionErrorRef = React.useRef<(error: unknown) => void>(() => {});
  selectionErrorRef.current = () => { toast.error(t('assistants.composer.selectionSaveFailed')); };
  const selectionCoordinatorRef = React.useRef<AssistantSelectionCoordinator | null>(null);
  if (!selectionCoordinatorRef.current) selectionCoordinatorRef.current = new AssistantSelectionCoordinator(setSelectionSaving, (error) => selectionErrorRef.current(error));
  const selectionIdentity = React.useMemo<AssistantSelectionIdentity>(() => ({ assistantID, transportIdentity: transport, runtimeGeneration }), [assistantID, runtimeGeneration, transport]);
  const selectionCoordinator = selectionCoordinatorRef.current;

  React.useEffect(() => { if (!selectedAssistantID && snapshot?.assistants[0]) selectAssistant(snapshot.assistants[0].id); }, [selectAssistant, selectedAssistantID, snapshot?.assistants]);
  React.useEffect(() => { if (snapshotQuery.isSuccess && selectedAssistantID && !assistant) selectAssistant(snapshot?.assistants[0]?.id ?? null); }, [assistant, selectAssistant, selectedAssistantID, snapshot?.assistants, snapshotQuery.isSuccess]);
  React.useEffect(() => { if (active && assistantID && !sessionID) void ensureAssistantSession(assistantID); }, [active, assistantID, sessionID]);
  React.useEffect(() => { pendingRefreshEpochRef.current++; setPendingMessagesByAssistant(new Map()); }, [transport, runtimeGeneration]);
  React.useEffect(() => () => { pendingRefreshEpochRef.current++; }, []);
  React.useEffect(() => { selectionCoordinator.activate(selectionIdentity); }, [selectionCoordinator, selectionIdentity]);
  React.useEffect(() => () => { selectionCoordinator.dispose(); }, [selectionCoordinator]);

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
    // Force only when the binding itself changed (/new, compact) or the user retries a failed load.
    await sync.ensureSessionRenderable(binding.sessionID, {
      directory: binding.directory,
      ...(options?.force ? { force: true } : {}),
    });
  });
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
    const restoration = await revertSessionToMessage(sessionID, messageID, { directory, restorePrimaryInput: false });
    const input = useInputStore.getState();
    const current = input.getDraft(draftKey);
    const restorationDraft = await createAssistantRevertDraftSnapshot(restoration, createUuid);
    const result = await input.commitDraftSnapshot({
      key: draftKey,
      expectedRevision: current?.revision ?? 'absent',
      runtime: input.captureDraftRuntime(),
      snapshot: restorationDraft.snapshot,
      values: restorationDraft.values,
    });
    if (!result.durable) throw new Error(`assistant-revert-draft-${result.status}`);
  });
  // selectionSaving must NOT drive composer busy/disabled. Primary Tab agent
  // cycling never disables the textarea; mapping PATCH-in-flight onto resources.busy
  // made Assistant Tab blur the input (browser drops focus from disabled fields).
  const resources = React.useMemo<ChatInputSurfaceResources>(() => ({
    busy: false,
    attachments,
    addAttachment: async (file) => { await useInputStore.getState().addDraftLocalAttachment(draftKey, file); },
    removeAttachment: (id) => { void useInputStore.getState().removeDraftAttachment(draftKey, id); },
    clearAttachments: () => { for (const attachment of useInputStore.getState().getDraftAttachmentViews(draftKey)) void useInputStore.getState().removeDraftAttachment(draftKey, attachment.id); },
    setAttachments: (nextAttachments) => {
      void (async () => {
        for (const attachment of useInputStore.getState().getDraftAttachmentViews(draftKey)) await useInputStore.getState().removeDraftAttachment(draftKey, attachment.id);
        for (const attachment of nextAttachments) await useInputStore.getState().addDraftLocalAttachment(draftKey, attachment.file, { filename: attachment.filename, source: attachment.source === 'vscode' ? 'vscode' : 'local', vscodePath: attachment.vscodePath, vscodeSource: attachment.vscodeSource === 'selection' ? 'selection' : undefined });
      })();
    },
    pendingInput: null,
    consumePendingInput: () => null,
    pendingPreset: null,
    consumePendingPreset: () => null,
    consumeSyntheticParts: () => {
      const input = useInputStore.getState();
      const views = new Map(input.getDraftAttachmentViews(draftKey).map((attachment) => [attachment.id, attachment]));
      return input.consumeDraftSyntheticParts(draftKey)
        // A handoff receipt must never cross the assistant transport.
        ?.filter((part) => !isMobileShareHandoffMarkerPart(part))
        .map((part) => ({ partID: part.partID, text: part.text, synthetic: part.synthetic, attachments: part.attachments.flatMap((attachment) => views.get(attachment.attachmentID) ?? []) })) ?? null;
    },
    restoreSyntheticParts: (parts) => {
      void (async () => {
        const input = useInputStore.getState();
        const restored = parts.map((part) => ({ partID: part.partID ?? createUuid(), text: part.text, attachments: [], ...(part.synthetic === true ? { synthetic: true } : {}) }));
        input.setDraftSyntheticParts(draftKey, restored);
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
  }), [attachments, draftKey, history]);

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
            void donateNativeAssistantInteraction({ serverInstanceID: capabilityQuery.data.serverInstanceID, assistantID: assistant.id, name: assistant.name, avatarSeed: assistant.id }).catch(() => undefined);
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
        create: async () => { await refreshBinding(await newAssistantSession(assistant.id), { force: true }); },
        compact: async () => { await refreshBinding((await compactAssistantSession(assistant.id, binding)).binding, { force: true }); },
        abort: async () => { await abortAssistantSession(assistant.id, binding); },
      },
      shortcuts: { cycle, new: async () => { await refreshBinding(await newAssistantSession(assistant.id), { force: true }); }, abort: async () => { await abortAssistantSession(assistant.id, binding); }, submit: () => {} },
    };
  }, [active, assistant, capabilityQuery.data?.serverInstanceID, changeSelection, cycle, directory, draftKey, hasMessages, providersQuery.data, providersQuery.isError, providersQuery.isPending, providersQuery.isSuccess, agentsQuery.isError, agentsQuery.isPending, agentsQuery.isSuccess, refreshBinding, rebindPendingMessage, removePendingMessages, resources, runtimeGeneration, selectionCoordinator, selectionIdentity, sessionID, status, transport, variants, visibleAgents]);

  const openCreateSettings = useEvent(() => { requestCreate(); if (mobileActions) { mobileActions.openSettings(); return; } const ui = useUIStore.getState(); ui.setSettingsPage('assistants'); ui.setSettingsDialogOpen(true); });
  const returnToChat = useEvent(() => { useUIStore.getState().setActiveMainTab('chat'); });
  const handleMobileBack = useEvent(() => {
    if (onMobileBack) {
      onMobileBack();
      return;
    }
    returnToChat();
  });
  const renderState = (icon: 'cloud-off' | 'error-warning' | 'ai-agent', title: string, description?: string, action?: React.ReactNode) => <div className="flex h-full min-h-0 flex-col">{isMobileSurface ? <MobileAssistantConversationHeader assistant={assistant} onBack={handleMobileBack} /> : null}<div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center"><Icon name={icon} className="size-6 text-muted-foreground" /><h1 className="mt-4 typography-ui-header font-semibold">{title}</h1>{description ? <p className="mt-2 max-w-md typography-ui text-muted-foreground">{description}</p> : null}{action ? <div className="mt-5">{action}</div> : null}</div></div>;
  if (capabilityQuery.isPending || snapshotQuery.isPending) return renderState('ai-agent', t('assistants.state.unavailable'));
  if (capabilityQuery.isError || !capabilityQuery.data?.supported || !capabilityQuery.data.enabled || !snapshot?.enabled) return renderState('cloud-off', t('assistants.state.unavailable'));
  if (!snapshot.assistants.length) return renderState('ai-agent', t('assistants.onboarding.title'), t('assistants.onboarding.description'), <Button onClick={openCreateSettings}>{t('assistants.onboarding.action')}</Button>);
  if (!assistant) return renderState('ai-agent', t('assistants.state.unavailable'));
  if (!surface) return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {isMobileSurface ? <MobileAssistantConversationHeader assistant={assistant} onBack={handleMobileBack} /> : null}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6" aria-busy="true" aria-label={t('assistants.state.unavailable')}>
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
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => selectAssistant(item.id)}
                    className={cn(
                      'flex w-full min-h-11 items-center gap-3 rounded-xl border px-3 py-3 text-left outline-none transition-[background-color,border-color,transform,opacity] duration-150 ease-out active:scale-[0.995] focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] motion-reduce:transition-none',
                      selected
                        ? 'border-border/50 bg-[var(--surface-elevated)]'
                        : 'border-transparent hover:bg-interactive-hover',
                      !item.enabled && 'opacity-65',
                    )}
                  >
                    <AgentAvatar name={item.id} emoji={itemPresentation.avatarEmoji} size={24} label={itemPresentation.displayName || item.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate typography-ui-label font-medium">{itemPresentation.displayName}</span>
                      <span className="mt-0.5 block truncate typography-micro text-muted-foreground">
                        {item.mode === 'stateless' ? t('assistants.mode.stateless') : t('assistants.mode.continuous')}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      )}
      <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background', !isMobileSurface && 'border-l border-border/60')}>
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
          assistant={assistant}
          sessionID={sessionID}
          warning={warning}
          surface={surface}
          pendingUserMessages={pendingMessages}
          onPendingUserMessagesMaterialized={handlePendingMessagesMaterialized}
        />
      </div>
    </div>
  );
};
