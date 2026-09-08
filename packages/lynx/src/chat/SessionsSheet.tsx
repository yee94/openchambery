/**
 * Cap MobileSessionsSheet / MobileSessionStatusBar full-sheet spirit for Lynx.
 *
 * Opens from LynxSessionStatusBar via LynxMobileResizableSheet (0.72 / 0.98).
 * Session-index grouped list + search + All/pinned/project chips + long-press
 * menus (buildLynx*MenuItems) + Cap two-step archive + ~10s unarchive undo +
 * Cap ArchivedSessionsDialog + rename smart-title. Not Cap Zustand / toast lib / @dnd-kit / MobileWindowMotion.
 */
import { useEffect, useMemo, useState } from 'react';

import { lynxT } from '../i18n/catalog';
import { LynxInput, LynxScrollView, LynxText, LynxView } from '../lynx-elements';
import {
  closeLynxProject,
  inferLynxProjectIsGit,
  probeLynxGitRepository,
  syncLynxProjectSessions,
  updateLynxProjectLabel,
} from '../projects/projectActions';
import {
  LynxCreateWorktreeDialog,
  LynxDeleteWorktreeDialog,
} from '../projects/WorktreeDialogs';
import {
  archiveLynxSession,
  deleteLynxSession,
  renameLynxSession,
  requestLynxSessionSmartTitle,
  shareLynxSession,
  toggleLynxSessionPin,
  unarchiveLynxSession,
  unshareLynxSession,
  copyLynxText,
  fetchLynxSessionShareUrl,
} from '../projects/sessionActions';
import { LynxArchivedSessionsDialog } from './ArchivedSessionsDialog';
import {
  createLynxArchiveUndoBanner,
  isLynxArchiveUndoExpired,
  toggleLynxArchiveConfirm,
  type LynxArchiveUndoBanner,
} from './sessionArchiveUndo';
import {
  buildLynxProjectMenuItems,
  buildLynxSessionMenuItems,
  buildLynxWorktreeMenuItems,
  type LynxMenuItem,
} from '../projects/sessionMenuModel';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import type {
  LynxHomeProject,
  LynxHomeSessionRow,
  LynxHomeWorktreeGroup,
  ProjectSessionIndexHomeOptions,
} from '../session-index/homeModel';
import type { SessionIndexState } from '../session-index/types';
import { LynxMobileResizableSheet } from '../shell/MobileResizableSheet';
import { cssVar } from '../theme/tokens';
import { LYNX_PINNED_SESSION_FILTER_ID } from './sessionStatusBar';
import {
  LYNX_SESSIONS_SHEET_DEFAULT_VISIBLE,
  buildLynxSessionsSheetModel,
  collapseLynxSessionsSheetVisibleCount,
  nextLynxSessionsSheetVisibleCount,
  resolveLynxSessionsSheetOpenDirectory,
  sliceLynxSessionsSheetVisible,
  type LynxSessionsSheetFilterId,
} from './sessionsSheet';

export type LynxSessionsSheetProps = {
  locale: string;
  open: boolean;
  onClose: () => void;
  indexState: SessionIndexState | null;
  runtimeFetch?: LynxRuntimeFetch | null;
  homeOptions?: ProjectSessionIndexHomeOptions;
  /** Prefer active chat directory's project when resolving default filter. */
  activeDirectory?: string | null;
  currentSessionId?: string | null;
  onSelectSession: (sessionId: string, directory: string | null) => void;
  onOpenDraft?: (directory?: string | null) => void;
  onMutated?: () => void;
};

type ActionTarget =
  | { kind: 'session'; session: LynxHomeSessionRow }
  | { kind: 'project'; project: LynxHomeProject; gitRepository: boolean }
  | { kind: 'worktree'; project: LynxHomeProject; worktree: LynxHomeWorktreeGroup };

