import * as React from 'react';
import { useEvent } from '@reactuses/core';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  createMobileLongPressController,
  type MobileLongPressController,
} from '@/components/ui/mobileLongPress';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  useLiveSessionStatus,
  useSessionPermissions,
  useSessionQuestions,
} from '@/sync/sync-context';

import { MobileTabPageHeader } from '../MobileTabPageHeader';
import { MobileFloatingSurface, MobileLabeledSurfaceGroup } from '../MobileSurface';
import {
  MobileProjectCard,
  type MobileProjectCardModel,
} from './MobileProjectCard';
import {
  MobileSessionRow,
  type MobileSessionRowModel,
  type MobileSessionRowProps,
} from './MobileSessionRow';
import { resolveMobileSessionIndicator } from './mobileSessionIndicator';
import { filterMobileProjectsForSearch } from './mobileProjectSearch';

const INTENT_LOCK_PX = 10;
const REVEALED_WORKTREE_EVENT = 'oc:mobile-worktree-row-revealed';

const broadcastWorktreeRevealed = (id: string): void => {
  window.dispatchEvent(new CustomEvent(REVEALED_WORKTREE_EVENT, { detail: id }));
};

type GestureIntent = 'pending' | 'horizontal' | 'vertical';

type ActiveGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  startOffset: number;
  actionWidth: number;
  intent: GestureIntent;
};

export type MobileSessionTreeNode = MobileSessionRowModel & {
  directory?: string;
  /**
   * Nested subagents may exist for archive/cascade helpers, but the mobile home
   * list is intentionally flat: never render children or expand chrome.
   */
  children?: MobileSessionTreeNode[];
  expanded?: boolean;
};

export type MobileWorktreeGroup = {
  id: string;
  name: string;
  path: string;
  /** Main workspace lists sessions flat; linked worktrees stay collapsible. */
  kind?: 'main' | 'worktree';
  active?: boolean;
  expanded?: boolean;
  /** Total top-level sessions in this bucket (not the visible slice). */
  sessionCount: number;
  sessions: MobileSessionTreeNode[];
};

export type MobileProjectHomeItem = MobileProjectCardModel & {
  expanded: boolean;
  worktrees: MobileWorktreeGroup[];
};

export type MobileProjectsHomeProps = {
  projects: MobileProjectHomeItem[];
  pinnedSessions: MobileSessionTreeNode[];
  inProgressSessions?: MobileSessionTreeNode[];
  onAddProject: () => void;
  onNewSession: () => void;
  onScanQr?: () => void;
  onSwitchInstance?: () => void;
  onToggleProject: (project: MobileProjectHomeItem) => void;
  onOpenProjectActions: (project: MobileProjectHomeItem) => void;
  onToggleWorktree: (project: MobileProjectHomeItem, worktree: MobileWorktreeGroup) => void;
  /** Start a session in the worktree directory (header + / swipe / action sheet). */
  onNewWorktreeSession?: (project: MobileProjectHomeItem, worktree: MobileWorktreeGroup) => void;
  /** Opens the worktree action sheet (long press / more / swipe delete entry). */
  onOpenWorktreeActions?: (project: MobileProjectHomeItem, worktree: MobileWorktreeGroup) => void;
  /** Swipe-rail delete; omit when delete is unavailable. */
  onDeleteWorktree?: (project: MobileProjectHomeItem, worktree: MobileWorktreeGroup) => void;
  onSelectSession: (session: MobileSessionTreeNode) => void;
  onPinSession: (session: MobileSessionTreeNode) => void;
  onArchiveSession: (session: MobileSessionTreeNode) => void;
  onOpenSessionActions: (session: MobileSessionTreeNode) => void;
  className?: string;
};

type SessionListProps = Pick<
  MobileProjectsHomeProps,
  | 'onSelectSession'
  | 'onPinSession'
  | 'onArchiveSession'
  | 'onOpenSessionActions'
> & {
  sessions: MobileSessionTreeNode[];
};

