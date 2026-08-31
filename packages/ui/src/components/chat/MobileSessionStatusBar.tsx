import React from 'react';
import { useEvent } from '@reactuses/core';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllSessionStatuses, useAllLiveSessions } from '@/sync/sync-context';
import { useAlwaysVisibleSessionIds } from '@/components/session/sidebar/hooks/useAlwaysVisibleSessionIds';
import { selectVisibleSessions } from '@/components/session/sidebar/sessionNavigationModel';
import {
  loadMoreGlobalSessionsForDirectory,
  mergeLiveSessionWithGlobalSession,
  useGlobalSessionsStore,
  refreshGlobalSessionsForDirectories,
  syncGlobalSessionsForDirectories,
} from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { usePinnedSessionIds, useTogglePinnedSession } from '@/queries/sessionIndexPinQueries';
import { useSessionStatusBarCollapseStore } from '@/stores/useSessionStatusBarCollapseStore';
import { orderWorktrees, useWorktreeOrderStore } from '@/stores/useWorktreeOrderStore';
import type { Session } from '@opencode-ai/sdk/v2';
import type { ProjectEntry } from '@/lib/api/types';
import type { WorktreeMetadata } from '@/types/worktree';
import { getSessionActivityUpdatedAt } from '@/lib/sessionActivity';
import { cn, formatDirectoryName } from '@/lib/utils';
import { PROJECT_ICON_MAP, PROJECT_COLOR_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { Icon } from "@/components/icon/Icon";
import { NewWorktreeDialog } from '@/components/session/NewWorktreeDialog';
import { SessionBusyIndicator } from '@/components/session/SessionBusyIndicator';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useNotificationStore } from '@/sync/notification-store';
import { useI18n } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { forceRefreshProjectWorktreeCatalog } from '@/lib/worktrees/worktreeManager';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { copyTextToClipboard } from '@/lib/clipboard';
import { deleteSessionsWithUndo, showArchivedSessionsUndoToast } from '@/lib/sessionMutationUndo';
import { suppressMobileOverlayFocusRestore } from '@/lib/mobileOverlayFocusRestore';
import { isIPadApp } from '@/lib/platform';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { MobileWindowMotion } from '@/components/ui/MobileWindowMotion';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import {
  createMobileLongPressController,
  type MobileLongPressController,
} from '@/components/ui/mobileLongPress';
import { MobileDeleteWorktreeDialog } from '@/apps/MobileDeleteWorktreeDialog';
import { MobileProjectEditSurface } from '@/apps/MobileProjectEditSurface';
import { mergeMobileWorktreeRefreshResults } from '@/apps/mobileSessionPagination';
import {
  buildProjectMenuItems,
  buildSessionMenuItems,
  buildWorktreeMenuItems,
  resolveMobileMenuItemLabel,
  type MobileMenuItem,
} from '@/mobile/sessionMenuModel';
import { useMobileNavigationStore } from '@/mobile/useMobileNavigationStore';
import {
  MOBILE_SHEET_EXPANDED_SNAP,
  useMobileSheetSnap,
} from '@/components/ui/useMobileSheetSnap';
import { MobileSheetSnapHandle } from '@/components/ui/MobileSheetSnapHandle';
import {
  MOBILE_SESSIONS_WINDOW_ID,
} from '@/components/ui/MobileWindowMotionRegistry';

interface MobileSessionStatusBarProps {
  onSessionSwitch?: (sessionId: string) => void;
}

interface SessionWithStatus extends Session {
  _statusType?: 'busy' | 'retry' | 'idle';
  _hasRunningChildren?: boolean;
  _runningChildrenCount?: number;
  _childIndicators?: Array<{ session: Session; isRunning: boolean }>;
}

// Cross-project session source. Mirrors the dedicated MobileSessionsSheet:
// global sessions cover all directories (even unbootstrapped ones), while the
// live aggregate (`useAllLiveSessions`) surfaces fresher data and every
// bootstrapped directory. Merging both makes other projects' sessions appear.
function useAllProjectSessions(): Session[] {
  const liveSessions = useAllLiveSessions();
  const globalActiveSessions = useGlobalSessionsStore((state) => state.activeSessions);
  return React.useMemo(() => {
    const liveById = new Map(liveSessions.map((session) => [session.id, session]));
    const merged = globalActiveSessions.map((session) => {
      const liveSession = liveById.get(session.id);
      return liveSession ? mergeLiveSessionWithGlobalSession(liveSession, session) : session;
    });
    const seen = new Set(merged.map((session) => session.id));
    for (const session of liveSessions) {
      if (!seen.has(session.id)) merged.push(session);
    }
    return merged;
  }, [globalActiveSessions, liveSessions]);
}

const PINNED_SESSION_FILTER_ID = '__pinned_sessions__';

/**
 * Whether opening a session from the recent-sessions sheet should leave the
 * active project alone.
 *
 * "All" (null) and "Pinned" are cross-project scopes: the user browses past
 * project boundaries there, so selecting a conversation is navigation only and
 * must not silently move their working project. A concrete project filter is
 * the opposite — the user narrowed to one project, so the active project still
 * follows the session when it belongs to another project.
 */
// eslint-disable-next-line react-refresh/only-export-components -- Pure resolver is tested directly.
export function shouldPreserveActiveProjectOnSessionOpen(
  filterProjectId: string | null,
): boolean {
  return filterProjectId === null || filterProjectId === PINNED_SESSION_FILTER_ID;
}

/**
 * Resolve the project filter the recent-sessions sheet should land on when it
 * opens. Preserve the user's last explicit choice: "All" (null), the pinned
 * scope, and any filter still matching a known project. Only correct to the
 * active project when the stored filter points at a removed/unknown project
 * (not a valid "this project" or cross-project scope the user chose).
 */
// eslint-disable-next-line react-refresh/only-export-components -- Pure resolver is tested directly.
export function resolveMobileSessionSheetDefaultFilter(options: {
  activeProjectId: string | null | undefined;
  currentFilterProjectId: string | null;
  projects: readonly { id: string }[];
}): string | null {
  const { activeProjectId, currentFilterProjectId, projects } = options;
  // "All" is an explicit last choice — keep it across open transitions.
  if (currentFilterProjectId === null) return null;
  if (currentFilterProjectId === PINNED_SESSION_FILTER_ID) return currentFilterProjectId;
  if (projects.some((project) => project.id === currentFilterProjectId)) {
    return currentFilterProjectId;
  }
  // Stale filter (removed project): fall back to active project when available.
  return activeProjectId ?? currentFilterProjectId;
}

const DEFAULT_GROUP_SESSION_COUNT = 3;
const GROUP_SESSION_INCREMENT = 7;
// Normalize path for comparison
const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

// A session's directory, mirroring the store's canonical resolution.
const sessionDirectory = (session: Session): string => {
  const record = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };
  return normalize(record.directory ?? record.project?.worktree ?? '');
};

const getTopLevelSessionCount = (sessions: Session[]): number => {
  const ids = new Set(sessions.map((session) => session.id));
  return sessions.filter((session) => {
    const parentID = (session as { parentID?: string | null }).parentID;
    return !parentID || !ids.has(parentID);
  }).length;
};

interface ProjectSessionGroup {
  key: string;
  directory: string;
  label: string;
  worktree: WorktreeMetadata | null;
  sessions: SessionWithStatus[];
}

type MobileActionTarget =
  | { key: string; kind: 'project'; project: ProjectEntry; worktrees: WorktreeMetadata[]; isGitRepository: boolean }
  | { key: string; kind: 'worktree'; project: ProjectEntry; worktree: WorktreeMetadata }
  | { key: string; kind: 'session'; session: SessionWithStatus };

type LongPressHandlers = {
  pressed: boolean;
  onPointerDown: React.PointerEventHandler<HTMLElement>;
  onPointerMove: React.PointerEventHandler<HTMLElement>;
  onPointerUp: React.PointerEventHandler<HTMLElement>;
  onPointerCancel: React.PointerEventHandler<HTMLElement>;
  onContextMenu: React.MouseEventHandler<HTMLElement>;
};

type BaseUIHandlerEvent = {
  preventBaseUIHandler: () => void;
};

// eslint-disable-next-line react-refresh/only-export-components -- Pure event handler is tested directly.
export function preventMobileSessionTouchStartBaseUIHandler(event: BaseUIHandlerEvent): void {
  event.preventBaseUIHandler();
}

// eslint-disable-next-line react-refresh/only-export-components -- Pure event handler is tested directly.
export function handleMobileSessionContextMenu(
  event: React.MouseEvent<HTMLElement> & BaseUIHandlerEvent,
  pressed: boolean,
  onContextMenu: React.MouseEventHandler<HTMLElement>,
): void {
  if (!pressed) return;
  event.preventBaseUIHandler();
  onContextMenu(event);
}

