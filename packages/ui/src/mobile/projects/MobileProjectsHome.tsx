import * as React from 'react';
import { useEvent } from '@reactuses/core';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import { MobileTabPageHeader } from '../MobileTabPageHeader';
import { MobileFloatingSurface, MobileLabeledSurfaceGroup } from '../MobileSurface';
import {
  MobileProjectCard,
  type MobileProjectCardModel,
} from './MobileProjectCard';
import {
  MobileSessionRow,
  type MobileSessionRowModel,
} from './MobileSessionRow';

export type MobileSessionTreeNode = MobileSessionRowModel & {
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
  sessions: MobileSessionTreeNode[];
};

export type MobileProjectHomeItem = MobileProjectCardModel & {
  expanded: boolean;
  worktrees: MobileWorktreeGroup[];
};

export type MobileProjectsHomeProps = {
  projects: MobileProjectHomeItem[];
  onAddProject: () => void;
  onNewSession: () => void;
  onToggleProject: (project: MobileProjectHomeItem) => void;
  onOpenProjectActions: (project: MobileProjectHomeItem) => void;
  onToggleWorktree: (project: MobileProjectHomeItem, worktree: MobileWorktreeGroup) => void;
  /** Worktrees currently expose one direct action: start a session in that directory. */
  onNewWorktreeSession?: (project: MobileProjectHomeItem, worktree: MobileWorktreeGroup) => void;
  onToggleSessionChildren: (session: MobileSessionTreeNode) => void;
  onSelectSession: (session: MobileSessionTreeNode) => void;
  onPinSession: (session: MobileSessionTreeNode) => void;
  onArchiveSession: (session: MobileSessionTreeNode) => void;
  onOpenSessionActions: (session: MobileSessionTreeNode) => void;
  className?: string;
};

type SessionTreeProps = Pick<
  MobileProjectsHomeProps,
  | 'onToggleSessionChildren'
  | 'onSelectSession'
  | 'onPinSession'
  | 'onArchiveSession'
  | 'onOpenSessionActions'
> & {
  sessions: MobileSessionTreeNode[];
  depth?: number;
};

function SessionTree({
  sessions,
  depth = 0,
  onToggleSessionChildren,
  onSelectSession,
  onPinSession,
  onArchiveSession,
  onOpenSessionActions,
}: SessionTreeProps) {
  return (
    <>
      {sessions.map((session, index) => {
        const hasChildren = Boolean(session.children?.length);
        const isFollowedByPagination = session.kind === 'pagination'
          && sessions[index + 1]?.kind === 'pagination';
        return (
          <React.Fragment key={session.id}>
            <MobileSessionRow
              session={session}
              depth={depth}
              hasChildren={hasChildren}
              expanded={session.expanded}
              paginationContinues={isFollowedByPagination}
              onToggleChildren={hasChildren ? () => onToggleSessionChildren(session) : undefined}
              onSelect={onSelectSession}
              onPin={onPinSession}
              onArchive={onArchiveSession}
              onOpenActions={onOpenSessionActions}
            />
            {hasChildren && session.expanded ? (
              <SessionTree
                sessions={session.children ?? []}
                depth={depth + 1}
                onToggleSessionChildren={onToggleSessionChildren}
                onSelectSession={onSelectSession}
                onPinSession={onPinSession}
                onArchiveSession={onArchiveSession}
                onOpenSessionActions={onOpenSessionActions}
              />
            ) : null}
          </React.Fragment>
        );
      })}
    </>
  );
}

/** Project-local group label; its matching session card is rendered separately. */
function WorkspaceGroupLabel({
  icon,
  label,
  count,
  expanded,
  onToggle,
  actions,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  expanded?: boolean;
  onToggle?: () => void;
  actions?: React.ReactNode;
}) {
  const { t } = useI18n();
  const content = (
    <>
      <span className="oc-mobile-group-label-icon" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-left typography-ui-label font-semibold text-foreground">
        {label}
      </span>
      {typeof count === 'number' ? (
        <span className="typography-small text-muted-foreground tabular-nums">
          {count === 1
            ? t('mobile.sessions.project.sessionsSingle')
            : t('mobile.sessions.project.sessionsPlural', { count })}
        </span>
      ) : null}
      {onToggle ? (
        <Icon
          name="arrow-down-s"
          className={cn(
            'size-3.5 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
            expanded ? 'rotate-0' : '-rotate-90',
          )}
        />
      ) : null}
    </>
  );

  return (
    <div className="oc-mobile-group-label">
      {onToggle ? (
        <button
          type="button"
          className="oc-mobile-group-label-trigger"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {content}
        </button>
      ) : (
        <div className="oc-mobile-group-label-trigger">{content}</div>
      )}
      {actions}
    </div>
  );
}

