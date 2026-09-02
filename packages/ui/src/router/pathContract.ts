import {
  resolveSettingsSlug,
  type SettingsPageSlug,
} from '@/lib/settings/metadata';
import {
  LEGACY_SCHEDULE_TAB_ID,
  SCHEDULE_TAB_ID,
} from './primarySurface';

/**
 * Session-scoped tools only (under /session/$id/…).
 * Schedule and assistant are top-level primaries — never nested under a session id.
 */
export const SESSION_TOOL_TABS = [
  'git',
  'diff',
  'terminal',
  'files',
  'diagram',
] as const;

export type SessionToolTab = (typeof SESSION_TOOL_TABS)[number];

/** @deprecated use SESSION_TOOL_TABS — kept for callers that still say WORKSPACE_PATH_TABS */
export const WORKSPACE_PATH_TABS = SESSION_TOOL_TABS;

export type WorkspacePathTab = SessionToolTab | typeof SCHEDULE_TAB_ID | 'assistant';

export type WorkspaceTab = WorkspacePathTab | 'chat';

export const SCHEDULE_VIEWS = ['tasks', 'history'] as const;
export type ScheduleView = (typeof SCHEDULE_VIEWS)[number];

/** @deprecated */
export type ScheduledView = ScheduleView;
/** @deprecated */
export const SCHEDULED_VIEWS = SCHEDULE_VIEWS;

export type DiffScope = 'staged' | 'working' | 'turn';

export type BuildSessionPathInput = {
  sessionId: string;
  tab?: string | null;
  file?: string | null;
  scope?: DiffScope | null;
};

export type BuildSchedulePathInput = {
  scheduleView?: ScheduleView | null;
  scheduleProjectId?: string | null;
  scheduleTaskId?: string | null;
  focusSessionId?: string | null;
  /** @deprecated aliases */
  scheduledView?: ScheduleView | null;
  scheduledProjectId?: string | null;
  scheduledTaskId?: string | null;
};

export type BuildAssistantPathInput = {
  assistantId?: string | null;
  focusSessionId?: string | null;
};

export type BuildSettingsPathInput = {
  slug: string;
  entityId?: string | null;
};

/**
 * Unified builder input used by serialize / navigation (may include exclusive primaries).
 * When tab is schedule|assistant, sessionId is ignored for path construction.
 */
export type BuildAppLocationInput = {
  sessionId?: string | null;
  tab?: string | null;
  file?: string | null;
  scope?: DiffScope | null;
  scheduleView?: ScheduleView | null;
  scheduleProjectId?: string | null;
  scheduleTaskId?: string | null;
  assistantId?: string | null;
  focusSessionId?: string | null;
  scheduledView?: ScheduleView | null;
  scheduledProjectId?: string | null;
  scheduledTaskId?: string | null;
};

export type ParsedSessionPath = {
  kind: 'session';
  sessionId: string;
  tab: WorkspaceTab;
  file: string | null;
  scope: DiffScope | null;
};

export type ParsedSchedulePath = {
  kind: 'schedule';
  scheduleView: ScheduleView;
  scheduleProjectId: string | null;
  scheduleTaskId: string | null;
  focusSessionId: string | null;
};

export type ParsedAssistantPath = {
  kind: 'assistant';
  assistantId: string | null;
  focusSessionId: string | null;
};

export type ParsedSettingsPath = {
  kind: 'settings';
  slug: SettingsPageSlug;
  entityId: string | null;
};

export type ParsedAppPath =
  | ParsedSessionPath
  | ParsedSchedulePath
  | ParsedAssistantPath
  | ParsedSettingsPath
  | { kind: 'new' }
  | { kind: 'connect' }
  | { kind: 'unknown' };

/** Canonical new-session draft path (session primary, no real session id). */
export const NEW_SESSION_PATH = '/session/new';

const SESSION_TOOL_SET = new Set<string>(SESSION_TOOL_TABS);
const SCHEDULE_VIEW_SET = new Set<string>(SCHEDULE_VIEWS);
const DIFF_SCOPE_SET = new Set<string>(['staged', 'working', 'turn']);

export function normalizeWorkspaceTab(tab: string | null | undefined): WorkspaceTab {
  if (!tab || tab === 'chat') return 'chat';
  if (tab === LEGACY_SCHEDULE_TAB_ID || tab === SCHEDULE_TAB_ID) return SCHEDULE_TAB_ID;
  if (tab === 'assistant') return 'assistant';
  if (SESSION_TOOL_SET.has(tab)) return tab as SessionToolTab;
  return 'chat';
}

export function normalizeSettingsSlug(slug: string | null | undefined): SettingsPageSlug {
  return resolveSettingsSlug(slug);
}

