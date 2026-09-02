import type { SidebarSection } from '@/constants/sidebar';
import type { MainTab } from '@/stores/useUIStore';

/**
 * Route state derived from history path.
 * All fields nullable = not specified (app defaults).
 */
export interface RouteState {
  sessionId: string | null;
  /** True for `/session/new` draft surface (mutually exclusive with sessionId). */
  isNewSession: boolean;
  tab: MainTab | null;
  settingsPath: string | null;
  settingsEntityId: string | null;
  diffFile: string | null;
  diffScope: 'staged' | 'working' | 'turn' | null;
  scheduleView: 'tasks' | 'history' | null;
  scheduleProjectId: string | null;
  scheduleTaskId: string | null;
  assistantId: string | null;
  /** Focused nested/subagent session under schedule or assistant primary. */
  focusSessionId: string | null;
}

/**
 * @deprecated Path-mode tabs live in `@/router/pathContract`.
 */
export const VALID_TABS: readonly MainTab[] = [
  'chat',
  'git',
  'diff',
  'terminal',
  'files',
  'diagram',
  'schedule',
  'assistant',
] as const;

/**
 * @deprecated Settings slugs live in settings metadata / pathContract.
 */
export const VALID_SETTINGS_SECTIONS: readonly SidebarSection[] = [
  'settings',
  'agents',
  'commands',
  'skills',
  'providers',
  'usage',
  'git-identities',
] as const;

/**
 * @deprecated Legacy query param names.
 */
export const ROUTE_PARAMS = {
  SESSION: 'session',
  TAB: 'tab',
  SETTINGS: 'settings',
  FILE: 'file',
} as const;