function SessionRow({
  session,
  isCurrent,
  confirmingArchive,
  onSelect,
  onLongPress,
  onRequestArchive,
  onConfirmArchive,
  locale,
}: {
  session: LynxHomeSessionRow;
  isCurrent: boolean;
  confirmingArchive: boolean;
  onSelect: () => void;
  onLongPress: () => void;
  onRequestArchive: () => void;
  onConfirmArchive: () => void;
  locale: string;
}) {
  return (
    <LynxView
      data-lynx-sessions-sheet-row={session.id}
      data-lynx-sessions-sheet-current={isCurrent ? 'true' : 'false'}
      data-lynx-sessions-sheet-confirming-archive={confirmingArchive ? 'true' : 'false'}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: '6px',
        borderRadius: '12px',
        borderWidth: '1px',
        borderColor: confirmingArchive
          ? cssVar('status.error')
          : isCurrent
            ? cssVar('primary.base')
            : cssVar('surface.mutedForeground'),
        backgroundColor: confirmingArchive
          ? cssVar('surface.muted')
          : isCurrent
            ? cssVar('surface.elevated')
            : cssVar('surface.muted'),
      }}
    >
      <LynxView
        bindtap={confirmingArchive ? undefined : onSelect}
        bindlongpress={confirmingArchive ? undefined : onLongPress}
        accessibility-role="button"
        accessibility-label={session.title}
        style={{
          flexGrow: 1,
          minWidth: '0',
          paddingTop: '10px',
          paddingBottom: '10px',
          paddingLeft: '12px',
          paddingRight: '8px',
          opacity: confirmingArchive ? 0.55 : 1,
        }}
      >
        <LynxView style={{ flexDirection: 'row', alignItems: 'center' }}>
          {session.pinned ? (
            <LynxText style={{ marginRight: '6px', color: cssVar('primary.base'), fontSize: '12px' }}>📌</LynxText>
          ) : null}
          {session.inProgress ? (
            <LynxText style={{ marginRight: '6px', color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>◐</LynxText>
          ) : null}
          <LynxText
            style={{
              color: cssVar('surface.foreground'),
              fontSize: '14px',
              fontWeight: isCurrent ? '700' : '500',
              flexGrow: 1,
            }}
          >
            {session.title}
          </LynxText>
        </LynxView>
        {session.subtitle ? (
          <LynxText style={{ marginTop: '2px', color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
            {session.subtitle}
          </LynxText>
        ) : null}
      </LynxView>

      {confirmingArchive ? (
        <LynxView
          data-lynx-sessions-sheet-archive-confirm={session.id}
          bindtap={onConfirmArchive}
          accessibility-role="button"
          accessibility-label={lynxT(locale, 'lynx.chat.sessionsSheet.archiveAria')}
          style={{
            flexShrink: 0,
            flexDirection: 'row',
            alignItems: 'center',
            marginRight: '4px',
            paddingLeft: '10px',
            paddingRight: '10px',
            paddingTop: '8px',
            paddingBottom: '8px',
            borderRadius: '10px',
            backgroundColor: cssVar('status.error'),
          }}
        >
          <LynxText style={{ color: cssVar('status.onError'), fontSize: '12px', fontWeight: '700' }}>
            {lynxT(locale, 'lynx.chat.sessionsSheet.archive')}
          </LynxText>
        </LynxView>
      ) : null}

      <LynxView
        data-lynx-sessions-sheet-archive-toggle={session.id}
        bindtap={onRequestArchive}
        accessibility-role="button"
        accessibility-label={
          confirmingArchive
            ? lynxT(locale, 'lynx.chat.sessionsSheet.cancelArchiveAria')
            : lynxT(locale, 'lynx.chat.sessionsSheet.archiveAria')
        }
        style={{
          flexShrink: 0,
          width: '36px',
          height: '36px',
          marginRight: '6px',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '10px',
        }}
      >
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '16px' }}>
          {confirmingArchive ? '✕' : '⧉'}
        </LynxText>
      </LynxView>
    </LynxView>
  );
}

/**
 * Full Cap-spirit sessions sheet. Returns null when closed (sheet handles open).
 */
