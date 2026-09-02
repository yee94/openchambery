import * as React from 'react';
import type { Session } from '@opencode-ai/sdk/v2/client';
import { useEvent } from '@reactuses/core';

import { Icon } from '@/components/icon/Icon';
import { NewWorktreeDialog } from '@/components/session/NewWorktreeDialog';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { MobileDeleteWorktreeDialog } from '@/apps/MobileDeleteWorktreeDialog';
import { MobileProjectEditSurface } from '@/apps/MobileProjectEditSurface';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { deleteSessionsWithUndo, showArchivedSessionsUndoToast } from '@/lib/sessionMutationUndo';
import { useMobileSessionTreeStore } from '@/stores/useMobileSessionTreeStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { usePinnedSessionIds, useTogglePinnedSession } from '@/queries/sessionIndexPinQueries';
import { syncGlobalSessionsForDirectories } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useLiveSessionStatus } from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { forceRefreshProjectWorktreeCatalog } from '@/lib/worktrees/worktreeManager';
import { normalizePath } from '@/lib/pathNormalization';
import type { WorktreeMetadata } from '@/types/worktree';

import { useMobileNavigationStore } from '../useMobileNavigationStore';

import {
  MobileProjectsHome,
  type MobileProjectHomeItem,
  type MobileSessionTreeNode,
  type MobileWorktreeGroup,
} from './MobileProjectsHome';
import {
  MobileRowActionsSheet,
  type MobileRowActionCallbacks,
  type MobileRowActionTarget,
} from './MobileRowActionsSheet';
import {
  getParentId,
  getSessionDirectory,
  isPaginationNodeId,
  parsePaginationNodeId,
  useMobileProjectsHomeModel,
  type ProjectMeta,
} from './useMobileProjectsHomeModel';
import {
  applyProjectGitProbeResult,
  type ActionTargetState,
} from './mobileProjectsHomeContainerState';

export type MobileProjectsHomeContainerProps = {
  onOpenChat: (args: { sessionId: string; directory: string | null }) => void;
  onAddProject: () => void;
  /** Optional override for the header new-session button; defaults to opening
      a plain new-session draft without navigation. */
  onNewSession?: () => void;
  onScanQr?: () => void;
  onSwitchInstance?: () => void;
  className?: string;
};

/**
 * Data + action container for the mobile Projects home.
 * Presentational classes stay in MobileProjectsHome; this only maps stores and callbacks.
 */
