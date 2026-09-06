/**
 * Four root dock tabs. Same identity as Capacitor `mobileTabs.ts`.
 * Chat is never a tab — it is a pushed secondary page.
 */
export type LynxTabId = 'projects' | 'assistant' | 'scheduled' | 'settings';

export type LynxTabDefinition = {
  id: LynxTabId;
  icon: 'folder-open' | 'sparkling' | 'calendar-schedule' | 'settings-3';
  labelKey:
    | 'mobile.tabs.projects'
    | 'mobile.tabs.assistant'
    | 'mobile.tabs.scheduled'
    | 'mobile.tabs.settings';
};

export const LYNX_TABS: readonly LynxTabDefinition[] = [
  { id: 'projects', icon: 'folder-open', labelKey: 'mobile.tabs.projects' },
  { id: 'assistant', icon: 'sparkling', labelKey: 'mobile.tabs.assistant' },
  { id: 'scheduled', icon: 'calendar-schedule', labelKey: 'mobile.tabs.scheduled' },
  { id: 'settings', icon: 'settings-3', labelKey: 'mobile.tabs.settings' },
];

export const LYNX_TAB_IDS: readonly LynxTabId[] = LYNX_TABS.map((tab) => tab.id);

export function isLynxTabId(value: string): value is LynxTabId {
  return (LYNX_TAB_IDS as readonly string[]).includes(value);
}