export function LynxSessionsSheet({
  locale,
  open,
  onClose,
  indexState,
  runtimeFetch = null,
  homeOptions,
  activeDirectory = null,
  currentSessionId = null,
  onSelectSession,
  onOpenDraft,
  onMutated,
}: LynxSessionsSheetProps) {
  const [filterProjectId, setFilterProjectId] = useState<LynxSessionsSheetFilterId>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(LYNX_SESSIONS_SHEET_DEFAULT_VISIBLE);
  const [actionTarget, setActionTarget] = useState<ActionTarget | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [newWorktreeProject, setNewWorktreeProject] = useState<LynxHomeProject | null>(null);
  const [worktreeToDelete, setWorktreeToDelete] = useState<{
    project: LynxHomeProject;
    worktree: LynxHomeWorktreeGroup;
  } | null>(null);
  const [confirmingArchiveSessionId, setConfirmingArchiveSessionId] = useState<string | null>(null);
  const [archiveUndo, setArchiveUndo] = useState<LynxArchiveUndoBanner | null>(null);
  const [archiveUndoError, setArchiveUndoError] = useState<string | null>(null);
  const [archivedDialogOpen, setArchivedDialogOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setSearchQuery('');
      setVisibleCount(LYNX_SESSIONS_SHEET_DEFAULT_VISIBLE);
      setActionTarget(null);
      setActionError(null);
      setRenameDraft(null);
      setNote(null);
      setNewWorktreeProject(null);
      setWorktreeToDelete(null);
      setConfirmingArchiveSessionId(null);
      setArchiveUndo(null);
      setArchiveUndoError(null);
      setArchivedDialogOpen(false);
    }
  }, [open]);

  useEffect(() => {
    if (!archiveUndo) return;
    const remaining = archiveUndo.expiresAt - Date.now();
    if (remaining <= 0) {
      setArchiveUndo(null);
      return;
    }
    const timer = setTimeout(() => {
      setArchiveUndo((current) => (
        current && isLynxArchiveUndoExpired(current) ? null : current
      ));
    }, remaining);
    return () => clearTimeout(timer);
  }, [archiveUndo]);

  const activeProjectId = useMemo(() => {
    const dir = activeDirectory?.trim();
    if (!dir || !indexState?.snapshot) return null;
    const built = buildLynxSessionsSheetModel({
      snapshot: indexState.snapshot,
      filterProjectId: null,
      homeOptions,
    });
    const hit = built.model.projects.find((project) =>
      project.path === dir
      || project.worktrees.some((wt) => wt.path === dir)
      || project.sessions.some((session) => session.directory === dir),
    );
    return hit?.id ?? null;
  }, [activeDirectory, homeOptions, indexState?.snapshot]);

  const sheet = useMemo(() => buildLynxSessionsSheetModel({
    snapshot: indexState?.snapshot ?? null,
    filterProjectId,
    searchQuery,
    activeProjectId,
    homeOptions,
    allLabel: lynxT(locale, 'lynx.chat.sessionsSheet.filterAll'),
    pinnedLabel: lynxT(locale, 'lynx.projects.pinned'),
  }), [activeProjectId, filterProjectId, homeOptions, indexState?.snapshot, locale, searchQuery]);

  useEffect(() => {
    if (sheet.filterProjectId !== filterProjectId) {
      setFilterProjectId(sheet.filterProjectId);
    }
  }, [filterProjectId, sheet.filterProjectId]);

  const sliced = sliceLynxSessionsSheetVisible(sheet.sessions, visibleCount);

  const closeActions = () => {
    setActionTarget(null);
    setActionError(null);
    setRenameDraft(null);
    setActionBusy(false);
  };

  const refresh = () => {
    onMutated?.();
  };

  const showArchiveUndo = (session: LynxHomeSessionRow) => {
    setArchiveUndoError(null);
    setArchiveUndo(createLynxArchiveUndoBanner({
      sessionId: session.id,
      directory: session.directory,
    }));
  };

  const runArchiveSession = async (session: LynxHomeSessionRow): Promise<boolean> => {
    const result = await archiveLynxSession(runtimeFetch, {
      sessionId: session.id,
      directory: session.directory,
    });
    if (result.status !== 'ok') {
      setActionError(
        result.status === 'no-runtime'
          ? 'no-runtime'
          : (result.error || lynxT(locale, 'lynx.chat.sessionsSheet.archiveError')),
      );
      return false;
    }
    showArchiveUndo(session);
    refresh();
    return true;
  };

  const handleRequestArchive = (sessionId: string) => {
    setArchiveUndoError(null);
    setConfirmingArchiveSessionId((current) => toggleLynxArchiveConfirm(current, sessionId));
  };

  const handleConfirmArchive = (session: LynxHomeSessionRow) => {
    setConfirmingArchiveSessionId(null);
    setActionBusy(true);
    setActionError(null);
    void (async () => {
      await runArchiveSession(session);
      setActionBusy(false);
    })();
  };

  const handleUndoArchive = () => {
    if (!archiveUndo || actionBusy) return;
    const pending = archiveUndo;
    setActionBusy(true);
    setArchiveUndoError(null);
    void (async () => {
      const result = await unarchiveLynxSession(runtimeFetch, {
        sessionId: pending.sessionId,
        directory: pending.directory,
      });
      setActionBusy(false);
      if (result.status !== 'ok') {
        setArchiveUndoError(
          result.status === 'no-runtime'
            ? 'no-runtime'
            : (result.error || lynxT(locale, 'lynx.chat.sessionsSheet.undoFailed')),
        );
        return;
      }
      setArchiveUndo(null);
      refresh();
    })();
  };

  const selectSession = (session: LynxHomeSessionRow) => {
    const directory = resolveLynxSessionsSheetOpenDirectory({
      filterProjectId: sheet.filterProjectId,
      sessionDirectory: session.directory,
      currentDirectory: activeDirectory,
    });
    onSelectSession(session.id, directory);
    onClose();
  };

  const openSessionActions = (session: LynxHomeSessionRow) => {
    setActionError(null);
    setRenameDraft(null);
    setActionTarget({ kind: 'session', session });
  };

  const openProjectActions = (project: LynxHomeProject) => {
    setActionError(null);
    setRenameDraft(null);
    const inferred = inferLynxProjectIsGit(project);
    setActionTarget({ kind: 'project', project, gitRepository: inferred });
    void (async () => {
      const probe = await probeLynxGitRepository(runtimeFetch, project.path);
      if (probe.status === 'ok') {
        setActionTarget((current) => (
          current?.kind === 'project' && current.project.id === project.id
            ? { ...current, gitRepository: probe.isGitRepository }
            : current
        ));
      }
    })();
  };

  const openWorktreeActions = (project: LynxHomeProject, worktree: LynxHomeWorktreeGroup) => {
    setActionError(null);
    setRenameDraft(null);
    setActionTarget({ kind: 'worktree', project, worktree });
  };

  const sessionMenuItems: LynxMenuItem[] = actionTarget?.kind === 'session'
    ? buildLynxSessionMenuItems({
      pinned: actionTarget.session.pinned,
      shared: false,
      onTogglePin: () => {
        setActionBusy(true);
        setActionError(null);
        void (async () => {
          const result = await toggleLynxSessionPin(runtimeFetch, {
            sessionId: actionTarget.session.id,
            pinned: actionTarget.session.pinned,
          });
          setActionBusy(false);
          if (result.status !== 'ok') {
            setActionError(result.status === 'no-runtime' ? 'no-runtime' : result.error);
            return;
          }
          closeActions();
          refresh();
        })();
      },
      onRename: () => setRenameDraft(actionTarget.session.title),
      onShare: () => {
        setActionBusy(true);
        setActionError(null);
        void (async () => {
          const result = await shareLynxSession(runtimeFetch, {
            sessionId: actionTarget.session.id,
            directory: actionTarget.session.directory,
          });
          setActionBusy(false);
          if (result.status !== 'ok') {
            setActionError(
              result.status === 'no-runtime'
                ? 'no-runtime'
                : (result.error || lynxT(locale, 'lynx.projects.share.error')),
            );
            return;
          }
          if (!result.shareUrl) {
            setActionError(lynxT(locale, 'lynx.projects.share.error'));
            return;
          }
          const copied = await copyLynxText(result.shareUrl);
          setNote(
            copied.status === 'ok'
              ? lynxT(locale, 'lynx.projects.share.success')
              : result.shareUrl,
          );
          closeActions();
          refresh();
        })();
      },
      onCopyLink: () => {
        setActionBusy(true);
        setActionError(null);
        void (async () => {
          const fetched = await fetchLynxSessionShareUrl(runtimeFetch, {
            sessionId: actionTarget.session.id,
            directory: actionTarget.session.directory,
          });
          if (fetched.status !== 'ok' || !fetched.shareUrl) {
            setActionBusy(false);
            setActionError(lynxT(locale, 'lynx.projects.copyLink.unavailable'));
            return;
          }
          const copied = await copyLynxText(fetched.shareUrl);
          setActionBusy(false);
          if (copied.status !== 'ok') {
            setActionError(lynxT(locale, 'lynx.projects.copyLink.unavailable'));
            setNote(fetched.shareUrl);
            return;
          }
          setNote(lynxT(locale, 'lynx.projects.copyLink.ok'));
          closeActions();
        })();
      },
      onUnshare: () => {
        setActionBusy(true);
        setActionError(null);
        void (async () => {
          const result = await unshareLynxSession(runtimeFetch, {
            sessionId: actionTarget.session.id,
            directory: actionTarget.session.directory,
          });
          setActionBusy(false);
          if (result.status !== 'ok') {
            setActionError(
              result.status === 'no-runtime'
                ? 'no-runtime'
                : (result.error || lynxT(locale, 'lynx.projects.unshare.error')),
            );
            return;
          }
          setNote(lynxT(locale, 'lynx.projects.unshare.success'));
          closeActions();
          refresh();
        })();
      },
      onArchive: () => {
        setActionBusy(true);
        setActionError(null);
        void (async () => {
          const session = actionTarget.session;
          const ok = await runArchiveSession(session);
          setActionBusy(false);
          if (!ok) return;
          closeActions();
        })();
      },
      onDelete: () => {
        setActionBusy(true);
        setActionError(null);
        void (async () => {
          const result = await deleteLynxSession(runtimeFetch, {
            sessionId: actionTarget.session.id,
            directory: actionTarget.session.directory,
          });
          setActionBusy(false);
          if (result.status !== 'ok') {
            setActionError(result.status === 'no-runtime' ? 'no-runtime' : result.error);
            return;
          }
          closeActions();
          refresh();
        })();
      },
    })
    : [];

  const projectMenuItems: LynxMenuItem[] = actionTarget?.kind === 'project'
    ? buildLynxProjectMenuItems({
      gitRepository: actionTarget.gitRepository,
      onNewSession: () => {
        const directory = actionTarget.project.path;
        closeActions();
        onClose();
        onOpenDraft?.(directory);
      },
      onNewWorktree: () => {
        setNewWorktreeProject(actionTarget.project);
        closeActions();
      },
      onSyncSessions: () => {
        setActionBusy(true);
        setActionError(null);
        void (async () => {
          const directories = [
            actionTarget.project.path,
            ...actionTarget.project.worktrees.map((worktree) => worktree.path),
          ];
          const result = await syncLynxProjectSessions(runtimeFetch, directories);
          setActionBusy(false);
          if (result.status === 'ok') {
            setNote(lynxT(locale, 'lynx.projects.sync.ok'));
            closeActions();
            refresh();
            return;
          }
          if (result.status === 'unsupported') {
            setActionError(lynxT(locale, 'lynx.projects.sync.failed') + ' (unsupported)');
            return;
          }
          setActionError(
            result.status === 'no-runtime'
              ? 'no-runtime'
              : (result.error || lynxT(locale, 'lynx.projects.sync.failed')),
          );
        })();
      },
      onEditProject: () => {
        setRenameDraft(actionTarget.project.label);
      },
      onCloseProject: () => {
        setActionBusy(true);
        setActionError(null);
        void (async () => {
          const result = await closeLynxProject(runtimeFetch, {
            projectId: actionTarget.project.id,
            path: actionTarget.project.path,
          });
          setActionBusy(false);
          if (result.status !== 'ok') {
            setActionError(
              result.status === 'no-runtime'
                ? 'no-runtime'
                : result.status === 'unavailable'
                  ? result.reason
                  : result.error,
            );
            return;
          }
          closeActions();
          refresh();
        })();
      },
    })
    : [];

  const worktreeMenuItems: LynxMenuItem[] = actionTarget?.kind === 'worktree'
    ? buildLynxWorktreeMenuItems({
      onNewSession: () => {
        const directory = actionTarget.worktree.path;
        closeActions();
        onClose();
        onOpenDraft?.(directory);
      },
      onDeleteWorktree: actionTarget.worktree.kind === 'worktree'
        ? () => {
          setWorktreeToDelete({
            project: actionTarget.project,
            worktree: actionTarget.worktree,
          });
          closeActions();
        }
        : undefined,
    })
    : [];

  const menuItems = actionTarget?.kind === 'session'
    ? sessionMenuItems
    : actionTarget?.kind === 'project'
      ? projectMenuItems
      : worktreeMenuItems;

  const indexStatus = indexState?.status ?? 'idle';
  const showChips = sheet.chips.length > 1;

  return (
    <LynxMobileResizableSheet
      locale={locale}
      open={open}
      title={lynxT(locale, 'lynx.chat.sessionsSheet.title')}
      ariaLabel={lynxT(locale, 'lynx.chat.sessionsSheet.aria')}
      onClose={onClose}
    >
      <LynxView data-lynx-sessions-sheet="body" style={{ flexGrow: 1, minHeight: '0', display: 'flex', flexDirection: 'column' }}>
        <LynxInput
          value={searchQuery}
          placeholder={lynxT(locale, 'lynx.projects.search.placeholder')}
          bindinput={(event) => {
            const detail = event.detail as { value?: string } | undefined;
            setSearchQuery(typeof detail?.value === 'string' ? detail.value : '');
            setVisibleCount(LYNX_SESSIONS_SHEET_DEFAULT_VISIBLE);
          }}
          accessibility-label={lynxT(locale, 'lynx.projects.searchAria')}
          style={{
            marginBottom: '8px',
            padding: '10px 12px',
            borderRadius: '12px',
            borderWidth: '1px',
            borderColor: cssVar('surface.mutedForeground'),
            backgroundColor: cssVar('surface.muted'),
            color: cssVar('surface.foreground'),
            fontSize: '14px',
          }}
        />

        {showChips ? (
          <LynxScrollView
            scroll-orientation="horizontal"
            style={{ flexDirection: 'row', flexShrink: 0, marginBottom: '8px', maxHeight: '44px' }}
          >
            {sheet.chips.map((chip) => {
              const active = sheet.filterProjectId === chip.id;
              return (
                <LynxView
                  key={chip.id ?? '__all__'}
                  data-lynx-sessions-sheet-chip={chip.kind}
                  bindtap={() => {
                    setFilterProjectId(chip.id);
                    setVisibleCount(LYNX_SESSIONS_SHEET_DEFAULT_VISIBLE);
                  }}
                  style={{
                    marginRight: '6px',
                    paddingLeft: '12px',
                    paddingRight: '12px',
                    paddingTop: '6px',
                    paddingBottom: '6px',
                    borderRadius: '999px',
                    borderWidth: '1px',
                    borderColor: active ? cssVar('primary.base') : cssVar('surface.mutedForeground'),
                    backgroundColor: active ? cssVar('surface.elevated') : cssVar('surface.muted'),
                  }}
                >
                  <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '12px', fontWeight: active ? '700' : '500' }}>
                    {chip.label}
                  </LynxText>
                </LynxView>
              );
            })}
          </LynxScrollView>
        ) : null}

        {note ? (
          <LynxText style={{ marginBottom: '6px', color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
            {note}
          </LynxText>
        ) : null}

        {archiveUndo ? (
          <LynxView
            data-lynx-sessions-sheet-archive-undo="true"
            style={{
              marginBottom: '8px',
              padding: '10px 12px',
              borderRadius: '12px',
              borderWidth: '1px',
              borderColor: cssVar('surface.mutedForeground'),
              backgroundColor: cssVar('surface.elevated'),
              flexDirection: 'row',
              alignItems: 'center',
            }}
          >
            <LynxText style={{ flexGrow: 1, color: cssVar('surface.foreground'), fontSize: '13px' }}>
              {lynxT(locale, 'lynx.chat.sessionsSheet.archiveSuccess')}
            </LynxText>
            <LynxView
              data-lynx-sessions-sheet-archive-view="true"
              bindtap={() => setArchivedDialogOpen(true)}
              accessibility-role="button"
              accessibility-label={lynxT(locale, 'lynx.chat.sessionsSheet.viewArchived')}
              style={{
                marginRight: '6px',
                paddingLeft: '10px',
                paddingRight: '10px',
                paddingTop: '6px',
                paddingBottom: '6px',
                borderRadius: '8px',
                borderWidth: '1px',
                borderColor: cssVar('surface.mutedForeground'),
              }}
            >
              <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '12px', fontWeight: '600' }}>
                {lynxT(locale, 'lynx.chat.sessionsSheet.viewArchived')}
              </LynxText>
            </LynxView>
            <LynxView
              data-lynx-sessions-sheet-archive-undo-action="true"
              bindtap={handleUndoArchive}
              accessibility-role="button"
              accessibility-label={lynxT(locale, 'lynx.chat.sessionsSheet.undo')}
              style={{
                paddingLeft: '10px',
                paddingRight: '10px',
                paddingTop: '6px',
                paddingBottom: '6px',
                borderRadius: '8px',
                backgroundColor: cssVar('primary.base'),
              }}
            >
              <LynxText style={{ color: cssVar('primary.foreground'), fontSize: '12px', fontWeight: '700' }}>
                {lynxT(locale, 'lynx.chat.sessionsSheet.undo')}
              </LynxText>
            </LynxView>
          </LynxView>
        ) : null}
        {archiveUndoError ? (
          <LynxText style={{ marginBottom: '6px', color: cssVar('status.error'), fontSize: '12px' }}>
            {archiveUndoError}
          </LynxText>
        ) : null}

        <LynxScrollView style={{ flexGrow: 1, minHeight: '0' }}>
          {indexStatus === 'loading' || indexStatus === 'idle' ? (
            <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
              {lynxT(locale, 'lynx.projects.loading')}
            </LynxText>
          ) : null}
          {indexStatus === 'failed' ? (
            <LynxText style={{ color: cssVar('status.error') }}>
              {lynxT(locale, 'lynx.projects.failure')}
            </LynxText>
          ) : null}
          {!indexState?.snapshot && indexStatus !== 'loading' ? (
            <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
              {lynxT(locale, 'lynx.projects.noRuntime')}
            </LynxText>
          ) : null}
          {indexState?.snapshot && sheet.empty ? (
            <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
              {lynxT(locale, 'lynx.chat.sessionsSheet.empty')}
            </LynxText>
          ) : null}

          {sheet.filterProjectId
            && sheet.filterProjectId !== LYNX_PINNED_SESSION_FILTER_ID
            && sheet.model.projects[0] ? (
            <LynxView
              data-lynx-sessions-sheet-project={sheet.model.projects[0].id}
              bindlongpress={() => openProjectActions(sheet.model.projects[0]!)}
              style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: '8px' }}
            >
              <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '700', fontSize: '15px' }}>
                {sheet.model.projects[0].label}
              </LynxText>
              <LynxView
                bindtap={() => {
                  onClose();
                  onOpenDraft?.(sheet.model.projects[0]!.path);
                }}
              >
                <LynxText style={{ color: cssVar('primary.base'), fontSize: '12px' }}>
                  {lynxT(locale, 'lynx.projects.menu.newSession')}
                </LynxText>
              </LynxView>
            </LynxView>
          ) : null}

          {sheet.filterProjectId
            && sheet.filterProjectId !== LYNX_PINNED_SESSION_FILTER_ID
            ? sheet.model.projects[0]?.worktrees
              .filter((worktree) => worktree.kind === 'worktree')
              .map((worktree) => (
                <LynxView
                  key={worktree.id}
                  bindlongpress={() => openWorktreeActions(sheet.model.projects[0]!, worktree)}
                  style={{ marginBottom: '6px' }}
                >
                  <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', fontWeight: '600' }}>
                    {worktree.name}
                  </LynxText>
                </LynxView>
              ))
            : null}

          {sliced.visible.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              isCurrent={session.id === currentSessionId}
              confirmingArchive={confirmingArchiveSessionId === session.id}
              locale={locale}
              onSelect={() => selectSession(session)}
              onLongPress={() => openSessionActions(session)}
              onRequestArchive={() => handleRequestArchive(session.id)}
              onConfirmArchive={() => handleConfirmArchive(session)}
            />
          ))}

          {sliced.canShowMore || sliced.canShowFewer ? (
            <LynxView style={{ flexDirection: 'row', gap: '12px', marginTop: '4px' }}>
              {sliced.canShowMore ? (
                <LynxView
                  bindtap={() => setVisibleCount((count) => nextLynxSessionsSheetVisibleCount(count, sheet.sessions.length))}
                >
                  <LynxText style={{ color: cssVar('primary.base'), fontSize: '13px' }}>
                    {lynxT(locale, 'lynx.chat.sessionsSheet.showMore')} (+{sliced.remaining})
                  </LynxText>
                </LynxView>
              ) : null}
              {sliced.canShowFewer ? (
                <LynxView bindtap={() => setVisibleCount(collapseLynxSessionsSheetVisibleCount())}>
                  <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '13px' }}>
                    {lynxT(locale, 'lynx.chat.sessionsSheet.showFewer')}
                  </LynxText>
                </LynxView>
              ) : null}
            </LynxView>
          ) : null}
        </LynxScrollView>


        <LynxView
          data-lynx-sessions-sheet-view-archived="true"
          bindtap={() => setArchivedDialogOpen(true)}
          accessibility-role="button"
          accessibility-label={lynxT(locale, 'lynx.chat.sessionsSheet.viewArchived')}
          style={{
            marginTop: '8px',
            paddingTop: '10px',
            paddingBottom: '4px',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '13px', fontWeight: '600' }}>
            {lynxT(locale, 'lynx.chat.archived.title')}
          </LynxText>
          <LynxText style={{ color: cssVar('primary.base'), fontSize: '12px' }}>
            {lynxT(locale, 'lynx.chat.sessionsSheet.viewArchived')}
          </LynxText>
        </LynxView>

        {actionTarget ? (
          <LynxView
            data-lynx-sessions-sheet-actions="true"
            style={{
              position: 'absolute',
              left: '0',
              right: '0',
              bottom: '0',
              top: '0',
              zIndex: 5,
              backgroundColor: 'rgba(0,0,0,0.35)',
              justifyContent: 'flex-end',
            }}
          >
            <LynxView
              bindtap={closeActions}
              style={{ position: 'absolute', left: '0', right: '0', top: '0', bottom: '0' }}
            />
            <LynxView
              style={{
                backgroundColor: cssVar('surface.elevated'),
                borderTopLeftRadius: '16px',
                borderTopRightRadius: '16px',
                padding: '16px',
              }}
            >
              <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '700', marginBottom: '8px' }}>
                {actionTarget.kind === 'session'
                  ? actionTarget.session.title
                  : actionTarget.kind === 'project'
                    ? actionTarget.project.label
                    : actionTarget.worktree.name}
              </LynxText>
              {renameDraft != null ? (
                <LynxView style={{ marginBottom: '8px' }}>
                  <LynxInput
                    value={renameDraft}
                    bindinput={(event) => {
                      const detail = event.detail as { value?: string } | undefined;
                      setRenameDraft(typeof detail?.value === 'string' ? detail.value : '');
                    }}
                    placeholder={lynxT(locale, 'lynx.projects.menu.renamePlaceholder')}
                    style={{
                      padding: '10px',
                      borderRadius: '10px',
                      borderWidth: '1px',
                      borderColor: cssVar('surface.mutedForeground'),
                      color: cssVar('surface.foreground'),
                      marginBottom: '8px',
                    }}
                  />
                  <LynxView
                    bindtap={() => {
                      if (actionBusy) return;
                      setActionBusy(true);
                      setActionError(null);
                      void (async () => {
                        if (actionTarget.kind === 'session') {
                          const result = await renameLynxSession(runtimeFetch, {
                            sessionId: actionTarget.session.id,
                            title: renameDraft,
                            directory: actionTarget.session.directory,
                          });
                          setActionBusy(false);
                          if (result.status !== 'ok') {
                            setActionError(result.status === 'no-runtime' ? 'no-runtime' : result.error);
                            return;
                          }
                        } else if (actionTarget.kind === 'project') {
                          const result = await updateLynxProjectLabel(runtimeFetch, {
                            projectId: actionTarget.project.id,
                            path: actionTarget.project.path,
                            label: renameDraft,
                          });
                          setActionBusy(false);
                          if (result.status !== 'ok') {
                            setActionError(
                              result.status === 'no-runtime'
                                ? 'no-runtime'
                                : result.status === 'unavailable'
                                  ? result.reason
                                  : result.error,
                            );
                            return;
                          }
                        }
                        closeActions();
                        refresh();
                      })();
                    }}
                    style={{ opacity: actionBusy ? 0.6 : 1, marginBottom: '8px' }}
                  >
                    <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600' }}>
                      {lynxT(locale, 'lynx.projects.menu.renameSave')}
                    </LynxText>
                  </LynxView>
                  {actionTarget.kind === 'session' ? (
                    <LynxView
                      bindtap={() => {
                        if (actionBusy) return;
                        const sessionId = actionTarget.session.id;
                        const directory = actionTarget.session.directory;
                        setActionBusy(true);
                        setActionError(null);
                        void (async () => {
                          // Cap closes immediately after submit — do not wait for generation.
                          // Lynx has no Cap toast lib: await the PATCH queue only, then close or show inline error.
                          const result = await requestLynxSessionSmartTitle(runtimeFetch, {
                            sessionId,
                            directory,
                          });
                          setActionBusy(false);
                          if (result.status !== 'ok') {
                            setActionError(result.status === 'no-runtime' ? 'no-runtime' : result.error);
                            return;
                          }
                          closeActions();
                          refresh();
                        })();
                      }}
                      style={{ opacity: actionBusy ? 0.6 : 1, marginBottom: '8px' }}
                    >
                      <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '600' }}>
                        {lynxT(locale, 'lynx.projects.menu.smartTitle')}
                      </LynxText>
                    </LynxView>
                  ) : null}
                </LynxView>
              ) : (
                menuItems.map((item) => (
                  <LynxView
                    key={item.id}
                    bindtap={() => {
                      if (actionBusy || item.disabled) return;
                      item.onClick();
                    }}
                    style={{
                      paddingTop: '12px',
                      paddingBottom: '12px',
                      opacity: item.disabled || actionBusy ? 0.5 : 1,
                      borderTopWidth: item.separated ? '1px' : '0',
                      borderTopColor: cssVar('surface.mutedForeground'),
                    }}
                  >
                    <LynxText
                      style={{
                        color: item.destructive ? cssVar('status.error') : cssVar('surface.foreground'),
                        fontSize: '15px',
                      }}
                    >
                      {lynxT(locale, item.labelKey as 'lynx.projects.menu.pin')}
                    </LynxText>
                  </LynxView>
                ))
              )}
              {actionError ? (
                <LynxText style={{ color: cssVar('status.error'), fontSize: '12px', marginTop: '6px' }}>
                  {actionError}
                </LynxText>
              ) : null}
              <LynxView bindtap={closeActions} style={{ marginTop: '8px' }}>
                <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
                  {lynxT(locale, 'lynx.projects.menu.cancel')}
                </LynxText>
              </LynxView>
            </LynxView>
          </LynxView>
        ) : null}

        {newWorktreeProject ? (
          <LynxCreateWorktreeDialog
            locale={locale}
            open
            projectDirectory={newWorktreeProject.path}
            runtimeFetch={runtimeFetch}
            onClose={() => {
              setNewWorktreeProject(null);
              setActionError(null);
            }}
            onCreated={(path) => {
              setNote(lynxT(locale, 'lynx.projects.menu.newWorktree'));
              refresh();
              onClose();
              onOpenDraft?.(path);
            }}
          />
        ) : null}

        {worktreeToDelete ? (
          <LynxDeleteWorktreeDialog
            locale={locale}
            open
            projectDirectory={worktreeToDelete.project.path}
            worktreeDirectory={worktreeToDelete.worktree.path}
            worktreeName={worktreeToDelete.worktree.name}
            worktreeBranch={worktreeToDelete.worktree.branch}
            linkedSessions={worktreeToDelete.worktree.sessions}
            runtimeFetch={runtimeFetch}
            onClose={() => setWorktreeToDelete(null)}
            onDeleted={() => {
              setWorktreeToDelete(null);
              refresh();
            }}
            onErrorNote={(message) => setNote(message)}
          />
        ) : null}

        <LynxArchivedSessionsDialog
          locale={locale}
          open={archivedDialogOpen}
          onClose={() => setArchivedDialogOpen(false)}
          indexState={indexState}
          runtimeFetch={runtimeFetch}
          onSelectSession={(sessionId, directory) => {
            setArchivedDialogOpen(false);
            onSelectSession(sessionId, directory);
            onClose();
          }}
          onMutated={refresh}
        />
      </LynxView>
    </LynxMobileResizableSheet>
  );
}


