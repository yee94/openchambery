import type { MainTab } from '@/stores/useUIStore';
import { isEmbeddedSessionChat } from '@/components/layout/contextPanelEmbeddedChat';
import {
  buildAppLocation,
  buildSettingsPath,
  parseAppPath,
  type DiffScope,
  type ScheduleView,
} from '@/router/pathContract';
import { SCHEDULE_TAB_ID } from '@/router/primarySurface';

export interface AppRouteState {
  sessionId: string | null;
  tab: MainTab;
  isSettingsOpen: boolean;
  settingsPath: string;
  settingsEntityId?: string | null;
  diffFile: string | null;
  diffScope?: DiffScope | null;
  scheduleView?: ScheduleView | null;
  scheduleProjectId?: string | null;
  scheduleTaskId?: string | null;
  assistantId?: string | null;
  focusSessionId?: string | null;
}

/**
 * Serialize UI state to history path.
 * Schedule / assistant are top-level primaries (no /session/$id prefix).
 */
export function serializeAppPath(state: AppRouteState): string {
  if (state.isSettingsOpen) {
    return buildSettingsPath({
      slug: state.settingsPath.trim().length > 0 ? state.settingsPath : 'home',
      entityId: state.settingsEntityId ?? null,
    });
  }

  if (state.tab === SCHEDULE_TAB_ID) {
    return buildAppLocation({
      tab: SCHEDULE_TAB_ID,
      scheduleView: state.scheduleView,
      scheduleProjectId: state.scheduleProjectId,
      scheduleTaskId: state.scheduleTaskId,
      focusSessionId: state.focusSessionId,
    });
  }

  if (state.tab === 'assistant') {
    return buildAppLocation({
      tab: 'assistant',
      assistantId: state.assistantId,
      focusSessionId: state.focusSessionId,
    });
  }

  if (state.sessionId && state.sessionId.trim().length > 0) {
    const fileTabs = new Set(['diff', 'files', 'diagram']);
    const file =
      fileTabs.has(state.tab) && state.diffFile
        ? state.diffFile
        : null;

    return buildAppLocation({
      sessionId: state.sessionId.trim(),
      tab: state.tab === 'context' ? 'chat' : state.tab,
      file,
      mode: state.tab === 'plan' ? 'plan' : null,
      scope: state.tab === 'diff' ? (state.diffScope ?? null) : null,
    });
  }

  return '/';
}

function routeMatchesURL(state: AppRouteState): boolean {
  if (typeof window === 'undefined') {
    return true;
  }

  try {
    const current = `${window.location.pathname}${window.location.search}`;
    const next = serializeAppPath(state);
    return JSON.stringify(parseAppPath(current)) === JSON.stringify(parseAppPath(next));
  } catch {
    return true;
  }
}

export function updateBrowserURL(
  state: AppRouteState,
  options: { replace?: boolean; force?: boolean } = {},
): void {
  if (typeof window === 'undefined') {
    return;
  }

  if (isVSCodeContext() || isEmbeddedSessionChat()) {
    return;
  }

  if (!options.force && routeMatchesURL(state)) {
    return;
  }

  try {
    const url = serializeAppPath(state);

    if (options.replace) {
      window.history.replaceState({ ...window.history.state, route: state }, '', url);
    } else {
      window.history.pushState({ route: state }, '', url);
    }
  } catch {
    // non-critical
  }
}

function isVSCodeContext(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const win = window as { __VSCODE_CONFIG__?: unknown };
  return win.__VSCODE_CONFIG__ !== undefined;
}