function MobileLiveSessionRow(props: MobileSessionRowProps) {
  // Live child-store only — matches MobileSessionsSheet's useAllSessionStatuses
  // so sticky global fallback busy cannot disagree with the recent-sessions list.
  const status = useLiveSessionStatus(props.session.id);
  const permissions = useSessionPermissions(
    props.session.id,
    (props.session as MobileSessionTreeNode).directory,
    { bootstrap: false },
  );
  const questions = useSessionQuestions(
    props.session.id,
    (props.session as MobileSessionTreeNode).directory,
    { bootstrap: false },
  );
  const indicator = resolveMobileSessionIndicator({
    hasPendingQuestion: questions.length > 0,
    hasPendingPermission: permissions.length > 0,
    running: status?.type === 'busy' || status?.type === 'retry',
    unread: Boolean(props.session.unread),
  });

  return <MobileSessionRow {...props} indicator={indicator} />;
}

/** Flat session list only — no subagent nesting or expand/collapse chevrons. */
function SessionList({
  sessions,
  onSelectSession,
  onPinSession,
  onArchiveSession,
  onOpenSessionActions,
}: SessionListProps) {
  return (
    <>
      {sessions.map((session, index) => {
        const isFollowedByPagination = session.kind === 'pagination'
          && sessions[index + 1]?.kind === 'pagination';
        const Row = session.kind === 'pagination' ? MobileSessionRow : MobileLiveSessionRow;
        return (
          <Row
            key={session.id}
            session={session}
            paginationContinues={isFollowedByPagination}
            onSelect={onSelectSession}
            onPin={onPinSession}
            onArchive={onArchiveSession}
            onOpenActions={onOpenSessionActions}
          />
        );
      })}
    </>
  );
}

/**
 * Linked worktree header: same long-press + left-swipe pattern as session rows.
 * Swipe reveals New session / Delete (PC hover parity); long press opens the full sheet.
 */
