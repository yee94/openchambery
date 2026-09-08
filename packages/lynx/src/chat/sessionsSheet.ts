/**
 * Cap MobileSessionsSheet / MobileSessionStatusBar full-sheet helpers for Lynx.
 *
 * Portable TS over session-index home model — not Cap Zustand dumps, not the
 * ~1900-line Cap MobileSessionStatusBar surface. Cap @dnd-kit / MobileWindowMotion
 * / iPad sidebar stay deferred.
 */
import { filterLynxProjectsHomeForSearch } from '../projects/search';
import {
  projectSessionIndexHome,
  type LynxHomeProject,
  type LynxHomeSessionRow,
  type LynxProjectsHomeModel,
  type ProjectSessionIndexHomeOptions,
} from '../session-index/homeModel';
import type { SessionIndexSnapshot } from '../session-index/types';
import {
  LYNX_PINNED_SESSION_FILTER_ID,
  resolveMobileSessionSheetDefaultFilter,
  shouldPreserveActiveProjectOnSessionOpen,
} from './sessionStatusBar';

/** Cap `getMobileSessionDefaultVisibleCount` — PC sidebar cold-start slice. */
export const LYNX_SESSIONS_SHEET_DEFAULT_VISIBLE = 3;
/** Cap `getMobileSessionShowMoreIncrement`. */
export const LYNX_SESSIONS_SHEET_SHOW_MORE_INCREMENT = 7;

export type LynxSessionsSheetFilterId = string | null;

export type LynxSessionsSheetFilterChip = {
  /** `null` = All; `LYNX_PINNED_SESSION_FILTER_ID` = pinned; else project id. */
  id: LynxSessionsSheetFilterId;
  label: string;
  kind: 'all' | 'pinned' | 'project';
};

export type LynxSessionsSheetModel = {
  filterProjectId: LynxSessionsSheetFilterId;
  chips: LynxSessionsSheetFilterChip[];
  /** Filtered (+ searched) home projection. */
  model: LynxProjectsHomeModel;
  /** Flat sessions for the active filter (after search). */
  sessions: LynxHomeSessionRow[];
  hasPinnedSessions: boolean;
  empty: boolean;
  preserveActiveProjectOnOpen: boolean;
};

export const buildLynxSessionsSheetFilterChips = (options: {
  projects: readonly Pick<LynxHomeProject, 'id' | 'label'>[];
  hasPinnedSessions: boolean;
  allLabel: string;
  pinnedLabel: string;
}): LynxSessionsSheetFilterChip[] => {
  const chips: LynxSessionsSheetFilterChip[] = [
    { id: null, label: options.allLabel, kind: 'all' },
  ];
  if (options.hasPinnedSessions) {
    chips.push({
      id: LYNX_PINNED_SESSION_FILTER_ID,
      label: options.pinnedLabel,
      kind: 'pinned',
    });
  }
  for (const project of options.projects) {
    chips.push({ id: project.id, label: project.label, kind: 'project' });
  }
  return chips;
};

/**
 * Cap filter: All → full model; pinned → pinnedSessions only; project → that card.
 */
export const applyLynxSessionsSheetFilter = (
  model: LynxProjectsHomeModel,
  filterProjectId: LynxSessionsSheetFilterId,
): LynxProjectsHomeModel => {
  if (filterProjectId === null) return model;
  if (filterProjectId === LYNX_PINNED_SESSION_FILTER_ID) {
    return {
      projects: [],
      pinnedSessions: model.pinnedSessions.slice(),
      inProgressSessions: [],
      sessionById: model.sessionById,
    };
  }
  const project = model.projects.find((entry) => entry.id === filterProjectId);
  if (!project) return model;
  const belongsToProject = (session: LynxHomeSessionRow): boolean => {
    if (project.sessions.some((row) => row.id === session.id)) return true;
    if (project.worktrees.some((wt) => wt.sessions.some((row) => row.id === session.id))) return true;
    // Pinned roots are excluded from project.sessions in homeModel — match by directory.
    const dir = session.directory;
    return project.path === dir || project.worktrees.some((wt) => wt.path === dir);
  };
  return {
    projects: [project],
    pinnedSessions: model.pinnedSessions.filter(belongsToProject),
    inProgressSessions: model.inProgressSessions.filter(belongsToProject),
    sessionById: model.sessionById,
  };
};

export const flattenLynxSessionsSheetSessions = (
  model: LynxProjectsHomeModel,
  filterProjectId: LynxSessionsSheetFilterId,
): LynxHomeSessionRow[] => {
  if (filterProjectId === LYNX_PINNED_SESSION_FILTER_ID) {
    return model.pinnedSessions.slice();
  }
  // Cap: pinned first (when in scope), then project session rows (deduped).
  const seen = new Set<string>();
  const out: LynxHomeSessionRow[] = [];
  for (const session of model.pinnedSessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    out.push(session);
  }
  for (const project of model.projects) {
    for (const session of project.sessions) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      out.push(session);
    }
  }
  return out;
};

