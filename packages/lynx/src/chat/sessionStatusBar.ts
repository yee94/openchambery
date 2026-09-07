/**
 * Cap MobileSessionStatusBar helpers for Lynx — slim multi-session strip.
 *
 * Cap source: packages/ui/src/components/chat/MobileSessionStatusBar.tsx (~1900
 * lines: full sessions sheet + worktree groups + long-press menus). Lynx keeps
 * a **thin** parity surface only:
 * - related session list / switch chips
 * - busy|retry|idle status + running count (Cap SessionBusyIndicator spirit)
 * - Cap sheet filter / preserve-active-project pure resolvers (tested)
 *
 * Full Cap sheet chrome (worktree collapse store, MobileWindowMotion sheet,
 * project edit / delete worktree dialogs, DnD) is **out of scope** — do not
 * invent host Keychain / IME / camera APIs here.
 */
import type { SessionIndexSession, SessionIndexSnapshot } from '../session-index/types';
import { normalizePath } from '../path';

/** Cap pinned filter sentinel — same id string as Cap UI store. */
export const LYNX_PINNED_SESSION_FILTER_ID = '__pinned_sessions__';

export type LynxSessionStatusType = 'busy' | 'retry' | 'idle';

export type LynxSessionStatusBarItem = {
  id: string;
  title: string;
  directory: string;
  statusType: LynxSessionStatusType;
  isCurrent: boolean;
  /** Cap attention cue — unread / needsAttention when not current. */
  needsAttention?: boolean;
};

export type LynxSessionStatusBarRelatedInput = {
  id: string;
  title?: string | null;
  directory?: string | null;
  /** Cap session.status.type / session-index metadata.openchamber.sessionStatus.type */
  statusType?: string | null;
  needsAttention?: boolean;
};

/**
 * Cap `shouldPreserveActiveProjectOnSessionOpen`.
 * Cross-project scopes ("All" / pinned) must not silently move the working project.
 */
export function shouldPreserveActiveProjectOnSessionOpen(
  filterProjectId: string | null,
): boolean {
  return filterProjectId === null || filterProjectId === LYNX_PINNED_SESSION_FILTER_ID;
}

/**
 * Cap `resolveMobileSessionSheetDefaultFilter`.
 * Preserve last explicit choice; only correct stale/removed project filters.
 */
export function resolveMobileSessionSheetDefaultFilter(options: {
  activeProjectId: string | null | undefined;
  currentFilterProjectId: string | null;
  projects: readonly { id: string }[];
}): string | null {
  const { activeProjectId, currentFilterProjectId, projects } = options;
  if (currentFilterProjectId === null) return null;
  if (currentFilterProjectId === LYNX_PINNED_SESSION_FILTER_ID) return currentFilterProjectId;
  if (projects.some((project) => project.id === currentFilterProjectId)) {
    return currentFilterProjectId;
  }
  return activeProjectId ?? currentFilterProjectId;
}

export function normalizeLynxSessionStatusType(value: unknown): LynxSessionStatusType {
  if (value === 'busy' || value === 'retry') return value;
  return 'idle';
}

export const isLynxSessionStatusWorking = (status: LynxSessionStatusType): boolean =>
  status === 'busy' || status === 'retry';

export const countLynxRunningSessions = (
  items: readonly Pick<LynxSessionStatusBarItem, 'statusType'>[],
): number => items.reduce((sum, item) => sum + (isLynxSessionStatusWorking(item.statusType) ? 1 : 0), 0);

/**
 * Cap shows the busy ring when status is busy|retry. Current-session working
 * from live timeline also counts (SSE may be fresher than session-index).
 */
export const shouldShowLynxSessionBusyIndicator = (options: {
  items: readonly Pick<LynxSessionStatusBarItem, 'statusType'>[];
  currentSessionIsWorking?: boolean;
}): boolean => {
  if (options.currentSessionIsWorking) return true;
  return countLynxRunningSessions(options.items) > 0;
};

/**
 * Cap status-bar strip visibility for Lynx: show when there is something to
 * switch to, or Cap would surface a busy/unread cue.
 */
export const shouldShowLynxSessionStatusBar = (options: {
  items: readonly LynxSessionStatusBarItem[];
  currentSessionIsWorking?: boolean;
}): boolean => {
  const { items } = options;
  if (items.length >= 2) return true;
  if (shouldShowLynxSessionBusyIndicator(options)) return true;
  if (items.some((item) => item.needsAttention && !item.isCurrent)) return true;
  return false;
};

export const lynxSessionStatusBarTitle = (
  input: Pick<LynxSessionStatusBarRelatedInput, 'id' | 'title'>,
  untitledLabel = 'Untitled',
): string => {
  const trimmed = input.title?.trim();
  if (trimmed) return trimmed;
  const id = input.id.trim();
  if (!id) return untitledLabel;
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
};

