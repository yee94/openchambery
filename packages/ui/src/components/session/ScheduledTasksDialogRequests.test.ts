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
    expect(workspaceContent.match(/mx-auto w-full max-w-4xl/g)?.length).toBeGreaterThanOrEqual(2);
    expect(workspaceContent).toContain('layoutId="scheduled-task-filter-pill"');
    expect(workspaceContent).toContain('<AnimatePresence initial={false} mode="popLayout">');
    expect(workspaceContent).toContain('key="empty"');
    expect(workspaceContent).toContain('key="tasks"');
    expect(workspaceContent).toContain('exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}');
    expect(workspaceContent).toContain("isMobilePanel ? 'h-11 min-h-11' : '!h-9 !min-h-9'");
    expect(workspaceContent).toContain("initial={reduceMotion ? { opacity: 1, width: 0 } : { opacity: 0, width: 0, x: 24 }}");
    expect(workspaceContent).toContain('motion-reduce:transition-none');
    expect(editorContent).toContain('motion-reduce:animate-none');
    expect(editorContent).toContain('groupedCardClassName');
    expect(editorContent).toContain('const groupedPanel = desktopPanel || mobilePanel;');
    expect(editorContent).toContain('MOBILE_PANEL_ROW_CLASS');
    expect(editorContent).toContain('MOBILE_PANEL_CONTROL_CLASS');
  });

  test('exposes scheduled tasks from the dedicated mobile menu and tab', async () => {
    const content = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../../apps/MobileApp.tsx'), 'utf8');
    expect(content).toContain("key: 'scheduled'");
    expect(content).toContain("icon: 'time'");
    expect(content).toContain("label: t('sessions.sidebar.header.actions.scheduledTasks')");
    // iPad keeps the dialog; phone routes to the scheduled tab.
    expect(content).toContain('setScheduledTasksDialogOpen(true);');
    expect(content).toContain("useMobileNavigationStore.getState().setActiveTab('scheduled');");
    expect(content).toContain('|| scheduledTasksDialogOpen');
    expect(content).toContain('if (scheduledTasksDialogOpen) {');
    expect(content).toContain("window.dispatchEvent(new Event('oc:scheduled-tasks-close-request'));");
    expect(content).toContain('<ScheduledTasksDialog />');
    // The phone tab hosts the workspace as a root page.
    expect(content).toContain('<ScheduledTasksWorkspace');
    expect(content).toContain('presentation="mobile-tab"');
  });

  test('keeps the mobile editor contained and routes close requests through its draft guard', async () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const [workspaceContent, overlayContent, mobileAppContent] = await Promise.all([
      readFile(join(directory, 'ScheduledTasksDialog.tsx'), 'utf8'),
      readFile(join(directory, '../ui/MobileOverlayPanel.tsx'), 'utf8'),
      readFile(join(directory, '../../apps/MobileApp.tsx'), 'utf8'),
    ]);
    expect(workspaceContent).toContain("presentation?: 'workspace' | 'mobile-panel' | 'mobile-tab'");
    expect(workspaceContent).toContain("presentation={isMobilePanel ? 'mobile-panel' : undefined}");
    expect(workspaceContent).toContain('if (editorMode !== \'closed\')');
    expect(workspaceContent).toContain('handleCancelEditor(false)');
    // Global close event is exclusive to mobile-panel (dialog); tab uses registerEditorBackHandler.
    expect(workspaceContent).toContain("if (presentation !== 'mobile-panel' || !open) return");
    expect(workspaceContent).toContain("window.addEventListener('oc:scheduled-tasks-close-request', handleCloseRequest)");
    expect(workspaceContent).toContain('registerEditorBackHandler?: (handler: (() => boolean) | null) => void');
    expect(overlayContent).toContain('containedBody?: boolean');
    expect(overlayContent).toContain("'flex min-h-0 flex-1 flex-col overflow-hidden'");
    expect(overlayContent).toContain('openOverlayStack[openOverlayStack.length - 1] === overlayID');
    expect(mobileAppContent).toContain("window.dispatchEvent(new Event('oc:scheduled-tasks-close-request'));");
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
});