export const buildLynxSessionsSheetModel = (options: {
  snapshot: SessionIndexSnapshot | null | undefined;
  filterProjectId: LynxSessionsSheetFilterId;
  searchQuery?: string;
  activeProjectId?: string | null;
  homeOptions?: ProjectSessionIndexHomeOptions;
  allLabel?: string;
  pinnedLabel?: string;
}): LynxSessionsSheetModel => {
  const emptyModel: LynxProjectsHomeModel = {
    projects: [],
    pinnedSessions: [],
    inProgressSessions: [],
    sessionById: new Map(),
  };
  const base = options.snapshot
    ? projectSessionIndexHome(options.snapshot, options.homeOptions)
    : emptyModel;
  const hasPinnedSessions = base.pinnedSessions.length > 0;
  const resolvedFilter = resolveMobileSessionSheetDefaultFilter({
    activeProjectId: options.activeProjectId ?? null,
    currentFilterProjectId: options.filterProjectId,
    projects: base.projects,
  });
  // Cap clears pinned filter when no pins remain.
  const filterProjectId =
    resolvedFilter === LYNX_PINNED_SESSION_FILTER_ID && !hasPinnedSessions
      ? null
      : resolvedFilter;

  const filtered = applyLynxSessionsSheetFilter(base, filterProjectId);
  const searched = filterLynxProjectsHomeForSearch(filtered, options.searchQuery ?? '');
  const sessions = flattenLynxSessionsSheetSessions(searched, filterProjectId);
  const chips = buildLynxSessionsSheetFilterChips({
    projects: base.projects,
    hasPinnedSessions,
    allLabel: options.allLabel ?? 'All',
    pinnedLabel: options.pinnedLabel ?? 'Pinned',
  });

  return {
    filterProjectId,
    chips,
    model: searched,
    sessions,
    hasPinnedSessions,
    empty: sessions.length === 0 && searched.projects.every((p) => p.sessionCount === 0),
    preserveActiveProjectOnOpen: shouldPreserveActiveProjectOnSessionOpen(filterProjectId),
  };
};

export const sliceLynxSessionsSheetVisible = <T,>(
  items: readonly T[],
  visibleCount: number,
): { visible: T[]; remaining: number; canShowMore: boolean; canShowFewer: boolean } => {
  const limit = Math.max(0, Math.floor(visibleCount));
  const visible = items.slice(0, limit);
  const remaining = Math.max(0, items.length - visible.length);
  return {
    visible,
    remaining,
    canShowMore: remaining > 0,
    canShowFewer: limit > LYNX_SESSIONS_SHEET_DEFAULT_VISIBLE && items.length > LYNX_SESSIONS_SHEET_DEFAULT_VISIBLE,
  };
};

export const nextLynxSessionsSheetVisibleCount = (
  current: number,
  total: number,
): number => Math.min(total, current + LYNX_SESSIONS_SHEET_SHOW_MORE_INCREMENT);

export const collapseLynxSessionsSheetVisibleCount = (): number =>
  LYNX_SESSIONS_SHEET_DEFAULT_VISIBLE;

/**
 * Cap open-session directory: when preserve-active-project (All / pinned),
 * keep the caller's current chat directory; otherwise use the session directory.
 */
export const resolveLynxSessionsSheetOpenDirectory = (options: {
  filterProjectId: LynxSessionsSheetFilterId;
  sessionDirectory: string | null | undefined;
  currentDirectory: string | null | undefined;
}): string | null => {
  if (shouldPreserveActiveProjectOnSessionOpen(options.filterProjectId)) {
    return options.currentDirectory ?? options.sessionDirectory ?? null;
  }
  return options.sessionDirectory ?? options.currentDirectory ?? null;
};

export const LYNX_SESSIONS_SHEET_NOTES = [
  'Cap full sessions sheet spirit via LynxMobileResizableSheet (0.72 / 0.98).',
  'Grouped list from session-index projectSessionIndexHome — not Cap Zustand.',
  'Filter chips: All / pinned / project (LYNX_PINNED_SESSION_FILTER_ID).',
  'Search via filterLynxProjectsHomeForSearch; tap session → switch + close.',
  'Menus reuse buildLynx*MenuItems; honest unavailable when HTTP missing.',
  'Deferred: Cap @dnd-kit, MobileWindowMotion polish, iPad sidebar variant.',
] as const;
