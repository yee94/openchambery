export const OPENCHAMBER_APP_GROUP = 'group.com.yee94.openchamber';
export const DEEP_LINK_SCHEME = 'openchamber';
export const LIVE_ACTIVITY_BUSY_START_MS = 5_000;
export const LIVE_ACTIVITY_COMPLETE_DISMISSAL_SECONDS = 900;
export const LIVE_ACTIVITY_ERROR_DISMISSAL_SECONDS = 3600;
export const ROOT_TAB_IDS = ['projects', 'assistant', 'scheduled', 'settings'] as const;
export type RootTabId = (typeof ROOT_TAB_IDS)[number];
