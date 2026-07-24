import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2/client';
import { useEvent } from '@reactuses/core';

import { DirectoryExplorerDialog } from '@/components/session/DirectoryExplorerDialog';
import { Icon } from '@/components/icon/Icon';
import { NewWorktreeDialog } from '@/components/session/NewWorktreeDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import {
  createMobileLongPressController,
  type MobileLongPressController,
} from '@/components/ui/mobileLongPress';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { cn } from '@/lib/utils';
import { forceRefreshProjectWorktreeCatalog, listProjectWorktrees } from '@/lib/worktrees/worktreeManager';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import {
  loadMoreGlobalSessionsForDirectory,
  mergeLiveSessionWithGlobalSession,
  syncGlobalSessionsForDirectories,
  useGlobalSessionsStore,
} from '@/stores/useGlobalSessionsStore';
import { useMobileSessionExpansionStore } from '@/stores/useMobileSessionExpansionStore';
import { useMobileSessionTreeStore } from '@/stores/useMobileSessionTreeStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { orderWorktrees, useWorktreeOrderStore } from '@/stores/useWorktreeOrderStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllLiveSessions, useAllSessionStatuses } from '@/sync/sync-context';
import type { WorktreeMetadata } from '@/types/worktree';
import { SessionBusyIndicator } from '@/components/session/SessionBusyIndicator';
import { deleteSessionsWithUndo, showArchivedSessionsUndoToast } from '@/lib/sessionMutationUndo';
import { abortCurrentOperation } from '@/sync/session-actions';

import { MobileProjectEditSurface } from './MobileProjectEditSurface';
import { MobileDeleteWorktreeDialog } from './MobileDeleteWorktreeDialog';
import { getMobileSessionPageSize, mergeMobileWorktreeRefreshResults } from './mobileSessionPagination';
import { MobileSurfaceShell } from './MobileSurfaceShell';

type MobileSessionsSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 'sheet' (default) wraps the content in the swipe-dismiss MobileSurfaceShell;
      'sidebar' renders the same content inline for the iPad persistent sidebar. */
  variant?: 'sheet' | 'sidebar';
};

type ProjectMeta = {
  id: string;
  label: string;
  path: string;
  icon?: string | null;
  color?: string | null;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
  iconBackground?: string | null;
  isGitRepo: boolean;
  worktrees: WorktreeMetadata[];
};

type WorktreeBucket = {
  /** Stable key — usually the worktree path (or project root). */
  key: string;
  /** Display label — branch name when available, else folder name. */
  label: string;
  /** Filesystem path used as `directory` for new sessions started here. */
  path: string;
  /** Underlying worktree metadata, null when this bucket represents the project root. */
  worktree: WorktreeMetadata | null;
  /** Sessions matched into this bucket, sorted by recency desc. */
  sessions: Session[];
};

type ProjectNode = {
  project: ProjectMeta;
  buckets: WorktreeBucket[];
  totalSessions: number;
  isActive: boolean;
};

type MobileActionTarget =
  | { key: string; kind: 'project'; project: ProjectMeta }
  | { key: string; kind: 'worktree'; project: ProjectMeta; worktree: WorktreeMetadata }
  | { key: string; kind: 'session'; session: Session };

type LongPressHandlers = {
  pressed: boolean;
  onPointerDown: React.PointerEventHandler<HTMLButtonElement>;
  onPointerMove: React.PointerEventHandler<HTMLButtonElement>;
  onPointerUp: React.PointerEventHandler<HTMLButtonElement>;
  onPointerCancel: React.PointerEventHandler<HTMLButtonElement>;
  onContextMenu: React.MouseEventHandler<HTMLButtonElement>;
};

// Left padding for session rows so the title's first letter aligns with its
// parent label. Root/project-level sessions align with the project label;
// worktree sessions sit one level deeper. SessionRow adds 16px (dot + gap) on top.
const PROJECT_SESSION_INDENT = 36;
const WORKTREE_SESSION_INDENT = 52;
// Extra left padding applied to each nested subsession level.
const CHILD_INDENT_STEP = 18;

const getParentId = (session: Session): string | null =>
  (session as Session & { parentID?: string | null }).parentID ?? null;

const normalizePath = (value?: string | null): string =>
  (value || '').replace(/\\/g, '/').replace(/\/+$/g, '');

const getSessionDirectory = (session: Session): string => {
  const sessionWithDirectory = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };
  return normalizePath(sessionWithDirectory.directory ?? sessionWithDirectory.project?.worktree ?? null);
};

const getProjectLabel = (path: string): string => {
  const normalized = normalizePath(path);
  if (!normalized) return '';
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] || normalized;
};

const getSessionTimestamp = (session: Session): number => {
  const raw = session.time?.updated ?? session.time?.created;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

const setsEqual = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && [...a].every((value) => b.has(value));

const formatRelativeShort = (timestamp: number): string => {
  if (timestamp <= 0) return '';
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) return 'now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(timestamp));
};

const pathBelongsToRoot = (path: string, root: string): boolean => {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  return Boolean(
    normalizedPath &&
      normalizedRoot &&
      (normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)),
  );
};

const findExactWorktreeMatch = (project: ProjectMeta, normalizedDirectory: string): WorktreeMetadata | null => (
  project.worktrees.find((worktree) => normalizePath(worktree.path) === normalizedDirectory) ?? null
);

const projectMatchesExactDirectory = (project: ProjectMeta, normalizedDirectory: string): boolean => (
  normalizedDirectory === project.path || Boolean(findExactWorktreeMatch(project, normalizedDirectory))
);

const findExactProjectMatch = (projects: ProjectMeta[], directory: string): ProjectMeta | null => {
  const normalizedDirectory = normalizePath(directory);
  if (!normalizedDirectory) return null;
  return projects.find((project) => projectMatchesExactDirectory(project, normalizedDirectory)) ?? null;
};

const sessionMatchesQuery = (session: Session, projectLabel: string, query: string): boolean => {
  if (!query) return true;
  const haystack = `${session.title ?? ''} ${session.id} ${getSessionDirectory(session)} ${projectLabel}`.toLowerCase();
  return haystack.includes(query);
};

const MobileProjectIcon: React.FC<{
  project: Pick<ProjectMeta, 'id' | 'icon' | 'color' | 'iconImage' | 'iconBackground'>;
  size?: 'sm' | 'md';
}> = ({ project, size = 'md' }) => {
  const containerClasses = size === 'sm' ? 'size-6 rounded-md' : 'size-8 rounded-lg';
  const innerClasses = size === 'sm' ? 'size-3.5' : 'size-4';
  const iconName = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
  const iconColor = project.color ? PROJECT_COLOR_MAP[project.color] : undefined;
  const fallback = <Icon name={iconName ?? 'folder-open'} className={innerClasses} style={iconColor ? { color: iconColor } : undefined} />;

  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden text-muted-foreground',
        containerClasses,
      )}
    >
      {project.iconImage ? (
        <ProjectIconImage
          project={project}
          className="size-full object-contain"
          fallback={fallback}
        />
      ) : fallback}
    </span>
  );
};

const ChevronToggle: React.FC<{ expanded: boolean }> = ({ expanded }) => (
  <span
    aria-hidden
    className={cn(
      'flex size-5 shrink-0 items-center justify-center text-muted-foreground/70 transition-transform duration-150',
      expanded ? 'rotate-0' : '-rotate-90',
    )}
  >
    <Icon name="arrow-down-s" className="size-4" />
  </span>
);

const ActiveDot: React.FC<{ ariaLabel?: string }> = ({ ariaLabel }) => (
  <span
    className="inline-block size-1.5 shrink-0 rounded-full bg-primary"
    aria-label={ariaLabel}
  />
);

