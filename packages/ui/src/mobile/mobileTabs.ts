import type { IconName } from '@/components/icon/icons';

export type MobileTabId = 'projects' | 'assistant' | 'scheduled' | 'settings';

export type MobileTabDefinition = {
  id: MobileTabId;
  icon: IconName;
  /** Short labels reserved for the floating tab bar — keep under ~10 Latin chars / 4 CJK. */
  labelKey:
    | 'mobile.tabs.projects'
    | 'mobile.tabs.assistant'
    | 'mobile.tabs.scheduled'
    | 'mobile.tabs.settings';
};

export const MOBILE_TABS: readonly MobileTabDefinition[] = [
  { id: 'projects', icon: 'folder-open', labelKey: 'mobile.tabs.projects' },
  { id: 'assistant', icon: 'sparkling', labelKey: 'mobile.tabs.assistant' },
  { id: 'scheduled', icon: 'calendar-schedule', labelKey: 'mobile.tabs.scheduled' },
  { id: 'settings', icon: 'settings-3', labelKey: 'mobile.tabs.settings' },
];
