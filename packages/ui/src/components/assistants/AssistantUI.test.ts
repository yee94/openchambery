import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgentModelSelection } from '../chat/mobileControlsUtils';

const directory = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFile(join(directory, path), 'utf8');

describe('Assistant UI product contract', () => {
  test('resolves an Agent-associated model as one controlled selection', () => {
    const current = { providerID: 'provider-a', modelID: 'model-a', agent: 'build' };
    const agents = [{ name: 'build' }, { name: 'review', model: { providerID: 'provider-b', modelID: 'model-b' } }];
    const providers = [{ id: 'provider-a', models: [{ id: 'model-a' }] }, { id: 'provider-b', models: [{ id: 'model-b' }] }];
    expect(resolveAgentModelSelection(current, 'review', agents, providers)).toEqual({ providerID: 'provider-b', modelID: 'model-b', agent: 'review' });
    expect(resolveAgentModelSelection(current, 'missing', agents, providers)).toEqual({ providerID: 'provider-a', modelID: 'model-a', agent: 'missing' });
  });

  test('keeps Assistant in the sidebar while omitting it from the conversation overflow menu', async () => {
    const [sidebar, mobile] = await Promise.all([
      read('../session/SessionSidebar.tsx'),
      read('../../apps/MobileApp.tsx'),
    ]);
    const sidebarMenu = sidebar.slice(sidebar.indexOf('const topContent ='), sidebar.indexOf('const isInlineEditing'));
    expect(sidebarMenu.indexOf('sessions.sidebar.header.actions.newSession')).toBeLessThan(sidebarMenu.indexOf('sessions.sidebar.header.actions.scheduledTasks'));
    expect(sidebarMenu.indexOf('sessions.sidebar.header.actions.scheduledTasks')).toBeLessThan(sidebarMenu.indexOf('t("assistants.title")'));
    // Product entry only appears when the host supports Assistants and the global switch is on.
    expect(sidebarMenu).toContain('assistantCapability.data?.supported && assistantCapability.data?.enabled ? <Button');
    expect(sidebarMenu.slice(0, sidebarMenu.indexOf('sessions.sidebar.header.actions.scheduledTasks'))).not.toContain('assistantCapability.data?.supported && assistantCapability.data?.enabled ? <Button');
    const overflowMenu = mobile.slice(mobile.indexOf('const overflowItems'), mobile.indexOf('return (', mobile.indexOf('const overflowItems')));
    expect(overflowMenu).not.toContain("key: 'assistant'");
  });

  test('routes empty-list onboarding to Assistant creation and focuses the name field', async () => {
    const [view, settings] = await Promise.all([
      read('AssistantView.tsx'),
      read('../sections/assistants/AssistantsSettingsPage.tsx'),
    ]);
    expect(view).toContain('mobileActions.openSettings()');
    expect(view).toContain("ui.setSettingsPage('assistants')");
    expect(view).toContain("t('assistants.onboarding.action')");
    expect(settings).toContain("document.getElementById('assistant-name')?.focus()");
    expect(settings).toContain('createRequestRevision');
  });

  test('uses the standard split settings shell and responsive workspace selector', async () => {
    const [settings, settingsView, metadata, sidebarItem] = await Promise.all([
      read('../sections/assistants/AssistantsSettingsPage.tsx'),
      read('../views/SettingsView.tsx'),
      read('../../lib/settings/metadata.ts'),
      read('../sections/shared/SettingsSidebarItem.tsx'),
    ]);
    expect(settings).toContain('<SettingsSidebarLayout');
    expect(settings).toContain('variant="background"');
    expect(settings).toContain('<SettingsSidebarItem');
    expect(settings).not.toContain('bg-sidebar');
    expect(settingsView).toContain('<AssistantsSettingsSidebar onItemSelect={opts.onItemSelect} />');
    expect(settingsView).toContain('onItemDeleted={isMobile ? handleMobileSplitItemDeleted : undefined}');
    expect(metadata.slice(metadata.indexOf("slug: 'assistants'"), metadata.indexOf("slug: 'behavior'"))).toContain("kind: 'split'");
    expect(settings).toContain('<SettingsToggleRow');
    expect(settings).toContain('itemId="assistants.instance-enabled"');
    expect(settings).toContain('setAssistantsEnabled(enabled, snapshot.revision)');
    expect(settings).not.toContain('settings.page.assistants.title');
    expect(settings).toContain('description={(');
    expect(settings.indexOf('itemId="assistants.instance-enabled"')).toBeLessThan(settings.indexOf('AssistantsSettingsPage'));
    expect(settings).toContain('useProjectsStore((state) => state.projects)');
    expect(settings).toContain("patchDraft('workspacePath', null)");
    expect(settings).toContain("patchDraft('workspacePath', project.path)");
    expect(settings).toContain('value={LEGACY_WORKSPACE_VALUE} disabled');
    expect(settings).toContain('w-[min(32rem,calc(100vw-2rem))]');
    expect(settings).toContain('<SettingsField');
    expect(settings).toContain('descriptionPlacement="outside"');
    expect(settings).toContain('data-settings-item="assistants.create"');
    expect(settings).not.toContain('itemId="assistants.create"');
    expect(settings.indexOf('assistants.settings.description')).toBeLessThan(settings.indexOf('data-settings-item="assistants.create"'));
    expect(settings).toContain('flex min-w-0 items-center gap-2');
    expect(settings).toContain('min-w-0 flex-1 truncate typography-micro text-muted-foreground');
    expect(settings).not.toContain('block truncate typography-micro text-muted-foreground');
    expect(settings).not.toContain('h-auto min-h-10');
    expect(settings).toContain('href="#assistant-share-welcome"');
    expect(settings).toContain('setWelcomeOpen(true)');
    expect(settings.slice(settings.indexOf('const WorkspaceOption'), settings.indexOf('export const AssistantsSettingsSidebar'))).not.toContain('break-all');
    expect(settings.slice(settings.indexOf('const WorkspaceOption'), settings.indexOf('export const AssistantsSettingsSidebar'))).not.toContain('whitespace-normal');
    expect(settings).toContain('if (!onItemSelect && selectedID === null');
    expect(settings).toContain('selectSettingsAssistant(onItemSelect ? null :');
    expect(settings).toContain('interface AssistantsSettingsPageProps');
    expect(settings).toContain('onItemDeleted?: () => void;');
    expect(settings).toContain('selectSettingsAssistant(null);\n      onItemDeleted?.();');
    expect(sidebarItem).toContain('data-mobile-press-feedback="soft"');
    expect(sidebarItem).toContain('flex min-w-0 flex-1 self-stretch items-center');
    expect(sidebarItem).toContain('self-stretch flex-col justify-center');
    expect(sidebarItem).toContain('rounded-sm text-left');
  });

  test('scopes managed Assistant catalogs without consulting the active project', async () => {
    const [view, settings] = await Promise.all([
      read('AssistantView.tsx'),
      read('../sections/assistants/AssistantsSettingsPage.tsx'),
    ]);
    expect(view).not.toContain('useScopedProvidersQuery');
    expect(view).not.toContain('useScopedAgentsQuery');
    expect(view).not.toContain('activeProjectId');
    expect(settings).toContain('draft.workspacePath ?? selected?.managedWorkspacePath ?? null');
    expect(settings).toContain('useScopedProvidersQuery(catalogDirectory, { enabled: true })');
    expect(settings).toContain('useScopedAgentsQuery(catalogDirectory, { enabled: true })');
    expect(settings).toContain('itemId="assistants.mode"');
    expect(settings).toContain("patchDraft('mode', mode)");
    expect(settings).not.toContain('activeProjectId');
  });

  test('removes skill roots from settings, requests, DTOs, search, and locale keys', async () => {
    const [settings, queries, dto, search, english] = await Promise.all([
      read('../sections/assistants/AssistantsSettingsPage.tsx'),
      read('../../queries/assistantQueries.ts'),
      read('../../queries/assistantDTO.ts'),
      read('../../lib/settings/search.ts'),
      read('../../lib/i18n/messages/en.settings.ts'),
    ]);
    for (const source of [settings, queries, dto, search, english]) {
      expect(source).not.toContain('skillRoots');
      expect(source).not.toContain('skillRoot');
      expect(source).not.toContain('skills-roots');
    }
  });

  test('opens an Assistant from the mobile catalog as a second-level conversation', async () => {
    const [view, mobileTab, phoneShell, navigation] = await Promise.all([
      read('AssistantView.tsx'),
      read('../../mobile/assistant/MobileAssistantTab.tsx'),
      read('../../mobile/MobilePhoneShell.tsx'),
      read('../../mobile/useMobileNavigationStore.ts'),
    ]);
    expect(mobileTab).toContain('role="listbox"');
    expect(mobileTab).toContain('onOpen={() => handleOpenAssistant(assistant.id)}');
    expect(mobileTab).toContain('key={assistant.id}');
    expect(mobileTab).toContain('oc-mobile-assistant-card-shell');
    expect(mobileTab).toContain('oc-mobile-assistant-card');
    expect(mobileTab).toContain('oc-mobile-entity-title');
    expect(mobileTab).toContain('oc-mobile-entity-meta');
    expect(phoneShell).toContain("secondaryKind === 'assistant'");
    expect(phoneShell).toContain('<AssistantView');
    expect(phoneShell).toContain('activeOverride');
    expect(phoneShell).toContain('onMobileBack=');
    expect(navigation).toContain("set({ secondary: { kind: 'assistant' } })");
    expect(navigation.indexOf('selectAssistant(assistantID)')).toBeLessThan(navigation.indexOf("set({ secondary: { kind: 'assistant' } })"));
    expect(view).toContain('onMobileBack?: () => void');
    expect(view).toContain('<MobileDetailNavigation');
    expect(view).toContain('overlay');
    expect(view).not.toContain('<MobileOverlayPanel');
    expect(view).not.toContain('mobileSelectorOpen');
  });

  test('fills the mobile Assistant avatar while preserving its circular frame', async () => {
    const [mobileTab, mobileStyles] = await Promise.all([
      read('../../mobile/assistant/MobileAssistantTab.tsx'),
      read('../../styles/mobile.css'),
    ]);
    expect(mobileTab).toContain("'oc-mobile-assistant-avatar'");
    expect(mobileTab).toContain("'oc-mobile-assistant-avatar--emoji'");
    expect(mobileTab).toContain("'oc-mobile-assistant-avatar--visual'");
    expect(mobileTab).toContain('size={avatarEmoji ? 40 : 38}');
    expect(mobileTab).not.toContain('oc-mobile-assistant-avatar oc-mobile-glass-control');
    const avatarStyles = mobileStyles.slice(
      mobileStyles.indexOf('.oc-mobile-assistant-avatar {'),
      mobileStyles.indexOf('.oc-mobile-assistant-content > *'),
    );
    expect(avatarStyles).toContain('border-radius: 999px');
    expect(avatarStyles).toContain(':is(img, svg)');
    expect(avatarStyles).toContain('object-fit: cover');
    expect(avatarStyles).toContain('.oc-mobile-assistant-avatar--emoji');
    expect(avatarStyles).toContain('padding: 0');
    expect(avatarStyles).toContain('width: 100% !important');
    expect(avatarStyles).toContain('height: 100% !important');
    expect(avatarStyles).toContain('font-size: 1.75rem !important');
    expect(avatarStyles).toContain('background: var(--interactive-selection)');
    expect(avatarStyles).toContain('.oc-mobile-assistant-avatar--visual');
    expect(avatarStyles).toContain('padding: 1px');
  });

  test('gives mobile Assistant cards room for mode and bounded prompt details', async () => {
    const [mobileTab, mobileStyles] = await Promise.all([
      read('../../mobile/assistant/MobileAssistantTab.tsx'),
      read('../../styles/mobile.css'),
    ]);
    expect(mobileTab).toContain('oc-mobile-assistant-name');
    expect(mobileTab).toContain('oc-mobile-assistant-card-header');
    expect(mobileTab).toContain('oc-mobile-assistant-mode');
    expect(mobileTab).toContain('oc-mobile-assistant-summary');
    expect(mobileTab).not.toContain('name="arrow-right-s"');
    expect(mobileTab).toContain('{modeLabel}');
    expect(mobileTab).toContain('{summary}');
    const cardStyles = mobileStyles.slice(
      mobileStyles.indexOf('.oc-mobile-assistant-catalog {'),
      mobileStyles.indexOf('.oc-mobile-assistant-content > *'),
    );
    expect(cardStyles).toContain('gap: 0.875rem');
    expect(cardStyles).toContain('min-height: 7rem');
    expect(cardStyles).toContain('align-items: flex-start');
    expect(cardStyles).toContain('padding: 1rem');
    expect(cardStyles).toContain('.oc-mobile-assistant-card-header');
    expect(cardStyles).toContain('-webkit-line-clamp: 3');
  });

  test('separates mobile disabled guidance, empty onboarding, and unavailable states', async () => {
    const [mobileTab, mobileStyles] = await Promise.all([
      read('../../mobile/assistant/MobileAssistantTab.tsx'),
      read('../../styles/mobile.css'),
    ]);
    expect(mobileTab).toContain("assistant-guide/assistant-guide-hero-wide.jpg");
    expect(mobileTab).toContain('oc-mobile-assistant-guide-steps');
    expect(mobileTab).not.toContain("t('assistants.shareWelcome.description')");
    expect(mobileTab).toContain("t('assistants.guide.disabledTitle')");
    expect(mobileTab).toContain("t('assistants.guide.disabledDescription')");
    expect(mobileTab).toContain("t('assistants.guide.enableAction')");
    expect(mobileTab).toContain("t('assistants.guide.shareTitle')");
    expect(mobileTab).toContain('instanceDisabled && !unavailable');
    expect(mobileTab).toContain('snapshot.data.assistants.length === 0');
    expect(mobileTab).toContain('requestCreate();');
    expect(mobileTab).toContain("t('assistants.onboarding.action')");
    const guideStyles = mobileStyles.slice(
      mobileStyles.indexOf('.oc-mobile-assistant-guide {'),
      mobileStyles.indexOf('.oc-mobile-assistant-onboarding {'),
    );
    expect(guideStyles).toContain('aspect-ratio: 16 / 9');
    expect(guideStyles).toContain('object-fit: contain');
    expect(guideStyles).toContain('scroll-snap-type: x mandatory');
    expect(guideStyles).toContain('overflow-x: auto');
    expect(guideStyles).not.toContain('grid-auto-flow: column');
  });

  test('offers edit and delete from assistant list context menu and long-press', async () => {
    const [view, mobileTab, deleteDialog, store, settingsView, english] = await Promise.all([
      read('AssistantView.tsx'),
      read('../../mobile/assistant/MobileAssistantTab.tsx'),
      read('AssistantDeleteConfirmDialog.tsx'),
      read('../../stores/useAssistantUIStore.ts'),
      read('../views/SettingsView.tsx'),
      read('../../lib/i18n/messages/en.settings.ts'),
    ]);
    expect(view).toContain('AssistantListItem');
    expect(view).toContain('openAssistantSettings');
    expect(view).toContain("t('assistants.menu.edit')");
    expect(view).toContain("t('assistants.settings.delete')");
    expect(view).toContain('name="edit"');
    expect(view).toContain('name="delete-bin"');
    expect(view).toContain('ContextMenuSeparator');
    expect(view).toContain('text-[var(--status-error)]');
    expect(view).toContain('AssistantDeleteConfirmDialog');
    expect(view).toContain('ContextMenu');
    expect(mobileTab).toContain('createMobileLongPressController');
    expect(mobileTab).toContain('openAssistantSettings');
    expect(mobileTab).toContain("t('assistants.menu.edit')");
    expect(mobileTab).toContain("t('assistants.settings.delete')");
    expect(mobileTab).toContain('name="edit"');
    expect(mobileTab).toContain('name="delete-bin"');
    expect(mobileTab).toContain('ContextMenuSeparator');
    expect(mobileTab).toContain('text-[var(--status-error)]');
    expect(mobileTab).toContain('AssistantDeleteConfirmDialog');
    expect(mobileTab).toContain('openFromContextMenu');
    expect(deleteDialog).toContain('deleteAssistantEntry');
    expect(deleteDialog).toContain('assistants.settings.deleteConfirm');
    expect(deleteDialog).toContain('variant="destructive"');
    expect(store).toContain('requestOpenSettings');
    expect(store).toContain('openSettingsRequestRevision');
    expect(store).toContain('export const openAssistantSettings');
    expect(settingsView).toContain('openSettingsRequestRevision');
    expect(settingsView).toContain('setMobileStage("page-content")');
    expect(english).toContain("'assistants.menu.edit': 'Edit'");
    expect(english).not.toContain('assistants.menu.configure');
  });

  test('hosts a contact transcript with session cards and peer DMs, not ChatContainer', async () => {
    const [view, conversation, card, chatContainer, chatInput, promptComposer, host, english] = await Promise.all([
      read('AssistantView.tsx'),
      read('AssistantConversationSurface.tsx'),
      read('AssistantSessionCard.tsx'),
      read('../chat/ChatContainer.tsx'),
      read('../chat/ChatInput.tsx'),
      read('../chat/ChatPromptComposer.tsx'),
      read('../chat/chatContainerHost.ts'),
      read('../../lib/i18n/messages/en.settings.ts'),
    ]);
    expect(view).not.toContain('SimpleMarkdownRenderer');
    expect(view).not.toContain('assistants.topics');
    expect(view).toContain('<AssistantConversationSurface');
    expect(view).not.toContain('ensureAssistantSession');
    expect(conversation).not.toContain('<ChatContainer');
    expect(conversation).not.toContain('<MessageList');
    expect(conversation).not.toContain('<QuestionCard');
    expect(conversation).not.toContain('<PermissionCard');
    expect(conversation).not.toContain('<StatusRowContainer');
    expect(conversation).not.toContain('<TimelineDialog');
    expect(conversation).not.toContain('<ChatInput');
    expect(conversation).toContain('<AssistantSessionCard');
    expect(conversation).not.toContain('<Activity');
    expect(conversation).not.toContain('thinkingLevel');
    expect(conversation).toContain("data-assistant-contact-role={message.role}");
    expect(conversation).toContain("message.role === 'peer'");
    expect(conversation).toContain('deliverAssistantContactDm');
    expect(conversation).toContain('assistants.contact.composerHint');
    expect(english).toContain('/card <sessionID> [title]');
    expect(english).toContain('/dm <assistantID> <text>');
    expect(english).not.toContain('/card Optional title');
    expect(english).not.toContain('/dm hello');
    expect(conversation).not.toContain('EventSource');
    expect(conversation).not.toContain('text/event-stream');
    expect(conversation).not.toContain('stream: true');
    expect(conversation).not.toContain('activeStreamingMessageId');
    expect(card).toContain('openSessionWithFeedback');
    expect(card).toContain('phoneShell: isPhoneShell');
    expect(card).toContain('card.sessionID');
    expect(host).toContain('export type ChatContainerHost');
    expect(host).toContain('composerSurface: ChatInputSurface');
    expect(chatContainer).toContain('if (props.host)');
    expect(chatContainer).toContain('HostedChatContainer');
    expect(chatContainer).toContain('<ChatInput');
    expect(chatContainer).toContain('surface={composerSurface}');
    expect(chatContainer).toContain('resolveSessionIdentityPending');
    expect(chatContainer).toContain("composerSurfaceKind: composerSurface?.kind");
    expect(chatContainer).toContain('<MessageList');
    expect(chatContainer).toContain('<QuestionCard');
    expect(chatContainer).toContain('<PermissionCard');
    expect(chatContainer).toContain('<StatusRowContainer');
    expect(chatContainer).toContain('<TimelineDialog');
    expect(chatContainer).toContain('onRevertMessage={onRevertMessage}');
    expect(chatContainer).toContain('hostFeatures.newSessionDraft');
    expect(chatContainer).toContain('hostFeatures.promptNavigator');
    expect(chatContainer).toContain('hostFeatures.returnToParent');
    expect(/<ChatPromptComposer[\s\S]+value=\{message\}/.test(chatInput)).toBe(true);
    expect(chatInput).not.toContain('standardContent');
    expect(promptComposer).not.toContain('standardContent');
    expect(chatInput).not.toContain('<ChatPromptTextarea');
    expect(chatInput).not.toContain('<ChatPromptFooter');
    expect(chatInput).toContain('inputHeader={composerInputHeader}');
    expect(chatInput).toContain('attachmentContent={composerAttachmentContent}');
    expect(chatInput).toContain('footerContent={composerFooterContent}');
    expect(chatInput).not.toContain('<Textarea');
    expect(promptComposer).toContain('<Textarea');
    expect(promptComposer).toContain('type="file"');
    expect(promptComposer).toContain('data-chat-input-footer="true"');
    expect(promptComposer).toContain('onRemoveAttachment');
    expect(chatInput).toContain('<MemoModelControls');
    expect(chatInput.indexOf('const painted = await beginDraftEstablishingPaint({')).toBeLessThan(chatInput.indexOf('await fetchResponseStyleInstruction()'));
    expect(chatInput.indexOf('const painted = await beginDraftEstablishingPaint({')).toBeLessThan(chatInput.indexOf('primaryText = await expandText(primaryText)'));
    // Establishing is claimed with the flight, before the paint await, so a
    // second send during create stages a follow-up chip instead of a session.
    expect(chatInput.indexOf('.beginEstablishing({')).toBeLessThan(chatInput.indexOf('const painted = await beginDraftEstablishingPaint({'));
    // Optimistic ticket owns the message ID when present; the draft send falls back to its pinned ID.
    expect(chatInput).toContain('? { messageID: optimisticTicket.messageID, ticket: optimisticTicket }');
    expect(chatInput).toContain('? { messageID: draftMessageID }');
  });

  test('loads the OpenChamber contact transcript instead of OpenCode session history', async () => {
    const [conversation, queries] = await Promise.all([
      read('AssistantConversationSurface.tsx'),
      read('../../queries/assistantQueries.ts'),
    ]);
    expect(conversation).toContain('useAssistantContactMessagesQuery');
    expect(conversation).toContain('sendAssistantContactMessage');
    expect(conversation).toContain('appendAssistantContactCard');
    expect(conversation).toContain('parseContactComposerInput');
    expect(queries).toContain('/contact/messages');
    expect(queries).toContain('/contact/cards');
    expect(queries).toContain('/contact/dm');
  });

  test('keeps Settings selection backend and contact send routes separate from OpenCode promptAsync', async () => {
    const [view, conversation, backend, queries] = await Promise.all([
      read('AssistantView.tsx'),
      read('AssistantConversationSurface.tsx'),
      read('assistantSelectionBackend.ts'),
      read('../../queries/assistantQueries.ts'),
    ]);
    expect(backend).toContain('dependencies.assertAuthoritative();');
    expect(backend).toContain('await dependencies.ensureSnapshot(dependencies.signal)');
    expect(backend).toContain('await dependencies.updateAssistant(latest');
    expect(backend).toContain('enabled: current.enabled');
    expect(backend).toContain('workspacePath: current.workspacePath');
    expect(backend).toContain("new AssistantAPIError('revision_conflict', 409)");
    expect(backend).toContain('dependencies.readSnapshot()?.assistants.find');
    expect(view).not.toContain('ensureAssistantSession');
    expect(view).not.toContain('fetchMessagesForSession');
    expect(conversation).toContain('sendAssistantContactMessage');
    expect(conversation).not.toContain('promptAsync');
    expect(queries).toContain('applyAssistant(result, transport)');
    expect(queries.indexOf('applyAssistant(result, transport)')).toBeLessThan(queries.indexOf('return result; }', queries.indexOf('export const updateAssistant')));
  });

  test('keeps assistant delivery on the contact transcript and session-card click-through', async () => {
    const [view, conversation, card] = await Promise.all([
      read('AssistantView.tsx'),
      read('AssistantConversationSurface.tsx'),
      read('AssistantSessionCard.tsx'),
    ]);
    expect(conversation).toContain('sendAssistantContactMessage');
    expect(conversation).toContain('appendAssistantContactCard');
    expect(conversation).toContain('<AssistantSessionCard');
    expect(card).toContain('openSessionWithFeedback');
    expect(card).toContain('useMobileAppActions');
    expect(view).not.toContain('<ContextPanel');
  });

  test('keeps nested subagent navigation on archived assistant history rows', async () => {
    const messageList = await read('../chat/MessageList.tsx');
    const historySurface = messageList.slice(
      messageList.indexOf('const messageSurface = message.sourceSessionID'),
      messageList.indexOf('const chatMessage = ('),
    );
    expect(historySurface).toContain('compose: false');
    expect(historySurface).not.toContain('navigateNestedSession: false');
  });

  test('opens session cards through the existing session route on phone and desktop', async () => {
    const card = await read('AssistantSessionCard.tsx');
    expect(card).toContain('openSessionWithFeedback');
    expect(card).toContain('useMobileAppActions');
    expect(card).toContain('const isPhoneShell = Boolean(mobileActions && !isIPadApp())');
    expect(card).toContain('phoneShell: isPhoneShell');
    expect(card).toContain('switchToChat: true');
    expect(card).toContain('findSessionById');
    expect(card).toContain('useGlobalSessionStatus');
  });

  test('keeps primary-chat source-session and edit callbacks on ChatContainer, not the contact transcript', async () => {
    const [conversation, sessionSurface, messageBody, chatMessage] = await Promise.all([
      read('AssistantConversationSurface.tsx'),
      read('../chat/SessionSurfaceContext.tsx'),
      read('../chat/message/MessageBody.tsx'),
      read('../chat/ChatMessage.tsx'),
    ]);
    expect(conversation).not.toContain('openSourceSession');
    expect(conversation).not.toContain('onEditMessage');
    expect(sessionSurface).toContain('openSourceSession?: (sessionId: string, directory: string) => void');
    expect(sessionSurface).toContain('onEditMessage?: (messageId: string, snapshot: SessionSurfaceMessageEditSnapshot) => Promise<void>');
    expect(messageBody).toContain("t('chat.messageBody.actions.openSourceSession')");
    expect(chatMessage).toContain('sessionSurface.onEditMessage');
  });

  test('keeps compiled Assistant queue delivery and timeline reads scoped to the Assistant binding', async () => {
    const [chatInput, conversation, chatContainer, chatMessage, timeline, queueServer] = await Promise.all([
      read('../chat/ChatInput.tsx'),
      read('AssistantConversationSurface.tsx'),
      read('../chat/ChatContainer.tsx'),
      read('../chat/ChatMessage.tsx'),
      read('../chat/TimelineDialog.tsx'),
      read('../../lib/message-queue-server.ts'),
    ]);
    expect(chatInput).toContain('const assistantDeliveryParts = scope.deliveryTarget.kind === \'assistant\'');
    expect(chatInput).toContain('compileChatComposerDelivery({');
    expect(chatInput).toContain('buildComposerSemanticParts(compiled.semantics, scope.directory)');
    expect(chatInput).toContain('syntheticParts: assistantSyntheticParts');
    expect(chatInput).toContain('deliveryParts: assistantDeliveryParts');
    expect(chatInput).toContain('? surface.selection.value.agent');
    expect(chatInput).toContain('resolveComposerVisibleAgents(surface.selection.catalog?.agents)');
    expect(chatInput).not.toContain("surface.kind === 'primary' ? state.agents : EMPTY_AGENTS");
    expect(chatInput).toContain('const sessionIsRunning = sessionPhase === \'busy\' || sessionPhase === \'retry\'');
    expect(chatInput).toContain('(sessionIsRunning || autoReviewRunning)');
    expect(queueServer).toContain("deliveryTarget.kind === 'assistant' && !deliveryParts");
    expect(conversation).toContain('assistant.effectiveWorkspacePath');
    expect(conversation).not.toContain('flattenAssistantHistoryPages');
    expect(conversation).not.toContain('onRevertMessage');
    expect(chatContainer).toContain('sessionID={currentSessionId ?? undefined}');
    expect(chatContainer).toContain('directory={effectiveSessionDirectory}');
    expect(chatContainer).toContain('onRevertMessage={onRevertMessage}');
    expect(chatMessage).toContain('sessionSurface.onRevertMessage');
    expect(chatMessage).toContain('directory: sessionSurface.directory ?? undefined');
    expect(timeline).toContain('sessionID?: string;');
    expect(timeline).toContain('useSessionMessageRecords(currentSessionId ?? \'\', directory)');
    expect(timeline).toContain('if (onRevertMessage) await onRevertMessage(messageId)');
    expect(timeline).toContain('revertToMessage(currentSessionId, messageId, { directory })');
    expect(timeline).toContain('getTimelineActionAvailability(sessionSurface.capabilities)');
  });

  test('uses standard chat columns and semantic theme states', async () => {
    const [view, conversation] = await Promise.all([
      read('AssistantView.tsx'),
      read('AssistantConversationSurface.tsx'),
    ]);
    expect(conversation).not.toContain('<ChatContainer');
    expect(conversation).not.toContain('chat-content-max-width');
    expect(conversation).not.toContain('inputClassName=');
    expect(view).toContain('bg-[var(--surface-elevated)]');
    expect(view).toContain('border-border/50');
    expect(view).toContain('border-l border-border/60');
    expect(view).toContain('focus-visible:ring-[var(--interactive-focus-ring)]');
    expect(view).toContain('border-border');
    expect(view).not.toContain('bg-sidebar');
    expect(view).not.toContain('w-56');
    expect(/\b(?:bg|text|border)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/.test(`${view}\n${conversation}`)).toBe(false);
    expect(/#[\da-fA-F]{3,8}\b/.test(`${view}\n${conversation}`)).toBe(false);
  });

  test('keeps Assistant mobile chrome in the shared safe-area header', async () => {
    const [view, mobileApp, header, detailNavigation, mobileStyles] = await Promise.all([
      read('AssistantView.tsx'),
      read('../../apps/MobileApp.tsx'),
      read('../ui/MobileSurfaceHeader.tsx'),
      read('../../mobile/MobileDetailNavigation.tsx'),
      read('../../styles/mobile.css'),
    ]);
    expect(view).toContain('<MobileDetailNavigation');
    expect(mobileApp).toContain('<MobileSurfaceHeader>');
    expect(header).toContain("paddingTop: 'var(--oc-safe-area-top, 0px)'");
    expect(header).toContain('h-[var(--oc-header-height,56px)]');
    expect(detailNavigation).toContain('var(--oc-safe-area-top');
    expect(detailNavigation).toContain("grid-cols-[2.75rem_minmax(0,1fr)_2.75rem]");
    expect(detailNavigation).toContain("grid-cols-[2.75rem_minmax(0,1fr)_auto]");
    expect(detailNavigation).toContain('trailing?: ReactNode');
    expect(mobileStyles).toContain('var(--oc-mobile-detail-action-edge-inset, 1rem)');
    expect(mobileStyles).toContain('var(--oc-safe-area-top, 0px) +');
    expect(mobileStyles).toContain('calc(var(--oc-safe-area-top, 0px) + 35%)');
    expect(view).toContain('overlay');
    expect(mobileStyles).toContain('--oc-mobile-header-fade');
    expect(mobileStyles).toContain('var(--surface-background) 85%');
    expect(mobileStyles.match(/var\(--oc-mobile-header-fade\)/g)?.length).toBeGreaterThanOrEqual(4);
  });

  test('shows the native share welcome once when a supported Assistant is opened', async () => {
    const [mobileApp, welcome, settings] = await Promise.all([
      read('../../apps/MobileApp.tsx'),
      read('AssistantShareWelcome.tsx'),
      read('../sections/assistants/AssistantsSettingsPage.tsx'),
    ]);
    expect(mobileApp).toContain('<AssistantShareWelcome');
    expect(mobileApp).toContain('showCapacitorOnlyFeatures');
    expect(mobileApp).toContain("activeMainTab === 'assistant'");
    expect(mobileApp).toContain('assistantCapability.data?.supported === true');
    expect(welcome).toContain('useLocalStorage(ASSISTANT_SHARE_WELCOME_STORAGE_KEY, false)');
    expect(welcome).toContain('controlled ? open : enabled && dismissed !== true');
    expect(welcome).toContain('ios-share-sheet.jpg');
    expect(welcome).toContain('android-direct-share.jpg');
    expect(welcome).toContain('select-assistant.jpg');
    expect(welcome).toContain('lg:grid-cols-3');
    expect(welcome).toContain('object-bottom');
    expect(welcome).toContain('lg:w-[min(calc(100%-4rem),74rem)]');
    expect(welcome).toContain("t('assistants.shareWelcome.action')");
    expect(settings).toContain('<AssistantShareWelcome open={welcomeOpen} onOpenChange={setWelcomeOpen} />');
    expect(settings).toContain("t('assistants.settings.descriptionLearnMore')");
    expect(settings).toContain('setWelcomeOpen(true)');
  });

  test('keeps primary Chat activity on ChatContainer while Assistant uses the contact transcript', async () => {
    const [view, conversation, chatContainer, statusRow] = await Promise.all([
      read('AssistantView.tsx'),
      read('AssistantConversationSurface.tsx'),
      read('../chat/ChatContainer.tsx'),
      read('../chat/StatusRowContainer.tsx'),
    ]);
    expect(view).not.toContain('ensureAssistantSession');
    expect(conversation).not.toContain('<ChatContainer');
    expect(conversation).toContain('useAssistantContactMessagesQuery');
    expect(chatContainer).toContain('activeStreamingMessageId={streamingMessageId}');
    expect(chatContainer).toContain('activeStreamingPhase={activeStreamingPhase}');
    expect(chatContainer).toContain('<StatusRowContainer');
    expect(statusRow).toContain('useAssistantStatus(currentSessionId, currentSessionDirectory)');
    expect(statusRow).toContain('isTurnSettled={working.isTurnSettled}');
    expect(statusRow).toContain('surface.sessionId ?? primarySessionId');
  });

  test('returns from Assistant on Android back', async () => {
    const mobile = await read('../../apps/MobileApp.tsx');
    const backHandler = mobile.slice(mobile.indexOf('const handleNativeBack'), mobile.indexOf('useNativeAndroidBackButton(handleNativeBack)'));
    expect(backHandler).toContain("activeMainTab === 'assistant'");
    expect(backHandler).toContain("setActiveMainTab('chat')");
    expect(backHandler).toContain('return true');
  });

  test('shows retry for an empty stale snapshot and truncates long assistant names in conversation chrome', async () => {
    const view = await read('AssistantView.tsx');
    expect(view).toContain("snapshotQuery.isError ? t('assistants.state.staleSnapshot')");
    expect(view).toContain('truncate typography-ui-label font-medium');
    expect(view).toContain("assistants.conversation.contactHint");
    expect(view).toContain('typography-micro leading-none text-muted-foreground/70');
    expect(view).toContain('presentation.displayName || assistant.name');
  });

  test('persists contact history, session cards, and peer DMs outside ChatContainer', async () => {
    const [surface, host, chat] = await Promise.all([
      read('AssistantConversationSurface.tsx'),
      read('../chat/chatContainerHost.ts'),
      read('../chat/ChatContainer.tsx'),
    ]);
    expect(surface).toContain('useAssistantContactMessagesQuery');
    expect(surface).toContain('<AssistantSessionCard');
    expect(surface).toContain("message.role === 'peer'");
    expect(surface).not.toContain('useAssistantHistoryInfiniteQuery');
    expect(host).toContain('assistantHistory?: {');
    expect(chat).toContain('stitchHostedSessionHistory');
  });

  test('scopes historical message actions to their source workspace', async () => {
    const [surface, list, history] = await Promise.all([
      read('AssistantConversationSurface.tsx'),
      read('../chat/MessageList.tsx'),
      read('../chat/hostedSessionHistory.ts'),
    ]);
    expect(history).toContain('sourceSessionID: entry.sessionID');
    expect(history).toContain('sourceDirectory: entry.directory');
    expect(list).toContain('message.sourceSessionID');
    expect(list).toContain('directory: message.sourceDirectory');
    expect(list).toContain('mutateSession: false');
    expect(list).toContain('forkSession: false');
    expect(list).toContain('SessionSurfaceContext.Provider');
    expect(surface).toContain('<AssistantSessionCard');
    expect(surface).not.toContain('historyDirectories.get(targetSessionID)');
  });

  test('filters Assistant agent catalogs through the shared composer visibility helper', async () => {
    const [view, catalog, chatInput, shortcuts] = await Promise.all([
      read('AssistantView.tsx'),
      read('../chat/chatComposerCatalog.ts'),
      read('../chat/ChatInput.tsx'),
      read('../../hooks/useKeyboardShortcuts.ts'),
    ]);
    expect(catalog).toContain('export const resolveComposerVisibleAgents');
    expect(catalog).toContain('filterVisibleAgents');
    expect(view).not.toContain('resolveComposerVisibleAgents');
    expect(chatInput).toContain("import { resolveComposerVisibleAgents } from './chatComposerCatalog'");
    expect(chatInput).toContain('setActiveChatInputSurface(surface)');
    expect(shortcuts).toContain('isChatComposerMainTab(activeMainTab)');
    expect(shortcuts).toContain('getActiveChatInputSurface()');
    expect(shortcuts).toContain("void wiring.shortcut('cycle'");
  });


  test('keeps Assistant composer focusable while selection PATCH is in flight', async () => {
    const [view, surface] = await Promise.all([
      read('AssistantView.tsx'),
      read('../chat/chatInputSurface.ts'),
    ]);
    expect(view).not.toContain('busy: selectionSaving');
    expect(view).not.toContain('kind: \'secondary\'');
    expect(surface).toContain('resolveChatInputDraftBusy');
    expect(surface).toContain("surface.kind === 'secondary' ? surface.resources?.busy ?? false : primaryDraftBusy");
  });

});