const NewWorktreeIconButton: React.FC<{
  onClick: () => void;
  className?: string;
}> = ({ onClick, className }) => {
  const { t } = useI18n();
  const label = t('sessions.sidebar.project.actions.newWorktree');

  return (
    <button
      type="button"
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--surface-mutedForeground)] transition-colors hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
        className,
      )}
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      style={{ touchAction: 'manipulation' }}
    >
      <Icon name="node-tree" className="size-4" />
    </button>
  );
};

const MobileActionButton: React.FC<{
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  onClick: () => void;
  destructive?: boolean;
}> = ({ icon, label, onClick, destructive = false }) => (
  <Button
    type="button"
    variant={destructive ? 'destructive' : 'ghost'}
    size="default"
    className="min-h-12 w-full justify-start gap-3 rounded-xl px-3 typography-ui-label"
    onClick={onClick}
    style={{ touchAction: 'manipulation' }}
  >
    <Icon name={icon} className="size-5 shrink-0" />
    <span className="truncate">{label}</span>
  </Button>
);

const SessionRow: React.FC<{
  session: Session;
  active: boolean;
  indent: number;
  /** When provided, shown as a small second-line subtitle below the title (e.g. "Project · branch"). */
  contextLabel?: string;
  /** When true, the row shows the two-step archive confirmation. */
  confirmingArchive?: boolean;
  /** When true, a chevron is shown in the left gutter to toggle nested subsessions. */
  hasChildren?: boolean;
  expanded?: boolean;
  onToggleChildren?: () => void;
  onSelect: () => void;
  /** When provided, an archive affordance is shown; first tap arms confirm, X cancels. */
  onRequestArchive?: () => void;
  onConfirmArchive?: () => void;
  /** When provided, a stop button is shown on the row. */
  onStop?: () => void;
  /** Aria label for the stop button. */
  stopAriaLabel?: string;
  longPressHandlers: LongPressHandlers;
}> = ({
  session,
  active,
  indent,
  contextLabel,
  confirmingArchive = false,
  hasChildren = false,
  expanded = false,
  onToggleChildren,
  onSelect,
  onRequestArchive,
  onConfirmArchive,
  onStop,
  stopAriaLabel,
  longPressHandlers,
}) => {
  const { t } = useI18n();
  const time = formatRelativeShort(getSessionTimestamp(session));
  const title = session.title?.trim() || t('mobile.sessions.untitled');
  return (
    <div
      className={cn(
        'relative flex items-center gap-1 transition-colors',
        active && !confirmingArchive && 'bg-[color-mix(in_srgb,var(--primary)_10%,transparent)]',
        confirmingArchive && 'bg-[color-mix(in_srgb,var(--destructive)_8%,transparent)]',
      )}
    >
      {hasChildren && onToggleChildren ? (
        <button
          type="button"
          className="absolute z-10 flex w-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          style={{ left: Math.max(indent - 32, 2), top: 0, bottom: 0, touchAction: 'manipulation' }}
          aria-label={expanded
            ? t('sessions.sidebar.session.subsessions.collapse')
            : t('sessions.sidebar.session.subsessions.expand')}
          onClick={(event) => {
            event.stopPropagation();
            onToggleChildren();
          }}
        >
          <Icon name="arrow-down-s" className={cn('size-[18px] transition-transform duration-150', expanded ? 'rotate-0' : '-rotate-90')} />
        </button>
      ) : null}
      <button
        type="button"
        className={cn(
          'flex min-h-12 min-w-0 flex-1 items-center gap-2.5 py-2 pr-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset',
          confirmingArchive && 'opacity-50',
          longPressHandlers.pressed && 'bg-interactive-active scale-[0.99]',
        )}
        style={{ paddingLeft: indent, touchAction: 'manipulation' }}
        onClick={onSelect}
        onPointerDown={longPressHandlers.onPointerDown}
        onPointerMove={longPressHandlers.onPointerMove}
        onPointerUp={longPressHandlers.onPointerUp}
        onPointerCancel={longPressHandlers.onPointerCancel}
        onContextMenu={longPressHandlers.onContextMenu}
        disabled={confirmingArchive}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2.5">
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                active ? 'bg-primary' : 'bg-muted-foreground/30',
              )}
              aria-hidden
            />
            <span
              className={cn(
                'block min-w-0 flex-1 truncate typography-ui-label',
                active ? 'text-primary' : 'text-foreground',
              )}
            >
              {title}
            </span>
            {time ? (
              <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">{time}</span>
            ) : null}
          </span>
          {contextLabel ? (
            <span className="block truncate typography-micro text-muted-foreground pl-4">{contextLabel}</span>
          ) : null}
        </span>
      </button>
      {onStop ? (
        <button
          type="button"
          className="mr-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl text-[var(--surface-mutedForeground)] transition-colors hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
          aria-label={stopAriaLabel}
          onClick={(event) => {
            event.stopPropagation();
            onStop();
          }}
          style={{ touchAction: 'manipulation' }}
        >
          <SessionBusyIndicator />
        </button>
      ) : null}
      {onRequestArchive ? (
        <>
          {confirmingArchive ? (
            <button
              type="button"
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-destructive px-3 text-destructive-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
              aria-label={t('mobile.sessions.archiveSessionAria', { title })}
              onClick={onConfirmArchive}
              style={{ touchAction: 'manipulation' }}
            >
              <Icon name="archive" className="size-4" />
              <span className="typography-ui-label">{t('sessions.sidebar.bulkActions.archive')}</span>
            </button>
          ) : null}
          <button
            type="button"
            className="mr-1.5 flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground/70 transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={
              confirmingArchive
                ? t('mobile.sessions.cancelArchiveAria', { title })
                : t('mobile.sessions.archiveSessionAria', { title })
            }
            onClick={onRequestArchive}
            style={{ touchAction: 'manipulation' }}
          >
            {confirmingArchive ? <Icon name="close" className="size-4" /> : <Icon name="archive" className="size-4" />}
          </button>
        </>
      ) : null}
    </div>
  );
};

const PaginationRow: React.FC<{
  indent: number;
  showMore: boolean;
  showFewer: boolean;
  loadingMore?: boolean;
  onShowMore?: () => void;
  onShowFewer?: () => void;
}> = ({ indent, showMore, showFewer, loadingMore = false, onShowMore, onShowFewer }) => {
  const { t } = useI18n();
  if (!showMore && !showFewer) return null;
  return (
    <div
      className="flex min-h-10 w-full items-center gap-3 py-1.5 pr-3 text-muted-foreground"
      style={{ paddingLeft: indent, touchAction: 'manipulation' }}
    >
      {showMore ? (
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1.5 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-60',
            loadingMore && 'animate-pulse',
          )}
          onClick={onShowMore}
          disabled={loadingMore}
        >
          <Icon name="arrow-down-s" className="size-4" />
          <span className="typography-micro">{t('sessions.sidebar.group.showMore')}</span>
        </button>
      ) : null}
      {showFewer ? (
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
          onClick={onShowFewer}
        >
          <Icon name="arrow-up-s" className="size-4" />
          <span className="typography-micro">{t('sessions.sidebar.group.showFewer')}</span>
        </button>
      ) : null}
    </div>
  );
};