function MobileActionButton({
  icon,
  label,
  onClick,
  destructive = false,
}: {
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <Button
      type="button"
      variant={destructive ? 'destructive' : 'ghost'}
      size="default"
      className="min-h-12 w-full justify-start gap-3 rounded-xl px-3"
      onClick={onClick}
      style={{ touchAction: 'manipulation' }}
    >
      <Icon name={icon} className="size-5 shrink-0" />
      <span className="truncate">{label}</span>
    </Button>
  );
}

function useSessionGrouping(
  sessions: Session[],
  sessionStatus: Record<string, { type: string }> | undefined
) {
  const unseenCounts = useNotificationStore((s) => s.index.session.unseenCount);

  const parentChildMap = React.useMemo(() => {
    const map = new Map<string, Session[]>();
    const allIds = new Set(sessions.map((s) => s.id));

    sessions.forEach((session) => {
      const parentID = (session as { parentID?: string }).parentID;
      if (parentID && allIds.has(parentID)) {
        map.set(parentID, [...(map.get(parentID) || []), session]);
      }
    });
    return map;
  }, [sessions]);

  const getStatusType = React.useCallback((sessionId: string): 'busy' | 'retry' | 'idle' => {
    const status = sessionStatus?.[sessionId];
    if (status?.type === 'busy' || status?.type === 'retry') return status.type;
    return 'idle';
  }, [sessionStatus]);

  const hasRunningChildren = React.useCallback((sessionId: string): boolean => {
    const children = parentChildMap.get(sessionId) || [];
    return children.some((child) => getStatusType(child.id) !== 'idle');
  }, [parentChildMap, getStatusType]);

  const getRunningChildrenCount = React.useCallback((sessionId: string): number => {
    const children = parentChildMap.get(sessionId) || [];
    return children.filter((child) => getStatusType(child.id) !== 'idle').length;
  }, [parentChildMap, getStatusType]);

  const getChildIndicators = React.useCallback((sessionId: string): Array<{ session: Session; isRunning: boolean }> => {
    const children = parentChildMap.get(sessionId) || [];
    return children
      .filter((child) => getStatusType(child.id) !== 'idle')
      .map((child) => ({ session: child, isRunning: true }))
      .slice(0, 3);
  }, [parentChildMap, getStatusType]);

  const processedSessions = React.useMemo(() => {
    const sessionIds = new Set(sessions.map((s) => s.id));
    const topLevel = sessions.filter((session) => {
      const parentID = (session as { parentID?: string }).parentID;
      return !parentID || !sessionIds.has(parentID);
    });

    const running: SessionWithStatus[] = [];
    const viewed: SessionWithStatus[] = [];

    topLevel.forEach((session) => {
      const statusType = getStatusType(session.id);
      const hasRunning = hasRunningChildren(session.id);
      const attention = (unseenCounts[session.id] ?? 0) > 0;

      const enriched: SessionWithStatus = {
        ...session,
        _statusType: statusType,
        _hasRunningChildren: hasRunning,
        _runningChildrenCount: getRunningChildrenCount(session.id),
        _childIndicators: getChildIndicators(session.id),
      };

      if (statusType !== 'idle' || hasRunning) {
        running.push(enriched);
      } else if (attention) {
        running.push(enriched);
      } else {
        viewed.push(enriched);
      }
    });

    const sortByActivityUpdated = (a: Session, b: Session) =>
      getSessionActivityUpdatedAt(b) - getSessionActivityUpdatedAt(a);

    running.sort(sortByActivityUpdated);
    viewed.sort(sortByActivityUpdated);

    return [...running, ...viewed];
  }, [sessions, getStatusType, hasRunningChildren, getRunningChildrenCount, getChildIndicators, unseenCounts]);

  const totalRunning = processedSessions.reduce((sum, s) => {
    const selfRunning = s._statusType !== 'idle' ? 1 : 0;
    return sum + selfRunning + (s._runningChildrenCount ?? 0);
  }, 0);

  const totalUnread = processedSessions.filter((s) => (unseenCounts[s.id] ?? 0) > 0).length;

  return { sessions: processedSessions, totalRunning, totalUnread, totalCount: processedSessions.length };
}

function useSessionHelpers() {
  const { t } = useI18n();

  const getSessionTitle = React.useCallback((session: Session): string => {
    const title = session.title;
    if (title && title.trim()) return title;
    return t('mobile.sessions.newChat');
  }, [t]);

  const unseenCounts = useNotificationStore((s) => s.index.session.unseenCount);
  const needsAttention = React.useCallback((sessionId: string): boolean => {
    return (unseenCounts[sessionId] ?? 0) > 0;
  }, [unseenCounts]);

  return { getSessionTitle, needsAttention };
}

// Per-project status indicators (running / unread) for the filter chips.
function useProjectStatus(
  sessions: Session[],
  sessionStatus: Record<string, { type: string }> | undefined,
  currentSessionId: string | null
) {
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const getSessionsByDirectory = useSessionUIStore((state) => state.getSessionsByDirectory);
  const notifUnseenCounts = useNotificationStore((s) => s.index.session.unseenCount);

  return React.useCallback((projectPath: string): { hasRunning: boolean; hasUnread: boolean } => {
    const getStatusType = (sessionId: string): 'busy' | 'retry' | 'idle' => {
      const status = sessionStatus?.[sessionId];
      if (status?.type === 'busy' || status?.type === 'retry') return status.type;
      return 'idle';
    };

    const projectRoot = normalize(projectPath);
    if (!projectRoot) return { hasRunning: false, hasUnread: false };

    const dirs: string[] = [projectRoot];
    const worktrees = availableWorktreesByProject.get(projectRoot) ?? [];
    for (const meta of worktrees) {
      const p = (meta && typeof meta === 'object' && 'path' in meta) ? (meta as { path?: unknown }).path : null;
      if (typeof p === 'string' && p.trim()) {
        const normalized = normalize(p);
        if (normalized && normalized !== projectRoot) dirs.push(normalized);
      }
    }

    const seen = new Set<string>();
    let hasRunning = false;
    let hasUnread = false;

    for (const dir of dirs) {
      for (const session of getSessionsByDirectory(dir)) {
        if (!session?.id || seen.has(session.id)) continue;
        seen.add(session.id);

        if (getStatusType(session.id) !== 'idle') hasRunning = true;
        if (session.id !== currentSessionId && (notifUnseenCounts[session.id] ?? 0) > 0) hasUnread = true;
        if (hasRunning && hasUnread) break;
      }
      if (hasRunning && hasUnread) break;
    }

    return { hasRunning, hasUnread };
  }, [getSessionsByDirectory, availableWorktreesByProject, sessionStatus, notifUnseenCounts, currentSessionId]);
}

// Resolves the project's root directories (root + known worktrees) for exact
// directory matching, mirroring the dedicated MobileSessionsSheet.
function useProjectRootsResolver() {
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);

  return React.useCallback((project: ProjectEntry): string[] => {
    const projectRoot = normalize(project.path);
    const roots = [projectRoot];
    const worktrees = availableWorktreesByProject.get(projectRoot) ?? [];
    for (const meta of worktrees) {
      const p = (meta && typeof meta === 'object' && 'path' in meta) ? (meta as { path?: unknown }).path : null;
      if (typeof p === 'string' && p.trim()) {
        const normalized = normalize(p);
        if (normalized) roots.push(normalized);
      }
    }
    return roots;
  }, [availableWorktreesByProject]);
}

function StatusIndicator({ isRunning, showUnread }: { isRunning: boolean; showUnread: boolean }) {
  if (isRunning) {
    return <SessionBusyIndicator />;
  }
  if (showUnread) {
    return <div className="h-2 w-2 rounded-full bg-[var(--status-info)]" />;
  }
  return null;
}

function RunningIndicator({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="flex items-center gap-1 text-[13px] text-[var(--surface-mutedForeground)]">
      <SessionBusyIndicator />
      {count}
    </span>
  );
}

function UnreadIndicator({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="flex items-center gap-1 text-[13px] text-[var(--status-info)]">
      <div className="h-2 w-2 rounded-full bg-[var(--status-info)]" />
      {count}
    </span>
  );
}

const clearBrowserTextSelection = (): void => {
  if (typeof window === 'undefined') return;
  const selection = window.getSelection();
  if (selection?.rangeCount) selection.removeAllRanges();
};

const MOBILE_LONG_PRESS_STYLE: React.CSSProperties = {
  touchAction: 'manipulation',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none',
};

