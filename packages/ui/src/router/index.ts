/**
 * App router infrastructure (TanStack Router, path mode).
 *
 * Ownership: packages/ui — shared across web / electron / vscode / mobile.
 * History: web → browser; vscode | electron | embedded | mobile → memory (no hash).
 *
 * Navigation authority: path + search via createAppNavigation / pathContract.
 * Domain state stays in Zustand / TanStack Query.
 */

export type { RouterRuntime } from './runtime';
export { MEMORY_ROUTER_RUNTIMES, isMemoryRouterRuntime } from './runtime';

export { createAppHistory } from './history';
export type { CreateAppHistoryOptions } from './history';

export { createAppRouter } from './createAppRouter';
export type { CreateAppRouterOptions, AppRouter } from './createAppRouter';

export type { AppRouterContext } from './routes/tree';
export { routeTree } from './routes/tree';

export {
  WORKSPACE_PATH_TABS,
  SESSION_TOOL_TABS,
  SCHEDULE_VIEWS,
  buildConnectPath,
  buildNewSessionPath,
  buildSessionPath,
  buildSchedulePath,
  buildAssistantPath,
  buildAppLocation,
  buildSettingsPath,
  normalizeSettingsSlug,
  normalizeWorkspaceTab,
  normalizeScheduleView,
  normalizeDiffScope,
  parseAppPath,
} from './pathContract';
export type {
  BuildSessionPathInput,
  BuildSchedulePathInput,
  BuildAssistantPathInput,
  BuildSettingsPathInput,
  DiffScope,
  ParsedAppPath,
  ParsedSessionPath,
  ParsedSchedulePath,
  ParsedAssistantPath,
  ParsedSettingsPath,
  ScheduleView,
  ScheduledView,
  WorkspacePathTab,
  WorkspaceTab,
} from './pathContract';

export {
  resolvePrimarySurface,
  isExclusiveFullMainPrimary,
  SCHEDULE_TAB_ID,
} from './primarySurface';
export type { PrimarySurface, PrimarySurfaceState, SessionTool } from './primarySurface';

export {
  findSessionById,
  resolveSessionDirectoryForRoute,
  resolveSessionForRoute,
} from './sessionLookup';
export type { SessionLookupResult } from './sessionLookup';

export type { NavigationIntent } from './navigationIntent';
export { createAppNavigation } from './navigation';
export type { AppNavigation, GoSessionOptions } from './navigation';

export {
  deepLinkToNavigationIntent,
  resolveDeepLinkNavigationIntent,
} from './deepLinkIntent';
