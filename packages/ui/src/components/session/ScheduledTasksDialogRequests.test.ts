import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('ScheduledTasksDialog queries', () => {
  test('keeps one global query and one scheduled-task business UI', async () => {
    const content = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'ScheduledTasksDialog.tsx'), 'utf8');
    expect(content).toContain("const globalScheduledTasksQueryKey = queryKeys.scoped('scheduled-tasks')");
    expect(content).toContain('queryKey: globalScheduledTasksQueryKey');
    expect(content).toContain('queryFn: fetchGlobalScheduledTasks');
    expect(content.match(/useQuery\(\{/g)).toHaveLength(1);
    expect(content.match(/export function ScheduledTasksWorkspace/g)).toHaveLength(1);
    expect(content).toContain('useMutation({');
    expect(content).toContain('tasksQuery.error ? (');
  });

  test('uses the global endpoint and preserves unrelated project records after project mutations', async () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const [content, apiContent] = await Promise.all([
      readFile(join(directory, 'ScheduledTasksDialog.tsx'), 'utf8'),
      readFile(join(directory, '../../lib/scheduledTasksApi.ts'), 'utf8'),
    ]);
    expect(apiContent).toContain("runtimeFetch('/api/openchamber/scheduled-tasks')");
    expect(apiContent).toContain('export type GlobalScheduledTasksResponse');
    expect(content).toContain('const replaceProjectTasks =');
    expect(content).toContain('current?.tasks.filter((entry) => entry.projectId !== projectId)');
    expect(content).toContain('item.projectId === projectID && item.task.id === task.id');
  });

  test('uses the workspace inside the mobile overlay without project list filtering', async () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const [content, editorContent] = await Promise.all([
      readFile(join(directory, 'ScheduledTasksDialog.tsx'), 'utf8'),
      readFile(join(directory, 'ScheduledTaskEditorDialog.tsx'), 'utf8'),
    ]);
    expect(content).toContain('<MobileOverlayPanel');
    expect(content).toContain('<ScheduledTasksWorkspace presentation="mobile-panel" open={open} onOpenChange={setOpen} />');
    expect(content).toContain('containedBody');
    expect(content).not.toContain('fetchScheduledTasks(');
    expect(content).not.toContain('selectedProjectID');
    expect(content).not.toContain('projectSelector');
    expect(editorContent).toContain('{projectOptions.length > 0 ? (');
    expect(editorContent).toContain('disabled={!onProjectChange}');
  });

  test('uses composite identities, shows partial failures, and refreshes every task-run event', async () => {
    const content = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'ScheduledTasksDialog.tsx'), 'utf8');
    expect(content).toContain('const taskIdentityKey = ({ projectId, taskId }: TaskIdentity)');
    expect(content).toContain('key={identityKey}');
    expect(content).toContain('projectId: projectID, task');
    expect(content).toContain("event.type !== 'scheduled-task-ran'");
    expect(content).toContain("t('sessions.scheduledTasks.workspace.partialLoadWarning')");
    expect(content).toContain('setSelectedTaskIdentity({ projectId: projectID, taskId: nextSelectedTask.id })');
  });

  test('shares short enabled-state action labels between task dropdown and context menus', async () => {
    const content = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'ScheduledTasksDialog.tsx'), 'utf8');
    expect(content).toContain('const renderMenuItems = (Item: React.ElementType) =>');
    expect(content).toContain('void handleToggleTask(entry, !task.enabled)');
    expect(content).toContain("task.enabled ? 'pause' : 'play'");
    expect(content).toContain("t('sessions.scheduledTasks.dialog.actions.pause')");
    expect(content).toContain("t('sessions.scheduledTasks.dialog.actions.resume')");
    expect(content).toContain('{renderMenuItems(DropdownMenuItem)}');
    expect(content).toContain('{renderMenuItems(ContextMenuItem)}');
  });

  test('keeps the selected task editor open when deleting a different composite task identity', async () => {
    const content = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'ScheduledTasksDialog.tsx'), 'utf8');
    expect(content).toContain('const deletedTaskIdentity = taskIdentityKey({ projectId, taskId: task.id });');
    expect(content).toContain('taskIdentityKey(selectedTaskIdentity) === deletedTaskIdentity');
    expect(content).toContain('const handleDeleteTask = useEvent(async (entry: GlobalScheduledTask) =>');
  });

  test('keeps workspace controls and rows on shared axes with reduced-motion-aware transitions', async () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const [workspaceContent, editorContent] = await Promise.all([
      readFile(join(directory, 'ScheduledTasksDialog.tsx'), 'utf8'),
      readFile(join(directory, 'ScheduledTaskEditorDialog.tsx'), 'utf8'),
    ]);
    expect(workspaceContent.match(/max-w-\[26rem\]/g)?.length).toBeGreaterThanOrEqual(2);
    expect(workspaceContent).toContain('layoutId="scheduled-task-filter-pill"');
    expect(workspaceContent).toContain("isMobileTab && 'oc-mobile-floating-surface oc-mobile-scheduled-controls'");
    expect(workspaceContent).toContain("!isMobileTab ? (");
    expect(workspaceContent).toContain('oc-mobile-project-trigger oc-mobile-scheduled-task-row');
    expect(workspaceContent).toContain("formatSchedule(task, t, !isMobileTab)");
    expect(workspaceContent).toContain('<AnimatePresence initial={false} mode="popLayout">');
    expect(workspaceContent).toContain('key="empty"');
    expect(workspaceContent).toContain('key="tasks"');
    expect(workspaceContent).toContain('exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}');
    expect(workspaceContent).toContain("isMobilePanel ? 'h-11 min-h-11' : '!h-9 !min-h-9'");
    expect(workspaceContent).toContain("initial={reduceMotion ? { opacity: 1, width: 0 } : { opacity: 0, width: 0, x: 24 }}");
    expect(workspaceContent).toContain('motion-reduce:transition-none');
    expect(editorContent).toContain('motion-reduce:animate-none');
    expect(editorContent).toContain('groupedCardClassName');
    expect(editorContent).toContain('const mobileGroupedPanel = mobilePanel || mobileTab;');
    expect(editorContent).toContain('const groupedPanel = desktopPanel || mobileGroupedPanel;');
    expect(editorContent).toContain('MOBILE_PANEL_ROW_CLASS');
    expect(editorContent).toContain('MOBILE_PANEL_CONTROL_CLASS');
    expect(workspaceContent).toContain("isMobileTab ? 'pb-0 pt-0'");
    expect(workspaceContent).toContain("? 'overscroll-none pb-[max(1rem,env(safe-area-inset-bottom))] pt-5'");
    expect(editorContent).toContain('overflow-y-auto overflow-x-hidden px-[var(--oc-mobile-page-inline-inset)] pb-[calc(var(--oc-mobile-dock-height)+2.5rem');
    expect(editorContent).not.toContain('<div className="px-3 pb-5 pt-4">');
  });

  test('keeps scheduled tasks in their dedicated surfaces and out of the conversation overflow menu', async () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const [content, phoneShellContent] = await Promise.all([
      readFile(join(directory, '../../apps/MobileApp.tsx'), 'utf8'),
      readFile(join(directory, '../../mobile/MobilePhoneShell.tsx'), 'utf8'),
    ]);
    const overflowMenu = content.slice(content.indexOf('const overflowItems'), content.indexOf('return (', content.indexOf('const overflowItems')));
    expect(overflowMenu).not.toContain("key: 'scheduled'");
    expect(content).toContain('|| scheduledTasksDialogOpen');
    expect(content).toContain('if (scheduledTasksDialogOpen) {');
    expect(content).toContain("window.dispatchEvent(new Event('oc:scheduled-tasks-close-request'));");
    expect(content).toContain('<ScheduledTasksDialog />');
    // The phone tab hosts the workspace as a root page.
    expect(phoneShellContent).toContain('scheduled: <MobileScheduledTab');
    expect(content).toContain('<ScheduledTasksWorkspace');
    expect(content).toContain('presentation="mobile-tab"');
  });

  test('keeps the mobile editor contained and routes close requests through its draft guard', async () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const [workspaceContent, overlayContent, mobileAppContent, phoneShellContent] = await Promise.all([
      readFile(join(directory, 'ScheduledTasksDialog.tsx'), 'utf8'),
      readFile(join(directory, '../ui/MobileOverlayPanel.tsx'), 'utf8'),
      readFile(join(directory, '../../apps/MobileApp.tsx'), 'utf8'),
      readFile(join(directory, '../../mobile/MobilePhoneShell.tsx'), 'utf8'),
    ]);
    expect(workspaceContent).toContain("presentation?: 'workspace' | 'mobile-panel' | 'mobile-tab'");
    expect(workspaceContent).toContain("presentation={isMobileTab ? 'mobile-tab' : isMobilePanel ? 'mobile-panel' : undefined}");
    expect(workspaceContent).toContain('if (editorMode !== \'closed\')');
    expect(workspaceContent).toContain('handleCancelEditor(false)');
    // Global close event is exclusive to mobile-panel (dialog); tab uses registerEditorBackHandler.
    expect(workspaceContent).toContain("if (presentation !== 'mobile-panel' || !open) return");
    expect(workspaceContent).toContain("window.addEventListener('oc:scheduled-tasks-close-request', handleCloseRequest)");
    expect(workspaceContent).toContain('registerEditorBackHandler?: (handler: (() => boolean) | null) => void');
    expect(workspaceContent).toContain("onEditorActiveChange?.(editorMode !== 'closed')");
    expect(workspaceContent).toContain('underlayRef: mobileNavigationUnderlayRef');
    expect(workspaceContent).toContain("'fixed inset-0 z-50 flex h-[100dvh]");
    expect(workspaceContent).toContain('gap-[var(--oc-mobile-page-gap)]');
    expect(workspaceContent).toContain("isMobileTab ? 'pb-0 pt-0'");
    expect(workspaceContent).toContain("isMobilePanel && !isMobileTab && editorMode !== 'closed' ? 'hidden' : 'flex'");
    expect(workspaceContent).not.toContain('mobileTaskGroupStarts');
    expect(mobileAppContent).toContain('onEditorActiveChange={onEditorActiveChange}');
    expect(phoneShellContent).toContain('<MobileScheduledTab showHeader={false}>');
    expect(overlayContent).toContain('containedBody?: boolean');
    expect(overlayContent).toContain("'flex min-h-0 flex-1 flex-col overflow-hidden'");
    expect(overlayContent).toContain('openOverlayStack[openOverlayStack.length - 1] === overlayID');
    expect(mobileAppContent).toContain("window.dispatchEvent(new Event('oc:scheduled-tasks-close-request'));");
  });

  test('keeps the scheduled root and dock mounted behind its pinned editor footer', async () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const [editorContent, phoneShellContent, tabRootContent, scheduledTabContent, mobileSurfaceContent, mobileTabBarContent] = await Promise.all([
      readFile(join(directory, 'ScheduledTaskEditorDialog.tsx'), 'utf8'),
      readFile(join(directory, '../../mobile/MobilePhoneShell.tsx'), 'utf8'),
      readFile(join(directory, '../../mobile/MobileTabsRoot.tsx'), 'utf8'),
      readFile(join(directory, '../../mobile/scheduled/MobileScheduledTab.tsx'), 'utf8'),
      readFile(join(directory, '../../mobile/MobileSurface.tsx'), 'utf8'),
      readFile(join(directory, '../../mobile/MobileTabBar.tsx'), 'utf8'),
    ]);
    expect(phoneShellContent).toContain('tabBarCovered={scheduledEditorActive}');
    expect(tabRootContent).toContain('showTabBar?: boolean;');
    expect(tabRootContent).toContain('data-mobile-navigation-dock-underlay="true"');
    expect(tabRootContent).toContain('inert={secondaryPage || tabBarCovered ? true : undefined}');
    expect(tabRootContent).toContain('<MobileTabBar activeTab={selectedTab}');
    expect(tabRootContent).not.toContain(') : showTabBar ? (');
    expect(tabRootContent).toContain('data-mobile-navigation-underlay="true"');
    expect(tabRootContent).not.toContain("secondaryPage && 'opacity-0'");
    expect(scheduledTabContent).toContain('scrollsWithPage');
    expect(scheduledTabContent).not.toContain('scrollsWithPage={showHeader}');
    const mobileTabEditorContent = editorContent
      .split("if (presentation === 'mobile-tab')")[1]
      ?.split('if (isMobile)')[0] ?? '';
    expect(mobileTabEditorContent).toContain('<MobileDetailNavigation\n          sticky');
    expect(mobileTabEditorContent).toContain('<section className="flex h-full min-h-0 flex-col bg-background"');
    expect(mobileTabEditorContent).toContain('min-h-0 flex-1 overflow-y-auto overflow-x-hidden');
    expect(mobileTabEditorContent).toContain('data-scheduled-editor-footer=""');
    expect(mobileTabEditorContent).toContain('<MobileFloatingBottomBar\n          as="footer"');
    expect(mobileTabEditorContent).toContain('className="z-[60]"');
    expect(mobileTabEditorContent).toContain('pb-[calc(var(--oc-mobile-dock-height)+2.5rem');
    expect(mobileTabEditorContent).not.toContain('<ScrollShadow');
    expect(mobileSurfaceContent).toContain("variant?: 'navigation' | 'actions'");
    expect(mobileSurfaceContent).toContain("'oc-mobile-floating-bottom-bar'");
    expect(mobileTabBarContent).toContain('<MobileFloatingBottomBar');
    expect(mobileTabBarContent).toContain('variant="navigation"');
  });

  test('uses the shared model picker for model and thinking mode selection', async () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const [editorContent, modelSelectorContent, mobileModelPickerContent] = await Promise.all([
      readFile(join(directory, 'ScheduledTaskEditorDialog.tsx'), 'utf8'),
      readFile(join(directory, '../sections/agents/ModelSelector.tsx'), 'utf8'),
      readFile(join(directory, '../model-picker/MobileModelPickerPanel.tsx'), 'utf8'),
    ]);
    expect(editorContent).toContain('variant={draft.execution.variant}');
    expect(editorContent).not.toContain("t('sessions.scheduledTasks.editor.thinkingLevel.label')");
    expect(modelSelectorContent).toContain('variant?: string;');
    expect(modelSelectorContent).toContain('<MobileModelPickerPanel');
    expect(modelSelectorContent).toContain('variantSelectionEnabled={variantSelectionEnabled}');
    expect(modelSelectorContent).toContain('onSelect={handleMobileSelect}');
    expect(mobileModelPickerContent).toContain('allowedModelIdsByProvider');
    expect(mobileModelPickerContent).toContain("setView('variant')");
    expect(editorContent).toContain('if (!selectedModelForVariant || !draft.execution.variant');
  });

  test('shares one mobile detail navigation across settings, task editing, and chat', async () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const [navigationContent, projectsHomeContent, buttonContent, editorContent, settingsContent, settingsTabContent, chatHeaderContent, chatScreenContent, mobileStyles] = await Promise.all([
      readFile(join(directory, '../../mobile/MobileDetailNavigation.tsx'), 'utf8'),
      readFile(join(directory, '../../mobile/projects/MobileProjectsHome.tsx'), 'utf8'),
      readFile(join(directory, '../ui/button.tsx'), 'utf8'),
      readFile(join(directory, 'ScheduledTaskEditorDialog.tsx'), 'utf8'),
      readFile(join(directory, '../views/SettingsView.tsx'), 'utf8'),
      readFile(join(directory, '../../mobile/settings/MobileSettingsTab.tsx'), 'utf8'),
      readFile(join(directory, '../../mobile/chat/MobileChatHeader.tsx'), 'utf8'),
      readFile(join(directory, '../../mobile/chat/MobileChatScreen.tsx'), 'utf8'),
      readFile(join(directory, '../../styles/mobile.css'), 'utf8'),
    ]);
    expect(navigationContent).toContain('oc-mobile-detail-navigation-content');
    expect(navigationContent).toContain('items-center gap-1 px-4');
    expect(navigationContent).toContain('actions?: readonly MobileDetailNavigationAction[]');
    expect(navigationContent).not.toContain('contentClassName?: string');
    expect(navigationContent).not.toContain('className?: string');
    expect(navigationContent).not.toContain('trailing?: ReactNode');
    expect(navigationContent.match(/variant="mobileGlass"/g)).toHaveLength(2);
    expect(navigationContent.match(/size="mobileIcon"/g)).toHaveLength(2);
    expect(projectsHomeContent.match(/variant="mobileGlass"/g)).toHaveLength(1);
    expect(projectsHomeContent.match(/size="mobileIcon"/g)).toHaveLength(2);
    expect(projectsHomeContent).toContain('bg-[var(--primary-base)]');
    expect(projectsHomeContent).toContain('var(--primary-base)_22%');
    expect(projectsHomeContent).toContain('filterMobileProjectsForSearch');
    expect(projectsHomeContent).toContain('inputMode="search"');
    expect(projectsHomeContent).not.toContain('type="search"');
    expect(projectsHomeContent).not.toContain('onClick={() => {}}');
    expect(buttonContent).toContain('mobileGlass:');
    expect(buttonContent).toContain('mobileIcon: "size-10 min-h-10 min-w-10 rounded-full"');
    expect(mobileStyles).toContain('.oc-mobile-floating-action');
    expect(mobileStyles).toContain('background: color-mix(in srgb, var(--surface-elevated) 54%, transparent)');
    expect(mobileStyles).toContain('backdrop-filter: blur(16px) saturate(1.25)');
    expect(mobileStyles).toContain('.dark .oc-mobile-floating-action');
    expect(mobileStyles).toContain('background: color-mix(in srgb, var(--surface-elevated) 88%, transparent)');
    expect(mobileStyles).toContain('color-mix(in srgb, var(--surface-foreground) 6%, transparent)');
    expect(mobileStyles).toContain('box-shadow: none');
    expect(navigationContent).toContain('max-w-72');
    expect(mobileStyles).toContain('--oc-mobile-detail-action-edge-inset: 1rem');
    expect(navigationContent).not.toContain('gap-1 px-2');
    expect(mobileStyles).toContain('var(--oc-mobile-detail-action-edge-inset, 1rem)');
    expect(mobileStyles).toContain('var(--oc-safe-area-left, 0px)');
    expect(mobileStyles).toContain('var(--oc-safe-area-right, 0px)');
    expect(mobileStyles).not.toContain('.oc-mobile-tab-page-flow .oc-mobile-detail-navigation');
    expect(mobileStyles).not.toContain('margin-inline: calc(-1 * var(--oc-mobile-page-inline-inset))');
    expect(mobileStyles).not.toContain('--oc-mobile-detail-navigation-inline-inset');
    expect(settingsContent).not.toContain('oc-mobile-settings-detail-navigation');
    expect(settingsContent).not.toContain('oc-mobile-settings-detail-header');
    expect(chatScreenContent).toContain('var(--oc-mobile-detail-navigation-height)');
    expect(editorContent).toContain('<MobileDetailNavigation');
    expect(settingsContent).toContain('<MobileDetailNavigation');
    expect(settingsContent).toContain('inert={detailActive ? true : undefined}');
    expect(settingsContent).toContain('<MobileTabPageHeader');
    expect(settingsContent).toContain('underlayRef: mobileBackUnderlayRef');
    expect(settingsContent).toContain('fixed inset-0 z-20 flex h-[100dvh]');
    expect(settingsContent).toContain('flex-col gap-6');
    expect(settingsTabContent).not.toContain('onMobileStageChange');
    expect(settingsTabContent).toContain('showHeader={false}');
    expect(chatHeaderContent).toContain('<MobileDetailNavigation');
    expect(chatScreenContent).not.toContain("t('miniChat.status.idle')");
  });
});