function MobileWorktreeGroupLabel({
  project,
  worktree,
  expanded,
  onToggle,
  onNewSession,
  onOpenActions,
  onDelete,
}: {
  project: MobileProjectHomeItem;
  worktree: MobileWorktreeGroup;
  expanded: boolean;
  onToggle: () => void;
  onNewSession?: (project: MobileProjectHomeItem, worktree: MobileWorktreeGroup) => void;
  onOpenActions?: (project: MobileProjectHomeItem, worktree: MobileWorktreeGroup) => void;
  onDelete?: (project: MobileProjectHomeItem, worktree: MobileWorktreeGroup) => void;
}) {
  const { t } = useI18n();
  const rowKey = `${project.id}::${worktree.id}`;
  const canSwipe = Boolean(onNewSession || onDelete);
  const canOpenActions = Boolean(onOpenActions);
  const swipeActionCount = Number(Boolean(onNewSession)) + Number(Boolean(onDelete));
  const [offset, setOffset] = React.useState(0);
  const [pressed, setPressed] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const gestureRef = React.useRef<ActiveGesture | null>(null);
  const suppressClickRef = React.useRef(false);
  const actionRailRef = React.useRef<HTMLDivElement | null>(null);
  const longPressRef = React.useRef<MobileLongPressController | null>(null);

  if (!longPressRef.current) {
    longPressRef.current = createMobileLongPressController({
      onPressedKeyChange: (key) => setPressed(key === rowKey),
    });
  }

  React.useEffect(() => () => longPressRef.current?.reset(), []);

  React.useEffect(() => {
    const handleRevealed = (event: Event) => {
      const revealedId = (event as CustomEvent<string>).detail;
      if (revealedId !== rowKey) setOffset(0);
    };
    window.addEventListener(REVEALED_WORKTREE_EVENT, handleRevealed);
    return () => window.removeEventListener(REVEALED_WORKTREE_EVENT, handleRevealed);
  }, [rowKey]);

  React.useEffect(() => {
    setOffset(0);
  }, [rowKey]);

  const closeActions = useEvent(() => setOffset(0));
  const revealed = offset !== 0;

  const handlePointerDown = useEvent((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;

    if (canSwipe) {
      const actionWidth = actionRailRef.current?.offsetWidth ?? 0;
      if (actionWidth > 0) {
        gestureRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startOffset: offset,
          actionWidth,
          intent: 'pending',
        };
        suppressClickRef.current = false;
      }
    }

    if (!canOpenActions) return;
    longPressRef.current?.start({
      pointerId: event.pointerId,
      key: rowKey,
      clientX: event.clientX,
      clientY: event.clientY,
      onTrigger: () => {
        setPressed(false);
        onOpenActions?.(project, worktree);
      },
    });
  });

  const handlePointerMove = useEvent((event: React.PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      longPressRef.current?.move(event.pointerId, event.clientX, event.clientY);
      return;
    }

    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    longPressRef.current?.move(event.pointerId, event.clientX, event.clientY);

    if (gesture.intent === 'pending') {
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      if (absY > INTENT_LOCK_PX && absY > absX) {
        gesture.intent = 'vertical';
        gestureRef.current = null;
        longPressRef.current?.cancel(event.pointerId);
        return;
      }
      if (absX > INTENT_LOCK_PX && absX > absY) {
        gesture.intent = 'horizontal';
        setDragging(true);
        suppressClickRef.current = true;
        longPressRef.current?.cancel(event.pointerId);
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Embedded webviews may reject capture after release.
        }
        broadcastWorktreeRevealed(rowKey);
      }
    }

    if (gesture.intent !== 'horizontal') return;
    event.preventDefault();
    const nextOffset = Math.max(-gesture.actionWidth, Math.min(0, gesture.startOffset + deltaX));
    setOffset(nextOffset);
  });

  const finishGesture = useEvent((event: React.PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    longPressRef.current?.end(event.pointerId);
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (gesture.intent !== 'horizontal') return;
    setDragging(false);
    setOffset((current) => (current < -(gesture.actionWidth * 0.35) ? -gesture.actionWidth : 0));
  });

  const handlePointerCancel = useEvent((event: React.PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    longPressRef.current?.cancel(event.pointerId);
    setDragging(false);
    setOffset(gesture?.startOffset ?? 0);
  });

  const handleToggle = useEvent(() => {
    if (longPressRef.current?.consumeClick(rowKey)) return;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (offset !== 0) {
      closeActions();
      return;
    }
    onToggle();
  });

  const handleContextMenu = useEvent((event: React.MouseEvent<HTMLElement>) => {
    if (!canOpenActions) return;
    event.preventDefault();
    event.stopPropagation();
    longPressRef.current?.openFromContextMenu(rowKey, () => {
      setPressed(false);
      onOpenActions?.(project, worktree);
    });
  });

  const handleNewSession = useEvent(() => {
    closeActions();
    onNewSession?.(project, worktree);
  });

  const handleDelete = useEvent(() => {
    closeActions();
    onDelete?.(project, worktree);
  });

  const handleOpenActions = useEvent(() => onOpenActions?.(project, worktree));

  const content = (
    <>
      <span className="oc-mobile-group-label-icon" aria-hidden>
        <Icon name="git-branch" className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate text-left oc-mobile-entity-title font-semibold text-foreground">
        {worktree.name}
      </span>
      <span className="typography-small text-muted-foreground tabular-nums">
        {worktree.sessionCount === 1
          ? t('mobile.sessions.project.sessionsSingle')
          : t('mobile.sessions.project.sessionsPlural', { count: worktree.sessionCount })}
      </span>
      <Icon
        name="arrow-down-s"
        className={cn(
          'size-3.5 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
          expanded ? 'rotate-0' : '-rotate-90',
        )}
      />
    </>
  );

  return (
    <div className="oc-mobile-group-label oc-mobile-worktree-label relative isolate overflow-hidden">
      {canSwipe ? (
        <div
          ref={actionRailRef}
          className={cn(
            'oc-mobile-worktree-actions absolute inset-y-0 right-0 z-0 flex items-stretch',
            dragging ? 'transition-none' : 'transition-transform duration-150 ease-out',
            !revealed && 'invisible pointer-events-none',
          )}
          style={{
            // Width tracks the visible action count so a single-button rail
            // does not leave a half-empty swipe region.
            width: `calc(${swipeActionCount} * var(--oc-mobile-worktree-action-width))`,
            transform: `translate3d(calc(100% + ${offset}px), 0, 0)`,
            willChange: offset === 0 ? undefined : 'transform',
          }}
          aria-hidden={!revealed}
        >
          {onNewSession ? (
            <Button
              type="button"
              variant="secondary"
              className="oc-mobile-worktree-action h-full flex-col rounded-none border-0 bg-interactive-selection px-1 text-interactive-selection-foreground hover:bg-interactive-active"
              aria-label={t('mobile.sessions.newSessionAria')}
              tabIndex={revealed ? 0 : -1}
              onClick={handleNewSession}
            >
              <Icon name="add" className="size-[18px]" />
              <span className="oc-mobile-session-action-label font-medium">
                {t('sessions.sidebar.project.actions.newSession')}
              </span>
            </Button>
          ) : null}
          {onDelete ? (
            <Button
              type="button"
              variant="destructive"
              className="oc-mobile-worktree-action h-full flex-col rounded-none border-0 px-1"
              aria-label={t('mobile.projectEdit.deleteWorktreeAria', { label: worktree.name })}
              tabIndex={revealed ? 0 : -1}
              onClick={handleDelete}
            >
              <Icon name="delete-bin" className="size-[18px]" />
              <span className="oc-mobile-session-action-label font-medium">
                {t('mobile.projectEdit.deleteWorktreeConfirmButton')}
              </span>
            </Button>
          ) : null}
        </div>
      ) : null}

      <div
        className={cn(
          'oc-mobile-worktree-label-content relative z-10 flex min-w-0 flex-1 items-center',
          'ease-out motion-reduce:transition-none',
          // Match session rows: transform-only while dragging; no fill on press/click.
          dragging ? 'transition-none' : 'transition-transform duration-150',
        )}
        style={{
          transform: `translate3d(${offset}px, 0, 0)`,
          willChange: offset === 0 ? undefined : 'transform',
        }}
        data-pressed={pressed ? 'true' : undefined}
      >
        <button
          type="button"
          // Soft scale only — no hover/active fill (session row parity).
          data-mobile-press-feedback="soft"
          className="oc-mobile-group-label-trigger oc-mobile-worktree-label-trigger"
          aria-expanded={expanded}
          onClick={handleToggle}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishGesture}
          onPointerCancel={handlePointerCancel}
          onContextMenu={handleContextMenu}
          style={{ touchAction: 'pan-y' }}
        >
          {content}
        </button>

        {canOpenActions ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="oc-mobile-worktree-more rounded-full text-muted-foreground"
            aria-label={t('agentManager.detail.actions.worktreeActionsAria')}
            onClick={handleOpenActions}
          >
            <Icon name="more-2" className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function MobileProjectsHome({
  projects,
  pinnedSessions,
  inProgressSessions = [],
  onAddProject,
  onNewSession,
  onScanQr,
  onSwitchInstance,
  onToggleProject,
  onOpenProjectActions,
  onToggleWorktree,
  onNewWorktreeSession,
  onOpenWorktreeActions,
  onDeleteWorktree,
  onSelectSession,
  onPinSession,
  onArchiveSession,
  onOpenSessionActions,
  className,
}: MobileProjectsHomeProps) {
  const { t } = useI18n();
  const [pinnedExpanded, setPinnedExpanded] = React.useState(true);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const searching = normalizedSearchQuery.length > 0;
  const visibleProjects = React.useMemo(
    () => filterMobileProjectsForSearch(projects, normalizedSearchQuery),
    [normalizedSearchQuery, projects],
  );

  const handleAddProject = useEvent(onAddProject);
  const handleNewSession = useEvent(onNewSession);
  const handleScanQr = useEvent(() => onScanQr?.());
  const handleSwitchInstance = useEvent(() => onSwitchInstance?.());
  const handleMenuOpenChange = useEvent((open: boolean) => setMenuOpen(open));
  const closeSearch = useEvent(() => {
    setSearchQuery('');
    setSearchOpen(false);
  });
  const handleToggleSearch = useEvent(() => {
    if (searchOpen) {
      closeSearch();
      return;
    }
    setSearchOpen(true);
  });
  const handleSearchProjectOpen = useEvent((project: MobileProjectHomeItem) => {
    closeSearch();
    if (!project.expanded) onToggleProject(project);
  });
  const handleSearchWorktreeOpen = useEvent((
    project: MobileProjectHomeItem,
    worktree: MobileWorktreeGroup,
  ) => {
    closeSearch();
    if (!project.expanded) onToggleProject(project);
    if (!worktree.expanded) onToggleWorktree(project, worktree);
  });
  const handleSelectSearchSession = useEvent((session: MobileSessionTreeNode) => {
    closeSearch();
    onSelectSession(session);
  });

  return (
    <main className={cn('relative isolate mx-auto flex w-full max-w-[26rem] flex-col gap-5', className)}>
      <MobileTabPageHeader
        title={t('mobile.sessions.section.projects')}
        trailing={(
          <>
            <Button
              type="button"
              variant="mobileGlass"
              size="mobileIcon"
              aria-label={searchOpen
                ? t('mobile.sessions.clearSearchAria')
                : t('mobile.sessions.searchAria')}
              aria-expanded={searchOpen}
              onClick={handleToggleSearch}
            >
              <Icon name={searchOpen ? 'close' : 'search'} className="size-5" />
            </Button>
            <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="mobileIcon"
                  className="oc-mobile-round-control border-transparent bg-[var(--primary-base)] text-[var(--primary-foreground)] shadow-[0_10px_22px_color-mix(in_srgb,var(--primary-base)_22%,transparent)] hover:bg-[var(--primary-hover)] dark:bg-[var(--primary-base)] dark:hover:bg-[var(--primary-hover)]"
                  aria-label={t('mobile.projects.menu.label')}
                >
                  <Icon
                    name="add"
                    className={cn(
                      'size-5 transition-transform duration-150 motion-reduce:transition-none',
                      menuOpen ? 'rotate-45' : 'rotate-0',
                    )}
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="bottom" className="min-w-44">
                <DropdownMenuItem className="min-h-11" onSelect={handleNewSession}>
                  <Icon name="chat-new" className="size-4" />
                  {t('mobile.projects.menu.newChat')}
                </DropdownMenuItem>
                <DropdownMenuItem className="min-h-11" onSelect={handleAddProject}>
                  <Icon name="folder" className="size-4" />
                  {t('mobile.projects.menu.newProject')}
                </DropdownMenuItem>
                {onScanQr ? (
                  <DropdownMenuItem className="min-h-11" onSelect={handleScanQr}>
                    <Icon name="scan-2" className="size-4" />
                    {t('mobile.projects.menu.scanQr')}
                  </DropdownMenuItem>
                ) : null}
                {onSwitchInstance ? (
                  <DropdownMenuItem className="min-h-11" onSelect={handleSwitchInstance}>
                    <Icon name="server" className="size-4" />
                    {t('mobile.projects.menu.switchInstance')}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      />

      {searchOpen ? (
        <div className="relative mx-1" role="search">
          <Icon
            name="search"
            className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            autoFocus
            type="text"
            inputMode="search"
            enterKeyHint="search"
            value={searchQuery}
            placeholder={t('mobile.sessions.search.placeholder')}
            aria-label={t('mobile.sessions.searchAria')}
            className={cn('h-11 rounded-full pl-9', searchQuery && 'pr-10')}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeSearch();
            }}
          />
          {searchQuery ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-1.5 top-1/2 size-8 -translate-y-1/2 rounded-full text-muted-foreground"
              aria-label={t('mobile.sessions.clearSearchAria')}
              onClick={() => setSearchQuery('')}
            >
              <Icon name="close" className="size-4" />
            </Button>
          ) : null}
        </div>
      ) : null}

      {!searching && (pinnedSessions.length > 0 || inProgressSessions.length > 0) ? (
        <MobileFloatingSurface asChild>
          <section className="oc-mobile-project-shell" aria-label={t('mobile.sessions.section.pinned')}>
            <MobileProjectCard
              project={{
                id: '__pinned__',
                name: t('mobile.sessions.section.pinned'),
                path: '',
                icon: 'pushpin',
                sessionCount: pinnedSessions.length + inProgressSessions.length,
              }}
              expanded={pinnedExpanded}
              embedded
              onToggle={() => setPinnedExpanded((expanded) => !expanded)}
            />
            {pinnedExpanded ? (
              <div className="oc-mobile-project-groups" role="group">
                {pinnedSessions.length > 0 ? (
                  <div className="oc-mobile-labeled-surface-group">
                    <SessionList
                      sessions={pinnedSessions}
                      onSelectSession={onSelectSession}
                      onPinSession={onPinSession}
                      onArchiveSession={onArchiveSession}
                      onOpenSessionActions={onOpenSessionActions}
                    />
                  </div>
                ) : null}
                {inProgressSessions.length > 0 ? (
                  <div className="oc-mobile-labeled-surface-group">
                    <SessionList
                      sessions={inProgressSessions}
                      onSelectSession={onSelectSession}
                      onPinSession={onPinSession}
                      onArchiveSession={onArchiveSession}
                      onOpenSessionActions={onOpenSessionActions}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        </MobileFloatingSurface>
      ) : null}

      {projects.length === 0 ? (
        <section className="flex min-h-[52dvh] flex-col items-center justify-center px-6 text-center">
          <span className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-[var(--surface-muted)] text-muted-foreground">
            <Icon name="folder-add" className="size-6" />
          </span>
          <h2 className="typography-ui-label font-semibold text-foreground">{t('mobile.sessions.empty.noProjectsTitle')}</h2>
          <p className="mt-1.5 max-w-xs typography-small text-muted-foreground">{t('mobile.sessions.empty.noProjectsDescription')}</p>
          <Button type="button" size="lg" className="mt-4 min-h-10 rounded-full px-5" onClick={handleAddProject}>
            <Icon name="folder-add" className="size-4" />
            {t('sessions.sidebar.header.actions.addProject')}
          </Button>
        </section>
      ) : searching && visibleProjects.length === 0 ? (
        <section className="flex min-h-[40dvh] flex-col items-center justify-center px-6 text-center">
          <Icon name="search" className="mb-4 size-6 text-muted-foreground" />
          <h2 className="typography-ui-label font-semibold text-foreground">{t('mobile.sessions.empty.searchTitle')}</h2>
          <p className="mt-1.5 max-w-xs typography-small text-muted-foreground">{t('mobile.sessions.empty.searchDescription')}</p>
        </section>
      ) : (
        visibleProjects.map((project) => {
          const projectExpanded = searching || project.expanded;
          const mainWorkspace = project.worktrees.find((entry) => entry.kind === 'main')
            ?? (project.worktrees.length === 1 && !project.worktrees[0]?.kind ? project.worktrees[0] : undefined);
          const linkedWorktrees = project.worktrees.filter((entry) => entry !== mainWorkspace);

          const mainSessions = mainWorkspace?.sessions ?? [];

          return (
            <MobileFloatingSurface key={project.id} asChild>
              <section className="oc-mobile-project-shell" aria-label={project.name}>
              {/* Project header and every workspace/session group share one parent surface. */}
              <MobileProjectCard
                project={project}
                expanded={projectExpanded}
                embedded
                onToggle={() => searching
                  ? handleSearchProjectOpen(project)
                  : onToggleProject(project)}
                onOpenActions={() => onOpenProjectActions(project)}
              />

              {projectExpanded ? (
                <div className="oc-mobile-project-groups" role="group" aria-label={project.name}>
                  {/* Main workspace sessions flow directly below the project header. */}
                  {mainSessions.length > 0 ? (
                    <div className="oc-mobile-labeled-surface-group">
                      <SessionList
                        sessions={mainSessions}
                        onSelectSession={searching ? handleSelectSearchSession : onSelectSession}
                        onPinSession={onPinSession}
                        onArchiveSession={onArchiveSession}
                        onOpenSessionActions={onOpenSessionActions}
                      />
                    </div>
                  ) : null}

                  {/* Every linked worktree gets an independent label + session card. */}
                  {linkedWorktrees.map((worktree) => {
                    const worktreeExpanded = searching || Boolean(worktree.expanded);
                    return (
                      <MobileLabeledSurfaceGroup
                        key={worktree.id}
                        className="oc-mobile-worktree-group"
                        ariaLabel={worktree.name}
                        label={(
                          <MobileWorktreeGroupLabel
                            project={project}
                            worktree={worktree}
                            expanded={worktreeExpanded}
                            onToggle={() => searching
                              ? handleSearchWorktreeOpen(project, worktree)
                              : onToggleWorktree(project, worktree)}
                            onNewSession={onNewWorktreeSession}
                            onOpenActions={searching ? undefined : onOpenWorktreeActions}
                            onDelete={searching ? undefined : onDeleteWorktree}
                          />
                        )}
                      >
                        {worktreeExpanded && worktree.sessions.length > 0 ? (
                          <SessionList
                            sessions={worktree.sessions}
                            onSelectSession={searching ? handleSelectSearchSession : onSelectSession}
                            onPinSession={onPinSession}
                            onArchiveSession={onArchiveSession}
                            onOpenSessionActions={onOpenSessionActions}
                          />
                        ) : null}
                      </MobileLabeledSurfaceGroup>
                    );
                  })}
                </div>
              ) : null}
              </section>
            </MobileFloatingSurface>
          );
        })
      )}

      {/* Keep add-project reachable when header is search-focused (hidden fallback). */}
      <button type="button" className="sr-only" onClick={handleAddProject}>
        {t('sessions.sidebar.header.actions.addProject')}
      </button>
    </main>
  );
}
