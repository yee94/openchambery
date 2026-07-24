import * as React from 'react';
import { useEvent } from '@reactuses/core';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

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
  onOpenWorktreeActions?: (project: MobileProjectHomeItem, worktree: MobileWorktreeGroup) => void;
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
      {sessions.map((session) => {
        const hasChildren = Boolean(session.children?.length);
        return (
          <React.Fragment key={session.id}>
            <MobileSessionRow
              session={session}
              depth={depth}
              hasChildren={hasChildren}
              expanded={session.expanded}
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

export function MobileProjectsHome({
  projects,
  onAddProject,
  onNewSession,
  onToggleProject,
  onOpenProjectActions,
  onToggleWorktree,
  onOpenWorktreeActions,
  onToggleSessionChildren,
  onSelectSession,
  onPinSession,
  onArchiveSession,
  onOpenSessionActions,
  className,
}: MobileProjectsHomeProps) {
  const { t } = useI18n();
  const handleAddProject = useEvent(onAddProject);
  const handleNewSession = useEvent(onNewSession);
  const handleToggleWorktree = useEvent((event: React.MouseEvent<HTMLButtonElement>) => {
    const project = projects.find((candidate) => candidate.id === event.currentTarget.dataset.projectId);
    const worktree = project?.worktrees.find((candidate) => candidate.id === event.currentTarget.dataset.worktreeId);
    if (project && worktree) onToggleWorktree(project, worktree);
  });
  const handleOpenWorktreeActions = useEvent((event: React.MouseEvent<HTMLButtonElement>) => {
    const project = projects.find((candidate) => candidate.id === event.currentTarget.dataset.projectId);
    const worktree = project?.worktrees.find((candidate) => candidate.id === event.currentTarget.dataset.worktreeId);
    if (project && worktree) onOpenWorktreeActions?.(project, worktree);
  });

  return (
    <main className={cn('mx-auto flex w-full max-w-xl flex-col pb-4', className)}>
      <header className="flex items-end justify-between gap-4 px-1 pb-6 pt-3">
        <div className="min-w-0">
          <p className="mb-1 typography-micro font-semibold uppercase tracking-[0.16em] text-muted-foreground">OpenChamber</p>
          <h1 className="truncate text-[clamp(2rem,10vw,2.75rem)] font-semibold leading-none tracking-[-0.045em] text-foreground">
            {t('mobile.sessions.section.projects')}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="min-h-11 min-w-11 rounded-full bg-[color:color-mix(in_srgb,var(--surface-elevated)_88%,transparent)] shadow-sm backdrop-blur-xl"
            aria-label={t('sessions.sidebar.header.actions.addProject')}
            onClick={handleAddProject}
          >
            <Icon name="folder-add" className="size-5" />
          </Button>
          <Button
            type="button"
            size="icon"
            className="min-h-11 min-w-11 rounded-full shadow-sm"
            aria-label={t('mobile.sessions.newChat')}
            onClick={handleNewSession}
          >
            <Icon name="add" className="size-5" />
          </Button>
        </div>
      </header>

      {projects.length === 0 ? (
        <section className="flex min-h-[52dvh] flex-col items-center justify-center px-6 text-center">
          <span className="mb-5 flex size-20 items-center justify-center rounded-[28px] border border-[var(--interactive-border)] bg-[var(--surface-elevated)] text-muted-foreground shadow-[0_18px_50px_color-mix(in_srgb,var(--surface-foreground)_10%,transparent)] supports-[corner-shape:squircle]:rounded-[64px]">
            <Icon name="folder-add" className="size-8" />
          </span>
          <h2 className="typography-ui-label font-semibold">{t('mobile.sessions.empty.noProjectsTitle')}</h2>
          <p className="mt-2 max-w-xs typography-small text-muted-foreground">{t('mobile.sessions.empty.noProjectsDescription')}</p>
          <Button type="button" size="lg" className="mt-6 min-h-11 rounded-full px-5" onClick={handleAddProject}>
            <Icon name="folder-add" className="size-4" />
            {t('sessions.sidebar.header.actions.addProject')}
          </Button>
        </section>
      ) : (
        <div className="flex flex-col gap-5">
          {projects.map((project, projectIndex) => (
            <section
              key={project.id}
              className="animate-in fade-in slide-in-from-bottom-3 fill-mode-both duration-500 motion-reduce:animate-none"
              style={{ animationDelay: `${Math.min(projectIndex, 6) * 55}ms` }}
            >
              <MobileProjectCard
                project={project}
                expanded={project.expanded}
                onToggle={() => onToggleProject(project)}
                onOpenActions={() => onOpenProjectActions(project)}
              />

              {project.expanded ? (
                <div className="mx-2 -mt-3 overflow-hidden rounded-b-[24px] border-x border-b border-[var(--interactive-border)] bg-[color:color-mix(in_srgb,var(--surface-elevated)_86%,transparent)] pt-3 shadow-[0_16px_36px_color-mix(in_srgb,var(--surface-foreground)_6%,transparent)] backdrop-blur-xl supports-[corner-shape:squircle]:rounded-b-[54px]">
                  {project.worktrees.map((worktree, index) => (
                    <div key={worktree.id} className={cn(index > 0 && 'border-t border-[var(--surface-subtle)]')}>
                      <div className="flex min-h-12 items-center gap-1 px-2">
                        <Button
                          type="button"
                          data-project-id={project.id}
                          data-worktree-id={worktree.id}
                          variant="ghost"
                          className="min-h-11 min-w-0 flex-1 justify-start gap-2 rounded-xl px-2"
                          aria-expanded={worktree.expanded}
                          onClick={handleToggleWorktree}
                        >
                          <Icon
                            name="arrow-down-s"
                            className={cn('size-4 transition-transform duration-200 motion-reduce:transition-none', worktree.expanded ? 'rotate-0' : '-rotate-90')}
                          />
                          <Icon name="git-branch" className="size-4 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate text-left typography-ui-label">{worktree.name}</span>
                          <span className="typography-micro text-muted-foreground tabular-nums">{worktree.sessions.length}</span>
                          {worktree.active ? <span className="size-1.5 rounded-full bg-[var(--status-success)]" aria-label={t('mobile.sessions.activeWorktreeAria')} /> : null}
                        </Button>
                        {onOpenWorktreeActions ? (
                          <Button
                            type="button"
                            data-project-id={project.id}
                            data-worktree-id={worktree.id}
                            variant="ghost"
                            size="icon"
                            className="min-h-11 min-w-11 rounded-full text-muted-foreground"
                            aria-label={t('sessions.sidebar.project.actions.projectMenu')}
                            onClick={handleOpenWorktreeActions}
                          >
                            <Icon name="more-2" className="size-5" />
                          </Button>
                        ) : null}
                      </div>

                      {worktree.expanded ? (
                        <div className="border-t border-[var(--surface-subtle)]">
                          <SessionTree
                            sessions={worktree.sessions}
                            onToggleSessionChildren={onToggleSessionChildren}
                            onSelectSession={onSelectSession}
                            onPinSession={onPinSession}
                            onArchiveSession={onArchiveSession}
                            onOpenSessionActions={onOpenSessionActions}
                          />
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