export function buildLynxSessionStatusBarItems(
  related: readonly LynxSessionStatusBarRelatedInput[],
  currentSessionId: string,
  options?: { untitledLabel?: string },
): LynxSessionStatusBarItem[] {
  const untitled = options?.untitledLabel ?? 'Untitled';
  const current = currentSessionId.trim();
  const seen = new Set<string>();
  const items: LynxSessionStatusBarItem[] = [];
  for (const entry of related) {
    const id = entry.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      title: lynxSessionStatusBarTitle(entry, untitled),
      directory: normalizePath(entry.directory ?? ''),
      statusType: normalizeLynxSessionStatusType(entry.statusType),
      isCurrent: id === current,
      needsAttention: entry.needsAttention === true,
    });
  }
  // Ensure current session is present even when related list omitted it.
  if (current && !seen.has(current)) {
    items.unshift({
      id: current,
      title: lynxSessionStatusBarTitle({ id: current }, untitled),
      directory: '',
      statusType: 'idle',
      isCurrent: true,
    });
  }
  return items;
}

/**
 * Build related rows from Cap session-index snapshot (same directory preferred).
 * Newest-first by activity/updated; top-level only when parent is in the set.
 */
export function relatedSessionsFromSessionIndex(options: {
  snapshot: SessionIndexSnapshot | null | undefined;
  currentSessionId: string;
  directory?: string | null;
  /** Cap-ish bound — slim bar, not full sheet. */
  limit?: number;
  untitledLabel?: string;
}): LynxSessionStatusBarRelatedInput[] {
  const snapshot = options.snapshot;
  if (!snapshot) return [];
  const current = options.currentSessionId.trim();
  const dirFilter = normalizePath(options.directory ?? '');
  const limit = options.limit ?? 12;
  const untitled = options.untitledLabel ?? 'Untitled';

  const all: SessionIndexSession[] = [];
  for (const directory of snapshot.directories) {
    for (const session of directory.sessions) {
      if (typeof session.time.archived === 'number' && session.time.archived > 0) continue;
      all.push(session);
    }
  }

  const byId = new Map(all.map((session) => [session.id, session]));
  const isTopLevel = (session: SessionIndexSession): boolean => {
    const parent = session.parentID ?? null;
    return !parent || !byId.has(parent);
  };

  const activityAt = (session: SessionIndexSession): number => {
    const activity = session.metadata?.openchamber?.titleRefresh?.activityUpdatedAt;
    if (typeof activity === 'number' && Number.isFinite(activity) && activity > 0) return activity;
    const updated = session.time.updated;
    if (typeof updated === 'number' && Number.isFinite(updated) && updated > 0) return updated;
    return typeof session.time.created === 'number' && Number.isFinite(session.time.created)
      ? session.time.created
      : 0;
  };

  let candidates = all.filter(isTopLevel);
  if (dirFilter) {
    const sameDir = candidates.filter((session) => normalizePath(session.directory) === dirFilter);
    // Prefer same-directory peers; fall back to global top-level if directory empty.
    if (sameDir.length > 0) candidates = sameDir;
  }

  candidates.sort((a, b) => activityAt(b) - activityAt(a));

  // Always keep current near the front when present.
  const currentSession = current ? byId.get(current) : undefined;
  if (currentSession && !candidates.some((session) => session.id === current)) {
    candidates = [currentSession, ...candidates];
  } else if (current) {
    candidates = [
      ...candidates.filter((session) => session.id === current),
      ...candidates.filter((session) => session.id !== current),
    ];
  }

  return candidates.slice(0, limit).map((session) => ({
    id: session.id,
    title: session.title.trim() || untitled,
    directory: session.directory,
    statusType: session.metadata?.openchamber?.sessionStatus?.type ?? 'idle',
  }));
}

/**
 * Merge orderedSessionIds (edge-swipe order) with richer related rows.
 * Ids keep swipe order; titles/status fill from related map when present.
 */
export function mergeLynxStatusBarRelated(options: {
  orderedSessionIds?: readonly string[];
  related?: readonly LynxSessionStatusBarRelatedInput[];
  currentSessionId: string;
}): LynxSessionStatusBarRelatedInput[] {
  const relatedById = new Map(
    (options.related ?? []).map((item) => [item.id.trim(), item] as const),
  );
  const ordered = options.orderedSessionIds ?? [];
  if (ordered.length > 0) {
    const seen = new Set<string>();
    const merged: LynxSessionStatusBarRelatedInput[] = [];
    for (const rawId of ordered) {
      const id = rawId.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const hit = relatedById.get(id);
      merged.push(hit ?? { id });
    }
    for (const item of relatedById.values()) {
      const id = item.id.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(item);
    }
    const current = options.currentSessionId.trim();
    if (current && !seen.has(current)) {
      merged.unshift(relatedById.get(current) ?? { id: current });
    }
    return merged;
  }
  return options.related ? options.related.slice() : [];
}
