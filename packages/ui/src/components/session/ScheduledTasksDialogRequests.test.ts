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

  test('loads run history incrementally and invalidates its exact query on run events', async () => {
    const content = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'ScheduledTasksDialog.tsx'), 'utf8');
    expect(content).toContain('useInfiniteQuery({');
    expect(content).toContain("const globalScheduledTaskRunsQueryKey = queryKeys.scoped('scheduled-task-runs')");
    expect(content).toContain("enabled: open && workspaceView === 'history'");
    expect(content).toContain('initialPageParam: undefined as string | undefined');
    expect(content).toContain('getNextPageParam: (lastPage) => lastPage.complete ? undefined : lastPage.nextCursor ?? undefined');
    expect(content).toContain('await runsQuery.fetchNextPage()');
    expect(content).toContain('new Set<string>()');
    expect(content).toContain('invalidateQueries({ queryKey: globalScheduledTaskRunsQueryKey })');
    expect(content).toContain('historyTaskFilter?.projectId ?? \'\'');
    expect(content).toContain('historyTaskFilter?.taskId ?? \'\'');
    expect(content).toContain('projectId: historyTaskFilter.projectId, taskId: historyTaskFilter.taskId');
  });

  test('renders history with compact duration beside status and icon-value meta', async () => {
    const content = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'ScheduledTasksDialog.tsx'), 'utf8');
    expect(content).toContain('const resolveRunDurationMs = (run: ScheduledTaskRun, nowMs: number)');
    expect(content).toContain('const formatCompactRunDuration = (durationMs: number | null)');
    expect(content).toContain('const durationMs = resolveRunDurationMs(run, historyNowMs)');
    expect(content).toContain('const durationLabel = formatCompactRunDuration(durationMs)');
    // Compact units: 2m 50s style — duration sits left of status.
    expect(content).toContain('`${totalMinutes}m ${seconds}s`');
    expect(content).toContain('typography-micro tabular-nums text-muted-foreground');
    // Icon + value meta only (no labeled meta grid).
    expect(content).not.toContain("t('sessions.scheduledTasks.history.meta.trigger')");
    expect(content).not.toContain("t('sessions.scheduledTasks.history.meta.duration')");
    expect(content).toContain("name=\"time\"");
    expect(content).toContain("run.trigger === 'manual' ? 'play' : 'calendar-schedule'");
    // Shared PC/mobile rows: full-width body; desktop keeps a visible label inside the row control.
    expect(content).toContain('const runBody = (');
    expect(content).toContain("isMobilePanel ? 'gap-2.5' : 'gap-3'");
    expect(content).toContain("t('sessions.scheduledTasks.history.openSession')");
    expect(content).toContain('<span className="shrink-0 self-center typography-ui-label font-medium text-foreground">');
    const runBody = content.slice(content.indexOf('const runBody = ('), content.indexOf('if (isMobilePanel)', content.indexOf('const runBody = (')));
    expect(runBody).not.toContain('<Button');
    expect(content).not.toContain("isMobilePanel && 'flex-nowrap gap-2'");
    expect(content).toContain('whitespace-nowrap tabular-nums');
    expect(content).toContain("month: 'numeric'");
    // The desktop button owns the full list-row hover and keyboard target.
    expect(content).not.toContain('<Icon name="external-link" className="size-4" />');
    expect(content).toContain("divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60");
    expect(content).toContain('<article key={run.id} className="w-full min-w-0">');
    expect(content).toContain('className="w-full min-w-0 px-4 py-3 text-left outline-none transition-colors hover:bg-interactive-hover');
    expect(content).toContain('onClick={() => handleOpenRunSession(run)}');
    // Run error detail: inline icon + text (wraps at the trailing edge, not stacked).
    expect(content).toContain('{run.error ? (');
    expect(content).toContain('mt-1.5 min-w-0 break-words typography-micro text-[var(--surface-muted-foreground)] [overflow-wrap:anywhere]');
    expect(content).toContain("isMobilePanel ? 'line-clamp-3' : 'line-clamp-1'");
    expect(content).toContain('name="error-warning"');
    expect(content).toContain('mr-1 inline-block size-3 align-[-0.125em] text-[var(--status-error)]');
    // History mobile-tab card gap matches Tasks list (space-y-4).
    expect(content).toContain("isMobileTab\n                    ? 'space-y-4'");
  });

  test('opens linked run sessions through openSessionWithFeedback (visible errors when incomplete)', async () => {
    const content = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'ScheduledTasksDialog.tsx'), 'utf8');
    const handler = content.slice(content.indexOf('const handleOpenSession'), content.indexOf('const handleRetryRuns'));
    // Unified open path: requires sessionId+directory; phone shell via option.
    expect(handler).toContain('openSessionWithFeedback(sessionId, directory');
    expect(handler).toContain('phoneShell: Boolean(isMobilePanel && !isIPadApp())');
    expect(handler).not.toContain('isCapacitorApp()');
    // Incomplete identities still go through feedback (toast), not silent return-only.
    expect(handler).not.toContain('if (!sessionId || !directory) return;');
    expect(content).toContain('const canOpenSession = Boolean(run.sessionId && run.directory)');
    expect(content).toContain("t('sessions.scheduledTasks.history.openSession')");
    // Desktop and mobile both use full-row native buttons for linked runs.
    expect(content).toContain('if (canOpenSession) {');
    expect(content).toContain('hover:bg-interactive-hover');
    expect(content).toContain('data-mobile-press-surface="soft"');
    expect(content).toContain('data-mobile-press-surface-trigger');
    expect(content).toContain('oc-mobile-scheduled-task-row');
    expect(content).toContain('onClick={() => handleOpenRunSession(run)}');
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

  test('opens a task-filtered history view from task rows, menus, and the editor', async () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const [workspaceContent, editorContent] = await Promise.all([
      readFile(join(directory, 'ScheduledTasksDialog.tsx'), 'utf8'),
      readFile(join(directory, 'ScheduledTaskEditorDialog.tsx'), 'utf8'),
    ]);
    const historyHandler = workspaceContent.slice(
      workspaceContent.indexOf('const handleOpenTaskHistory'),
      workspaceContent.indexOf('const handleRetryRuns'),
    );
    const taskMenuItems = workspaceContent.slice(
      workspaceContent.indexOf('const renderMenuItems = (Item: React.ElementType)'),
      workspaceContent.indexOf('return (', workspaceContent.indexOf('const renderMenuItems = (Item: React.ElementType)')),
    );

    expect(historyHandler).toContain('setHistoryTaskFilter({ projectId: entry.projectId, taskId: entry.task.id })');
    expect(historyHandler).toContain("setWorkspaceView('history')");
    expect(historyHandler).toContain("syncScheduledPath('history', null)");
    expect(historyHandler).not.toContain('openSessionWithFeedback');
    expect(taskMenuItems).toContain('handleOpenTaskHistory(entry)');
    expect(taskMenuItems).toContain("t('sessions.scheduledTasks.workspace.views.history')");
    expect(workspaceContent).toContain('onOpenTaskHistory={handleEditorOpenTaskHistory}');
    expect(workspaceContent).toContain("t('sessions.scheduledTasks.history.filter.aria'");
    expect(workspaceContent).toContain("t('sessions.scheduledTasks.history.filter.clearAria')");
    expect(workspaceContent).toContain('{renderMenuItems(DropdownMenuItem)}');
    expect(workspaceContent).toContain('{renderMenuItems(ContextMenuItem)}');

    expect(editorContent).toContain('onOpenTaskHistory?: (task: ScheduledTask) => void');
    expect(editorContent).toContain('const canOpenTaskHistory = Boolean(task && onOpenTaskHistory)');
    expect(editorContent).toContain('onSelect={() => onOpenTaskHistory?.(task)}');
    expect(editorContent).toContain("t('sessions.scheduledTasks.workspace.views.history')");
    expect(editorContent).toContain('trailing={editorOverflowMenu}');
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
    // View switcher + filters share the mobile segmented track/item + selected pill.
    expect(workspaceContent).toContain('layoutId="scheduled-workspace-view-pill"');
    expect(workspaceContent).toContain("? 'oc-mobile-floating-surface oc-mobile-segmented-track'");
    expect(workspaceContent).toContain("? 'oc-mobile-segmented-item'");
    expect(workspaceContent).toContain("? 'oc-mobile-segmented-group'");
    expect(workspaceContent).toContain('oc-mobile-segmented-action');
    expect(workspaceContent).toContain("'oc-segmented-selected-pill absolute inset-0'");
    expect(workspaceContent).toContain("? 'oc-mobile-floating-surface oc-mobile-segmented-track oc-mobile-scheduled-controls'");
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
    // mobile-tab list is in-flow under the root tabpanel scroller (no nested safe-area pad).
    expect(workspaceContent).toContain("? 'flex-none overflow-visible pt-[var(--oc-mobile-page-gap)]'");
    expect(workspaceContent).not.toContain("overscroll-none pb-[max(1rem,env(safe-area-inset-bottom))] pt-5");
    // History mobile-tab: tablist has no mb-3 so only page-gap separates tab→list.
    expect(workspaceContent).toContain("(workspaceView === 'tasks' || historyTaskFilter || !isMobileTab) && 'mb-3'");
    expect(editorContent).toContain('oc-mobile-scheduled-editor-body min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-[var(--oc-mobile-page-inline-inset)] pt-4');
    expect(editorContent).not.toContain('<div className="px-3 pb-5 pt-4">');
  });

  test('keeps scheduled tasks in their dedicated surfaces and out of the conversation overflow menu', async () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const [content, phoneShellContent] = await Promise.all([
      readFile(join(directory, '../../apps/MobileApp.tsx'), 'utf8'),
      readFile(join(directory, '../../mobile/MobilePhoneShell.tsx'), 'utf8'),
    ]);
    const overflowMenu = content.slice(content.indexOf('const overflowItems'), content.indexOf('return (', content.indexOf('const overflowItems')));
    expect(overflowMenu).not.toContain("key: 'schedule'");
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
    // Editor push stays in-tab (below the web dock); list underlay is in-flow so tabpanel owns scroll.
    expect(workspaceContent).toContain("'oc-mobile-scheduled-editor-overlay flex w-full min-w-0 max-w-full flex-col overflow-hidden bg-background [contain:layout_paint]'");
    expect(workspaceContent).toContain("? 'flex w-full min-w-0 flex-col gap-[var(--oc-mobile-page-gap)]'");
    expect(workspaceContent).not.toContain('fixed inset-0 z-20 flex h-[100dvh]');
    expect(workspaceContent).not.toContain("isMobileTab\n            ? 'fixed inset-0 z-20");
    expect(workspaceContent).toContain("isMobileTab ? 'flex-none overflow-visible' : 'flex-1 overflow-hidden'");
    expect(workspaceContent).toContain("isMobileTab ? 'pb-0 pt-0'");
    expect(workspaceContent).toContain("isMobilePanel && !isMobileTab && editorMode !== 'closed' ? 'hidden' : 'flex'");
    expect(workspaceContent).toContain("? 'oc-mobile-floating-surface oc-mobile-project-shell rounded-[var(--oc-mobile-surface-radius)]'");
    expect(workspaceContent).not.toContain('mobileTaskGroupStarts');
    expect(mobileAppContent).toContain('onEditorActiveChange={onEditorActiveChange}');
    expect(phoneShellContent).toContain('<MobileScheduledTab showHeader={false}>');
    expect(overlayContent).toContain('containedBody?: boolean');
    expect(overlayContent).toContain("'flex min-h-0 flex-1 flex-col overflow-hidden'");
    expect(overlayContent).toContain('openOverlayStack[openOverlayStack.length - 1] === overlayID');
    expect(mobileAppContent).toContain("window.dispatchEvent(new Event('oc:scheduled-tasks-close-request'));");
  });

  test('keeps the scheduled root tab and web dock interactive under the in-tab editor', async () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const [editorContent, phoneShellContent, tabRootContent, scheduledTabContent, mobileSurfaceContent, mobileTabBarContent, mobileStyles] = await Promise.all([
      readFile(join(directory, 'ScheduledTaskEditorDialog.tsx'), 'utf8'),
      readFile(join(directory, '../../mobile/MobilePhoneShell.tsx'), 'utf8'),
      readFile(join(directory, '../../mobile/MobileTabsRoot.tsx'), 'utf8'),
      readFile(join(directory, '../../mobile/scheduled/MobileScheduledTab.tsx'), 'utf8'),
      readFile(join(directory, '../../mobile/MobileSurface.tsx'), 'utf8'),
      readFile(join(directory, '../../mobile/MobileTabBar.tsx'), 'utf8'),
      readFile(join(directory, '../../styles/mobile.css'), 'utf8'),
    ]);
    expect(phoneShellContent).toContain('tabBarCovered={scheduledEditorActive}');
    expect(tabRootContent).toContain('showTabBar?: boolean;');
    expect(tabRootContent).toContain('data-mobile-navigation-dock-underlay="true"');
    expect(tabRootContent).toContain('inert={topSecondaryPage || nativeTabBarAdopted ? true : undefined}');
    expect(tabRootContent).not.toContain('inert={topSecondaryPage || tabBarCovered || nativeTabBarAdopted ? true : undefined}');
    expect(mobileStyles).toContain('.oc-mobile-scheduled-editor-overlay');
    expect(mobileStyles).toContain(':root:not(.oc-native-ios-tab-bar)\n  .oc-mobile-floating-bottom-bar-frame[data-scheduled-editor-footer]');
    expect(tabRootContent).toContain('<MobileTabBar activeTab={selectedTab}');
    expect(tabRootContent).not.toContain(') : showTabBar ? (');
    expect(tabRootContent).toContain('data-mobile-navigation-underlay="true"');
    expect(tabRootContent).not.toContain("secondaryPage && 'opacity-0'");
    expect(scheduledTabContent).toContain('scrollsWithPage');
    expect(scheduledTabContent).not.toContain('scrollsWithPage={showHeader}');
    // Root tabpanel is the sole scroller for scheduled content (matches Projects).
    expect(tabRootContent).toContain('scrollbar-none h-full min-h-0 flex-1 overflow-y-auto');
    expect(scheduledTabContent).toContain("surfaceClassName={cn('oc-mobile-scheduled-content'");
    const mobileTabEditorContent = editorContent
      .split("if (presentation === 'mobile-tab')")[1]
      ?.split('if (isMobile)')[0] ?? '';
    expect(mobileTabEditorContent).toContain('<MobileDetailNavigation\n          sticky');
    expect(mobileTabEditorContent).toContain('<section className="flex h-full min-h-0 flex-col bg-background"');
    expect(mobileTabEditorContent).toContain('oc-mobile-scheduled-editor-body min-h-0 flex-1 overflow-y-auto overflow-x-hidden');
    expect(mobileTabEditorContent).toContain('data-scheduled-editor-footer=""');
    expect(mobileTabEditorContent).toContain('<MobileFloatingBottomBar\n          as="footer"');
    expect(mobileTabEditorContent).toContain('className="z-[60]"');
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
    const [navigationContent, rootHeaderContent, projectsHomeContent, buttonContent, editorContent, settingsContent, settingsTabContent, chatHeaderContent, chatScreenContent, mobileStyles] = await Promise.all([
      readFile(join(directory, '../../mobile/MobileDetailNavigation.tsx'), 'utf8'),
      readFile(join(directory, '../../mobile/MobileTabPageHeader.tsx'), 'utf8'),
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
    expect(navigationContent).toContain('trailing?: ReactNode');
    expect(navigationContent).not.toContain('contentClassName?: string');
    expect(navigationContent).not.toContain('className?: string');
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
    expect(mobileStyles).toContain('--oc-mobile-glass-fill: rgb(255 255 255 / 0.68)');
    expect(mobileStyles).toContain('--oc-mobile-glass-blur: 20px');
    expect(mobileStyles).toContain('--oc-mobile-glass-saturate: 1.25');
    expect(mobileStyles).toContain('0 0 12px rgb(0 0 0 / 0.06)');
    expect(mobileStyles).toContain('0 8px 20px -6px rgb(0 0 0 / 0.12)');
    expect(mobileStyles).toContain('inset 0 1px 0 var(--oc-mobile-glass-highlight)');
    expect(mobileStyles).not.toContain('--oc-mobile-glass-caustic');
    expect(mobileStyles).not.toContain('--oc-mobile-glass-edge');
    expect(mobileStyles).not.toContain('--oc-mobile-glass-border');
    expect(mobileStyles).toContain('background: var(--oc-mobile-glass-fill)');
    expect(mobileStyles).toContain('box-shadow: var(--oc-mobile-glass-shadow)');
    expect(mobileStyles).toContain('blur(var(--oc-mobile-glass-blur))');
    expect(mobileStyles).toContain('saturate(var(--oc-mobile-glass-saturate))');
    expect(mobileStyles).not.toContain('.oc-mobile-floating-action::before');
    expect(mobileStyles).toContain('.dark .oc-mobile-floating-action');
    expect(mobileStyles).toContain('--oc-mobile-border: color-mix(');
    expect(navigationContent).toContain('max-w-72');
    expect(mobileStyles).toContain('--oc-mobile-detail-action-edge-inset: 1rem');
    expect(navigationContent).not.toContain('gap-1 px-2');
    expect(mobileStyles).toContain('var(--oc-mobile-detail-action-edge-inset, 1rem)');
    expect(mobileStyles).toContain('var(--oc-safe-area-left, 0px)');
    expect(mobileStyles).toContain('var(--oc-safe-area-right, 0px)');
    expect(mobileStyles).not.toContain('.oc-mobile-tab-page-flow .oc-mobile-detail-navigation');
    expect(navigationContent).not.toContain('margin-inline');
    expect(mobileStyles).not.toContain('--oc-mobile-detail-navigation-inline-inset');
    expect(rootHeaderContent).toContain('oc-mobile-collapsing-header');
    expect(rootHeaderContent).toContain('oc-mobile-collapsing-header-inner');
    expect(rootHeaderContent).toContain('oc-mobile-collapsing-header-spacer');
    expect(rootHeaderContent).toContain('oc-mobile-collapsing-header-title-block');
    expect(rootHeaderContent).toContain("header.style.setProperty('--oc-mobile-title-collapse'");
    expect(rootHeaderContent).toContain("addEventListener('scroll', scheduleCollapseProgress, { passive: true })");
    expect(rootHeaderContent).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
    expect(mobileStyles).toContain('.oc-mobile-collapsing-header::after');
    expect(mobileStyles).toContain('--oc-mobile-header-fade');
    expect(mobileStyles).toContain('var(--surface-background) 85%');
    expect(mobileStyles).toContain('opacity: var(--oc-mobile-title-collapse)');
    // Bounce-free: layout box is constant; collapse only drives transform/opacity.
    // Compact end is 1.25rem (scale 0.625), not detail-nav 0.9375rem — balances 40px actions.
    expect(mobileStyles).toContain('transform-origin: left center');
    expect(mobileStyles).toContain('0.375 * var(--oc-mobile-title-collapse, 0)');
    expect(mobileStyles).toContain('--oc-mobile-collapsing-title-compact-size: 1.25rem');
    expect(mobileStyles).toContain('--oc-mobile-collapsing-expand-shift: 0.625rem');
    expect(mobileStyles).toContain('.oc-mobile-collapsing-header-spacer');
    expect(mobileStyles).toContain('var(--oc-safe-area-top, 0px) + 0.75rem');
    expect(mobileStyles).toContain('--oc-mobile-collapsing-action-size: 2.5rem');
    expect(mobileStyles).toContain('[role="tabpanel"]:has(.oc-mobile-collapsing-header)');
    expect(mobileStyles).toContain('.oc-mobile-settings-root-surface:has(.oc-mobile-collapsing-header)');
    expect(settingsContent).not.toContain('oc-mobile-settings-detail-navigation');
    expect(settingsContent).not.toContain('oc-mobile-settings-detail-header');
    expect(chatScreenContent).toContain('var(--oc-mobile-detail-navigation-height)');
    expect(editorContent).toContain('<MobileDetailNavigation');
    expect(settingsContent).toContain('<MobileDetailNavigation');
    expect(settingsContent).toContain('inert={detailActive ? true : undefined}');
    expect(settingsContent).toContain('<MobileTabPageHeader');
    expect(settingsContent).toContain('underlayRef: mobileBackUnderlayRef');
    expect(settingsContent).toContain('fixed inset-0 z-20 flex h-[100dvh]');
    expect(settingsContent).toContain('flex-col gap-[var(--oc-mobile-page-gap)]');
    expect(settingsContent).toContain('"flex-1 min-h-0 overflow-hidden bg-transparent"');
    expect(settingsContent).toContain(': "px-[var(--oc-mobile-page-inline-inset)]"');
    expect(settingsContent).toContain('"oc-settings-workspace-mobile bg-transparent"');
    expect(settingsContent).toContain('"oc-settings-workspace-desktop bg-background"');
    expect(settingsContent.match(/className=\{mobileDetailStageClassName\}/g)).toHaveLength(4);
    const mobileDetailCardStyles = mobileStyles.slice(
      mobileStyles.indexOf('.oc-mobile-settings-detail-card {'),
      mobileStyles.indexOf('.oc-mobile-settings-detail-card > *'),
    );
    expect(mobileDetailCardStyles).toContain('background: transparent');
    expect(mobileDetailCardStyles).toContain('backdrop-filter: none');
    expect(settingsTabContent).not.toContain('onMobileStageChange');
    expect(settingsTabContent).toContain('showHeader={false}');
    expect(chatHeaderContent).toContain('<MobileDetailNavigation');
    expect(chatHeaderContent).toContain('trailing={trailing}');
    expect(chatHeaderContent).toContain('elevated={elevated || menuOpen}');
    expect(chatHeaderContent).toContain('pressed: menuOpen');
    expect(chatScreenContent).toContain('<MobileContextProgressButton');
    expect(chatScreenContent).toContain('onOpenChange={handleContextOpenChange}');
    expect(chatScreenContent).toContain('onCloseMenu?.()');
    expect(chatScreenContent).toContain('menuOpen={menuOpen}');
    expect(chatScreenContent).toContain('elevated={headerElevated}');
    expect(chatScreenContent).not.toContain('disabled={menuOpen}');
    expect(chatScreenContent).not.toContain("t('miniChat.status.idle')");
  });

  test('keeps the three mobile Settings stages as sibling back-navigation surfaces', async () => {
    const content = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '../views/SettingsView.tsx'),
      'utf8',
    );
    const mobileFlowContent = content.slice(
      content.indexOf('if (mobileFlow) {'),
      content.indexOf('\n  return (', content.indexOf('if (mobileFlow) {')),
    );

    // Stable route id (no mobileStage) so sidebar→content does not re-register.
    expect(content).toContain('id: `mobile-settings:${settingsSlug}`');
    expect(content).not.toContain('id: `mobile-settings:${settingsSlug}:${mobileStage}`');

    // Stable bridge refs + layout effect retarget surface/underlay by stage.
    expect(content).toContain('const mobileBackSurfaceRef = React.useRef<HTMLElement | null>(null)');
    expect(content).toContain('const mobileBackUnderlayRef = React.useRef<HTMLElement | null>(null)');
    expect(content).toContain('React.useLayoutEffect(() => {');
    expect(content).toContain('mobileBackSurfaceRef.current = mobileBackContentRef.current');
    expect(content).toContain('mobileBackSurfaceRef.current = mobileBackSidebarRef.current');
    expect(content).toContain('mobileBackUnderlayRef.current = mobileBackRootRef.current');
    expect(content).toContain('mobileBackUnderlayRef.current =\n        activePageMeta?.kind === "split"\n          ? mobileBackSidebarRef.current\n          : mobileBackRootRef.current');
    expect(content).toContain('surfaceRef: mobileBackSurfaceRef');
    expect(content).toContain('underlayRef: mobileBackUnderlayRef');

    // Capacitor must not own nested split-detail history (native coordinator + local stage).
    expect(content).toContain('import { isCapacitorApp } from "@/lib/platform"');
    expect(content).toContain('runtimeCtx.isVSCode ||\n        isCapacitorApp()');
    expect(content).toContain('if (isCapacitorApp() || runtimeCtx.isVSCode) {\n      setMobileStage("page-sidebar")');
    expect(content).toContain('if (!isMobile || runtimeCtx.isVSCode || isCapacitorApp())');

    expect(content).toContain('const sidebarLayerMounted =\n      detailActive && activePageMeta?.kind === "split";');
    expect(content).toContain('const rootIsUnderlay = detailActive && !sidebarIsUnderlay;');
    expect(content).toContain('pt-[calc(var(--oc-safe-area-top,env(safe-area-inset-top,0px))+1rem)]');
    expect(content).toContain('var(--oc-safe-area-bottom,env(safe-area-inset-bottom,0px))');

    const rootStage = mobileFlowContent.indexOf('data-mobile-settings-stage="nav"');
    const sidebarStage = mobileFlowContent.indexOf('data-mobile-settings-stage="page-sidebar"');
    const contentStage = mobileFlowContent.indexOf('data-mobile-settings-stage="page-content"');
    expect(rootStage).toBeGreaterThanOrEqual(0);
    expect(sidebarStage).toBeGreaterThan(rootStage);
    expect(contentStage).toBeGreaterThan(sidebarStage);
    expect(mobileFlowContent).toContain('ref={mobileBackRootRef}');
    expect(mobileFlowContent).toContain('ref={mobileBackSidebarRef}');
    expect(mobileFlowContent).toContain('ref={mobileBackContentRef}');
    expect(mobileFlowContent).toContain('fixed inset-0 z-20');
    expect(mobileFlowContent).toContain('fixed inset-0 z-40');
    expect(mobileFlowContent).toContain('fixed inset-0 z-50');
    expect(mobileFlowContent).toContain('aria-hidden={sidebarLayerActive ? undefined : "true"}');
    expect(mobileFlowContent).toContain('inert={sidebarLayerActive ? undefined : true}');
  });
});