/** Collect root-level sessions from a tree (for pinned extraction). */
const collectRootSessions = (sessions: MobileSessionTreeNode[]): MobileSessionTreeNode[] =>
  sessions.filter((session) => !session.id.startsWith('__show_'));

const stripPinned = (sessions: MobileSessionTreeNode[]): {
  pinned: MobileSessionTreeNode[];
  rest: MobileSessionTreeNode[];
} => {
  const roots = collectRootSessions(sessions);
  const pinned = roots.filter((session) => session.pinned);
  const rest = sessions.filter((session) => !session.pinned);
  return { pinned, rest };
};

export function MobileProjectsHome({
  projects,
  onAddProject,
  onNewSession,
  onToggleProject,
  onOpenProjectActions,
  onToggleWorktree,
  onNewWorktreeSession,
  onToggleSessionChildren,
  onSelectSession,
  onPinSession,
  onArchiveSession,
  onOpenSessionActions,
  className,
}: MobileProjectsHomeProps) {
  const { t } = useI18n();
  const [pinnedExpandedByProject, setPinnedExpandedByProject] = React.useState<Record<string, boolean>>({});

  const handleAddProject = useEvent(onAddProject);
  const handleNewSession = useEvent(onNewSession);
  const handleNewWorktreeSession = useEvent((event: React.MouseEvent<HTMLButtonElement>) => {
    const project = projects.find((candidate) => candidate.id === event.currentTarget.dataset.projectId);
    const worktree = project?.worktrees.find((candidate) => candidate.id === event.currentTarget.dataset.worktreeId);
    if (project && worktree) onNewWorktreeSession?.(project, worktree);
  });

  return (
    <main className={cn('relative isolate mx-auto flex w-full max-w-[26rem] flex-col gap-5', className)}>
      <MobileTabPageHeader
        title={t('mobile.sessions.section.projects')}
        trailing={(
          <>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="oc-mobile-glass-control oc-mobile-round-control size-10 min-h-10 min-w-10 rounded-full text-muted-foreground"
              aria-label={t('mobile.sessions.searchAria')}
              // Search surface is not wired yet — keep the control present for design parity.
              onClick={() => {}}
            >
              <Icon name="search" className="size-5" />
            </Button>
            <Button
              type="button"
              size="icon"
              className="oc-mobile-round-control size-10 min-h-10 min-w-10 rounded-full border-transparent bg-[var(--primary-base)] text-[var(--primary-foreground)] shadow-[0_10px_22px_color-mix(in_srgb,var(--primary-base)_22%,transparent)] hover:bg-[var(--primary-hover)] dark:bg-[var(--primary-base)] dark:hover:bg-[var(--primary-hover)]"
              aria-label={t('mobile.sessions.newChat')}
              onClick={handleNewSession}
            >
              <Icon name="add" className="size-5" />
            </Button>
          </>
        )}
      />

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
      ) : (
        projects.map((project) => {
          const mainWorkspace = project.worktrees.find((entry) => entry.kind === 'main')
            ?? (project.worktrees.length === 1 && !project.worktrees[0]?.kind ? project.worktrees[0] : undefined);
          const linkedWorktrees = project.worktrees.filter((entry) => entry !== mainWorkspace);

          const mainSessions = mainWorkspace?.sessions ?? [];
          const { pinned: pinnedFromMain, rest: mainRest } = stripPinned(mainSessions);
          // Also surface pinned sessions that live inside worktrees at the top.
          const pinnedFromWorktrees = linkedWorktrees.flatMap((worktree) =>
            collectRootSessions(worktree.sessions).filter((session) => session.pinned),
          );
          const pinnedSessions = [...pinnedFromMain, ...pinnedFromWorktrees];
          const pinnedExpanded = pinnedExpandedByProject[project.id] ?? true;

          return (
            <MobileFloatingSurface key={project.id} asChild>
              <section className="oc-mobile-project-shell" aria-label={project.name}>
              {/* Project header and every workspace/session group share one parent surface. */}
              <MobileProjectCard
                project={project}
                expanded={project.expanded}
                embedded
                onToggle={() => onToggleProject(project)}
                onOpenActions={() => onOpenProjectActions(project)}
              />

              {project.expanded ? (
                <div className="oc-mobile-project-groups" role="group" aria-label={project.name}>
                  {/* Pinned group */}
                  {pinnedSessions.length > 0 ? (
                    <MobileLabeledSurfaceGroup
                      ariaLabel={t('mobile.sessions.section.pinned')}
                      label={(
                        <WorkspaceGroupLabel
                          icon={<Icon name="pushpin" className="size-3.5" />}
                          label={t('mobile.sessions.section.pinned')}
                          count={pinnedSessions.length}
                          expanded={pinnedExpanded}
                          onToggle={() => {
                            setPinnedExpandedByProject((previous) => ({
                              ...previous,
                              [project.id]: !(previous[project.id] ?? true),
                            }));
                          }}
                        />
                      )}
                    >
                      {pinnedExpanded ? (
                        <SessionTree
                          sessions={pinnedSessions}
                          onToggleSessionChildren={onToggleSessionChildren}
                          onSelectSession={onSelectSession}
                          onPinSession={onPinSession}
                          onArchiveSession={onArchiveSession}
                          onOpenSessionActions={onOpenSessionActions}
                        />
                      ) : null}
                    </MobileLabeledSurfaceGroup>
                  ) : null}

                  {/* Main workspace sessions keep their own label and card. */}
                  {mainRest.length > 0 ? (
                    <MobileLabeledSurfaceGroup
                      className="oc-mobile-main-workspace-group"
                      ariaLabel={t('mobile.sessions.mainWorkspace')}
                      label={(
                        <WorkspaceGroupLabel
                          icon={<Icon name="git-branch" className="size-3.5" />}
                          label={t('mobile.sessions.mainWorkspace')}
                          count={mainSessions.length}
                        />
                      )}
                    >
                      <SessionTree
                        sessions={mainRest}
                        onToggleSessionChildren={onToggleSessionChildren}
                        onSelectSession={onSelectSession}
                        onPinSession={onPinSession}
                        onArchiveSession={onArchiveSession}
                        onOpenSessionActions={onOpenSessionActions}
                      />
                    </MobileLabeledSurfaceGroup>
                  ) : null}

                  {/* Every linked worktree gets an independent label + session card. */}
                  {linkedWorktrees.map((worktree) => {
                    const worktreeRest = worktree.sessions.filter((session) => !session.pinned);
                    return (
                      <MobileLabeledSurfaceGroup
                        key={worktree.id}
                        className="oc-mobile-worktree-group"
                        ariaLabel={worktree.name}
                        label={(
                          <WorkspaceGroupLabel
                            icon={<Icon name="git-branch" className="size-3.5" />}
                            label={worktree.name}
                            count={worktree.sessions.length}
                            expanded={worktree.expanded}
                            onToggle={() => onToggleWorktree(project, worktree)}
                            actions={onNewWorktreeSession ? (
                              <Button
                                type="button"
                                data-project-id={project.id}
                                data-worktree-id={worktree.id}
                                variant="ghost"
                                size="icon"
                                className="oc-mobile-worktree-new-session rounded-full text-muted-foreground"
                                aria-label={t('mobile.sessions.newSessionAria')}
                                onClick={handleNewWorktreeSession}
                              >
                                <Icon name="add" className="size-4" />
                              </Button>
                            ) : null}
                          />
                        )}
                      >
                        {worktree.expanded && worktreeRest.length > 0 ? (
                          <SessionTree
                            sessions={worktreeRest}
                            onToggleSessionChildren={onToggleSessionChildren}
                            onSelectSession={onSelectSession}
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
