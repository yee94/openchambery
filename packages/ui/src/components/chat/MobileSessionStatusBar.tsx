import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllSessionStatuses, useAllLiveSessions } from '@/sync/sync-context';
import {
  loadMoreGlobalSessionsForDirectory,
  mergeLiveSessionWithGlobalSession,
  useGlobalSessionsStore,
  refreshGlobalSessionsForDirectories,
  syncGlobalSessionsForDirectories,
} from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import type { Session } from '@opencode-ai/sdk/v2';
import type { ProjectEntry } from '@/lib/api/types';
import type { WorktreeMetadata } from '@/types/worktree';
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
import { toast } from '@/components/ui/toast';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useNotificationStore } from '@/sync/notification-store';
import { useI18n } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { forceRefreshProjectWorktreeCatalog } from '@/lib/worktrees/worktreeManager';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { copyTextToClipboard } from '@/lib/clipboard';
import { showArchivedSessionsUndoToast } from '@/lib/sessionMutationUndo';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { MobileWindowMotion } from '@/components/ui/MobileWindowMotion';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import {
  createMobileLongPressController,
  type MobileLongPressController,
} from '@/components/ui/mobileLongPress';
import { MobileDeleteWorktreeDialog } from '@/apps/MobileDeleteWorktreeDialog';
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

    const sortByUpdated = (a: Session, b: Session) => {
      const aTime = (a as unknown as { time?: { updated?: number } }).time?.updated ?? 0;
      const bTime = (b as unknown as { time?: { updated?: number } }).time?.updated ?? 0;
      return bTime - aTime;
    };

    running.sort(sortByUpdated);
    viewed.sort(sortByUpdated);

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
  onTogglePinned,
  onShare,
  onCopyShareUrl,
  onUnshare,
  onArchive,
  needsAttention,
  longPressHandlers,
}: {
  session: SessionWithStatus;
  isCurrent: boolean;
  isPinned: boolean;
  contextLabel?: string;
  getSessionTitle: (s: Session) => string;
  onClick: () => void;
  onTogglePinned: () => void;
  onShare: () => void;
  onCopyShareUrl: (url: string) => void;
  onUnshare: () => void;
  onArchive: () => void;
  needsAttention: (sessionId: string) => boolean;
  longPressHandlers: LongPressHandlers;
}) {
  const { t } = useI18n();
  const [contextMenuOpen, setContextMenuOpen] = React.useState(false);
  const attention = needsAttention(session.id);
  const shareUrl = session.share?.url;

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
        <ContextMenuItem className="min-h-10 px-3" onClick={onTogglePinned}>
          <Icon name={isPinned ? 'unpin' : 'pushpin'} className="size-4" />
          {isPinned
            ? t('sessions.sidebar.session.menu.unpin')
            : t('sessions.sidebar.session.menu.pin')}
        </ContextMenuItem>
        {shareUrl ? (
          <>
            <ContextMenuItem className="min-h-10 px-3" onClick={() => onCopyShareUrl(shareUrl)}>
              <Icon name="file-copy" className="size-4" />
              {t('sessions.sidebar.session.menu.copyLink')}
            </ContextMenuItem>
            <ContextMenuItem className="min-h-10 px-3" onClick={onUnshare}>
              <Icon name="link-unlink-m" className="size-4" />
              {t('sessions.sidebar.session.menu.unshare')}
            </ContextMenuItem>
          </>
        ) : (
          <ContextMenuItem className="min-h-10 px-3" onClick={onShare}>
            <Icon name="share-2" className="size-4" />
            {t('sessions.sidebar.session.menu.share')}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem className="min-h-10 px-3" onClick={onArchive}>
          <Icon name="inbox-archive" className="size-4" />
          {t('sessions.sidebar.bulkActions.archive')}
        </ContextMenuItem>
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
  const archiveSession = useSessionUIStore((state) => state.archiveSession);
  const shareSession = useSessionUIStore((state) => state.shareSession);
  const unshareSession = useSessionUIStore((state) => state.unshareSession);
  const open = useUIStore((state) => state.mobileSessionPanelOpen);
  const setOpen = useUIStore((state) => state.setMobileSessionPanelOpen);
  const sessionSheetSnap = useMobileSheetSnap({ onDismiss: () => setOpen(false) });

  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const pinnedSessionIds = useSessionPinnedStore((state) => state.ids);
  const togglePinnedSession = useSessionPinnedStore((state) => state.toggle);
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const activePaginationByDirectory = useGlobalSessionsStore((state) => state.activePaginationByDirectory);

  const { sessions: sortedSessions, totalRunning, totalUnread } = useSessionGrouping(sessions, sessionStatus);
  const { getSessionTitle, needsAttention } = useSessionHelpers();
  const getProjectStatus = useProjectStatus(sessions, sessionStatus, currentSessionId);
  const resolveProjectRoots = useProjectRootsResolver();
  const [expandedWorktreeGroups, setExpandedWorktreeGroups] = React.useState<Set<string>>(new Set());
  const [visibleCountByGroup, setVisibleCountByGroup] = React.useState<Map<string, number>>(new Map());
  const [rootBranchesByProject, setRootBranchesByProject] = React.useState<Map<string, string>>(new Map());
  const [newWorktreeDialogOpen, setNewWorktreeDialogOpen] = React.useState(false);
  const [worktreeDialogProjectId, setWorktreeDialogProjectId] = React.useState<string | null>(null);
  const [actionTarget, setActionTarget] = React.useState<MobileActionTarget | null>(null);
  const [pressedActionKey, setPressedActionKey] = React.useState<string | null>(null);
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
    const worktrees = availableWorktreesByProject.get(projectRoot) ?? [];
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
  }, [availableWorktreesByProject, filteredSessions, formatProjectLabel, selectedProject]);

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
    closeSessionPanel();
    void setCurrentSession(session.id, sessionDirectory(session) || null);
    onSessionSwitch?.(session.id);
  }, [closeSessionPanel, onSessionSwitch, setCurrentSession]);

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

  // "+" — start a new session draft. Target the project selected in the filter;
  // for "All", use the most recently active session's directory, falling back to
  // the store's own default target when there are no sessions.
  const handleNewChat = React.useCallback(() => {
    closeSessionPanel();
    if (filterProjectId) {
      const project = projects.find((p) => p.id === filterProjectId);
      if (project) {
        openNewSessionDraft({ selectedProjectId: project.id, directoryOverride: project.path });
        return;
      }
    }
    const mostRecent = [...sessions].sort((a, b) => {
      const aTime = (a as { time?: { updated?: number } }).time?.updated ?? 0;
      const bTime = (b as { time?: { updated?: number } }).time?.updated ?? 0;
      return bTime - aTime;
    })[0];
    const directory = mostRecent ? sessionDirectory(mostRecent) : '';
    openNewSessionDraft(directory ? { directoryOverride: directory } : undefined);
  }, [closeSessionPanel, filterProjectId, projects, sessions, openNewSessionDraft]);

  const handleNewWorktree = React.useCallback(() => {
    if (!worktreeTargetProject || !worktreeTargetIsGitRepository) return;
    setActiveProjectIdOnly(worktreeTargetProject.id);
    setWorktreeDialogProjectId(worktreeTargetProject.id);
    setNewWorktreeDialogOpen(true);
  }, [setActiveProjectIdOnly, worktreeTargetIsGitRepository, worktreeTargetProject]);

  const startSessionDraftForDirectory = (project: ProjectEntry, directory: string) => {
    closeActionMenu();
    setOpen(false);
    openNewSessionDraft({
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

  const toggleWorktreeGroup = React.useCallback((groupKey: string) => {
    setExpandedWorktreeGroups((previous) => {
      const next = new Set(previous);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
    setVisibleCountByGroup((previous) => {
      if (!previous.has(groupKey)) return previous;
      const next = new Map(previous);
      next.delete(groupKey);
      return next;
    });
  }, []);

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
    const expanded = isRoot || expandedWorktreeGroups.has(group.key);
    const visibleCount = visibleCountByGroup.get(group.key) ?? DEFAULT_GROUP_SESSION_COUNT;
    const visibleSessions = group.sessions.slice(0, visibleCount);
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
          <div className={cn('pb-1', !isRoot && 'pl-4')}>
            {visibleSessions.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                isCurrent={session.id === currentSessionId}
                isPinned={pinnedSessionIds.has(session.id)}
                getSessionTitle={getSessionTitle}
                onClick={() => runRowClick(`session:${session.id}`, () => handleSessionClick(session))}
                onTogglePinned={() => togglePinnedSession(session.id)}
                onShare={() => { void handleShareSession(session); }}
                onCopyShareUrl={(url) => { void handleCopyShareUrl(url); }}
                onUnshare={() => { void handleUnshareSession(session.id); }}
                onArchive={() => { void handleArchiveSession(session.id); }}
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

      <div className="flex items-center justify-end gap-2 px-4 pb-2">
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

  const actionMenuContent = actionTarget?.kind === 'project' ? (
    <div className="flex flex-col gap-1 pb-[max(0.5rem,env(safe-area-inset-bottom))]" data-mobile-session-action-sheet="project">
      <MobileActionButton
        icon="add"
        label={t('sessions.sidebar.project.actions.newSession')}
        onClick={() => startSessionDraftForDirectory(actionTarget.project, actionTarget.project.path)}
      />
      {actionTarget.isGitRepository ? (
        <MobileActionButton
          icon="node-tree"
          label={t('sessions.sidebar.project.actions.newWorktree')}
          onClick={() => {
            const projectId = actionTarget.project.id;
            closeActionMenu();
            setActiveProjectIdOnly(projectId);
            setWorktreeDialogProjectId(projectId);
            setNewWorktreeDialogOpen(true);
          }}
        />
      ) : null}
      <MobileActionButton
        icon="refresh"
        label={t('sessions.sidebar.project.actions.syncSessions')}
        onClick={() => syncProjectSessions(actionTarget)}
      />
    </div>
  ) : actionTarget?.kind === 'worktree' ? (
    <div className="flex flex-col gap-1 pb-[max(0.5rem,env(safe-area-inset-bottom))]" data-mobile-session-action-sheet="worktree">
      <MobileActionButton
        icon="add"
        label={t('sessions.sidebar.project.actions.newSession')}
        onClick={() => startSessionDraftForDirectory(actionTarget.project, actionTarget.worktree.path)}
      />
      <MobileActionButton
        icon="delete-bin"
        label={t('mobile.projectEdit.deleteWorktreeConfirmButton')}
        destructive
        onClick={() => {
          const target = { project: actionTarget.project, worktree: actionTarget.worktree };
          closeActionMenu();
          setWorktreeToDelete(target);
        }}
      />
    </div>
  ) : actionTarget?.kind === 'session' ? (
    <div className="flex flex-col gap-1 pb-[max(0.5rem,env(safe-area-inset-bottom))]" data-mobile-session-action-sheet="session">
      <MobileActionButton
        icon={pinnedSessionIds.has(actionTarget.session.id) ? 'unpin' : 'pushpin'}
        label={pinnedSessionIds.has(actionTarget.session.id)
          ? t('sessions.sidebar.session.menu.unpin')
          : t('sessions.sidebar.session.menu.pin')}
        onClick={() => {
          const sessionId = actionTarget.session.id;
          closeActionMenu();
          togglePinnedSession(sessionId);
        }}
      />
      {actionTarget.session.share?.url ? (
        <>
          <MobileActionButton
            icon="file-copy"
            label={t('sessions.sidebar.session.menu.copyLink')}
            onClick={() => {
              const url = actionTarget.session.share?.url;
              closeActionMenu();
              if (url) void handleCopyShareUrl(url);
            }}
          />
          <MobileActionButton
            icon="link-unlink-m"
            label={t('sessions.sidebar.session.menu.unshare')}
            onClick={() => {
              const sessionId = actionTarget.session.id;
              closeActionMenu();
              void handleUnshareSession(sessionId);
            }}
          />
        </>
      ) : (
        <MobileActionButton
          icon="share-2"
          label={t('sessions.sidebar.session.menu.share')}
          onClick={() => {
            const session = actionTarget.session;
            closeActionMenu();
            void handleShareSession(session);
          }}
        />
      )}
      <MobileActionButton
        icon="archive"
        label={t('sessions.sidebar.bulkActions.archive')}
        onClick={() => {
          const sessionId = actionTarget.session.id;
          closeActionMenu();
          void handleArchiveSession(sessionId);
        }}
      />
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
                    onTogglePinned={() => togglePinnedSession(session.id)}
                    onShare={() => { void handleShareSession(session); }}
                    onCopyShareUrl={(url) => { void handleCopyShareUrl(url); }}
                    onUnshare={() => { void handleUnshareSession(session.id); }}
                    onArchive={() => { void handleArchiveSession(session.id); }}
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
      <NewWorktreeDialog
        open={newWorktreeDialogOpen}
        onOpenChange={(value) => {
          setNewWorktreeDialogOpen(value);
          if (!value) setWorktreeDialogProjectId(null);
        }}
        onWorktreeCreated={(worktreePath, options) => {
          setNewWorktreeDialogOpen(false);
          setOpen(false);
          if (options?.sessionId) {
            void setCurrentSession(options.sessionId, worktreePath);
          } else if (worktreeDialogProjectId) {
            openNewSessionDraft({
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
    </>
  );
};
