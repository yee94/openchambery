import { updateBrowserURL } from '@/lib/router';
import { useUIStore } from '@/stores/useUIStore';

/** Open an exact task, including hosts that intentionally do not write browser URLs. */
export function openScheduledTask(projectId: string, taskId: string): void {
  const ui = useUIStore.getState();
  if (!ui.setActiveMainTab('schedule')) return;
  ui.setSettingsDialogOpen(false);
  updateBrowserURL({
    sessionId: null,
    tab: 'schedule',
    isSettingsOpen: false,
    settingsPath: ui.settingsPage,
    diffFile: null,
    scheduleView: 'tasks',
    scheduleProjectId: projectId,
    scheduleTaskId: taskId,
  });
  ui.setScheduledTaskOpenRequest({ projectId, taskId });
  if (ui.isMobile) ui.setScheduledTasksDialogOpen(true);
}