export function normalizeScheduleView(view: string | null | undefined): ScheduleView | null {
  if (!view) return null;
  return SCHEDULE_VIEW_SET.has(view) ? (view as ScheduleView) : null;
}

/** @deprecated */
export const normalizeScheduledView = normalizeScheduleView;

export function normalizeDiffScope(scope: string | null | undefined): DiffScope | null {
  if (!scope) return null;
  return DIFF_SCOPE_SET.has(scope) ? (scope as DiffScope) : null;
}

export function buildNewSessionPath(): string {
  return NEW_SESSION_PATH;
}

export function buildConnectPath(): string {
  return '/connect';
}

export function buildSettingsPath(
  slugOrInput: string | BuildSettingsPathInput,
  entityId?: string | null,
): string {
  const slug =
    typeof slugOrInput === 'string'
      ? normalizeSettingsSlug(slugOrInput)
      : normalizeSettingsSlug(slugOrInput.slug);
  const entity =
    typeof slugOrInput === 'string'
      ? entityId
      : slugOrInput.entityId;

  const base = `/settings/${slug}`;
  if (entity && entity.trim().length > 0) {
    return `${base}/${encodeURIComponent(entity.trim())}`;
  }
  return base;
}

function appendAgentFocus(base: string, focusSessionId?: string | null): string {
  if (focusSessionId && focusSessionId.trim().length > 0) {
    return `${base}/agent/${encodeURIComponent(focusSessionId.trim())}`;
  }
  return base;
}

/** Top-level schedule primary — never under /session/$id. */
export function buildSchedulePath(input: BuildSchedulePathInput = {}): string {
  const view = normalizeScheduleView(input.scheduleView ?? input.scheduledView) ?? 'tasks';
  const projectId = input.scheduleProjectId ?? input.scheduledProjectId ?? null;
  const taskId = input.scheduleTaskId ?? input.scheduledTaskId ?? null;

  let base: string;
  if (projectId && taskId) {
    base = `/schedule/tasks/${encodeURIComponent(projectId)}/${encodeURIComponent(taskId)}`;
  } else if (view === 'history') {
    base = '/schedule/history';
  } else {
    base = '/schedule';
  }
  return appendAgentFocus(base, input.focusSessionId);
}

/** Top-level assistant primary — never under /session/$id. */
export function buildAssistantPath(input: BuildAssistantPathInput = {}): string {
  let base = '/assistant';
  if (input.assistantId && input.assistantId.trim().length > 0) {
    base = `/assistant/${encodeURIComponent(input.assistantId.trim())}`;
  }
  return appendAgentFocus(base, input.focusSessionId);
}

/** Session primary + session tools only. */
export function buildSessionPath(input: BuildSessionPathInput): string {
  const sessionId = encodeURIComponent(input.sessionId);
  const tab = normalizeWorkspaceTab(input.tab);

  // Guard: never nest schedule/assistant under session
  if (tab === SCHEDULE_TAB_ID) {
    return buildSchedulePath({});
  }
  if (tab === 'assistant') {
    return buildAssistantPath({});
  }

  let base: string;
  if (tab === 'chat') {
    base = `/session/${sessionId}`;
  } else {
    base = `/session/${sessionId}/${tab}`;
  }

  const params = new URLSearchParams();
  if (input.file) params.set('file', input.file);
  const scope = normalizeDiffScope(input.scope);
  if (scope) params.set('scope', scope);

  const search = params.toString();
  return search ? `${base}?${search}` : base;
}

/**
 * Build any app location from a flat state bag (serialize / navigation).
 */
export function buildAppLocation(input: BuildAppLocationInput): string {
  const tab = normalizeWorkspaceTab(input.tab);

  if (tab === SCHEDULE_TAB_ID) {
    return buildSchedulePath({
      scheduleView: input.scheduleView ?? input.scheduledView,
      scheduleProjectId: input.scheduleProjectId ?? input.scheduledProjectId,
      scheduleTaskId: input.scheduleTaskId ?? input.scheduledTaskId,
      focusSessionId: input.focusSessionId,
    });
  }

  if (tab === 'assistant') {
    return buildAssistantPath({
      assistantId: input.assistantId,
      focusSessionId: input.focusSessionId,
    });
  }

  if (input.sessionId && input.sessionId.trim().length > 0) {
    return buildSessionPath({
      sessionId: input.sessionId.trim(),
      tab,
      file: input.file,
      scope: input.scope,
    });
  }

  return '/';
}

function parseSearch(search: string): {
  file: string | null;
  scope: DiffScope | null;
} {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const file = params.get('file');
  const scope = normalizeDiffScope(params.get('scope'));
  return { file, scope };
}

