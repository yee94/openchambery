import * as React from 'react';
import type { Session } from '@opencode-ai/sdk/v2/client';
import { useEvent } from '@reactuses/core';

import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { deleteSessionsWithUndo, showArchivedSessionsUndoToast } from '@/lib/sessionMutationUndo';
import { useMobileSessionExpansionStore } from '@/stores/useMobileSessionExpansionStore';
import { useMobileSessionTreeStore } from '@/stores/useMobileSessionTreeStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

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

export type MobileProjectsHomeContainerProps = {
  onOpenChat: (args: { sessionId: string; directory: string | null }) => void;
  onAddProject: () => void;
  /** Optional override for the header new-session button; defaults to opening
      a plain new-session draft without navigation. */
  onNewSession?: () => void;
  className?: string;
};

type ActionTargetState =
  | { kind: 'session'; session: Session }
  | { kind: 'project'; project: ProjectMeta }
  | { kind: 'worktree'; project: ProjectMeta; worktreePath: string; worktreeName: string };

/**
 * Data + action container for the mobile Projects home.
 * Presentational classes stay in MobileProjectsHome; this only maps stores and callbacks.
 */
export function MobileProjectsHomeContainer({
  onOpenChat,
  onAddProject,
  onNewSession,
  className,
}: MobileProjectsHomeContainerProps) {
  const { t } = useI18n();
  const model = useMobileProjectsHomeModel();

  const setProjectExpanded = useMobileSessionTreeStore((state) => state.setProjectExpanded);
  const setWorktreeExpanded = useMobileSessionTreeStore((state) => state.setWorktreeExpanded);
  const toggleParent = useMobileSessionExpansionStore((state) => state.toggleParent);
  const togglePinnedSession = useSessionPinnedStore((state) => state.toggle);
  const pinnedSessionIds = useSessionPinnedStore((state) => state.ids);
  const archiveSessions = useSessionUIStore((state) => state.archiveSessions);
  const updateSessionTitle = useSessionUIStore((state) => state.updateSessionTitle);
  const shareSession = useSessionUIStore((state) => state.shareSession);
  const unshareSession = useSessionUIStore((state) => state.unshareSession);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const removeProject = useProjectsStore((state) => state.removeProject);

  const [actionTarget, setActionTarget] = React.useState<ActionTargetState | null>(null);
  const [actionsOpen, setActionsOpen] = React.useState(false);
  const [renamingSession, setRenamingSession] = React.useState<Session | null>(null);
  const [renameDraft, setRenameDraft] = React.useState('');

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

  const handleOpenSessionActions = useEvent((session: MobileSessionTreeNode) => {
    if (isPaginationNodeId(session.id)) return;
    const raw = model.sessionById.get(session.id);
    if (!raw) return;
    setActionTarget({ kind: 'session', session: raw });
    setActionsOpen(true);
  });

  const handleToggleSessionChildren = useEvent((session: MobileSessionTreeNode) => {
    if (isPaginationNodeId(session.id)) return;
    toggleParent(session.id);
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
    openNewSessionDraft({
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
    setActionTarget({ kind: 'project', project: meta });
    setActionsOpen(true);
  });

  const handleNewWorktreeSession = useEvent((
    project: MobileProjectHomeItem,
    worktree: MobileWorktreeGroup,
  ) => {
    const meta = model.projectMetaById.get(project.id);
    if (!meta) return;
    startSessionDraftForDirectory(meta, worktree.path);
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
        // Worktrees list is authoritative for git-backed projects in this surface.
        gitRepository: actionTarget.project.worktrees.length > 0,
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
        // TODO: new worktree — MobileSessionsSheet owns NewWorktreeDialog; extract before wiring here.
        onNewWorktree: undefined,
        // Edit project (MobileProjectEditSurface) is out of scope for this wiring lane.
        onEditProject: undefined,
        onCloseProject: () => removeProject(project.id),
      };
    }
    const { project, worktreePath } = actionTarget;
    return {
      onNewSession: () => startSessionDraftForDirectory(project, worktreePath),
      // TODO: delete worktree — MobileDeleteWorktreeDialog is owned by MobileSessionsSheet.
      onDeleteWorktree: undefined,
    };
  }, [
    actionTarget,
    handleArchiveSession,
    handleCopyShareUrl,
    handleHardDeleteSession,
    handleShareFromMenu,
    handleUnshareFromMenu,
    removeProject,
    startSessionDraftForDirectory,
    t,
    togglePinnedSession,
  ]);

  return (
    <>
      <MobileProjectsHome
        className={className}
        projects={model.projects}
        onAddProject={onAddProject}
        onNewSession={handleNewSession}
        onToggleProject={handleToggleProject}
        onOpenProjectActions={handleOpenProjectActions}
        onToggleWorktree={handleToggleWorktree}
        onNewWorktreeSession={handleNewWorktreeSession}
        onToggleSessionChildren={handleToggleSessionChildren}
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
        onOpenChange={(open) => {
          if (!open) closeActions();
          else setActionsOpen(true);
        }}
      />

      <MobileOverlayPanel
        open={Boolean(renamingSession)}
        title={t('sessions.sidebar.session.menu.rename')}
        onClose={() => {
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
    </>
  );
}