export const MobileSessionsSheet: React.FC<MobileSessionsSheetProps> = ({ open, onOpenChange, variant = 'sheet' }) => {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const liveSessions = useAllLiveSessions();
  const globalActiveSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const activePaginationByDirectory = useGlobalSessionsStore((state) => state.activePaginationByDirectory);
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const worktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const archiveSession = useSessionUIStore((state) => state.archiveSession);
  const archiveSessions = useSessionUIStore((state) => state.archiveSessions);
  const updateSessionTitle = useSessionUIStore((state) => state.updateSessionTitle);
  const shareSession = useSessionUIStore((state) => state.shareSession);
  const unshareSession = useSessionUIStore((state) => state.unshareSession);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const setActiveProject = useProjectsStore((state) => state.setActiveProject);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const removeProject = useProjectsStore((state) => state.removeProject);
  const pinnedSessionIds = useSessionPinnedStore((state) => state.ids);
  const togglePinnedSession = useSessionPinnedStore((state) => state.toggle);
  const projectExpandedMap = useMobileSessionTreeStore((state) => state.projectExpanded);
  const worktreeExpandedMap = useMobileSessionTreeStore((state) => state.worktreeExpanded);
  const setProjectExpanded = useMobileSessionTreeStore((state) => state.setProjectExpanded);
  const setWorktreeExpanded = useMobileSessionTreeStore((state) => state.setWorktreeExpanded);
  const worktreeOrderByProject = useWorktreeOrderStore((state) => state.orderByProject);
  const expandedParents = useMobileSessionExpansionStore((state) => state.expandedParents);
  const toggleParent = useMobileSessionExpansionStore((state) => state.toggleParent);
  const [query, setQuery] = React.useState('');
  const [editingProjectId, setEditingProjectId] = React.useState<string | null>(null);
  const [confirmingArchiveSessionId, setConfirmingArchiveSessionId] = React.useState<string | null>(null);
  // Bumped to force a re-list of worktrees (e.g. after one is deleted in the editor).
  const [worktreeRefreshKey, setWorktreeRefreshKey] = React.useState(0);
  const [directoryDialogOpen, setDirectoryDialogOpen] = React.useState(false);
  const [newWorktreeDialogOpen, setNewWorktreeDialogOpen] = React.useState(false);
  const [worktreeDialogProjectId, setWorktreeDialogProjectId] = React.useState<string | null>(null);
  const [actionTarget, setActionTarget] = React.useState<MobileActionTarget | null>(null);
  const [pressedActionKey, setPressedActionKey] = React.useState<string | null>(null);
  const [renamingSession, setRenamingSession] = React.useState<Session | null>(null);
  const [renameDraft, setRenameDraft] = React.useState('');
  const [worktreeToDelete, setWorktreeToDelete] = React.useState<{
    project: ProjectMeta;
    worktree: WorktreeMetadata;
  } | null>(null);
  const longPressControllerRef = React.useRef<MobileLongPressController | null>(null);
  if (!longPressControllerRef.current) {
    longPressControllerRef.current = createMobileLongPressController({
      onPressedKeyChange: setPressedActionKey,
    });
  }
  const [gitProjectPaths, setGitProjectPaths] = React.useState<Set<string>>(new Set());
  const [rootBranchesByProject, setRootBranchesByProject] = React.useState<Map<string, string>>(new Map());
  // Per-bucket count of sessions revealed past the default page. Ephemeral —
  // resets when the sheet closes, while group/project collapse preserves it.
  // Expand state itself lives in useMobileSessionTreeStore (persisted).
  // Key: `${projectId}::${bucketKey}`.
  const [visibleCountByBucket, setVisibleCountByBucket] = React.useState<Map<string, number>>(new Map());

  const allStatuses = useAllSessionStatuses();

  // Single-pass running session map: session ID → true if busy or retry.
  const runningSessionMap = React.useMemo<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    for (const [id, status] of Object.entries(allStatuses)) {
      map[id] = status.type === 'busy' || status.type === 'retry';
    }
    return map;
  }, [allStatuses]);

  // Abort helpers retain stable event identities for prop passing.
  const handleStopSession = useEvent((sessionId: string) => {
    void abortCurrentOperation(sessionId);
  });

  const handleStopSessions = useEvent((sessionIds: string[]) => {
    void Promise.all(sessionIds.map((id) => abortCurrentOperation(id)));
  });

  React.useEffect(() => {
    if (!open) {
      setQuery('');
      setVisibleCountByBucket(new Map());
      setEditingProjectId(null);
      setConfirmingArchiveSessionId(null);
      setActionTarget(null);
      setRenamingSession(null);
      setWorktreeToDelete(null);
      longPressControllerRef.current?.reset();
      return;
    }
  }, [open]);

  React.useEffect(() => () => {
    longPressControllerRef.current?.reset();
  }, []);

  React.useEffect(() => {
    if (!open) return;
    if (projects.length === 0) {
      useSessionUIStore.setState((state) => {
        const next = mergeMobileWorktreeRefreshResults(state.availableWorktreesByProject, new Set(), []);
        if (next === state.availableWorktreesByProject) return {};
        return { availableWorktreesByProject: next, availableWorktrees: [] };
      });
      setGitProjectPaths((previous) => (previous.size === 0 ? previous : new Set()));
      setRootBranchesByProject((previous) => (previous.size === 0 ? previous : new Map()));
      return;
    }
    let cancelled = false;
    const run = async () => {
      const entries = await Promise.all(
        projects.map(async (project) => {
          const path = normalizePath(project.path);
          if (!path) return null;
          let isGitRepo: boolean;
          try {
            isGitRepo = await git.checkIsGitRepository(path);
          } catch {
            return { id: project.id, path, gitStatus: 'failed' as const };
          }
          if (!isGitRepo) {
            return {
              id: project.id,
              path,
              gitStatus: 'success' as const,
              isGitRepo,
              worktreeStatus: 'success' as const,
              worktrees: [],
            };
          }
          const [worktreeResult, rootBranchResult] = await Promise.allSettled([
            listProjectWorktrees({ id: project.id, path }),
            getRootBranch(path),
          ]);
          return {
            id: project.id,
            path,
            gitStatus: 'success' as const,
            isGitRepo,
            worktreeStatus: worktreeResult.status === 'fulfilled' ? 'success' as const : 'failed' as const,
            worktrees: worktreeResult.status === 'fulfilled' ? worktreeResult.value : undefined,
            rootBranchStatus: rootBranchResult.status === 'fulfilled' ? 'success' as const : 'failed' as const,
            rootBranch: rootBranchResult.status === 'fulfilled' ? rootBranchResult.value : undefined,
          };
        }),
      );
      if (cancelled) return;
      const projectPaths = new Set(projects.map((project) => normalizePath(project.path)).filter(Boolean));
      const worktreeResults = entries.flatMap((entry) => (
        entry?.worktreeStatus
          ? [{ path: entry.path, status: entry.worktreeStatus, worktrees: entry.worktrees }]
          : []
      ));
      useSessionUIStore.setState((state) => {
        const next = mergeMobileWorktreeRefreshResults(
          state.availableWorktreesByProject,
          projectPaths,
          worktreeResults,
        );
        if (next === state.availableWorktreesByProject) return {};
        return {
          availableWorktreesByProject: next,
          availableWorktrees: Array.from(next.values()).flat(),
        };
      });
      setGitProjectPaths((previous) => {
        const next = new Set([...previous].filter((path) => projectPaths.has(path)));
        for (const entry of entries) {
          if (entry?.gitStatus !== 'success') continue;
          if (entry.isGitRepo) next.add(entry.path);
          else next.delete(entry.path);
        }
        return setsEqual(next, previous) ? previous : next;
      });
      setRootBranchesByProject((previous) => {
        const projectIds = new Set(projects.map((project) => project.id));
        const branches = new Map([...previous].filter(([id]) => projectIds.has(id)));
        for (const entry of entries) {
          if (!entry || entry.gitStatus !== 'success') continue;
          if (!entry.isGitRepo) {
            branches.delete(entry.id);
            continue;
          }
          if (entry.rootBranchStatus !== 'success') continue;
          const branch = entry.rootBranch?.trim();
          if (branch && branch !== 'HEAD') branches.set(entry.id, branch);
          else branches.delete(entry.id);
        }
        return branches.size === previous.size && [...branches].every(([id, branch]) => previous.get(id) === branch)
          ? previous
          : branches;
      });
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [git, open, projects, worktreeRefreshKey]);

  const projectsMeta = React.useMemo<ProjectMeta[]>(
    () =>
      projects.map((project) => ({
        id: project.id,
        label: getProjectLabel(project.path),
        path: normalizePath(project.path),
        icon: project.icon,
        color: project.color,
        iconImage: project.iconImage,
        iconBackground: project.iconBackground,
        isGitRepo: gitProjectPaths.has(normalizePath(project.path)),
        worktrees: orderWorktrees(
          worktreeOrderByProject[project.id],
          worktreesByProject.get(normalizePath(project.path)) ?? [],
        ),
      })),
    [gitProjectPaths, projects, worktreeOrderByProject, worktreesByProject],
  );

  /**
   * Global sessions cover all directories — even unbootstrapped ones — so the tree shows
   * accurate counts even when a worktree's live store hasn't been hydrated yet. Live
   * sessions overlay for fresher data on the active directory.
   */
  const sessions = React.useMemo(() => {
    const liveById = new Map(liveSessions.map((session) => [session.id, session]));
    const merged = globalActiveSessions.map((session) => {
      const liveSession = liveById.get(session.id);
      return liveSession ? mergeLiveSessionWithGlobalSession(liveSession, session) : session;
    });
    const seenIds = new Set(merged.map((session) => session.id));
    for (const session of liveSessions) {
      if (!seenIds.has(session.id)) merged.push(session);
    }
    return merged;
  }, [globalActiveSessions, liveSessions]);

  const normalizedQuery = query.trim().toLowerCase();

  const projectNodes = React.useMemo<ProjectNode[]>(() => {
    const nodes: ProjectNode[] = projectsMeta.map((project) => ({
      project,
      buckets: [] as WorktreeBucket[],
      totalSessions: 0,
      isActive: project.id === activeProjectId,
    }));

    const ensureBucket = (node: ProjectNode, path: string, worktree: WorktreeMetadata | null): WorktreeBucket => {
      const normalizedBucketPath = normalizePath(path) || node.project.path;
      const key = normalizedBucketPath || '__root__';
      let bucket = node.buckets.find((entry) => entry.key === key);
      if (!bucket) {
        bucket = {
          key,
          label: worktree?.branch || getProjectLabel(normalizedBucketPath),
          path: normalizedBucketPath,
          worktree,
          sessions: [],
        };
        node.buckets.push(bucket);
      }
      return bucket;
    };

    for (const node of nodes) {
      ensureBucket(node, node.project.path, null);
      for (const worktree of node.project.worktrees) ensureBucket(node, worktree.path, worktree);
    }

    for (const session of sessions) {
      const directory = getSessionDirectory(session);
      if (!directory) continue;
      const normalizedDirectory = normalizePath(directory);
      const node = nodes.find((entry) => projectMatchesExactDirectory(entry.project, normalizedDirectory));
      if (!node) continue;
      const matchedWorktree = findExactWorktreeMatch(node.project, normalizedDirectory);
      const bucket = matchedWorktree
        ? ensureBucket(node, matchedWorktree.path, matchedWorktree)
        : ensureBucket(node, node.project.path, null);
      bucket.sessions.push(session);
    }

    for (const node of nodes) {
      for (const bucket of node.buckets) {
        bucket.sessions.sort((a, b) => getSessionTimestamp(b) - getSessionTimestamp(a));
        for (const session of bucket.sessions) {
          if (!getParentId(session)) node.totalSessions += 1;
        }
      }
    }

    return nodes;
  }, [activeProjectId, projectsMeta, sessions]);

  const normalizedDirectory = normalizePath(currentDirectory);

  const findActiveWorktreePath = (node: ProjectNode): string | null => {
    if (!node.isActive) return null;
    if (normalizedDirectory === node.project.path) return node.project.path;
    const matched = node.project.worktrees.find((entry) => pathBelongsToRoot(normalizedDirectory, entry.path));
    return matched?.path ?? node.project.path;
  };

  // Expansion is the user's own choice (persisted), independent of the active
  // directory: projects default to expanded, worktree groups to collapsed.
  const isProjectExpanded = (node: ProjectNode): boolean =>
    projectExpandedMap[node.project.id] ?? true;

  const isWorktreeExpanded = (node: ProjectNode, bucket: WorktreeBucket): boolean =>
    worktreeExpandedMap[`${node.project.id}::${bucket.key}`] ?? false;

  const resetBucketVisibleCount = (bucketKey: string) => {
    setVisibleCountByBucket((previous) => {
      if (!previous.has(bucketKey)) return previous;
      const next = new Map(previous);
      next.delete(bucketKey);
      return next;
    });
  };

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
        onTrigger: () => setActionTarget(target),
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
      longPressControllerRef.current?.openFromContextMenu(target.key, () => setActionTarget(target));
    },
  });

  const runRowClick = (key: string, action: () => void) => {
    if (longPressControllerRef.current?.consumeClick(key)) return;
    action();
  };

  const showMoreBucketSessions = (
    bucketKey: string,
    directory: string,
    currentVisibleCount: number,
    totalSessions: number,
    pageSize: number,
  ) => {
    setVisibleCountByBucket((previous) => {
      const next = new Map(previous);
      const current = Math.max(pageSize, previous.get(bucketKey) ?? pageSize, currentVisibleCount);
      next.set(bucketKey, current + pageSize);
      return next;
    });
    const nextVisibleCount = Math.max(pageSize, currentVisibleCount) + pageSize;
    if (nextVisibleCount < totalSessions) return;
    const normalizedBucketDirectory = normalizePath(directory);
    if (!normalizedBucketDirectory) return;
    const pagination = useGlobalSessionsStore
      .getState()
      .activePaginationByDirectory.get(normalizedBucketDirectory);
    if (pagination?.hasMore && !pagination.loadingMore) {
      void loadMoreGlobalSessionsForDirectory(normalizedBucketDirectory);
    }
  };

  // Paginated, tree-aware list of a bucket's sessions: top-level sessions paginate,
  // and a parent with subsessions can be expanded to reveal its children (nested,
  // recursively). Pagination counts only top-level sessions.
  const renderBucketSessions = (node: ProjectNode, bucket: WorktreeBucket, indent: number) => {
    const bucketKey = `${node.project.id}::${bucket.key}`;
    const pageSize = getMobileSessionPageSize(node.project.worktrees.length > 0);

    // Group children by parent within this bucket, and treat sessions whose parent
    // is not in this bucket as top-level so nothing is hidden.
    const idsInBucket = new Set(bucket.sessions.map((entry) => entry.id));
    const childrenByParent = new Map<string, Session[]>();
    for (const candidate of bucket.sessions) {
      const parentId = getParentId(candidate);
      if (parentId && idsInBucket.has(parentId)) {
        const list = childrenByParent.get(parentId) ?? [];
        list.push(candidate);
        childrenByParent.set(parentId, list);
      }
    }
    const roots = bucket.sessions.filter((entry) => {
      const parentId = getParentId(entry);
      return !parentId || !idsInBucket.has(parentId);
    });

    const visibleCount = visibleCountByBucket.get(bucketKey) ?? pageSize;
    const visibleRoots = roots.slice(0, visibleCount);
    const remaining = roots.length - visibleRoots.length;
    const pagination = activePaginationByDirectory.get(normalizePath(bucket.path));
    const hasRemoteSessions = pagination?.hasMore === true;
    const isLoadingRemoteSessions = pagination?.loadingMore === true;
    // Show fewer whenever the rendered list is past the default page, even if
    // more remain — so "more" and "fewer" can appear together for fold / load-more.
    const canShowFewer = roots.length > pageSize
      && (visibleRoots.length > pageSize || visibleCount > pageSize);

    const renderNode = (session: Session, rowIndent: number): React.ReactNode => {
      const children = childrenByParent.get(session.id) ?? [];
      const hasChildren = children.length > 0;
      const expanded = Boolean(expandedParents[session.id]);
      const isRunning = runningSessionMap[session.id] || false;
      const runningChildIds = hasChildren && !expanded ? (children.filter((c) => runningSessionMap[c.id]).map((c) => c.id)) : [];
      const hasRunningHiddenChildren = runningChildIds.length > 0;
      const stopIds = isRunning
        ? [session.id, ...runningChildIds]
        : runningChildIds;
      const title = session.title?.trim() || t('mobile.sessions.untitled');
      const actionKey = `session:${session.id}`;
      return (
        <React.Fragment key={session.id}>
          <SessionRow
            session={session}
            active={currentSessionId === session.id}
            indent={rowIndent}
            hasChildren={hasChildren}
            expanded={expanded}
            onToggleChildren={hasChildren ? () => toggleParent(session.id) : undefined}
            confirmingArchive={confirmingArchiveSessionId === session.id}
            onSelect={() => runRowClick(actionKey, () => handleSelectSession(session))}
            onRequestArchive={() => handleRequestArchive(session.id)}
            onConfirmArchive={() => void handleConfirmArchive(session)}
            onStop={(isRunning || hasRunningHiddenChildren) ? () => handleStopSessions(stopIds) : undefined}
            stopAriaLabel={
              hasRunningHiddenChildren
                ? t('mobile.sessions.stopSubsessionsAria', { title })
                : t('mobile.sessions.stopSessionAria', { title })
            }
            longPressHandlers={getLongPressHandlers({ key: actionKey, kind: 'session', session })}
          />
          {hasChildren && expanded
            ? children.map((child) => renderNode(child, rowIndent + CHILD_INDENT_STEP))
            : null}
        </React.Fragment>
      );
    };

    return (
      <div>
        {visibleRoots.map((session) => renderNode(session, indent))}
        <PaginationRow
          indent={indent}
          showMore={remaining > 0 || hasRemoteSessions}
          showFewer={canShowFewer}
          loadingMore={isLoadingRemoteSessions}
          onShowMore={() => showMoreBucketSessions(bucketKey, bucket.path, visibleRoots.length, roots.length, pageSize)}
          onShowFewer={() => resetBucketVisibleCount(bucketKey)}
        />
      </div>
    );
  };

  const toggleProject = (projectId: string, currentlyExpanded: boolean) => {
    setProjectExpanded(projectId, !currentlyExpanded);
  };

  const toggleWorktree = (projectId: string, bucketKey: string, currentlyExpanded: boolean) => {
    setWorktreeExpanded(`${projectId}::${bucketKey}`, !currentlyExpanded);
  };

  const handleSelectSession = (session: Session) => {
    const directory = getSessionDirectory(session) || null;
    // Switching session switches the working directory (handled by
    // setCurrentSession) — also move the active project so the rest of the app
    // and the active highlight follow the selected session, not just the draft.
    const project = findExactProjectMatch(projectsMeta, directory ?? '');
    if (project) setActiveProjectIdOnly(project.id);
    void setCurrentSession(session.id, directory);
    onOpenChange(false);
  };

  // Two-step archive: first tap arms the confirm on that row, second confirms.
  // Only one row can be in the confirming state at a time.
  const handleRequestArchive = (sessionId: string) => {
    setConfirmingArchiveSessionId((current) => (current === sessionId ? null : sessionId));
  };

  const handleConfirmArchive = async (session: Session) => {
    setConfirmingArchiveSessionId(null);
    const ok = await archiveSession(session.id);
    if (ok) {
      showArchivedSessionsUndoToast({
        sessionIds: [session.id],
        message: t('sessions.sidebar.session.archive.success'),
        undoLabel: t('sessions.sidebar.undo'),
        settingsLabel: t('settings.openchamber.archivedSessions.actions.view'),
        undoFailedMessage: t('sessions.sidebar.session.archive.undoFailed'),
      });
    } else {
      toast.error(t('sessions.sidebar.session.archive.error'));
    }
  };

  const handleStartNewChat = () => {
    openNewSessionDraft();
    onOpenChange(false);
  };

  const handleNewWorktree = (projectId: string) => {
    setWorktreeDialogProjectId(projectId);
    setActiveProjectIdOnly(projectId);
    setNewWorktreeDialogOpen(true);
  };

  const collectSessionTreeIds = (sessionId: string): string[] => {
    const childrenByParent = new Map<string, string[]>();
    for (const candidate of sessions) {
      const parentId = getParentId(candidate);
      if (!parentId) continue;
      const childIds = childrenByParent.get(parentId) ?? [];
      childIds.push(candidate.id);
      childrenByParent.set(parentId, childIds);
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
  };

  const handleArchiveFromMenu = async (session: Session) => {
    const ids = collectSessionTreeIds(session.id);
    const { archivedIds, failedIds } = await archiveSessions(ids);
    if (archivedIds.length > 0) {
      showArchivedSessionsUndoToast({
        sessionIds: archivedIds,
        message: archivedIds.length === 1
          ? t('sessions.sidebar.session.archive.success')
          : t('sessions.sidebar.bulkActions.archivedPlural', { count: archivedIds.length }),
        undoLabel: t('sessions.sidebar.undo'),
        settingsLabel: t('settings.openchamber.archivedSessions.actions.view'),
        undoFailedMessage: archivedIds.length === 1
          ? t('sessions.sidebar.session.archive.undoFailed')
          : t('sessions.sidebar.bulkActions.archiveUndoFailed', { count: archivedIds.length }),
      });
    }
    if (failedIds.length > 0) {
      toast.error(failedIds.length === 1
        ? t('sessions.sidebar.bulkActions.failedArchiveSingle', { count: failedIds.length })
        : t('sessions.sidebar.bulkActions.failedArchivePlural', { count: failedIds.length }));
    }
  };

  const handleHardDeleteSession = (session: Session) => {
    const ids = collectSessionTreeIds(session.id);
    deleteSessionsWithUndo({
      sessionIds: ids,
      message: ids.length === 1
        ? t('sessions.sidebar.session.delete.success')
        : t('sessions.sidebar.bulkActions.deletedPlural', { count: ids.length }),
      undoLabel: t('sessions.sidebar.undo'),
      commitFailedMessage: t('sessions.sidebar.session.delete.error'),
    });
  };

  const handleShareFromMenu = async (session: Session) => {
    try {
      const result = await shareSession(session.id);
      if (!result?.share?.url) {
        toast.error(t('sessions.sidebar.session.share.error'));
        return;
      }
      toast.success(t('sessions.sidebar.session.share.successTitle'), {
        description: t('sessions.sidebar.session.share.successDescription'),
      });
    } catch {
      toast.error(t('sessions.sidebar.session.share.error'));
    }
  };

  const handleCopyShareUrl = async (url: string) => {
    const result = await copyTextToClipboard(url);
    if (result.ok) {
      toast.success(t('sessions.sidebar.session.menu.copied'));
      return;
    }
    toast.error(t('sessions.sidebar.session.share.copyUrlError'));
  };

  const handleUnshareFromMenu = async (sessionId: string) => {
    try {
      const result = await unshareSession(sessionId);
      if (result) {
        toast.success(t('sessions.sidebar.session.unshare.success'));
        return;
      }
      toast.error(t('sessions.sidebar.session.unshare.error'));
    } catch {
      toast.error(t('sessions.sidebar.session.unshare.error'));
    }
  };

  const handleSaveSessionRename = async () => {
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
  };

  const startSessionDraftForDirectory = (project: ProjectMeta, directory: string) => {
    setActiveProjectIdOnly(project.id);
    openNewSessionDraft({
      selectedProjectId: project.id,
      directoryOverride: directory,
      preserveDirectoryOverride: true,
    });
    onOpenChange(false);
  };

  const syncProjectSessions = (project: ProjectMeta) => {
    void (async () => {
      // Re-list git worktrees before session-index sync so newly created trees
      // land in the SQLite catalog, not only the already-cached sidebar paths.
      try {
        await forceRefreshProjectWorktreeCatalog({ id: project.id, path: project.path });
      } catch (error) {
        console.warn('[MobileSessions] Worktree refresh before session sync failed:', error);
      }
      const latest = useSessionUIStore.getState().availableWorktreesByProject.get(project.path) ?? project.worktrees;
      const directories = [project.path, ...latest.map((worktree) => worktree.path)];
      await syncGlobalSessionsForDirectories(directories, sessions);
    })();
  };

  /** Short "Project · branch" string shown under the session title in search results. */
  const buildSessionContextLabel = (session: Session): string => {
    const directory = getSessionDirectory(session);
    const project = findExactProjectMatch(projectsMeta, directory);
    if (!project) return getProjectLabel(directory) || directory;
    const matchedWorktree = findExactWorktreeMatch(project, normalizePath(directory));
    if (matchedWorktree?.branch) return `${project.label} · ${matchedWorktree.branch}`;
    return project.label;
  };

  const handleSelectProject = (project: ProjectMeta) => {
    setActiveProject(project.id);
    onOpenChange(false);
  };

  const filteredNodes = React.useMemo(() => {
    if (!normalizedQuery) return projectNodes;
    return projectNodes.filter((node) => {
      if (`${node.project.label} ${node.project.path}`.toLowerCase().includes(normalizedQuery)) return true;
      return node.buckets.some((bucket) =>
        bucket.sessions.some((session) => sessionMatchesQuery(session, node.project.label, normalizedQuery)),
      );
    });
  }, [normalizedQuery, projectNodes]);

  // Project order follows the newest session activity under each project.
  const orderedNodes = filteredNodes;

  // Flat lists used only by the dedicated search-results view.
  const searchSessionMatches = React.useMemo(() => {
    if (!normalizedQuery) return [] as Session[];
    return sessions
      .filter((session) => {
        const directory = getSessionDirectory(session);
        const project = findExactProjectMatch(projectsMeta, directory);
        return sessionMatchesQuery(session, project?.label ?? '', normalizedQuery);
      })
      .sort((a, b) => getSessionTimestamp(b) - getSessionTimestamp(a));
  }, [normalizedQuery, projectsMeta, sessions]);

  const searchProjectMatches = React.useMemo(() => {
    if (!normalizedQuery) return [] as Array<ProjectMeta & { sessionCount: number }>;
    return projectsMeta
      .filter((project) => `${project.label} ${project.path}`.toLowerCase().includes(normalizedQuery))
      .map((project) => ({
        ...project,
        sessionCount: sessions.filter((session) => {
          if (getParentId(session)) return false;
          const directory = normalizePath(getSessionDirectory(session));
          return projectMatchesExactDirectory(project, directory);
        }).length,
      }));
  }, [normalizedQuery, projectsMeta, sessions]);

  const hasNoMatches =
    normalizedQuery && searchSessionMatches.length === 0 && searchProjectMatches.length === 0;

  const newChatButton =
    projectsMeta.length > 0 ? (
      <Button
        type="button"
        variant="default"
        size="sm"
        aria-label={t('mobile.sessions.newChat')}
        onClick={handleStartNewChat}
        style={{ touchAction: 'manipulation' }}
      >
        <Icon name="add" className="size-4" />
        {t('mobile.sessions.newChat')}
      </Button>
    ) : null;

  const activeProject = projectsMeta.find((project) => project.id === activeProjectId) ?? null;
  const newWorktreeButton = activeProject?.isGitRepo ? (
    <Button
      type="button"
      variant="chip"
      size="sm"
      aria-label={t('sessions.sidebar.project.actions.newWorktree')}
      title={t('sessions.sidebar.project.actions.newWorktree')}
      onClick={() => handleNewWorktree(activeProject.id)}
      style={{ touchAction: 'manipulation' }}
    >
      <Icon name="node-tree" className="size-4" />
    </Button>
  ) : null;

  const addProjectButton = (
    <Button
      type="button"
      variant="chip"
      size="sm"
      aria-label={t('sessions.sidebar.header.actions.addProject')}
      title={t('sessions.sidebar.header.actions.addProject')}
      onClick={() => setDirectoryDialogOpen(true)}
      style={{ touchAction: 'manipulation' }}
    >
      <Icon name="folder-add" className="size-4" />
    </Button>
  );

  const trailingActions =
    newChatButton || addProjectButton ? (
      <>
        {newChatButton}
        {newWorktreeButton}
        {addProjectButton}
      </>
    ) : null;

  const actionTargetTitle = actionTarget?.kind === 'project'
    ? actionTarget.project.label
    : actionTarget?.kind === 'worktree'
      ? actionTarget.worktree.branch || actionTarget.worktree.label || actionTarget.worktree.path
      : actionTarget?.kind === 'session'
        ? actionTarget.session.title?.trim() || t('mobile.sessions.untitled')
        : '';

  const actionMenuContent = actionTarget?.kind === 'project' ? (
    <div className="flex flex-col gap-1">
      <MobileActionButton
        icon="add"
        label={t('sessions.sidebar.project.actions.newSession')}
        onClick={() => {
          const project = actionTarget.project;
          closeActionMenu();
          startSessionDraftForDirectory(project, project.path);
        }}
      />
      {actionTarget.project.isGitRepo ? (
        <MobileActionButton
          icon="node-tree"
          label={t('sessions.sidebar.project.actions.newWorktree')}
          onClick={() => {
            const projectId = actionTarget.project.id;
            closeActionMenu();
            handleNewWorktree(projectId);
          }}
        />
      ) : null}
      <MobileActionButton
        icon="refresh"
        label={t('sessions.sidebar.project.actions.syncSessions')}
        onClick={() => {
          const project = actionTarget.project;
          closeActionMenu();
          syncProjectSessions(project);
        }}
      />
      <MobileActionButton
        icon="pencil-ai"
        label={t('sessions.sidebar.project.actions.edit')}
        onClick={() => {
          const projectId = actionTarget.project.id;
          closeActionMenu();
          setEditingProjectId(projectId);
        }}
      />
      <MobileActionButton
        icon="close"
        label={t('sessions.sidebar.project.actions.closeProject')}
        destructive
        onClick={() => {
          const projectId = actionTarget.project.id;
          closeActionMenu();
          removeProject(projectId);
        }}
      />
    </div>
  ) : actionTarget?.kind === 'worktree' ? (
    <div className="flex flex-col gap-1">
      <MobileActionButton
        icon="add"
        label={t('sessions.sidebar.project.actions.newSession')}
        onClick={() => {
          const { project, worktree } = actionTarget;
          closeActionMenu();
          startSessionDraftForDirectory(project, worktree.path);
        }}
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
    <div className="flex flex-col gap-1">
      <MobileActionButton
        icon="pencil-ai"
        label={t('sessions.sidebar.session.menu.rename')}
        onClick={() => {
          const session = actionTarget.session;
          closeActionMenu();
          setRenameDraft(session.title?.trim() || t('mobile.sessions.untitled'));
          setRenamingSession(session);
        }}
      />
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
              void handleUnshareFromMenu(sessionId);
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
            void handleShareFromMenu(session);
          }}
        />
      )}
      <MobileActionButton
        icon="archive"
        label={t('sessions.sidebar.bulkActions.archive')}
        onClick={() => {
          const session = actionTarget.session;
          closeActionMenu();
          void handleArchiveFromMenu(session);
        }}
      />
      <MobileActionButton
        icon="delete-bin"
        label={t('sessions.sidebar.bulkActions.delete')}
        destructive
        onClick={() => {
          const session = actionTarget.session;
          closeActionMenu();
          handleHardDeleteSession(session);
        }}
      />
    </div>
  ) : null;

  const surfaceContent = (
      <div className="flex h-full flex-col">
        <div className="shrink-0 px-4 pb-2 pt-1">
          <div className="relative">
            <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('mobile.sessions.search.placeholder')}
              className={cn('h-11 pl-9', query && 'pr-10')}
            />
            {query ? (
              <button
                type="button"
                className="absolute right-1.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                aria-label={t('mobile.sessions.clearSearchAria')}
                onClick={() => setQuery('')}
                style={{ touchAction: 'manipulation' }}
              >
                <Icon name="close" className="size-4" />
              </button>
            ) : null}
          </div>
        </div>

        <ScrollShadow className="min-h-0 flex-1 overflow-y-auto pb-4">
          {projectsMeta.length === 0 ? (
            <MobileSessionsEmpty
              title={t('mobile.sessions.empty.noProjectsTitle')}
              description={t('mobile.sessions.empty.noProjectsDescription')}
              action={
                <button
                  type="button"
                  className="flex items-center justify-center gap-2 rounded-2xl bg-primary px-5 py-3 typography-ui-label text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  onClick={() => setDirectoryDialogOpen(true)}
                >
                  <Icon name="folder-add" className="size-4" />
                  {t('sessions.sidebar.header.actions.addProject')}
                </button>
              }
            />
          ) : hasNoMatches ? (
            <MobileSessionsEmpty
              title={t('mobile.sessions.empty.searchTitle')}
              description={t('mobile.sessions.empty.searchDescription')}
            />
          ) : normalizedQuery ? (
            <div className="flex flex-col gap-3 px-3 pt-2">
              {searchSessionMatches.length > 0 ? (
                <section>
                  <div className="flex items-center justify-between px-1 pb-1.5">
                    <span className="typography-micro font-semibold uppercase tracking-wider text-muted-foreground">
                      {t('mobile.sessions.search.section.sessions')}
                    </span>
                    <span className="typography-micro text-muted-foreground tabular-nums">
                      {searchSessionMatches.length}
                    </span>
                  </div>
                  <div className="overflow-hidden rounded-2xl border border-border/40 bg-[var(--surface-elevated)]">
                    {searchSessionMatches.map((session, index) => {
                       const isRunning = runningSessionMap[session.id] || false;
                       const title = session.title?.trim() || t('mobile.sessions.untitled');
                       return (
                       <div key={session.id} className={cn(index > 0 && 'border-t border-border/30')}>
                         <SessionRow
                           session={session}
                           active={currentSessionId === session.id}
                           indent={12}
                           contextLabel={buildSessionContextLabel(session)}
                           onSelect={() => runRowClick(`session:${session.id}`, () => handleSelectSession(session))}
                           longPressHandlers={getLongPressHandlers({ key: `session:${session.id}`, kind: 'session', session })}
                           onStop={isRunning ? () => handleStopSession(session.id) : undefined}
                           stopAriaLabel={t('mobile.sessions.stopSessionAria', { title })}
                         />
                       </div>
                     )})}
                  </div>
                </section>
              ) : null}

              {searchProjectMatches.length > 0 ? (
                <section>
                  <div className="flex items-center justify-between px-1 pb-1.5">
                    <span className="typography-micro font-semibold uppercase tracking-wider text-muted-foreground">
                      {t('mobile.sessions.search.section.projects')}
                    </span>
                    <span className="typography-micro text-muted-foreground tabular-nums">
                      {searchProjectMatches.length}
                    </span>
                  </div>
                  <div className="overflow-hidden rounded-2xl border border-border/40 bg-[var(--surface-elevated)]">
                    {searchProjectMatches.map((project, index) => {
                      const actionKey = `project:${project.id}`;
                      const handlers = getLongPressHandlers({ key: actionKey, kind: 'project', project });
                      return (
                        <div
                          key={project.id}
                          className={cn('flex items-center', index > 0 && 'border-t border-border/30')}
                        >
                          <button
                            type="button"
                            className={cn(
                              'flex min-h-14 min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left transition-all hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset',
                              handlers.pressed && 'bg-interactive-active scale-[0.99]',
                            )}
                            onClick={() => runRowClick(actionKey, () => handleSelectProject(project))}
                            onPointerDown={handlers.onPointerDown}
                            onPointerMove={handlers.onPointerMove}
                            onPointerUp={handlers.onPointerUp}
                            onPointerCancel={handlers.onPointerCancel}
                            onContextMenu={handlers.onContextMenu}
                            style={{ touchAction: 'manipulation' }}
                          >
                          <MobileProjectIcon project={project} />
                          <span className="block min-w-0 flex-1 truncate typography-ui-label text-foreground">
                            {project.label}
                          </span>
                          <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">
                            {project.sessionCount}
                          </span>
                          </button>
                          {project.isGitRepo ? (
                            <NewWorktreeIconButton
                              className="mr-2"
                              onClick={() => handleNewWorktree(project.id)}
                            />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col">
              {orderedNodes.map((node, nodeIndex) => {
                const projectExpanded = isProjectExpanded(node);
                const projectActionKey = `project:${node.project.id}`;
                const projectLongPress = getLongPressHandlers({ key: projectActionKey, kind: 'project', project: node.project });
                const buckets = normalizedQuery
                  ? node.buckets.filter((bucket) =>
                      bucket.sessions.some((session) =>
                        sessionMatchesQuery(session, node.project.label, normalizedQuery),
                      ),
                    )
                  : node.buckets;
                const activeWorktreePath = findActiveWorktreePath(node);
                return (
                  <section
                    key={node.project.id}
                    className={cn(nodeIndex > 0 && 'border-t border-border/30')}
                  >
                    <div className="flex min-h-14 w-full items-center">
                      <button
                        type="button"
                        className={cn(
                          'flex min-h-14 min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left transition-all hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset',
                          projectLongPress.pressed && 'bg-interactive-active scale-[0.99]',
                        )}
                        onClick={() => runRowClick(projectActionKey, () => toggleProject(node.project.id, projectExpanded))}
                        onPointerDown={projectLongPress.onPointerDown}
                        onPointerMove={projectLongPress.onPointerMove}
                        onPointerUp={projectLongPress.onPointerUp}
                        onPointerCancel={projectLongPress.onPointerCancel}
                        onContextMenu={projectLongPress.onContextMenu}
                        aria-expanded={projectExpanded}
                        aria-label={
                          projectExpanded
                            ? t('sessions.sidebar.group.collapseAria', { label: node.project.label })
                            : t('sessions.sidebar.group.expandAria', { label: node.project.label })
                        }
                        style={{ touchAction: 'manipulation' }}
                      >
                        <MobileProjectIcon project={node.project} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="block truncate typography-ui-label font-semibold text-foreground">
                            {node.project.label}
                          </span>
                          {rootBranchesByProject.get(node.project.id) ? (
                            <span className="flex min-w-0 items-center gap-1 typography-micro text-muted-foreground">
                              <Icon name="git-branch" className="size-3 shrink-0" />
                              <span className="truncate">{rootBranchesByProject.get(node.project.id)}</span>
                            </span>
                          ) : null}
                        </span>
                        {node.isActive ? <ActiveDot ariaLabel={t('mobile.sessions.activeProjectAria')} /> : null}
                        <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">
                          {node.totalSessions}
                        </span>
                      </button>
                      {(() => {
                        const projectRunningIds = !projectExpanded
                          ? [...new Set(node.buckets.flatMap((b) => b.sessions.filter((s) => runningSessionMap[s.id]).map((s) => s.id)))]
                          : [];
                        return projectRunningIds.length > 0 ? (
                          <button
                            type="button"
                            className="flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--surface-mutedForeground)] transition-colors hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] mr-1"
                            aria-label={t('mobile.sessions.stopGroupAria', { label: node.project.label })}
                            onClick={(event) => {
                              event.stopPropagation();
                              handleStopSessions(projectRunningIds);
                            }}
                            style={{ touchAction: 'manipulation' }}
                          >
                            <SessionBusyIndicator />
                          </button>
                        ) : null;
                      })()}
                      {node.project.isGitRepo ? (
                        <NewWorktreeIconButton
                          className="mr-2"
                          onClick={() => handleNewWorktree(node.project.id)}
                        />
                      ) : null}
                    </div>

                    {projectExpanded ? (
                      <div className="pb-2">
                        {(() => {
                          // Root (project-level) sessions always render as a flat list
                          // at the top — same as a project without worktrees — never
                          // hidden behind a worktree-style group.
                          const rootBucket = buckets.find((bucket) => bucket.worktree === null);
                          const worktreeBuckets = buckets.filter((bucket) => bucket.worktree !== null);
                          return (
                            <>
                              {rootBucket && rootBucket.sessions.length > 0
                                ? renderBucketSessions(node, rootBucket, PROJECT_SESSION_INDENT)
                                : null}
                              {worktreeBuckets.map((bucket) => {
                                const worktreeExpanded = isWorktreeExpanded(node, bucket);
                                const isActiveWt = activeWorktreePath === bucket.path;
                                const worktreeActionKey = `worktree:${node.project.id}:${bucket.key}`;
                                const worktreeLongPress = getLongPressHandlers({
                                  key: worktreeActionKey,
                                  kind: 'worktree',
                                  project: node.project,
                                  worktree: bucket.worktree!,
                                });
                                return (
                                  <div key={bucket.key}>
                                    <button
                                      type="button"
                                      className={cn(
                                        'flex min-h-11 w-full items-center gap-2 py-1.5 pl-4 pr-3 text-left transition-all hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset',
                                        worktreeLongPress.pressed && 'bg-interactive-active scale-[0.99]',
                                      )}
                                      onClick={() => runRowClick(worktreeActionKey, () => toggleWorktree(node.project.id, bucket.key, worktreeExpanded))}
                                      onPointerDown={worktreeLongPress.onPointerDown}
                                      onPointerMove={worktreeLongPress.onPointerMove}
                                      onPointerUp={worktreeLongPress.onPointerUp}
                                      onPointerCancel={worktreeLongPress.onPointerCancel}
                                      onContextMenu={worktreeLongPress.onContextMenu}
                                      aria-expanded={worktreeExpanded}
                                      aria-label={
                                        worktreeExpanded
                                          ? t('sessions.sidebar.group.collapseAria', { label: bucket.label })
                                          : t('sessions.sidebar.group.expandAria', { label: bucket.label })
                                      }
                                      style={{ touchAction: 'manipulation' }}
                                    >
                                      <ChevronToggle expanded={worktreeExpanded} />
                                      <Icon
                                        name="node-tree"
                                        className={cn(
                                          'size-4 shrink-0',
                                          isActiveWt ? 'text-primary' : 'text-muted-foreground',
                                        )}
                                      />
                                      <span
                                        className={cn(
                                          'block min-w-0 flex-1 truncate typography-ui-label font-semibold',
                                          isActiveWt ? 'text-foreground' : 'text-foreground/90',
                                        )}
                                      >
                                        {bucket.label}
                                      </span>
                                      {isActiveWt ? (
                                        <ActiveDot ariaLabel={t('mobile.sessions.activeWorktreeAria')} />
                                      ) : null}
                                      {(() => {
                                        const worktreeRunningIds = !worktreeExpanded
                                          ? bucket.sessions.filter((s) => runningSessionMap[s.id]).map((s) => s.id)
                                          : [];
                                        return worktreeRunningIds.length > 0 ? (
                                          <button
                                            type="button"
                                            className="flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--surface-mutedForeground)] transition-colors hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
                                            aria-label={t('mobile.sessions.stopGroupAria', { label: bucket.label })}
                                            onClick={(event) => {
                                              event.stopPropagation();
                                              handleStopSessions(worktreeRunningIds);
                                            }}
                                            style={{ touchAction: 'manipulation' }}
                                          >
                                            <SessionBusyIndicator />
                                          </button>
                                        ) : null;
                                      })()}
                                      <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">
                                        {bucket.sessions.length}
                                      </span>
                                    </button>
                                    {worktreeExpanded
                                      ? renderBucketSessions(node, bucket, WORKTREE_SESSION_INDENT)
                                      : null}
                                  </div>
                                );
                              })}
                            </>
                          );
                        })()}
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          )}
        </ScrollShadow>

        <DirectoryExplorerDialog open={directoryDialogOpen} onOpenChange={setDirectoryDialogOpen} forceMobile />
        <NewWorktreeDialog
          open={newWorktreeDialogOpen}
          onOpenChange={(value) => {
            setNewWorktreeDialogOpen(value);
            if (!value) setWorktreeDialogProjectId(null);
          }}
          onWorktreeCreated={(worktreePath, options) => {
            if (options?.sessionId) void setCurrentSession(options.sessionId, worktreePath);
            else
              openNewSessionDraft({
                selectedProjectId: worktreeDialogProjectId,
                directoryOverride: worktreePath,
                preserveDirectoryOverride: true,
              });
            onOpenChange(false);
          }}
        />
        <MobileOverlayPanel
          open={Boolean(actionTarget)}
          title={actionTargetTitle}
          onClose={closeActionMenu}
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
            className="px-1 py-1"
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
          </form>
        </MobileOverlayPanel>
        {worktreeToDelete ? (
          <MobileDeleteWorktreeDialog
            open
            project={{ id: worktreeToDelete.project.id, path: worktreeToDelete.project.path }}
            worktree={worktreeToDelete.worktree}
            onClose={() => setWorktreeToDelete(null)}
            onDeleted={() => setWorktreeRefreshKey((value) => value + 1)}
          />
        ) : null}
        <MobileProjectEditSurface
          open={editingProjectId !== null}
          project={projectsMeta.find((entry) => entry.id === editingProjectId) ?? null}
          onClose={() => setEditingProjectId(null)}
          onWorktreesChanged={() => setWorktreeRefreshKey((value) => value + 1)}
        />
      </div>
  );

  if (variant === 'sidebar') {
    if (!open) return null;
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center justify-end gap-2 px-4">
          {trailingActions ? (
            <div className="flex shrink-0 items-center gap-2">{trailingActions}</div>
          ) : null}
        </div>
        {surfaceContent}
      </div>
    );
  }

  return (
    <MobileSurfaceShell
      open={open}
      onClose={() => onOpenChange(false)}
      ariaLabel={t('mobile.sessions.sheet.title')}
      trailing={trailingActions}
    >
      {surfaceContent}
    </MobileSurfaceShell>
  );
};

const MobileSessionsEmpty: React.FC<{
  title: string;
  description?: string;
  action?: React.ReactNode;
}> = ({ title, description, action }) => (
  <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
    <p className="typography-ui-label text-foreground">{title}</p>
    {description ? <p className="typography-meta text-muted-foreground">{description}</p> : null}
    {action ? <div className="pt-2">{action}</div> : null}
  </div>
);