function splitAgentFocus(parts: string[]): { rest: string[]; focusSessionId: string | null } {
  const agentIdx = parts.indexOf('agent');
  if (agentIdx >= 0 && parts[agentIdx + 1]) {
    return {
      rest: parts.slice(0, agentIdx),
      focusSessionId: decodeURIComponent(parts[agentIdx + 1]!),
    };
  }
  return { rest: parts, focusSessionId: null };
}

function parseScheduleParts(parts: string[], focusSessionId: string | null): ParsedSchedulePath {
  // parts[0] === 'schedule' | 'scheduled'
  const sub = parts[1];
  if (!sub) {
    return {
      kind: 'schedule',
      scheduleView: 'tasks',
      scheduleProjectId: null,
      scheduleTaskId: null,
      focusSessionId,
    };
  }
  if (sub === 'history') {
    return {
      kind: 'schedule',
      scheduleView: 'history',
      scheduleProjectId: null,
      scheduleTaskId: null,
      focusSessionId,
    };
  }
  if (sub === 'tasks' && parts[2] && parts[3]) {
    return {
      kind: 'schedule',
      scheduleView: 'tasks',
      scheduleProjectId: decodeURIComponent(parts[2]),
      scheduleTaskId: decodeURIComponent(parts[3]),
      focusSessionId,
    };
  }
  return {
    kind: 'schedule',
    scheduleView: 'tasks',
    scheduleProjectId: null,
    scheduleTaskId: null,
    focusSessionId,
  };
}

/**
 * Parse path into domain location.
 *
 * Product tree:
 * - /session/$id[/$tool]
 * - /schedule[…]
 * - /assistant[…]
 * - /settings[…]
 *
 * Legacy: /session/$id/schedule|scheduled|assistant… still parses (maps to top-level kinds).
 */
export function parseAppPath(pathWithSearch: string): ParsedAppPath {
  let pathname = pathWithSearch;
  let search = '';
  const q = pathWithSearch.indexOf('?');
  if (q >= 0) {
    pathname = pathWithSearch.slice(0, q);
    search = pathWithSearch.slice(q);
  }

  const hash = pathname.indexOf('#');
  if (hash >= 0) pathname = pathname.slice(0, hash);

  // Canonical + short aliases for the new-session draft surface
  if (pathname === NEW_SESSION_PATH || pathname === '/new' || pathname === '/session/new/') {
    return { kind: 'new' };
  }
  if (pathname === '/connect') return { kind: 'connect' };

  const settingsMatch = pathname.match(/^\/settings(?:\/([^/]+)(?:\/([^/]+))?)?$/);
  if (settingsMatch) {
    return {
      kind: 'settings',
      slug: normalizeSettingsSlug(settingsMatch[1] ?? 'home'),
      entityId: settingsMatch[2] ? decodeURIComponent(settingsMatch[2]) : null,
    };
  }

  const rawParts = pathname.split('/').filter(Boolean);
  if (rawParts.length === 0) return { kind: 'unknown' };

  const { rest: parts, focusSessionId } = splitAgentFocus(rawParts);
  const head = parts[0];

  // Top-level schedule
  if (head === SCHEDULE_TAB_ID || head === LEGACY_SCHEDULE_TAB_ID) {
    return parseScheduleParts(parts, focusSessionId);
  }

  // Top-level assistant
  if (head === 'assistant') {
    return {
      kind: 'assistant',
      assistantId: parts[1] ? decodeURIComponent(parts[1]) : null,
      focusSessionId,
    };
  }

  // Session tree
  if (head === 'session') {
    const sessionId = parts[1] ? decodeURIComponent(parts[1]) : '';
    if (!sessionId) return { kind: 'unknown' };
    // Reserved: /session/new is the draft surface, never a real session id
    if (sessionId === 'new') {
      return { kind: 'new' };
    }

    const { file, scope } = parseSearch(search);
    const segment = parts[2];

    // Legacy nested schedule/assistant under session → promote to top-level kinds
    if (segment === SCHEDULE_TAB_ID || segment === LEGACY_SCHEDULE_TAB_ID) {
      return parseScheduleParts(parts.slice(2), focusSessionId);
    }
    if (segment === 'assistant') {
      return {
        kind: 'assistant',
        assistantId: parts[3] ? decodeURIComponent(parts[3]) : null,
        focusSessionId,
      };
    }

    if (!segment) {
      return {
        kind: 'session',
        sessionId,
        tab: 'chat',
        file,
        scope,
      };
    }

    const tab = normalizeWorkspaceTab(segment);
    if (tab === 'chat' && segment !== 'chat') {
      return {
        kind: 'session',
        sessionId,
        tab: 'chat',
        file,
        scope,
      };
    }

    return {
      kind: 'session',
      sessionId,
      tab,
      file,
      scope,
    };
  }

  return { kind: 'unknown' };
}