export function MobileProjectsHomeContainer({
  onOpenChat,
  onAddProject,
  onNewSession,
  onScanQr,
  onSwitchInstance,
  className,
}: MobileProjectsHomeContainerProps) {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const model = useMobileProjectsHomeModel();

  const setProjectExpanded = useMobileSessionTreeStore((state) => state.setProjectExpanded);
  const setWorktreeExpanded = useMobileSessionTreeStore((state) => state.setWorktreeExpanded);
  const togglePinnedSession = useTogglePinnedSession();
  const pinnedSessionIds = usePinnedSessionIds();
  const archiveSessions = useSessionUIStore((state) => state.archiveSessions);
  const updateSessionTitle = useSessionUIStore((state) => state.updateSessionTitle);
  const requestSessionSmartTitle = useSessionUIStore((state) => state.requestSessionSmartTitle);
  const shareSession = useSessionUIStore((state) => state.shareSession);
  const unshareSession = useSessionUIStore((state) => state.unshareSession);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const openDraft = useMobileNavigationStore((state) => state.openDraft);
  const openSession = useMobileNavigationStore((state) => state.openSession);
  const projects = useProjectsStore((state) => state.projects);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const removeProject = useProjectsStore((state) => state.removeProject);
  const sync = useSync();

  const [actionTarget, setActionTarget] = React.useState<ActionTargetState | null>(null);
  const [actionsOpen, setActionsOpen] = React.useState(false);
  const [editingProjectId, setEditingProjectId] = React.useState<string | null>(null);
  const [closingProject, setClosingProject] = React.useState<ProjectMeta | null>(null);
  const [renamingSession, setRenamingSession] = React.useState<Session | null>(null);
  const [renameDraft, setRenameDraft] = React.useState('');
  const [smartTitleRequesting, setSmartTitleRequesting] = React.useState(false);
  const [newWorktreeDialogOpen, setNewWorktreeDialogOpen] = React.useState(false);
  const [worktreeDialogProjectId, setWorktreeDialogProjectId] = React.useState<string | null>(null);
  const [worktreeToDelete, setWorktreeToDelete] = React.useState<{
    project: ProjectMeta;
    worktree: WorktreeMetadata;
  } | null>(null);
  const [refreshingSessionId, setRefreshingSessionId] = React.useState<string | null>(null);
  const actionSessionId = actionTarget?.kind === 'session' ? actionTarget.session.id : '';
  const actionSessionStatus = useLiveSessionStatus(actionSessionId);
  const isActionSessionBusy = actionSessionStatus?.type === 'busy' || actionSessionStatus?.type === 'retry';
  const actionSessionDirectory = actionTarget?.kind === 'session'
    ? getSessionDirectory(actionTarget.session)
    : '';
  const isActionTranscriptRefreshing = Boolean(actionSessionId) && refreshingSessionId === actionSessionId;
  const refreshTranscriptDisabled = !actionSessionDirectory || isActionTranscriptRefreshing || isActionSessionBusy;

  const collectSessionTreeIds = useEvent((sessionId: string): string[] => {
    const childrenByParent = new Map<string, string[]>();
    for (const candidate of model.allSessions) {
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
  });

  const closeActions = useEvent(() => {
    setActionsOpen(false);
    setActionTarget(null);
  });

  const handleSelectSession = useEvent((session: MobileSessionTreeNode) => {
    if (isPaginationNodeId(session.id)) {
      const parsed = parsePaginationNodeId(session.id);
      if (!parsed) return;
      if (parsed.kind === 'more') {
        model.showMoreBucketSessions(parsed.projectId, parsed.bucketKey);
      } else {
        model.resetBucketVisibleCount(parsed.projectId, parsed.bucketKey);
      }
      return;
    }
    const raw = model.sessionById.get(session.id);
    const directory = raw ? getSessionDirectory(raw) || null : null;
    onOpenChat({ sessionId: session.id, directory });
  });

  const handlePinSession = useEvent((session: MobileSessionTreeNode) => {
    if (isPaginationNodeId(session.id)) return;
    togglePinnedSession(session.id);
  });

  const handleArchiveSession = useEvent(async (session: MobileSessionTreeNode) => {
    if (isPaginationNodeId(session.id)) return;
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
  });

  const handleRefreshTranscript = useEvent(() => {
    if (!actionTarget || actionTarget.kind !== 'session') return;
    const session = actionTarget.session;
    const directory = getSessionDirectory(session);
    const statusType = actionSessionStatus?.type ?? 'idle';
    if (!directory || refreshingSessionId === session.id || statusType === 'busy' || statusType === 'retry') {
      return;
    }
    setRefreshingSessionId(session.id);
    void (async () => {
      try {
        await sync.refreshSessionTranscript(session.id, { directory });
        toast.success(t('sessions.sidebar.session.menu.refreshTranscriptSuccess'));
      } catch {
        toast.error(t('sessions.sidebar.session.menu.refreshTranscriptFailed'));
      } finally {
        setRefreshingSessionId((current) => (current === session.id ? null : current));
      }
    })();
  });

  const handleOpenSessionActions = useEvent((session: MobileSessionTreeNode) => {
    if (isPaginationNodeId(session.id)) return;
    const raw = model.sessionById.get(session.id);
    if (!raw) return;
    setActionTarget({ kind: 'session', session: raw });
    setActionsOpen(true);
  });

  const handleToggleProject = useEvent((project: MobileProjectHomeItem) => {
    setProjectExpanded(project.id, !project.expanded);
  });

  const handleToggleWorktree = useEvent((
    project: MobileProjectHomeItem,
    worktree: MobileWorktreeGroup,
  ) => {
    setWorktreeExpanded(`${project.id}::${worktree.id}`, !worktree.expanded);
  });

  const startSessionDraftForDirectory = useEvent((project: ProjectMeta, directory: string) => {
    setActiveProjectIdOnly(project.id);
    openDraft({
      selectedProjectId: project.id,
      directoryOverride: directory,
      preserveDirectoryOverride: true,
    });
  });

  const handleNewSession = useEvent(() => {
    if (onNewSession) {
      onNewSession();
      return;
    }
    openNewSessionDraft();
  });

  const handleOpenProjectActions = useEvent((project: MobileProjectHomeItem) => {
    const meta = model.projectMetaById.get(project.id);
    if (!meta) return;
    setActionTarget({ kind: 'project', project: meta, isGitRepository: false });
    setActionsOpen(true);
    void git.checkIsGitRepository(meta.path)
      .then((isGitRepository) => {
        setActionTarget((current) => applyProjectGitProbeResult(current, meta.id, isGitRepository));
      })
      .catch(() => {
        setActionTarget((current) => applyProjectGitProbeResult(current, meta.id, false));
      });
  });

  const resolveWorktreeMetadata = useEvent((
    project: ProjectMeta,
    worktreePath: string,
  ): WorktreeMetadata | null => {
    const normalized = normalizePath(worktreePath);
    if (!normalized) return null;
    const fromProject = project.worktrees.find(
      (entry) => normalizePath(entry.path) === normalized,
    );
    if (fromProject) return fromProject;
    const catalog = useSessionUIStore.getState().availableWorktreesByProject.get(project.path) ?? [];
    return catalog.find((entry) => normalizePath(entry.path) === normalized) ?? null;
  });

  const handleNewWorktreeSession = useEvent((
    project: MobileProjectHomeItem,
    worktree: MobileWorktreeGroup,
  ) => {
    const meta = model.projectMetaById.get(project.id);
    if (!meta) return;
    startSessionDraftForDirectory(meta, worktree.path);
  });

  const handleOpenWorktreeActions = useEvent((
    project: MobileProjectHomeItem,
    worktree: MobileWorktreeGroup,
  ) => {
    const meta = model.projectMetaById.get(project.id);
    if (!meta) return;
    setActionTarget({
      kind: 'worktree',
      project: meta,
      worktreePath: worktree.path,
      worktreeName: worktree.name,
    });
    setActionsOpen(true);
  });

  const handleDeleteWorktree = useEvent((
    project: MobileProjectHomeItem,
    worktree: MobileWorktreeGroup,
  ) => {
    const meta = model.projectMetaById.get(project.id);
    if (!meta) return;
    const metadata = resolveWorktreeMetadata(meta, worktree.path);
    if (!metadata) {
      toast.error(t('sessions.sidebar.sessionDialogs.worktree.errorRemoveTitle'), {
        description: t('sessions.sidebar.dialogs.deleteResult.tryAgain'),
      });
      return;
    }
    setWorktreeToDelete({ project: meta, worktree: metadata });
  });

  const handleNewWorktree = useEvent((projectId: string) => {
    setWorktreeDialogProjectId(projectId);
    setActiveProjectIdOnly(projectId);
    setNewWorktreeDialogOpen(true);
  });

  const handleSyncProjectSessions = useEvent((project: ProjectMeta) => {
    void (async () => {
      let worktrees = project.worktrees;
      try {
        const result = await forceRefreshProjectWorktreeCatalog({
          id: project.id,
          path: project.path,
        });
        worktrees = result.worktrees;
      } catch (error) {
        console.warn('[MobileProjectsHome] Worktree refresh before session sync failed:', error);
        worktrees = useSessionUIStore.getState().availableWorktreesByProject.get(project.path) ?? project.worktrees;
      }
      await syncGlobalSessionsForDirectories(
        [project.path, ...worktrees.map((worktree) => worktree.path)],
        model.allSessions,
      );
    })();
  });

  const handleWorktreeCreated = useEvent((worktreePath: string, options?: { sessionId?: string }) => {
    const projectId = worktreeDialogProjectId;
    setNewWorktreeDialogOpen(false);
    setWorktreeDialogProjectId(null);
    if (options?.sessionId) {
      openSession({ sessionId: options.sessionId, directory: worktreePath });
      return;
    }
    openDraft({
      selectedProjectId: projectId,
      directoryOverride: worktreePath,
      preserveDirectoryOverride: true,
    });
  });

  const handleShareFromMenu = useEvent(async (session: Session) => {
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
  });

  const handleCopyShareUrl = useEvent(async (url: string) => {
    const result = await copyTextToClipboard(url);
    if (result.ok) {
      toast.success(t('sessions.sidebar.session.menu.copied'));
      return;
    }
    toast.error(t('sessions.sidebar.session.share.copyUrlError'));
  });

  const handleUnshareFromMenu = useEvent(async (sessionId: string) => {
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

  const handleSaveSessionRename = useEvent(async () => {
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
  });

  // Smart title only queues the server-side refresh (metadata.requestedAt).
  // Close immediately after submit — do not wait for generation to finish.
  const handleRequestSmartTitle = useEvent(async () => {
    if (!renamingSession || smartTitleRequesting) return;
    const sessionId = renamingSession.id;
    setRenamingSession(null);
    setRenameDraft('');
    setSmartTitleRequesting(true);
    try {
      await requestSessionSmartTitle(sessionId);
    } catch {
      toast.error(t('sessions.sidebar.session.rename.smartTitle'), {
        description: t('sessions.sidebar.dialogs.deleteResult.tryAgain'),
      });
    } finally {
      setSmartTitleRequesting(false);
    }
  });

  const sheetTarget: MobileRowActionTarget | null = React.useMemo(() => {
    if (!actionTarget) return null;
    if (actionTarget.kind === 'session') {
      return {
        kind: 'session',
        title: actionTarget.session.title?.trim() || t('mobile.sessions.untitled'),
        pinned: pinnedSessionIds.has(actionTarget.session.id),
        shared: Boolean(actionTarget.session.share?.url),
      };
    }
    if (actionTarget.kind === 'project') {
      return {
        kind: 'project',
        title: actionTarget.project.label,
        gitRepository: actionTarget.isGitRepository,
      };
    }
    return {
      kind: 'worktree',
      title: actionTarget.worktreeName,
    };
  }, [actionTarget, pinnedSessionIds, t]);

  const sheetActions: MobileRowActionCallbacks = React.useMemo(() => {
    if (!actionTarget) return {};
    if (actionTarget.kind === 'session') {
      const session = actionTarget.session;
      return {
        onRename: () => {
          setRenameDraft(session.title?.trim() || t('mobile.sessions.untitled'));
          setRenamingSession(session);
        },
        onTogglePin: () => togglePinnedSession(session.id),
        onShare: session.share?.url
          ? undefined
          : () => {
              void handleShareFromMenu(session);
            },
        onCopyLink: session.share?.url
          ? () => {
              void handleCopyShareUrl(session.share!.url!);
            }
          : undefined,
        onUnshare: session.share?.url
          ? () => {
              void handleUnshareFromMenu(session.id);
            }
          : undefined,
        onRefreshTranscript: handleRefreshTranscript,
        onArchive: () => {
          void handleArchiveSession({
            id: session.id,
            title: session.title?.trim() || t('mobile.sessions.untitled'),
          });
        },
        onDelete: () => handleHardDeleteSession(session),
      };
    }
    if (actionTarget.kind === 'project') {
      const project = actionTarget.project;
      return {
        onNewSession: () => startSessionDraftForDirectory(project, project.path),
        onNewWorktree: () => handleNewWorktree(project.id),
        onSyncSessions: () => handleSyncProjectSessions(project),
        onEditProject: () => setEditingProjectId(project.id),
        onCloseProject: () => setClosingProject(project),
      };
    }
    const { project, worktreePath } = actionTarget;
    return {
      onNewSession: () => startSessionDraftForDirectory(project, worktreePath),
      onDeleteWorktree: () => {
        const metadata = resolveWorktreeMetadata(project, worktreePath);
        if (!metadata) {
          toast.error(t('sessions.sidebar.sessionDialogs.worktree.errorRemoveTitle'), {
            description: t('sessions.sidebar.dialogs.deleteResult.tryAgain'),
          });
          return;
        }
        setWorktreeToDelete({ project, worktree: metadata });
      },
    };
  }, [
    actionTarget,
    handleArchiveSession,
    handleCopyShareUrl,
    handleHardDeleteSession,
    handleRefreshTranscript,
    handleNewWorktree,
    handleSyncProjectSessions,
    handleShareFromMenu,
    handleUnshareFromMenu,
    resolveWorktreeMetadata,
    startSessionDraftForDirectory,
    t,
    togglePinnedSession,
  ]);

  const editingProject = React.useMemo(() => {
    if (!editingProjectId) return null;
    const entry = projects.find((project) => project.id === editingProjectId);
    const meta = model.projectMetaById.get(editingProjectId);
    if (!entry || !meta) return null;
    const isGitRepo = actionTarget?.kind === 'project' && actionTarget.project.id === editingProjectId
      ? actionTarget.isGitRepository
      : meta.worktrees.length > 0;
    return {
      id: entry.id,
      label: entry.label?.trim() || meta.label,
      path: normalizePath(entry.path) || meta.path,
      icon: entry.icon,
      color: entry.color,
      iconImage: entry.iconImage,
      iconBackground: entry.iconBackground,
      isGitRepo,
      worktrees: meta.worktrees,
    };
  }, [actionTarget, editingProjectId, model.projectMetaById, projects]);

  return (
    <>
      <MobileProjectsHome
        className={className}
        projects={model.projects}
        pinnedSessions={model.pinnedSessions}
        inProgressSessions={model.inProgressSessions}
        onAddProject={onAddProject}
        onNewSession={handleNewSession}
        onScanQr={onScanQr}
        onSwitchInstance={onSwitchInstance}
        onToggleProject={handleToggleProject}
        onOpenProjectActions={handleOpenProjectActions}
        onToggleWorktree={handleToggleWorktree}
        onNewWorktreeSession={handleNewWorktreeSession}
        onOpenWorktreeActions={handleOpenWorktreeActions}
        onDeleteWorktree={handleDeleteWorktree}
        onSelectSession={handleSelectSession}
        onPinSession={handlePinSession}
        onArchiveSession={(session) => {
          void handleArchiveSession(session);
        }}
        onOpenSessionActions={handleOpenSessionActions}
      />

      <MobileRowActionsSheet
        open={actionsOpen}
        target={sheetTarget}
        actions={sheetActions}
        refreshTranscriptDisabled={refreshTranscriptDisabled}
        refreshTranscriptSpinning={isActionTranscriptRefreshing}
        onOpenChange={(open) => {
          if (!open) closeActions();
          else setActionsOpen(true);
        }}
      />

      <NewWorktreeDialog
        open={newWorktreeDialogOpen}
        projectId={worktreeDialogProjectId}
        onOpenChange={(value) => {
          setNewWorktreeDialogOpen(value);
          if (!value) setWorktreeDialogProjectId(null);
        }}
        onWorktreeCreated={handleWorktreeCreated}
      />

      {worktreeToDelete ? (
        <MobileDeleteWorktreeDialog
          open
          project={{ id: worktreeToDelete.project.id, path: worktreeToDelete.project.path }}
          worktree={worktreeToDelete.worktree}
          onClose={() => setWorktreeToDelete(null)}
        />
      ) : null}

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
                toast.success(t('mobile.sessions.toast.projectRemoved', { label: project.label }));
              }}
            >
              {t('mobile.sessions.confirmRemoveProject')}
            </Button>
          </div>
        }
      >
        <p className="px-1 py-1 typography-ui-body text-foreground">
          {t('mobile.projects.closeConfirmMessage', { title: closingProject?.label ?? '' })}
        </p>
      </MobileOverlayPanel>

      <MobileOverlayPanel
        open={Boolean(renamingSession)}
        title={t('sessions.sidebar.session.menu.rename')}
        onClose={() => {
          if (smartTitleRequesting) return;
          setRenamingSession(null);
          setRenameDraft('');
        }}
        closeAriaLabel={t('mobile.surface.closeAria')}
        footer={
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              className="flex-1"
              disabled={smartTitleRequesting}
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
              disabled={!renameDraft.trim() || smartTitleRequesting}
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
            disabled={smartTitleRequesting}
          />
          <Button
            type="button"
            variant="outline"
            className="w-full gap-2"
            disabled={smartTitleRequesting}
            onClick={() => void handleRequestSmartTitle()}
          >
            {smartTitleRequesting ? (
              <Icon name="loader-4" className="size-4 animate-spin" />
            ) : (
              <Icon name="ai-generate-2" className="size-4" />
            )}
            {t('sessions.sidebar.session.rename.smartTitle')}
          </Button>
        </form>
      </MobileOverlayPanel>

      <MobileProjectEditSurface
        open={editingProjectId !== null}
        project={editingProject}
        onClose={() => setEditingProjectId(null)}
      />
    </>
  );
}
