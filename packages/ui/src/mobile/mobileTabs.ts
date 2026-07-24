import type { IconName } from '@/components/icon/icons';

export type MobileTabId = 'projects' | 'assistant' | 'scheduled' | 'settings';

export type MobileTabDefinition = {
  id: MobileTabId;
  icon: IconName;
  labelKey:
    | 'mobile.sessions.section.projects'
    | 'assistants.title'
    | 'sessions.scheduledTasks.dialog.title'
    | 'mobile.settings.placeholder.title';
};

// TODO(locale): Move these labels to dedicated mobile.tabs.* keys when locale dictionaries enter this lane.
export const MOBILE_TABS: readonly MobileTabDefinition[] = [
  { id: 'projects', icon: 'briefcase', labelKey: 'mobile.sessions.section.projects' },
  { id: 'assistant', icon: 'sparkling', labelKey: 'assistants.title' },
  { id: 'scheduled', icon: 'calendar-schedule', labelKey: 'sessions.scheduledTasks.dialog.title' },
  { id: 'settings', icon: 'settings-3', labelKey: 'mobile.settings.placeholder.title' },
];