// A single session row sized for comfortable touch.
export function SessionItem({
  session,
  isCurrent,
  isPinned,
  contextLabel,
  getSessionTitle,
  onClick,
  onRename,
  onTogglePinned,
  onShare,
  onCopyShareUrl,
  onUnshare,
  onArchive,
  onDelete,
  needsAttention,
  longPressHandlers,
}: {
  session: SessionWithStatus;
  isCurrent: boolean;
  isPinned: boolean;
  contextLabel?: string;
  getSessionTitle: (s: Session) => string;
  onClick: () => void;
  onRename: () => void;
  onTogglePinned: () => void;
  onShare: () => void;
  onCopyShareUrl: (url: string) => void;
  onUnshare: () => void;
  onArchive: () => void;
  onDelete?: () => void;
  needsAttention: (sessionId: string) => boolean;
  longPressHandlers: LongPressHandlers;
}) {
  const { t } = useI18n();
  const [contextMenuOpen, setContextMenuOpen] = React.useState(false);
  const attention = needsAttention(session.id);
  const shareUrl = session.share?.url;
  const menuItems = React.useMemo(
    () => buildSessionMenuItems({
      pinned: isPinned,
      shared: Boolean(shareUrl),
      onRename,
      onTogglePin: onTogglePinned,
      onShare: shareUrl ? undefined : onShare,
      onCopyLink: shareUrl ? () => onCopyShareUrl(shareUrl) : undefined,
      onUnshare: shareUrl ? onUnshare : undefined,
      onArchive,
      onDelete,
    }),
    [isPinned, onArchive, onCopyShareUrl, onDelete, onRename, onShare, onTogglePinned, onUnshare, shareUrl],
  );

  return (
    <ContextMenu open={contextMenuOpen} onOpenChange={setContextMenuOpen}>
      <ContextMenuTrigger
        onTouchStart={preventMobileSessionTouchStartBaseUIHandler}
        onContextMenu={(event) => {
          handleMobileSessionContextMenu(event, longPressHandlers.pressed, longPressHandlers.onContextMenu);
        }}
        render={
          <button
            type="button"
            data-mobile-session-context-trigger={session.id}
            data-mobile-long-press-trigger={`session:${session.id}`}
            onPointerDown={longPressHandlers.onPointerDown}
            onPointerMove={longPressHandlers.onPointerMove}
            onPointerUp={longPressHandlers.onPointerUp}
            onPointerCancel={longPressHandlers.onPointerCancel}
            onClick={(event) => {
              if (contextMenuOpen) {
                event.preventDefault();
                return;
              }
              onClick();
            }}
            className={cn(
              "flex w-full min-h-[56px] items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors select-none",
              "active:bg-[var(--interactive-selection)]",
              longPressHandlers.pressed && "bg-[var(--interactive-active)] scale-[0.99]",
              isCurrent ? "bg-[color-mix(in_srgb,var(--interactive-selection)_40%,transparent)]" : "hover:bg-[var(--interactive-hover)]"
            )}
            style={MOBILE_LONG_PRESS_STYLE}
          />
        }
      >
        <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
          <StatusIndicator
            isRunning={session._statusType !== 'idle'}
            showUnread={attention && !isCurrent}
          />
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={cn(
            "truncate text-[15px] leading-tight",
            isCurrent ? "font-semibold text-[var(--surface-foreground)]" : "text-[var(--surface-foreground)]"
          )}>
            {getSessionTitle(session)}
          </span>
          {contextLabel ? (
            <span className="truncate text-[12px] leading-none text-[var(--surface-mutedForeground)]">
              {contextLabel}
            </span>
          ) : null}
        </span>

        {(session._runningChildrenCount ?? 0) > 0 && (
          <span className="flex flex-shrink-0 items-center gap-1 text-[12px] text-[var(--surface-mutedForeground)]">
            <SessionBusyIndicator size={12} />
            {session._runningChildrenCount}
          </span>
        )}

        {isCurrent && (
          <Icon name="check" className="h-4 w-4 flex-shrink-0 text-[var(--primary-base)]" />
        )}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[200px] p-1.5">
        {menuItems.map((item, index) => (
          <React.Fragment key={item.id}>
            {index > 0 && (item.separated || item.id === 'archive') ? <ContextMenuSeparator /> : null}
            <ContextMenuItem className="min-h-10 px-3" onClick={item.onClick}>
              <Icon name={item.icon} className="size-4" />
              {resolveMobileMenuItemLabel(item, t)}
            </ContextMenuItem>
          </React.Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

// A project filter pill sized for touch. Selecting it filters
// the session list; it does NOT switch the active project.
interface ProjectFilterChipProps {
  label: string;
  leadingIcon?: React.ReactNode;
  icon?: string | null;
  project?: Pick<ProjectEntry, 'id' | 'iconImage'> | null;
  iconOptions?: React.ComponentProps<typeof ProjectIconImage>['options'];
  iconBackground?: string | null;
  colorVar?: string | null;
  isActive: boolean;
  status?: { hasRunning: boolean; hasUnread: boolean };
  onClick: () => void;
}

function ProjectFilterChip({
  label,
  leadingIcon,
  icon,
  project,
  iconOptions,
  iconBackground,
  colorVar,
  isActive,
  status,
  onClick,
}: ProjectFilterChipProps) {
  const projectIconName = icon ? PROJECT_ICON_MAP[icon] : null;
  const fallbackIcon = projectIconName ? (
    <Icon name={projectIconName} className="h-4 w-4" style={!isActive && colorVar ? { color: colorVar } : undefined} />
  ) : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-[40px] shrink-0 select-none items-center gap-1.5 rounded-full border px-3.5 text-[13px] leading-none whitespace-nowrap transition-colors",
        isActive
          ? "border-transparent bg-[var(--primary-base)] text-[var(--primary-foreground)] font-medium"
          : "border-[var(--interactive-border)] bg-[var(--surface-subtle)] text-[var(--surface-foreground)] active:bg-[var(--interactive-hover)]"
      )}
    >
      {leadingIcon}
      {status && (status.hasRunning || status.hasUnread) && !isActive && (
        status.hasRunning
          ? <SessionBusyIndicator size={10} />
          : <span className="h-1.5 w-1.5 rounded-full bg-[var(--status-info)]" />
      )}

      {project?.iconImage ? (
        <span
          className="inline-flex h-4 w-4 items-center justify-center overflow-hidden rounded-[2px]"
          style={iconBackground ? { backgroundColor: iconBackground } : undefined}
        >
          <ProjectIconImage
            project={project}
            options={iconOptions}
            className="h-full w-full object-contain"
            fallback={fallbackIcon}
          />
        </span>
      ) : fallbackIcon}

      <span className="max-w-[140px] truncate">{label}</span>
    </button>
  );
}

export const MobileSessionStatusBar: React.FC<MobileSessionStatusBarProps> = ({
  onSessionSwitch,
}) => {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const { currentTheme } = useThemeSystem();
  const isMobile = useUIStore((state) => state.isMobile);
  const sessions = useAllProjectSessions();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const sessionStatus = useAllSessionStatuses();
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  // Phone secondary stack owns draft presentation (ChatView selectionOverride
  // comes from the route). Calling openNewSessionDraft alone leaves the chat
  // route on the previous session — the + button looked dead.
  const startNewSessionDraft = React.useCallback((
    options?: Parameters<typeof openNewSessionDraft>[0],
  ) => {
    if (!isIPadApp()) {
      useMobileNavigationStore.getState().openDraft(options);
      return;
    }
    openNewSessionDraft(options);
  }, [openNewSessionDraft]);
  const archiveSession = useSessionUIStore((state) => state.archiveSession);
  const shareSession = useSessionUIStore((state) => state.shareSession);
  const unshareSession = useSessionUIStore((state) => state.unshareSession);
  const updateSessionTitle = useSessionUIStore((state) => state.updateSessionTitle);
  const requestSessionSmartTitle = useSessionUIStore((state) => state.requestSessionSmartTitle);
  const open = useUIStore((state) => state.mobileSessionPanelOpen);
  const setOpen = useUIStore((state) => state.setMobileSessionPanelOpen);
  const sessionSheetSnap = useMobileSheetSnap({ onDismiss: () => setOpen(false) });

  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const removeProject = useProjectsStore((state) => state.removeProject);
  const pinnedSessionIds = usePinnedSessionIds();
  const togglePinnedSession = useTogglePinnedSession();
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const worktreeOrderByProject = useWorktreeOrderStore((state) => state.orderByProject);
  const activePaginationByDirectory = useGlobalSessionsStore((state) => state.activePaginationByDirectory);
  const expandedWorktreeGroups = useSessionStatusBarCollapseStore((state) => state.expandedWorktreeGroups);
  const setWorktreeGroupExpanded = useSessionStatusBarCollapseStore((state) => state.setWorktreeGroupExpanded);

  const { sessions: sortedSessions, totalRunning, totalUnread } = useSessionGrouping(sessions, sessionStatus);
  const { getSessionTitle, needsAttention } = useSessionHelpers();
  const getProjectStatus = useProjectStatus(sessions, sessionStatus, currentSessionId);
  const resolveProjectRoots = useProjectRootsResolver();
  const [visibleCountByGroup, setVisibleCountByGroup] = React.useState<Map<string, number>>(new Map());
  const alwaysVisibleSessionIds = useAlwaysVisibleSessionIds();
  const [rootBranchesByProject, setRootBranchesByProject] = React.useState<Map<string, string>>(new Map());
  const [newWorktreeDialogOpen, setNewWorktreeDialogOpen] = React.useState(false);
  const [worktreeDialogProjectId, setWorktreeDialogProjectId] = React.useState<string | null>(null);
  const [actionTarget, setActionTarget] = React.useState<MobileActionTarget | null>(null);
  const [pressedActionKey, setPressedActionKey] = React.useState<string | null>(null);
  const [renamingSession, setRenamingSession] = React.useState<Session | null>(null);
  const [renameDraft, setRenameDraft] = React.useState('');
  const [editingProjectId, setEditingProjectId] = React.useState<string | null>(null);
  const [closingProject, setClosingProject] = React.useState<ProjectEntry | null>(null);
  const [worktreeToDelete, setWorktreeToDelete] = React.useState<{
    project: ProjectEntry;
    worktree: WorktreeMetadata;
  } | null>(null);
  const longPressControllerRef = React.useRef<MobileLongPressController | null>(null);
  if (!longPressControllerRef.current) {
    longPressControllerRef.current = createMobileLongPressController({
      onPressedKeyChange: setPressedActionKey,
    });
  }
  const worktreeTargetCacheRef = React.useRef<{ git: typeof git; path: string; isGitRepository: boolean } | null>(null);
  const [worktreeTargetIsGitRepository, setWorktreeTargetIsGitRepository] = React.useState(false);
  // Project filter persists across sheet openings. The pinned sentinel shares
  // the same state slot because it is a list scope alongside project scopes.
  const filterProjectId = useUIStore((state) => state.mobileSessionFilterProjectId);
  const setFilterProjectId = useUIStore((state) => state.setMobileSessionFilterProjectId);
  const hasPinnedSessions = React.useMemo(
    () => sortedSessions.some((session) => pinnedSessionIds.has(session.id)),
    [pinnedSessionIds, sortedSessions],
  );

  React.useEffect(() => {
    if (!hasPinnedSessions && filterProjectId === PINNED_SESSION_FILTER_ID) {
      setFilterProjectId(null);
    }
  }, [filterProjectId, hasPinnedSessions, setFilterProjectId]);

  // When the recent-sessions sheet opens, keep the last filter tab ("All",
  // pinned, or a still-valid project). Only correct a stale/removed project
  // filter to the active project. This only runs on the closed-to-open
  // transition; taps made while the sheet stays open are the user's explicit
  // choice and must not be overridden.
  const prevSheetOpenRef = React.useRef(false);
  React.useEffect(() => {
    const wasOpen = prevSheetOpenRef.current;
    prevSheetOpenRef.current = open;
    if (!open || wasOpen) return;
    const nextFilterProjectId = resolveMobileSessionSheetDefaultFilter({
      activeProjectId,
      currentFilterProjectId: filterProjectId,
      projects,
    });
    if (nextFilterProjectId !== filterProjectId) {
      setFilterProjectId(nextFilterProjectId);
    }
  }, [open, activeProjectId, filterProjectId, projects, setFilterProjectId]);

  React.useEffect(() => {
    if (open) return;
    setActionTarget(null);
    setWorktreeToDelete(null);
    longPressControllerRef.current?.reset();
  }, [open]);

  React.useEffect(() => () => {
    longPressControllerRef.current?.reset();
  }, []);

  React.useEffect(() => {
    if (!actionTarget) return;
    clearBrowserTextSelection();
    const frame = window.requestAnimationFrame(clearBrowserTextSelection);
    document.addEventListener('selectionchange', clearBrowserTextSelection);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', clearBrowserTextSelection);
      clearBrowserTextSelection();
    };
  }, [actionTarget]);

  const selectedProject = React.useMemo(
    () => filterProjectId && filterProjectId !== PINNED_SESSION_FILTER_ID
      ? projects.find((project) => project.id === filterProjectId) ?? null
      : null,
    [filterProjectId, projects],
  );

  const worktreeTargetProject = React.useMemo(
    () => selectedProject ?? projects.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projects, selectedProject],
  );

  React.useEffect(() => {
    const path = normalize(worktreeTargetProject?.path ?? '');
    if (!open || !path) {
      setWorktreeTargetIsGitRepository(false);
      return;
    }
    const cached = worktreeTargetCacheRef.current;
    if (cached?.git === git && cached.path === path) {
      setWorktreeTargetIsGitRepository(cached.isGitRepository);
      return;
    }
    let cancelled = false;
    setWorktreeTargetIsGitRepository(false);
    void git.checkIsGitRepository(path)
      .then((isGitRepository) => {
        if (cancelled) return;
        worktreeTargetCacheRef.current = { git, path, isGitRepository };
        setWorktreeTargetIsGitRepository(isGitRepository);
      })
      .catch(() => {
        if (cancelled) return;
        worktreeTargetCacheRef.current = { git, path, isGitRepository: false };
        setWorktreeTargetIsGitRepository(false);
      });
    return () => {
      cancelled = true;
    };
  }, [git, open, worktreeTargetProject]);

  React.useEffect(() => {
    if (!open || projects.length === 0) return;
    let cancelled = false;
    void Promise.all(projects.map(async (project) => ({
      projectId: project.id,
      branch: await getRootBranch(project.path).catch(() => null),
    }))).then((entries) => {
      if (cancelled) return;
      setRootBranchesByProject((previous) => {
        const next = new Map(previous);
        for (const entry of entries) {
          const branch = entry.branch?.trim();
          if (branch && branch !== 'HEAD') next.set(entry.projectId, branch);
          if (entry.branch === 'HEAD') next.delete(entry.projectId);
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [open, projects]);

  const visibleSessionDirectories = React.useMemo(() => {
    if (filterProjectId && filterProjectId !== PINNED_SESSION_FILTER_ID) {
      const project = projects.find((candidate) => candidate.id === filterProjectId);
      return project ? resolveProjectRoots(project) : [];
    }
    return projects.flatMap(resolveProjectRoots);
  }, [filterProjectId, projects, resolveProjectRoots]);

  // The panel requests bounded snapshots for the project roots it renders.
  React.useEffect(() => {
    if (open) {
      void refreshGlobalSessionsForDirectories(visibleSessionDirectories);
    }
  }, [open, visibleSessionDirectories]);

  // Refresh worktree groups when the sheet opens so project filter shows the
  // tree (root + worktrees). Without this the catalog can stay empty after a
  // cold start until another surface (iPad sheet / app bootstrap) fills it.
  React.useEffect(() => {
    if (!open || projects.length === 0) return;
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(projects.map(async (project) => {
        const path = normalize(project.path);
        if (!path) return null;
        let isGitRepo = false;
        try {
          isGitRepo = await git.checkIsGitRepository(path);
        } catch {
          return { path, status: 'failed' as const };
        }
        if (!isGitRepo) {
          return { path, status: 'success' as const, worktrees: [] as WorktreeMetadata[] };
        }
        try {
          // Align with PC/topology: force-refresh invalidates the 30s list cache
          // and merges into availableWorktreesByProject per project.
          const result = await forceRefreshProjectWorktreeCatalog(
            { id: project.id, path },
            { isCurrent: () => !cancelled },
          );
          return { path, status: 'success' as const, worktrees: result.worktrees };
        } catch {
          return { path, status: 'failed' as const };
        }
      }));
      if (cancelled) return;
      const projectPaths = new Set(projects.map((project) => normalize(project.path)).filter(Boolean));
      const results = entries.flatMap((entry) => (entry ? [entry] : []));
      useSessionUIStore.setState((state) => {
        const next = mergeMobileWorktreeRefreshResults(
          state.availableWorktreesByProject,
          projectPaths,
          results,
        );
        if (next === state.availableWorktreesByProject) return {};
        return {
          availableWorktreesByProject: next,
          availableWorktrees: Array.from(next.values()).flat(),
        };
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [git, open, projects]);

  const formatProjectLabel = React.useCallback((project: ProjectEntry): string => {
    return formatDirectoryName(project.path) || project.path;
  }, []);

  // Filter sessions by exact project/worktree directory keys so adjacent or
  // nested worktree paths remain separate groups.
  const filteredSessions = React.useMemo(() => {
    if (!filterProjectId) return sortedSessions;
    if (filterProjectId === PINNED_SESSION_FILTER_ID) {
      return sortedSessions.filter((session) => pinnedSessionIds.has(session.id));
    }
    const project = projects.find((p) => p.id === filterProjectId);
    if (!project) return sortedSessions;
    const roots = resolveProjectRoots(project);
    return sortedSessions.filter((session) => {
      const dir = sessionDirectory(session);
      return roots.some((root) => normalize(root) === dir);
    });
  }, [sortedSessions, filterProjectId, pinnedSessionIds, projects, resolveProjectRoots]);

  const projectSessionGroups = React.useMemo<ProjectSessionGroup[]>(() => {
    if (!selectedProject) return [];
    const projectRoot = normalize(selectedProject.path);
    const worktrees = orderWorktrees(
      worktreeOrderByProject[selectedProject.id],
      availableWorktreesByProject.get(projectRoot) ?? [],
    );
    const groups: ProjectSessionGroup[] = [{
      key: `${selectedProject.id}::${projectRoot}`,
      directory: projectRoot,
      label: formatProjectLabel(selectedProject),
      worktree: null,
      sessions: [],
    }];
    for (const worktree of worktrees) {
      const directory = normalize(worktree.path);
      if (!directory || directory === projectRoot || groups.some((group) => group.directory === directory)) continue;
      groups.push({
        key: `${selectedProject.id}::${directory}`,
        directory,
        label: worktree.branch || worktree.label || formatDirectoryName(directory),
        worktree,
        sessions: [],
      });
    }
    const groupByDirectory = new Map(groups.map((group) => [group.directory, group]));
    for (const session of filteredSessions) {
      groupByDirectory.get(sessionDirectory(session))?.sessions.push(session);
    }
    return groups;
  }, [availableWorktreesByProject, filteredSessions, formatProjectLabel, selectedProject, worktreeOrderByProject]);

  const sessionContextLabel = React.useCallback((session: Session): string | undefined => {
    const directory = sessionDirectory(session);
    for (const project of projects) {
      const projectRoot = normalize(project.path);
      const projectLabel = formatProjectLabel(project);
      if (directory === projectRoot) {
        const branch = rootBranchesByProject.get(project.id);
        return branch ? `${projectLabel} · ${branch}` : projectLabel;
      }
      const worktree = (availableWorktreesByProject.get(projectRoot) ?? [])
        .find((candidate) => normalize(candidate.path) === directory);
      if (worktree) return worktree.branch ? `${projectLabel} · ${worktree.branch}` : projectLabel;
    }
    return formatDirectoryName(directory) || directory || undefined;
  }, [availableWorktreesByProject, formatProjectLabel, projects, rootBranchesByProject]);

  const closeSessionPanel = React.useCallback(() => {
    setActionTarget(null);
    longPressControllerRef.current?.reset();
    setOpen(false);
  }, [setOpen]);

  const closeActionMenu = () => {
    setActionTarget(null);
    longPressControllerRef.current?.reset();
  };

  const getLongPressHandlers = (target: MobileActionTarget): LongPressHandlers => ({
    pressed: pressedActionKey === target.key || actionTarget?.key === target.key,
    onPointerDown: (event) => {
      if ((event.pointerType !== 'touch' && event.pointerType !== 'pen') || event.button !== 0) return;
      longPressControllerRef.current?.start({
        pointerId: event.pointerId,
        key: target.key,
        clientX: event.clientX,
        clientY: event.clientY,
        onTrigger: () => {
          clearBrowserTextSelection();
          setActionTarget(target);
        },
      });
    },
    onPointerMove: (event) => {
      longPressControllerRef.current?.move(event.pointerId, event.clientX, event.clientY);
    },
    onPointerUp: (event) => {
      longPressControllerRef.current?.end(event.pointerId);
    },
    onPointerCancel: (event) => {
      longPressControllerRef.current?.cancel(event.pointerId);
    },
    onContextMenu: (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearBrowserTextSelection();
      longPressControllerRef.current?.openFromContextMenu(target.key, () => setActionTarget(target));
    },
  });

  const runRowClick = (key: string, action: () => void) => {
    if (longPressControllerRef.current?.consumeClick(key)) return;
    action();
  };

  const handleSessionClick = React.useCallback((session: SessionWithStatus) => {
    // Switching sessions is navigation — suppress the overlay focus/keyboard
    // restore that would otherwise raise the old conversation's composer.
    suppressMobileOverlayFocusRestore();
    closeSessionPanel();
    const directory = sessionDirectory(session) || null;
    // Cross-project scopes ("All" / "Pinned") navigate without adopting the
    // session's project; a concrete project filter still lets the active
    // project follow the session through setCurrentSession.
    const preserveActiveProject = shouldPreserveActiveProjectOnSessionOpen(filterProjectId);
    if (!isIPadApp()) {
      // Prefer the phone nav entry so draft → session and home → session both
      // land on the chat secondary page with the correct route override.
      useMobileNavigationStore.getState().openSession({
        sessionId: session.id,
        directory,
        preserveActiveProject,
      });
    } else {
      void setCurrentSession(session.id, directory, { preserveActiveProject });
    }
    onSessionSwitch?.(session.id);
  }, [closeSessionPanel, filterProjectId, onSessionSwitch, setCurrentSession]);

  const handleShareSession = React.useCallback(async (session: Session) => {
    try {
      const shared = await shareSession(session.id);
      if (!shared?.share?.url) {
        toast.error(t('sessions.sidebar.session.share.error'));
        return;
      }
      toast.success(t('sessions.sidebar.session.share.successTitle'), {
        description: t('sessions.sidebar.session.share.successDescription'),
      });
    } catch {
      toast.error(t('sessions.sidebar.session.share.error'));
    }
  }, [shareSession, t]);

  const handleCopyShareUrl = React.useCallback(async (url: string) => {
    const result = await copyTextToClipboard(url);
    if (result.ok) {
      toast.success(t('sessions.sidebar.session.menu.copied'));
      return;
    }
    toast.error(t('sessions.sidebar.session.share.copyUrlError'));
  }, [t]);

  const handleUnshareSession = React.useCallback(async (sessionId: string) => {
    try {
      const unshared = await unshareSession(sessionId);
      if (!unshared) {
        toast.error(t('sessions.sidebar.session.unshare.error'));
        return;
      }
      toast.success(t('sessions.sidebar.session.unshare.success'));
    } catch {
      toast.error(t('sessions.sidebar.session.unshare.error'));
    }
  }, [t, unshareSession]);

  const handleArchiveSession = React.useCallback(async (sessionId: string) => {
    const archived = await archiveSession(sessionId);
    if (!archived) {
      toast.error(t('sessions.sidebar.session.archive.error'));
      return;
    }
    showArchivedSessionsUndoToast({
      sessionIds: [sessionId],
      message: t('sessions.sidebar.session.archive.success'),
      undoLabel: t('sessions.sidebar.undo'),
      settingsLabel: t('settings.openchamber.archivedSessions.actions.view'),
      undoFailedMessage: t('sessions.sidebar.session.archive.undoFailed'),
    });
  }, [archiveSession, t]);

  const collectSessionTreeIds = useEvent((sessionId: string): string[] => {
    const childrenByParent = new Map<string, string[]>();
    for (const candidate of sessions) {
      const parentID = (candidate as { parentID?: string | null }).parentID ?? null;
      if (!parentID) continue;
      const childIds = childrenByParent.get(parentID) ?? [];
      childIds.push(candidate.id);
      childrenByParent.set(parentID, childIds);
    }
    const collected: string[] = [];
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      collected.push(id);
      for (const childId of childrenByParent.get(id) ?? []) visit(childId);
    };
    visit(sessionId);
    return collected;
  });

  const handleHardDeleteSession = useEvent((session: Session) => {
    const ids = collectSessionTreeIds(session.id);
    deleteSessionsWithUndo({
      sessionIds: ids,
      message: ids.length === 1
        ? t('sessions.sidebar.session.delete.success')
        : t('sessions.sidebar.bulkActions.deletedPlural', { count: ids.length }),
      undoLabel: t('sessions.sidebar.undo'),
      commitFailedMessage: t('sessions.sidebar.session.delete.error'),
    });
  });

  // Open the same rename sheet used on mobile home / sessions list.
  const beginSessionRename = React.useCallback((session: Session) => {
    setRenameDraft(getSessionTitle(session));
    setRenamingSession(session);
  }, [getSessionTitle]);

  const handleSaveSessionRename = React.useCallback(async () => {
    if (!renamingSession) return;
    const title = renameDraft.trim();
    if (!title) return;
    try {
      await updateSessionTitle(renamingSession.id, title);
      setRenamingSession(null);
      setRenameDraft('');
    } catch {
      toast.error(t('sessions.sidebar.session.menu.rename'), {
        description: t('sessions.sidebar.dialogs.deleteResult.tryAgain'),
      });
    }
  }, [renameDraft, renamingSession, t, updateSessionTitle]);

  // Smart title only queues the server-side refresh (metadata.requestedAt).
  // Close immediately after submit — do not wait for generation to finish.
  const handleRequestSmartTitle = React.useCallback(async () => {
    if (!renamingSession) return;
    const sessionId = renamingSession.id;
    setRenamingSession(null);
    setRenameDraft('');
    try {
      await requestSessionSmartTitle(sessionId);
    } catch {
      toast.error(t('sessions.sidebar.session.rename.smartTitle'), {
        description: t('sessions.sidebar.dialogs.deleteResult.tryAgain'),
      });
    }
  }, [renamingSession, requestSessionSmartTitle, t]);

  // "+" — start a new session draft. Target the project selected in the filter;
  // for "All", use the most recently active session's directory, falling back to
  // the store's own default target when there are no sessions.
  const handleNewChat = React.useCallback(() => {
    closeSessionPanel();
    if (filterProjectId) {
      const project = projects.find((p) => p.id === filterProjectId);
      if (project) {
        startNewSessionDraft({ selectedProjectId: project.id, directoryOverride: project.path });
        return;
      }
    }
    const mostRecent = [...sessions].sort((a, b) => {
      const aTime = (a as { time?: { updated?: number } }).time?.updated ?? 0;
      const bTime = (b as { time?: { updated?: number } }).time?.updated ?? 0;
      return bTime - aTime;
    })[0];
    const directory = mostRecent ? sessionDirectory(mostRecent) : '';
    startNewSessionDraft(directory ? { directoryOverride: directory } : undefined);
  }, [closeSessionPanel, filterProjectId, projects, sessions, startNewSessionDraft]);

  const handleNewWorktree = React.useCallback(() => {
    if (!worktreeTargetProject || !worktreeTargetIsGitRepository) return;
    // Close the sessions sheet first so the worktree overlay is not stacked under
    // the same z-index MobileWindowMotion surface (both use z-[60]).
    closeSessionPanel();
    setActiveProjectIdOnly(worktreeTargetProject.id);
    setWorktreeDialogProjectId(worktreeTargetProject.id);
    setNewWorktreeDialogOpen(true);
  }, [closeSessionPanel, setActiveProjectIdOnly, worktreeTargetIsGitRepository, worktreeTargetProject]);

  const startSessionDraftForDirectory = (project: ProjectEntry, directory: string) => {
    closeActionMenu();
    setOpen(false);
    startNewSessionDraft({
      selectedProjectId: project.id,
      directoryOverride: directory,
      preserveDirectoryOverride: true,
    });
  };

  const syncProjectSessions = (target: Extract<MobileActionTarget, { kind: 'project' }>) => {
    closeActionMenu();
    void (async () => {
      try {
        await forceRefreshProjectWorktreeCatalog({ id: target.project.id, path: target.project.path });
      } catch (error) {
        console.warn('[MobileStatus] Worktree refresh before session sync failed:', error);
      }
      const latest = useSessionUIStore.getState().availableWorktreesByProject.get(target.project.path) ?? target.worktrees;
      await syncGlobalSessionsForDirectories(
        [target.project.path, ...latest.map((worktree) => worktree.path)],
        sessions,
      );
    })();
  };

  const toggleWorktreeGroup = useEvent((groupKey: string) => {
    setWorktreeGroupExpanded(groupKey, !expandedWorktreeGroups[groupKey]);
    setVisibleCountByGroup((previous) => {
      if (!previous.has(groupKey)) return previous;
      const next = new Map(previous);
      next.delete(groupKey);
      return next;
    });
  });

  const showMoreGroupSessions = React.useCallback((group: ProjectSessionGroup) => {
    const currentVisibleCount = visibleCountByGroup.get(group.key) ?? DEFAULT_GROUP_SESSION_COUNT;
    const nextVisibleCount = currentVisibleCount + GROUP_SESSION_INCREMENT;
    setVisibleCountByGroup((previous) => {
      const next = new Map(previous);
      next.set(group.key, (previous.get(group.key) ?? DEFAULT_GROUP_SESSION_COUNT) + GROUP_SESSION_INCREMENT);
      return next;
    });
    if (nextVisibleCount < group.sessions.length) return;
    const pagination = useGlobalSessionsStore.getState().activePaginationByDirectory.get(group.directory);
    if (pagination?.hasMore && !pagination.loadingMore) {
      void loadMoreGlobalSessionsForDirectory(group.directory);
    }
  }, [visibleCountByGroup]);

  const showFewerGroupSessions = React.useCallback((groupKey: string) => {
    setVisibleCountByGroup((previous) => {
      if (!previous.has(groupKey)) return previous;
      const next = new Map(previous);
      next.delete(groupKey);
      return next;
    });
  }, []);

  const renderProjectGroup = (group: ProjectSessionGroup) => {
    const isRoot = group.worktree === null;
    const expanded = isRoot || expandedWorktreeGroups[group.key] === true;
    const visibleCount = visibleCountByGroup.get(group.key) ?? DEFAULT_GROUP_SESSION_COUNT;
    const visibleSessions = selectVisibleSessions(
      group.sessions,
      visibleCount,
      alwaysVisibleSessionIds,
    );
    const pagination = activePaginationByDirectory.get(group.directory);
    const showMore = visibleSessions.length < group.sessions.length || pagination?.hasMore === true;
    const showFewer = group.sessions.length > DEFAULT_GROUP_SESSION_COUNT
      && visibleCount > DEFAULT_GROUP_SESSION_COUNT;
    const branch = isRoot && selectedProject ? rootBranchesByProject.get(selectedProject.id) : null;
    const groupLabel = group.label;
    const actionKey = isRoot
      ? `project:${selectedProject?.id ?? group.key}`
      : `worktree:${selectedProject?.id ?? group.key}:${group.directory}`;
    const longPressHandlers = selectedProject
      ? getLongPressHandlers(isRoot
        ? {
            key: actionKey,
            kind: 'project',
            project: selectedProject,
            worktrees: projectSessionGroups.flatMap((entry) => entry.worktree ? [entry.worktree] : []),
            isGitRepository: worktreeTargetIsGitRepository,
          }
        : {
            key: actionKey,
            kind: 'worktree',
            project: selectedProject,
            worktree: group.worktree!,
          })
      : null;

    return (
      <section key={group.key} className="overflow-hidden rounded-xl">
        {isRoot ? (
          <div
            data-mobile-long-press-trigger={actionKey}
            className={cn(
              "flex min-h-12 items-center gap-2 rounded-xl px-3 py-2 text-left transition-all select-none",
              longPressHandlers?.pressed && "bg-[var(--interactive-active)] scale-[0.99]",
            )}
            onPointerDown={longPressHandlers?.onPointerDown}
            onPointerMove={longPressHandlers?.onPointerMove}
            onPointerUp={longPressHandlers?.onPointerUp}
            onPointerCancel={longPressHandlers?.onPointerCancel}
            onContextMenu={longPressHandlers?.onContextMenu}
            style={MOBILE_LONG_PRESS_STYLE}
          >
            <Icon name="folder-open" className="size-4 shrink-0 text-[var(--surface-mutedForeground)]" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[14px] font-semibold text-[var(--surface-foreground)]">{groupLabel}</span>
              {branch ? (
                <span className="flex min-w-0 items-center gap-1 text-[12px] text-[var(--surface-mutedForeground)]">
                  <Icon name="git-branch" className="size-3 shrink-0" />
                  <span className="truncate">{branch}</span>
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-[12px] tabular-nums text-[var(--surface-mutedForeground)]">
              {getTopLevelSessionCount(group.sessions)}
            </span>
          </div>
        ) : (
          <button
            type="button"
            data-mobile-long-press-trigger={actionKey}
            onClick={() => runRowClick(actionKey, () => toggleWorktreeGroup(group.key))}
            onPointerDown={longPressHandlers?.onPointerDown}
            onPointerMove={longPressHandlers?.onPointerMove}
            onPointerUp={longPressHandlers?.onPointerUp}
            onPointerCancel={longPressHandlers?.onPointerCancel}
            onContextMenu={longPressHandlers?.onContextMenu}
            aria-expanded={expanded}
            aria-label={expanded
              ? t('sessions.sidebar.group.collapseAria', { label: groupLabel })
              : t('sessions.sidebar.group.expandAria', { label: groupLabel })}
            className={cn(
              "flex min-h-12 w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition-all hover:bg-[var(--interactive-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] select-none",
              longPressHandlers?.pressed && "bg-[var(--interactive-active)] scale-[0.99]",
            )}
            style={MOBILE_LONG_PRESS_STYLE}
          >
            <Icon
              name="arrow-down-s"
              className={cn('size-4 shrink-0 text-[var(--surface-mutedForeground)] transition-transform', expanded ? 'rotate-0' : '-rotate-90')}
            />
            <Icon name="node-tree" className="size-4 shrink-0 text-[var(--surface-mutedForeground)]" />
            <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-[var(--surface-foreground)]">{groupLabel}</span>
            <span className="shrink-0 text-[12px] tabular-nums text-[var(--surface-mutedForeground)]">
              {getTopLevelSessionCount(group.sessions)}
            </span>
          </button>
        )}

        {expanded ? (
          // Worktree sessions share the root list inset so titles align with
          // surrounding project sessions instead of receiving a nested indent.
          <div className="pb-1">
            {visibleSessions.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                isCurrent={session.id === currentSessionId}
                isPinned={pinnedSessionIds.has(session.id)}
                getSessionTitle={getSessionTitle}
                onClick={() => runRowClick(`session:${session.id}`, () => handleSessionClick(session))}
                onRename={() => beginSessionRename(session)}
                onTogglePinned={() => togglePinnedSession(session.id)}
                onShare={() => { void handleShareSession(session); }}
                onCopyShareUrl={(url) => { void handleCopyShareUrl(url); }}
                onUnshare={() => { void handleUnshareSession(session.id); }}
                onArchive={() => { void handleArchiveSession(session.id); }}
                onDelete={() => handleHardDeleteSession(session)}
                needsAttention={needsAttention}
                longPressHandlers={getLongPressHandlers({ key: `session:${session.id}`, kind: 'session', session })}
              />
            ))}
            {showMore || showFewer ? (
              <div className="flex min-h-10 items-center gap-2 py-1 pr-3 pl-8">
                {showMore ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={pagination?.loadingMore === true}
                    onClick={() => showMoreGroupSessions(group)}
                    className="text-muted-foreground/70 hover:text-foreground"
                  >
                    {t('sessions.sidebar.group.showMore')}
                  </Button>
                ) : null}
                {showFewer ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => showFewerGroupSessions(group.key)}
                    className="text-muted-foreground/70 hover:text-foreground"
                  >
                    {t('sessions.sidebar.group.showFewer')}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    );
  };

  const renderHeader = React.useCallback(() => (
    <div className="shrink-0">
      <MobileSheetSnapHandle controller={sessionSheetSnap} ariaLabel={t('mobile.sessions.sheet.resizeAria')} />

      <div className="flex items-center justify-between gap-2 px-4 pb-2">
        <h2 className="min-w-0 flex-1 truncate typography-ui-label font-semibold text-foreground">
          {t('mobile.sessions.sheet.title')}
        </h2>
        <div className="flex items-center gap-3">
          <RunningIndicator count={totalRunning} />
          <UnreadIndicator count={totalUnread} />
          <Button
            variant="ghost"
            size="icon"
            onClick={handleNewChat}
            aria-label={t('mobile.sessions.newChat')}
            className="text-[var(--surface-mutedForeground)]"
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="add" className="h-5 w-5" />
          </Button>
          {worktreeTargetIsGitRepository && worktreeTargetProject ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={handleNewWorktree}
              aria-label={t('sessions.sidebar.project.actions.newWorktree')}
              title={t('sessions.sidebar.project.actions.newWorktree')}
              className="text-[var(--surface-mutedForeground)]"
              style={{ touchAction: 'manipulation' }}
            >
              <Icon name="node-tree" className="size-4" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={closeSessionPanel}
            aria-label={t('mobile.surface.closeAria')}
            className="text-[var(--surface-mutedForeground)]"
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="close" className="h-5 w-5" />
          </Button>
        </div>
      </div>

      {(projects.length > 1 || hasPinnedSessions) && (
        <div
          className="flex items-center gap-2 overflow-x-auto px-4 py-2.5 scrollbar-none"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          <ProjectFilterChip
            label={t('chat.modelControls.modeValue.all')}
            isActive={filterProjectId === null}
            onClick={() => setFilterProjectId(null)}
          />
          {hasPinnedSessions ? (
            <ProjectFilterChip
              label={t('sessions.sidebar.session.actions.pinned')}
              leadingIcon={<Icon name="pushpin-2-fill" className="size-3.5" />}
              isActive={filterProjectId === PINNED_SESSION_FILTER_ID}
              onClick={() => setFilterProjectId(PINNED_SESSION_FILTER_ID)}
            />
          ) : null}
          {projects.map((project) => (
            <ProjectFilterChip
              key={project.id}
              label={formatProjectLabel(project)}
              icon={project.icon}
              project={{ id: project.id, iconImage: project.iconImage ?? null }}
              iconOptions={{
                themeVariant: currentTheme.metadata.variant,
                iconColor: currentTheme.colors.surface.foreground,
              }}
              iconBackground={project.iconBackground ?? null}
              colorVar={project.color ? (PROJECT_COLOR_MAP[project.color] ?? null) : null}
              isActive={filterProjectId === project.id}
              status={getProjectStatus(project.path)}
              onClick={() => setFilterProjectId(project.id)}
            />
          ))}
        </div>
      )}
    </div>
  ), [t, totalRunning, totalUnread, projects, hasPinnedSessions, filterProjectId, setFilterProjectId, formatProjectLabel, currentTheme, getProjectStatus, handleNewChat, handleNewWorktree, closeSessionPanel, worktreeTargetIsGitRepository, worktreeTargetProject, sessionSheetSnap]);

  const actionTargetTitle = actionTarget?.kind === 'project'
    ? formatProjectLabel(actionTarget.project)
    : actionTarget?.kind === 'worktree'
      ? actionTarget.worktree.branch || actionTarget.worktree.label || formatDirectoryName(actionTarget.worktree.path)
      : actionTarget?.kind === 'session'
        ? getSessionTitle(actionTarget.session)
        : '';

  const editingProject = React.useMemo(() => {
    if (!editingProjectId) return null;
    const project = projects.find((entry) => entry.id === editingProjectId);
    if (!project) return null;
    const projectRoot = normalize(project.path);
    const worktrees = orderWorktrees(
      worktreeOrderByProject[project.id],
      availableWorktreesByProject.get(projectRoot) ?? [],
    );
    const isGitRepo = actionTarget?.kind === 'project' && actionTarget.project.id === project.id
      ? actionTarget.isGitRepository
      : worktrees.length > 0 || Boolean(rootBranchesByProject.get(project.id));
    return {
      id: project.id,
      label: formatProjectLabel(project),
      path: projectRoot || project.path,
      icon: project.icon,
      color: project.color,
      iconImage: project.iconImage,
      iconBackground: project.iconBackground,
      isGitRepo,
      worktrees,
    };
  }, [
    actionTarget,
    availableWorktreesByProject,
    editingProjectId,
    formatProjectLabel,
    projects,
    rootBranchesByProject,
    worktreeOrderByProject,
  ]);

  const actionMenuItems = React.useMemo((): MobileMenuItem[] => {
    if (!actionTarget) return [];
    if (actionTarget.kind === 'project') {
      const project = actionTarget.project;
      return buildProjectMenuItems({
        gitRepository: actionTarget.isGitRepository,
        onNewSession: () => startSessionDraftForDirectory(project, project.path),
        onNewWorktree: () => {
          const projectId = project.id;
          closeActionMenu();
          closeSessionPanel();
          setActiveProjectIdOnly(projectId);
          setWorktreeDialogProjectId(projectId);
          setNewWorktreeDialogOpen(true);
        },
        onSyncSessions: () => syncProjectSessions(actionTarget),
        onEditProject: () => {
          closeActionMenu();
          setEditingProjectId(project.id);
        },
        onCloseProject: () => {
          closeActionMenu();
          setClosingProject(project);
        },
      });
    }
    if (actionTarget.kind === 'worktree') {
      const { project, worktree } = actionTarget;
      return buildWorktreeMenuItems({
        onNewSession: () => startSessionDraftForDirectory(project, worktree.path),
        onDeleteWorktree: () => {
          closeActionMenu();
          setWorktreeToDelete({ project, worktree });
        },
      });
    }
    const session = actionTarget.session;
    const shared = Boolean(session.share?.url);
    return buildSessionMenuItems({
      pinned: pinnedSessionIds.has(session.id),
      shared,
      onRename: () => {
        closeActionMenu();
        beginSessionRename(session);
      },
      onTogglePin: () => {
        closeActionMenu();
        togglePinnedSession(session.id);
      },
      onShare: shared
        ? undefined
        : () => {
            closeActionMenu();
            void handleShareSession(session);
          },
      onCopyLink: shared
        ? () => {
            const url = session.share?.url;
            closeActionMenu();
            if (url) void handleCopyShareUrl(url);
          }
        : undefined,
      onUnshare: shared
        ? () => {
            closeActionMenu();
            void handleUnshareSession(session.id);
          }
        : undefined,
      onArchive: () => {
        closeActionMenu();
        void handleArchiveSession(session.id);
      },
      onDelete: () => {
        closeActionMenu();
        handleHardDeleteSession(session);
      },
    });
  }, [
    actionTarget,
    beginSessionRename,
    closeActionMenu,
    closeSessionPanel,
    handleArchiveSession,
    handleCopyShareUrl,
    handleHardDeleteSession,
    handleShareSession,
    handleUnshareSession,
    pinnedSessionIds,
    setActiveProjectIdOnly,
    startSessionDraftForDirectory,
    syncProjectSessions,
    togglePinnedSession,
  ]);

  const actionMenuContent = actionMenuItems.length > 0 ? (
    <div
      className="flex flex-col gap-1"
      data-mobile-session-action-sheet={actionTarget?.kind ?? 'none'}
    >
      {actionMenuItems.map((item) => {
        const button = (
          <MobileActionButton
            key={item.id}
            icon={item.icon}
            label={resolveMobileMenuItemLabel(item, t)}
            destructive={item.destructive}
            onClick={item.onClick}
          />
        );
        if (!item.separated) return button;
        return (
          <div key={item.id} className="mt-3 border-t border-[var(--surface-subtle)] pt-3">
            {button}
          </div>
        );
      })}
    </div>
  ) : null;

  if (!isMobile) {
    return null;
  }

  return (
    <>
      <MobileWindowMotion
        id={MOBILE_SESSIONS_WINDOW_ID}
        open={open}
        onOpenChange={setOpen}
        keepMounted
        presentation="sheet"
        edge="bottom"
        dismissGesture={{ reservedTargetSelector: '[data-mobile-sheet-snap-handle]' }}
        ariaLabel={t('mobile.sessions.sheet.title')}
        surfaceClassName={sessionSheetSnap.snapPoint === MOBILE_SHEET_EXPANDED_SNAP ? 'h-[98dvh] max-h-[98dvh]' : 'h-[72dvh] max-h-[98dvh]'}
        surfaceElementRef={sessionSheetSnap.surfaceRef}
        onExitComplete={sessionSheetSnap.reset}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          {renderHeader()}
          <ScrollableOverlay
            useScrollShadow
            disableHorizontal
            preventOverscroll
            outerClassName="min-h-0 max-h-full flex-1"
            className="px-2 py-2 pwa-overlay-scroll"
          >
            <div className="flex min-h-full flex-col gap-0.5">
              {selectedProject ? (
                <>
                  {projectSessionGroups.map(renderProjectGroup)}
                  {projectSessionGroups.every((group) => group.sessions.length === 0) ? (
                    <div className="flex flex-1 items-center justify-center py-8 text-[13px] text-[var(--surface-mutedForeground)]">
                      <span>{t('chat.mobileStatus.noSessionsInProject')}</span>
                    </div>
                  ) : null}
                </>
              ) : filteredSessions.length === 0 ? (
                <div className="flex flex-1 items-center justify-center py-10 text-[13px] text-[var(--surface-mutedForeground)]">
                  <span>{t('chat.mobileStatus.noSessionsInProject')}</span>
                </div>
              ) : (
                filteredSessions.map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    isCurrent={session.id === currentSessionId}
                    isPinned={pinnedSessionIds.has(session.id)}
                    contextLabel={sessionContextLabel(session)}
                    getSessionTitle={getSessionTitle}
                    onClick={() => runRowClick(`session:${session.id}`, () => handleSessionClick(session))}
                    onRename={() => beginSessionRename(session)}
                    onTogglePinned={() => togglePinnedSession(session.id)}
                    onShare={() => { void handleShareSession(session); }}
                    onCopyShareUrl={(url) => { void handleCopyShareUrl(url); }}
                    onUnshare={() => { void handleUnshareSession(session.id); }}
                    onArchive={() => { void handleArchiveSession(session.id); }}
                    onDelete={() => handleHardDeleteSession(session)}
                    needsAttention={needsAttention}
                    longPressHandlers={getLongPressHandlers({ key: `session:${session.id}`, kind: 'session', session })}
                  />
                ))
              )}
            </div>
          </ScrollableOverlay>
        </div>
      </MobileWindowMotion>
      <MobileOverlayPanel
        open={Boolean(actionTarget)}
        title={actionTargetTitle}
        onClose={closeActionMenu}
        className="select-none"
        contentMaxHeightClassName="max-h-[min(68dvh,560px)]"
      >
        {actionMenuContent}
      </MobileOverlayPanel>
      <MobileOverlayPanel
        open={Boolean(renamingSession)}
        title={t('sessions.sidebar.session.menu.rename')}
        onClose={() => {
          setRenamingSession(null);
          setRenameDraft('');
        }}
        footer={
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              className="flex-1"
              onClick={() => {
                setRenamingSession(null);
                setRenameDraft('');
              }}
            >
              {t('sessions.sidebar.dialogs.cancel')}
            </Button>
            <Button
              type="button"
              variant="default"
              className="flex-1"
              disabled={!renameDraft.trim()}
              onClick={() => void handleSaveSessionRename()}
            >
              {t('sessions.sidebar.session.rename.save')}
            </Button>
          </div>
        }
      >
        <form
          className="flex flex-col gap-3 px-1 py-1"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSaveSessionRename();
          }}
        >
          <Input
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
            autoFocus
            className="h-12"
          />
          <Button
            type="button"
            variant="outline"
            className="w-full gap-2"
            onClick={() => void handleRequestSmartTitle()}
          >
            <Icon name="ai-generate-2" className="size-4" />
            {t('sessions.sidebar.session.rename.smartTitle')}
          </Button>
        </form>
      </MobileOverlayPanel>
      <MobileOverlayPanel
        open={Boolean(closingProject)}
        title={t('sessions.sidebar.project.actions.closeProject')}
        onClose={() => setClosingProject(null)}
        closeAriaLabel={t('mobile.surface.closeAria')}
        footer={
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              className="flex-1"
              onClick={() => setClosingProject(null)}
            >
              {t('sessions.sidebar.dialogs.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="flex-1"
              onClick={() => {
                if (!closingProject) return;
                const project = closingProject;
                setClosingProject(null);
                removeProject(project.id);
                toast.success(t('mobile.sessions.toast.projectRemoved', {
                  label: formatProjectLabel(project),
                }));
              }}
            >
              {t('mobile.sessions.confirmRemoveProject')}
            </Button>
          </div>
        }
      >
        <p className="px-1 py-1 typography-ui-label text-foreground">
          {t('mobile.projects.closeConfirmMessage', {
            title: closingProject ? formatProjectLabel(closingProject) : '',
          })}
        </p>
      </MobileOverlayPanel>
      <NewWorktreeDialog
        open={newWorktreeDialogOpen}
        projectId={worktreeDialogProjectId}
        onOpenChange={(value) => {
          setNewWorktreeDialogOpen(value);
          if (!value) setWorktreeDialogProjectId(null);
        }}
        onWorktreeCreated={(worktreePath, options) => {
          setNewWorktreeDialogOpen(false);
          setOpen(false);
          if (options?.sessionId) {
            if (!isIPadApp()) {
              useMobileNavigationStore.getState().openSession({
                sessionId: options.sessionId,
                directory: worktreePath,
              });
            } else {
              void setCurrentSession(options.sessionId, worktreePath);
            }
          } else if (worktreeDialogProjectId) {
            startNewSessionDraft({
              selectedProjectId: worktreeDialogProjectId,
              directoryOverride: worktreePath,
              preserveDirectoryOverride: true,
            });
          }
        }}
      />
      {worktreeToDelete ? (
        <MobileDeleteWorktreeDialog
          open
          project={{ id: worktreeToDelete.project.id, path: worktreeToDelete.project.path }}
          worktree={worktreeToDelete.worktree}
          onClose={() => setWorktreeToDelete(null)}
          onDeleted={() => {
            const projectPath = normalize(worktreeToDelete.project.path);
            const worktreePath = normalize(worktreeToDelete.worktree.path);
            useSessionUIStore.setState((state) => {
              const next = new Map(state.availableWorktreesByProject);
              next.set(projectPath, (next.get(projectPath) ?? []).filter((entry) => normalize(entry.path) !== worktreePath));
              return {
                availableWorktreesByProject: next,
                availableWorktrees: Array.from(next.values()).flat(),
              };
            });
            setWorktreeToDelete(null);
          }}
        />
      ) : null}
      <MobileProjectEditSurface
        open={editingProjectId !== null}
        project={editingProject}
        onClose={() => setEditingProjectId(null)}
      />
    </>
  );
};
