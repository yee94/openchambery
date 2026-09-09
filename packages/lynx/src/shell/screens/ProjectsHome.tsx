import { useEffect, useMemo, useState } from 'react';

import type { LynxHostGlobalProps } from '../../host/embedding';
import { lynxT, tabLabel } from '../../i18n/catalog';
import { LynxInput, LynxScrollView, LynxText, LynxView } from '../../lynx-elements';
import {
  buildLynxProjectMenuItems,
  buildLynxSessionMenuItems,
  buildLynxWorktreeMenuItems,
  type LynxMenuItem,
} from '../../projects/sessionMenuModel';
import {
  archiveLynxSessions,
  copyLynxText,
  deleteLynxSession,
  fetchLynxSessionShareUrl,
  renameLynxSession,
  requestLynxSessionSmartTitle,
  shareLynxSession,
  toggleLynxSessionPin,
  unshareLynxSession,
} from '../../projects/sessionActions';
import {
  SESSION_DELETE_UNDO_MS,
  cancelLynxScheduledSessionDeletes,
  createLynxDeleteUndoBanner,
  isLynxDeleteUndoExpired,
  scheduleLynxSessionDeletes,
  type LynxDeleteUndoBanner,
} from '../../chat/sessionDeleteUndo';
import { resolveLynxSessionTreeTargets } from '../../chat/sessionTreeIds';
import {
  LYNX_SESSIONS_SHEET_DEFAULT_VISIBLE,
  collapseLynxSessionsSheetVisibleCount,
  lynxProjectsHomeBucketKey,
  nextLynxSessionsSheetVisibleCount,
  sliceLynxSessionsSheetVisible,
} from '../../chat/sessionsSheet';
import {
  closeLynxProject,
  inferLynxProjectIsGit,
  probeLynxGitRepository,
  syncLynxProjectSessions,
} from '../../projects/projectActions';
import { LynxProjectEditSurface } from '../../projects/ProjectEditSurface';
import {
  LynxCreateWorktreeDialog,
  LynxDeleteWorktreeDialog,
} from '../../projects/WorktreeDialogs';
import { filterLynxProjectsHomeForSearch } from '../../projects/search';
import type { LynxRuntimeFetch } from '../../runtime/fetch';
import {
  projectSessionIndexHome,
  type LynxHomeProject,
  type LynxHomeSessionRow,
  type LynxHomeWorktreeGroup,
  type LynxProjectsHomeModel,
  type ProjectSessionIndexHomeOptions,
} from '../../session-index/homeModel';
import type { SessionIndexState } from '../../session-index/types';
import { cssVar } from '../../theme/tokens';
import { DirectoryExplorerSheet } from '../../projects/DirectoryExplorerSheet';
import type { LynxCameraAdapter } from '../../host/camera';
import { LynxTabPageHeader } from '../TabPageHeader';
import { computeLynxTitleCollapseProgress } from '../tabPageHeader';
import { LynxCenteredDialog, LynxCenteredDialogAction } from '../CenteredDialog';
import { LynxDialogPortal } from '../DialogPortal';

export type ProjectsHomeBindings = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => SessionIndexState;
  load: () => Promise<unknown>;
  refresh: () => Promise<unknown>;
};

export type ProjectsHomeProps = {
  locale: string;
  host: LynxHostGlobalProps;
  fullPageAutoGlassSkin?: boolean;
  collapseProgress?: number;
  /** Session-index home bindings from connect (#36). Null → labeled no-runtime. */
  bindings?: ProjectsHomeBindings | null;
  homeOptions?: ProjectSessionIndexHomeOptions;
  /** Optional controlled search (tests / host). */
  searchQuery?: string;
  onSearchQueryChange?: (value: string) => void;
  onOpenSession?: (session: LynxHomeSessionRow) => void;
  /** Cap draft for directory — project/worktree newSession passes path. */
  onOpenDraft?: (directory?: string | null) => void;
  onTogglePin?: (session: LynxHomeSessionRow) => void;
  /** Connect runtime for pin/archive/delete/share. Null → actions report no-runtime. */
  runtimeFetch?: LynxRuntimeFetch | null;
  /** After a mutating menu action succeeds, refresh session-index. */
  onSessionMutated?: () => void;
  /** Test / story inject: skip store and render this model. */
  modelOverride?: LynxProjectsHomeModel | null;
  indexStateOverride?: SessionIndexState | null;
  /** Cap 扫一扫 — host camera adapter (honest unavailable). */
  cameraAdapter?: LynxCameraAdapter | null;
  /** Cap 切换实例 — navigate to instances secondary. */
  onOpenInstances?: () => void;
  onScanResult?: (message: string) => void;
};

type ActionTarget =
  | { kind: 'session'; session: LynxHomeSessionRow }
  | { kind: 'project'; project: LynxHomeProject; gitRepository: boolean }
  | { kind: 'worktree'; project: LynxHomeProject; worktree: LynxHomeWorktreeGroup };

function useSessionIndexState(
  bindings: ProjectsHomeBindings | null | undefined,
  override: SessionIndexState | null | undefined,
): SessionIndexState {
  const [state, setState] = useState<SessionIndexState>(() =>
    override ?? bindings?.getSnapshot() ?? {
      status: 'idle',
      snapshot: null,
      error: null,
      runtimeKey: null,
    },
  );

  useEffect(() => {
    if (override) {
      setState(override);
      return;
    }
    if (!bindings) {
      setState({ status: 'idle', snapshot: null, error: null, runtimeKey: null });
      return;
    }
    setState(bindings.getSnapshot());
    const unsubscribe = bindings.subscribe(() => setState(bindings.getSnapshot()));
    void bindings.load();
    return unsubscribe;
  }, [bindings, override]);

  return state;
}

function SessionRow({
  session,
  onOpen,
  onLongPress,
  cue,
}: {
  session: LynxHomeSessionRow;
  onOpen?: (session: LynxHomeSessionRow) => void;
  onLongPress?: (session: LynxHomeSessionRow) => void;
  cue?: 'pin' | 'busy' | null;
}) {
  return (
    <LynxView
      bindtap={() => onOpen?.(session)}
      bindlongpress={() => onLongPress?.(session)}
      accessibility-role="button"
      accessibility-label={session.title}
      style={{
        padding: '12px 0',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}
    >
      <LynxView style={{ flexGrow: 1, minWidth: '0px' }}>
        <LynxView style={{ flexDirection: 'row', alignItems: 'center' }}>
          {cue === 'pin' ? (
            <LynxText style={{ color: cssVar('primary.base'), marginRight: '6px', fontSize: '12px' }}>
              ●
            </LynxText>
          ) : null}
          {cue === 'busy' || session.inProgress ? (
            <LynxText style={{ color: cssVar('primary.base'), marginRight: '6px', fontSize: '12px' }}>
              ◐
            </LynxText>
          ) : null}
          <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '16px', fontWeight: '600' }}>
            {session.title}
          </LynxText>
        </LynxView>
        {session.subtitle ? (
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginTop: '2px' }}>
            {session.subtitle}
          </LynxText>
        ) : null}
      </LynxView>
      <LynxText style={{ color: cssVar('surface.mutedForeground') }}>›</LynxText>
    </LynxView>
  );
}

function WorktreeGroup({
  locale,
  worktree,
  expanded,
  onToggle,
  onOpenSession,
  onSessionLongPress,
  onWorktreeLongPress,
  visibleCount,
  onShowMore,
  onShowFewer,
  /** Cap: search uses unpaginated catalog — never limit matches to the compact slice. */
  searching = false,
}: {
  locale: string;
  worktree: LynxHomeWorktreeGroup;
  expanded: boolean;
  onToggle: () => void;
  onOpenSession?: (session: LynxHomeSessionRow) => void;
  onSessionLongPress?: (session: LynxHomeSessionRow) => void;
  onWorktreeLongPress?: (worktree: LynxHomeWorktreeGroup) => void;
  visibleCount: number;
  onShowMore: () => void;
  onShowFewer: () => void;
  searching?: boolean;
}) {
  const sliced = searching
    ? {
      visible: worktree.sessions.slice(),
      remaining: 0,
      canShowMore: false,
      canShowFewer: false,
    }
    : sliceLynxSessionsSheetVisible(worktree.sessions, visibleCount);
  return (
    <LynxView style={{ marginTop: '8px' }}>
      <LynxView
        bindtap={onToggle}
        bindlongpress={() => onWorktreeLongPress?.(worktree)}
        accessibility-role="button"
        accessibility-label={worktree.name}
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          padding: '8px 0',
        }}
      >
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '13px', fontWeight: '600' }}>
          {worktree.kind === 'worktree' ? `↳ ${worktree.name}` : worktree.name}
          {worktree.branch ? ` · ${worktree.branch}` : ''}
        </LynxText>
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
          {worktree.sessionCount} {expanded ? '▾' : '▸'}
        </LynxText>
      </LynxView>
      {expanded ? (
        <>
          {sliced.visible.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              onOpen={onOpenSession}
              onLongPress={onSessionLongPress}
              cue={session.inProgress ? 'busy' : null}
            />
          ))}
          {sliced.canShowMore || sliced.canShowFewer ? (
            <LynxView
              style={{ flexDirection: 'row', gap: '12px', marginTop: '4px', paddingBottom: '4px' }}
            >
              {sliced.canShowMore ? (
                <LynxView
                  bindtap={onShowMore}
                  accessibility-role="button"
                  accessibility-label={lynxT(locale, 'lynx.chat.sessionsSheet.showMore')}
                >
                  <LynxText style={{ color: cssVar('primary.base'), fontSize: '13px' }}>
                    {lynxT(locale, 'lynx.chat.sessionsSheet.showMore')} (+{sliced.remaining})
                  </LynxText>
                </LynxView>
              ) : null}
              {sliced.canShowFewer ? (
                <LynxView
                  bindtap={onShowFewer}
                  accessibility-role="button"
                  accessibility-label={lynxT(locale, 'lynx.chat.sessionsSheet.showFewer')}
                >
                  <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '13px' }}>
                    {lynxT(locale, 'lynx.chat.sessionsSheet.showFewer')}
                  </LynxText>
                </LynxView>
              ) : null}
            </LynxView>
          ) : null}
        </>
      ) : null}
    </LynxView>
  );
}

function ProjectCard({
  locale,
  project,
  expanded,
  onToggle,
  worktreeExpanded,
  onToggleWorktree,
  onOpenSession,
  onSessionLongPress,
  onProjectLongPress,
  onWorktreeLongPress,
  visibleCountByBucket,
  onShowMoreBucket,
  onShowFewerBucket,
  searching = false,
}: {
  locale: string;
  project: LynxHomeProject;
  expanded: boolean;
  onToggle: () => void;
  worktreeExpanded: Record<string, boolean>;
  onToggleWorktree: (worktreeId: string) => void;
  onOpenSession?: (session: LynxHomeSessionRow) => void;
  onSessionLongPress?: (session: LynxHomeSessionRow) => void;
  onProjectLongPress?: (project: LynxHomeProject) => void;
  onWorktreeLongPress?: (project: LynxHomeProject, worktree: LynxHomeWorktreeGroup) => void;
  visibleCountByBucket: Record<string, number>;
  onShowMoreBucket: (projectId: string, worktree: LynxHomeWorktreeGroup) => void;
  onShowFewerBucket: (projectId: string, worktreeId: string) => void;
  searching?: boolean;
}) {
  return (
    <LynxView
      style={{
        marginBottom: '12px',
        padding: '14px 14px',
        borderRadius: '16px',
        backgroundColor: cssVar('surface.elevated'),
      }}
    >
      <LynxView
        bindtap={onToggle}
        bindlongpress={() => onProjectLongPress?.(project)}
        accessibility-role="button"
        accessibility-label={project.label}
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <LynxView>
          <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '17px', fontWeight: '700' }}>
            {project.label}
          </LynxText>
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginTop: '2px' }}>
            {project.path}
          </LynxText>
        </LynxView>
        <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
          {project.sessionCount} {expanded ? '▾' : '▸'}
        </LynxText>
      </LynxView>
      {expanded
        ? project.worktrees.map((worktree) => {
          const bucketKey = lynxProjectsHomeBucketKey(project.id, worktree.id);
          const visibleCount = visibleCountByBucket[bucketKey] ?? LYNX_SESSIONS_SHEET_DEFAULT_VISIBLE;
          return (
            <WorktreeGroup
              key={worktree.id}
              locale={locale}
              worktree={worktree}
              expanded={searching || (worktreeExpanded[worktree.id] ?? worktree.kind === 'main')}
              onToggle={() => onToggleWorktree(worktree.id)}
              onOpenSession={onOpenSession}
              onSessionLongPress={onSessionLongPress}
              onWorktreeLongPress={(wt) => onWorktreeLongPress?.(project, wt)}
              visibleCount={visibleCount}
              onShowMore={() => onShowMoreBucket(project.id, worktree)}
              onShowFewer={() => onShowFewerBucket(project.id, worktree.id)}
              searching={searching}
            />
          );
        })
        : null}
    </LynxView>
  );
}

/**
 * Projects home: session-index cards + worktree groups + search + pin/busy cues.
 * failure ≠ empty — failed refresh keeps previous snapshot and shows an error banner.
 * Cap per-bucket Show more / Show fewer (default 3 / +7) via SessionsSheet helpers.
 */
export function ProjectsHome({
  locale,
  host,
  fullPageAutoGlassSkin = true,
  collapseProgress,
  bindings = null,
  homeOptions,
  searchQuery: searchQueryProp,
  onSearchQueryChange,
  onOpenSession,
  onOpenDraft,
  onTogglePin,
  runtimeFetch = null,
  onSessionMutated,
  modelOverride = null,
  indexStateOverride = null,
  cameraAdapter = null,
  onOpenInstances,
  onScanResult,
}: ProjectsHomeProps) {
  const indexState = useSessionIndexState(bindings, indexStateOverride);
  const [internalQuery, setInternalQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(Boolean(searchQueryProp));
  const [headerProgress, setHeaderProgress] = useState(0);
  const [projectExpanded, setProjectExpanded] = useState<Record<string, boolean>>({});
  const [worktreeExpanded, setWorktreeExpanded] = useState<Record<string, boolean>>({});
  /** Cap `visibleCountByBucket` — per project/worktree key `projectId::worktreeId`. */
  const [visibleCountByBucket, setVisibleCountByBucket] = useState<Record<string, number>>({});
  const [actionTarget, setActionTarget] = useState<ActionTarget | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [shareUrlBySessionId, setShareUrlBySessionId] = useState<Record<string, string>>({});
  const [closingProject, setClosingProject] = useState<LynxHomeProject | null>(null);
  const [editingProject, setEditingProject] = useState<LynxHomeProject | null>(null);
  const [newWorktreeProject, setNewWorktreeProject] = useState<LynxHomeProject | null>(null);
  const [worktreeToDelete, setWorktreeToDelete] = useState<{
    project: LynxHomeProject;
    worktree: LynxHomeWorktreeGroup;
  } | null>(null);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [chromeNote, setChromeNote] = useState<string | null>(null);
  const [deleteUndo, setDeleteUndo] = useState<LynxDeleteUndoBanner | null>(null);
  const [pendingDeletionIds, setPendingDeletionIds] = useState<string[]>([]);
  const searchQuery = searchQueryProp ?? internalQuery;
  const setSearchQuery = onSearchQueryChange ?? setInternalQuery;
  /** Cap keyword search — bypass compact Show-more slice (catalogSessions spirit). */
  const searching = searchQuery.trim().length > 0;

  const baseModel = useMemo(() => {
    if (modelOverride) return modelOverride;
    if (!indexState.snapshot) {
      return {
        projects: [],
        pinnedSessions: [],
        inProgressSessions: [],
        sessionById: new Map(),
      } satisfies LynxProjectsHomeModel;
    }
    return projectSessionIndexHome(indexState.snapshot, homeOptions);
  }, [modelOverride, indexState.snapshot, homeOptions]);

  const searchedModel = useMemo(
    () => filterLynxProjectsHomeForSearch(baseModel, searchQuery),
    [baseModel, searchQuery],
  );

  useEffect(() => {
    if (!deleteUndo) return;
    const remaining = deleteUndo.expiresAt - Date.now();
    if (remaining <= 0) {
      setDeleteUndo(null);
      return;
    }
    const timer = setTimeout(() => {
      setDeleteUndo((current) => (
        current && isLynxDeleteUndoExpired(current) ? null : current
      ));
    }, remaining);
    return () => clearTimeout(timer);
  }, [deleteUndo]);

  const pendingDeletionSet = useMemo(() => new Set(pendingDeletionIds), [pendingDeletionIds]);
  const model = useMemo(() => {
    if (pendingDeletionSet.size === 0) return searchedModel;
    const filterRows = (rows: typeof searchedModel.pinnedSessions) => (
      rows.filter((row) => !pendingDeletionSet.has(row.id))
    );
    return {
      ...searchedModel,
      pinnedSessions: filterRows(searchedModel.pinnedSessions),
      inProgressSessions: filterRows(searchedModel.inProgressSessions),
      projects: searchedModel.projects.map((project) => ({
        ...project,
        sessions: filterRows(project.sessions),
        worktrees: project.worktrees.map((worktree) => ({
          ...worktree,
          sessions: filterRows(worktree.sessions),
          sessionCount: filterRows(worktree.sessions).length,
        })),
        sessionCount: filterRows(project.sessions).length,
      })),
    };
  }, [pendingDeletionSet, searchedModel]);


  const showFailure = indexState.status === 'failed';
  const showUnsupported = indexState.status === 'unsupported';
  const showLoading = indexState.status === 'loading' || indexState.status === 'idle';
  const noRuntime = !bindings && !modelOverride && !indexStateOverride;

  const progress = collapseProgress ?? headerProgress;

  const closeActionSheet = () => {
    setActionTarget(null);
    setActionError(null);
    setRenameDraft(null);
    setActionBusy(false);
  };

  const refreshAfterMutation = () => {
    onSessionMutated?.();
    void bindings?.refresh?.();
  };

  const openSessionActions = (session: LynxHomeSessionRow) => {
    setActionError(null);
    setRenameDraft(null);
    setActionTarget({ kind: 'session', session });
    void (async () => {
      if (shareUrlBySessionId[session.id]) return;
      const result = await fetchLynxSessionShareUrl(runtimeFetch, {
        sessionId: session.id,
        directory: session.directory,
      });
      if (result.status === 'ok' && result.shareUrl) {
        setShareUrlBySessionId((map) => ({ ...map, [session.id]: result.shareUrl! }));
      }
    })();
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
    ? (() => {
      const actionSession = actionTarget.session;
      const shareUrl = shareUrlBySessionId[actionSession.id] ?? null;
      const shared = Boolean(shareUrl);
      return buildLynxSessionMenuItems({
        pinned: actionSession.pinned,
        shared,
        onTogglePin: () => {
          setActionBusy(true);
          setActionError(null);
          void (async () => {
            if (onTogglePin) {
              onTogglePin(actionSession);
              setActionBusy(false);
              closeActionSheet();
              refreshAfterMutation();
              return;
            }
            const result = await toggleLynxSessionPin(runtimeFetch, {
              sessionId: actionSession.id,
              pinned: actionSession.pinned,
            });
            setActionBusy(false);
            if (result.status !== 'ok') {
              setActionError(result.status === 'no-runtime' ? 'no-runtime' : result.error);
              return;
            }
            closeActionSheet();
            refreshAfterMutation();
          })();
        },
        onRename: () => {
          setActionError(null);
          setRenameDraft(actionSession.title);
        },
        onShare: () => {
          setActionBusy(true);
          setActionError(null);
          void (async () => {
            const result = await shareLynxSession(runtimeFetch, {
              sessionId: actionSession.id,
              directory: actionSession.directory,
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
            if (result.shareUrl) {
              setShareUrlBySessionId((map) => ({ ...map, [actionSession.id]: result.shareUrl! }));
            } else {
              // Cap requires share.url — treat missing url as failure (never fake-success).
              setActionError(lynxT(locale, 'lynx.projects.share.error'));
              return;
            }
            setChromeNote(lynxT(locale, 'lynx.projects.share.success'));
            closeActionSheet();
            refreshAfterMutation();
          })();
        },
        onCopyLink: () => {
          setActionBusy(true);
          setActionError(null);
          void (async () => {
            const url = shareUrl;
            if (!url) {
              setActionBusy(false);
              setActionError(lynxT(locale, 'lynx.projects.copyLink.unavailable'));
              return;
            }
            const copied = await copyLynxText(url);
            setActionBusy(false);
            if (copied.status !== 'ok') {
              setActionError(lynxT(locale, 'lynx.projects.copyLink.unavailable'));
              setChromeNote(url);
              return;
            }
            setChromeNote(lynxT(locale, 'lynx.projects.copyLink.ok'));
            closeActionSheet();
          })();
        },
        onUnshare: () => {
          setActionBusy(true);
          setActionError(null);
          void (async () => {
            const result = await unshareLynxSession(runtimeFetch, {
              sessionId: actionSession.id,
              directory: actionSession.directory,
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
            setShareUrlBySessionId((map) => {
              const next = { ...map };
              delete next[actionSession.id];
              return next;
            });
            setChromeNote(lynxT(locale, 'lynx.projects.unshare.success'));
            closeActionSheet();
            refreshAfterMutation();
          })();
        },
        onArchive: () => {
          setActionBusy(true);
          setActionError(null);
          void (async () => {
            const targets = resolveLynxSessionTreeTargets(
              { sessionId: actionSession.id, directory: actionSession.directory },
              model.sessionById,
            );
            const { archivedIds, failedIds } = await archiveLynxSessions(
              runtimeFetch,
              targets.map((target) => ({
                sessionId: target.sessionId,
                directory: target.directory,
              })),
            );
            setActionBusy(false);
            if (archivedIds.length > 0) {
              setChromeNote(
                archivedIds.length === 1
                  ? lynxT(locale, 'lynx.chat.sessionsSheet.archiveSuccess')
                  : lynxT(locale, 'lynx.chat.sessionsSheet.archiveSuccessPlural', {
                    count: String(archivedIds.length),
                  }),
              );
              closeActionSheet();
              refreshAfterMutation();
            }
            if (failedIds.length > 0) {
              setActionError(
                failedIds.length === 1
                  ? lynxT(locale, 'lynx.chat.sessionsSheet.archiveError')
                  : lynxT(locale, 'lynx.chat.sessionsSheet.archiveErrorPlural', {
                    count: String(failedIds.length),
                  }),
              );
            }
          })();
        },
        onDelete: () => {
          setActionError(null);
          const targets = resolveLynxSessionTreeTargets(
            { sessionId: actionSession.id, directory: actionSession.directory },
            model.sessionById,
          );
          const { batchId, scheduledIds } = scheduleLynxSessionDeletes(targets, {
            delayMs: SESSION_DELETE_UNDO_MS,
            onCommit: async (entries) => {
              const failedIds: string[] = [];
              for (const entry of entries) {
                const result = await deleteLynxSession(runtimeFetch, {
                  sessionId: entry.sessionId,
                  directory: entry.directory,
                });
                if (result.status !== 'ok') failedIds.push(entry.sessionId);
              }
              setPendingDeletionIds((current) => current.filter((id) => !scheduledIds.includes(id)));
              setDeleteUndo((current) => (current?.batchId === batchId ? null : current));
              if (failedIds.length > 0) {
                setChromeNote(
                  failedIds.length === 1
                    ? lynxT(locale, 'lynx.chat.sessionsSheet.deleteCommitFailed')
                    : lynxT(locale, 'lynx.chat.sessionsSheet.deleteCommitFailedPlural', {
                      count: String(failedIds.length),
                    }),
                );
              }
              refreshAfterMutation();
            },
          });
          if (!batchId) {
            setActionError(lynxT(locale, 'lynx.chat.sessionsSheet.deleteError'));
            return;
          }
          setPendingDeletionIds((current) => Array.from(new Set([...current, ...scheduledIds])));
          setDeleteUndo(createLynxDeleteUndoBanner({ batchId, sessionIds: scheduledIds }));
          closeActionSheet();
        },
      });
    })()
    : [];

  const projectMenuItems: LynxMenuItem[] = actionTarget?.kind === 'project'
    ? buildLynxProjectMenuItems({
      gitRepository: actionTarget.gitRepository,
      onNewSession: () => {
        const directory = actionTarget.project.path;
        closeActionSheet();
        onOpenDraft?.(directory);
      },
      onNewWorktree: () => {
        setNewWorktreeProject(actionTarget.project);
        closeActionSheet();
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
            setChromeNote(lynxT(locale, 'lynx.projects.sync.ok'));
            closeActionSheet();
            refreshAfterMutation();
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
        setEditingProject(actionTarget.project);
        closeActionSheet();
      },
      onCloseProject: () => {
        setClosingProject(actionTarget.project);
        closeActionSheet();
      },
    })
    : [];

  const worktreeMenuItems: LynxMenuItem[] = actionTarget?.kind === 'worktree'
    ? buildLynxWorktreeMenuItems({
      onNewSession: () => {
        const directory = actionTarget.worktree.path;
        closeActionSheet();
        onOpenDraft?.(directory);
      },
      onDeleteWorktree: actionTarget.worktree.kind === 'worktree'
        ? () => {
          setWorktreeToDelete({
            project: actionTarget.project,
            worktree: actionTarget.worktree,
          });
          closeActionSheet();
        }
        : undefined,
    })
    : [];

  const sheetItems = actionTarget?.kind === 'session'
    ? sessionMenuItems
    : actionTarget?.kind === 'project'
      ? projectMenuItems
      : worktreeMenuItems;

  const sheetTitle = actionTarget?.kind === 'session'
    ? actionTarget.session.title
    : actionTarget?.kind === 'project'
      ? actionTarget.project.label
      : actionTarget?.kind === 'worktree'
        ? actionTarget.worktree.name
        : '';

  const sheetAria = actionTarget?.kind === 'project'
    ? lynxT(locale, 'lynx.projects.menu.projectTitle')
    : actionTarget?.kind === 'worktree'
      ? lynxT(locale, 'lynx.projects.menu.worktreeTitle')
      : lynxT(locale, 'lynx.projects.menu.title');

  return (
    <LynxView
      style={{
        flexGrow: 1,
        backgroundColor: cssVar('surface.background'),
      }}
    >
      <LynxTabPageHeader
        title={tabLabel(locale, 'projects')}
        locale={locale}
        host={host}
        fullPageAutoGlassSkin={fullPageAutoGlassSkin}
        collapseProgress={progress}
        searchOpen={searchOpen || Boolean(searchQuery)}
        searchQuery={searchQuery}
        onToggleSearch={() => {
          setSearchOpen((open) => {
            const next = !open;
            if (!next) setSearchQuery('');
            return next;
          });
        }}
        onSearchQueryChange={setSearchQuery}
        onPrimaryAction={() => onOpenDraft?.()}
        primaryAccessibilityLabel={lynxT(locale, 'lynx.projects.newDraft')}
        searchAccessibilityLabel={lynxT(locale, 'lynx.projects.searchAria')}
        searchClearAccessibilityLabel={lynxT(locale, 'lynx.projects.clearSearchAria')}
      />

      <LynxView style={{ flexDirection: 'row', padding: '0 16px 8px', gap: '12px' }}>
        <LynxView
          bindtap={() => setExplorerOpen(true)}
          accessibility-role="button"
          accessibility-label={lynxT(locale, 'lynx.projects.chrome.addProject')}
        >
          <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600', fontSize: '13px' }}>
            {lynxT(locale, 'lynx.projects.chrome.addProject')}
          </LynxText>
        </LynxView>
        <LynxView
          bindtap={() => {
            void (async () => {
              if (!cameraAdapter) {
                const msg = lynxT(locale, 'lynx.connect.qr.unavailable');
                setChromeNote(msg);
                onScanResult?.(msg);
                return;
              }
              const result = await cameraAdapter.scanPairingQr();
              if (result.status === 'unavailable' || result.status === 'unsupported') {
                const msg = lynxT(locale, 'lynx.connect.qr.unavailable');
                setChromeNote(msg);
                onScanResult?.(msg);
                return;
              }
              if (result.status === 'ok' || result.status === 'pairing') {
                setChromeNote(lynxT(locale, 'lynx.projects.chrome.scan'));
                onScanResult?.(result.status);
                return;
              }
              setChromeNote(result.status);
              onScanResult?.(result.status);
            })();
          }}
          accessibility-role="button"
          accessibility-label={lynxT(locale, 'lynx.projects.chrome.scan')}
        >
          <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600', fontSize: '13px' }}>
            {lynxT(locale, 'lynx.projects.chrome.scan')}
          </LynxText>
        </LynxView>
        <LynxView
          bindtap={() => onOpenInstances?.()}
          accessibility-role="button"
          accessibility-label={lynxT(locale, 'lynx.projects.chrome.switchInstance')}
        >
          <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600', fontSize: '13px' }}>
            {lynxT(locale, 'lynx.projects.chrome.switchInstance')}
          </LynxText>
        </LynxView>
      </LynxView>
      {chromeNote ? (
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', padding: '0 16px 8px' }}>
          {chromeNote}
        </LynxText>
      ) : null}
      {deleteUndo ? (
        <LynxView
          data-lynx-projects-delete-undo="true"
          style={{
            margin: '0 16px 8px',
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
            {deleteUndo.sessionIds.length > 1
              ? lynxT(locale, 'lynx.chat.sessionsSheet.deleteScheduledPlural', {
                count: String(deleteUndo.sessionIds.length),
              })
              : lynxT(locale, 'lynx.chat.sessionsSheet.deleteScheduled')}
          </LynxText>
          <LynxView
            data-lynx-projects-delete-undo-action="true"
            bindtap={() => {
              if (!deleteUndo) return;
              if (cancelLynxScheduledSessionDeletes(deleteUndo.batchId)) {
                setPendingDeletionIds((current) => current.filter((id) => !deleteUndo.sessionIds.includes(id)));
                setDeleteUndo(null);
              }
            }}
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


      <DirectoryExplorerSheet
        locale={locale}
        runtimeFetch={runtimeFetch ?? null}
        open={explorerOpen}
        onClose={() => setExplorerOpen(false)}
        onAdded={() => {
          setExplorerOpen(false);
          void bindings?.refresh?.();
          onSessionMutated?.();
        }}
      />

      <LynxScrollView
        style={{
          flexGrow: 1,
          padding: '0 16px 24px',
        }}
        bindtap={() => {
          setHeaderProgress(computeLynxTitleCollapseProgress({ scrollTop: progress * 48 }));
        }}
      >

      {noRuntime ? (
        <LynxText style={{ color: cssVar('surface.mutedForeground'), marginBottom: '12px' }}>
          {lynxT(locale, 'lynx.projects.noRuntime')}
        </LynxText>
      ) : null}

      {showFailure ? (
        <LynxView
          style={{
            marginBottom: '12px',
            padding: '10px 12px',
            borderRadius: '12px',
            backgroundColor: cssVar('surface.elevated'),
          }}
        >
          <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '600' }}>
            {lynxT(locale, 'lynx.projects.failure')}
          </LynxText>
          {indexState.error ? (
            <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginTop: '4px' }}>
              {indexState.error.message}
            </LynxText>
          ) : null}
        </LynxView>
      ) : null}

      {showUnsupported ? (
        <LynxText style={{ color: cssVar('surface.mutedForeground'), marginBottom: '12px' }}>
          {lynxT(locale, 'lynx.projects.unsupported')}
        </LynxText>
      ) : null}

      {showLoading && !indexState.snapshot && !modelOverride ? (
        <LynxText style={{ color: cssVar('surface.mutedForeground'), marginBottom: '12px' }}>
          {lynxT(locale, 'lynx.projects.loading')}
        </LynxText>
      ) : null}

      {!searching && model.pinnedSessions.length > 0 ? (
        <LynxView style={{ marginBottom: '16px' }}>
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '13px', fontWeight: '600', marginBottom: '4px' }}>
            {lynxT(locale, 'lynx.projects.pinned')}
          </LynxText>
          {model.pinnedSessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              onOpen={onOpenSession}
              onLongPress={openSessionActions}
              cue="pin"
            />
          ))}
        </LynxView>
      ) : null}

      {!searching && model.inProgressSessions.length > 0 ? (
        <LynxView style={{ marginBottom: '16px' }}>
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '13px', fontWeight: '600', marginBottom: '4px' }}>
            {lynxT(locale, 'lynx.projects.inProgress')}
          </LynxText>
          {model.inProgressSessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              onOpen={onOpenSession}
              onLongPress={openSessionActions}
              cue="busy"
            />
          ))}
        </LynxView>
      ) : null}

      {model.projects.length === 0
        && !showLoading
        && !showFailure
        && !showUnsupported
        && !noRuntime
        && indexState.snapshot
        ? (
          <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
            {lynxT(locale, 'lynx.projects.empty')}
          </LynxText>
        )
        : null}

      {model.projects.map((project) => (
        <ProjectCard
          key={project.id}
          locale={locale}
          project={project}
          expanded={searching || (projectExpanded[project.id] ?? true)}
          onToggle={() => setProjectExpanded((map) => ({
            ...map,
            [project.id]: !(map[project.id] ?? true),
          }))}
          worktreeExpanded={worktreeExpanded}
          onToggleWorktree={(worktreeId) => setWorktreeExpanded((map) => ({
            ...map,
            [worktreeId]: !(map[worktreeId] ?? true),
          }))}
          onOpenSession={onOpenSession}
          onSessionLongPress={openSessionActions}
          onProjectLongPress={openProjectActions}
          onWorktreeLongPress={openWorktreeActions}
          searching={searching}
          visibleCountByBucket={visibleCountByBucket}
          onShowMoreBucket={(projectId, worktree) => {
            const key = lynxProjectsHomeBucketKey(projectId, worktree.id);
            setVisibleCountByBucket((map) => ({
              ...map,
              [key]: nextLynxSessionsSheetVisibleCount(
                map[key] ?? LYNX_SESSIONS_SHEET_DEFAULT_VISIBLE,
                worktree.sessions.length,
              ),
            }));
          }}
          onShowFewerBucket={(projectId, worktreeId) => {
            const key = lynxProjectsHomeBucketKey(projectId, worktreeId);
            setVisibleCountByBucket((map) => ({
              ...map,
              [key]: collapseLynxSessionsSheetVisibleCount(),
            }));
          }}
        />
      ))}
      </LynxScrollView>

      {actionTarget ? (
        <LynxView
          style={{
            padding: '16px',
            backgroundColor: cssVar('surface.elevated'),
            borderTopLeftRadius: '16px',
            borderTopRightRadius: '16px',
          }}
          accessibility-label={sheetAria}
        >
          <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '700', marginBottom: '8px' }}>
            {sheetTitle}
          </LynxText>
          {actionError ? (
            <LynxText style={{ color: cssVar('status.error'), fontSize: '12px', marginBottom: '8px' }}>
              {actionError}
            </LynxText>
          ) : null}
          {renameDraft !== null && actionTarget.kind === 'session' ? (
            <LynxView style={{ marginBottom: '8px' }}>
              <LynxInput
                value={renameDraft}
                placeholder={lynxT(locale, 'lynx.projects.menu.renamePlaceholder')}
                bindinput={(event) => setRenameDraft(event.detail?.value ?? '')}
                style={{ color: cssVar('surface.foreground'), fontSize: '15px', marginBottom: '8px' }}
              />
              <LynxView
                bindtap={() => {
                  if (actionBusy) return;
                  const title = renameDraft.trim();
                  if (!title) {
                    setActionError('session title required');
                    return;
                  }
                  setActionBusy(true);
                  setActionError(null);
                  void (async () => {
                    const result = await renameLynxSession(runtimeFetch, {
                      sessionId: actionTarget.session.id,
                      title,
                      directory: actionTarget.session.directory,
                    });
                    setActionBusy(false);
                    if (result.status !== 'ok') {
                      setActionError(result.status === 'no-runtime' ? 'no-runtime' : result.error);
                      return;
                    }
                    closeActionSheet();
                    refreshAfterMutation();
                  })();
                }}
                style={{ padding: '12px 0', opacity: actionBusy ? 0.6 : 1 }}
              >
                <LynxText style={{ color: cssVar('primary.base'), fontSize: '15px' }}>
                  {lynxT(locale, 'lynx.projects.menu.renameSave')}
                </LynxText>
              </LynxView>
              <LynxView
                bindtap={() => {
                  if (actionBusy) return;
                  const sessionId = actionTarget.session.id;
                  const directory = actionTarget.session.directory;
                  setActionBusy(true);
                  setActionError(null);
                  void (async () => {
                    // Cap closes immediately after submit — do not wait for generation.
                    // Lynx has no Cap toast: await PATCH queue only, then close or show inline error.
                    const result = await requestLynxSessionSmartTitle(runtimeFetch, {
                      sessionId,
                      directory,
                    });
                    setActionBusy(false);
                    if (result.status !== 'ok') {
                      setActionError(result.status === 'no-runtime' ? 'no-runtime' : result.error);
                      return;
                    }
                    closeActionSheet();
                    refreshAfterMutation();
                  })();
                }}
                style={{ padding: '12px 0', opacity: actionBusy ? 0.6 : 1 }}
              >
                <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '15px' }}>
                  {lynxT(locale, 'lynx.projects.menu.smartTitle')}
                </LynxText>
              </LynxView>
              <LynxView
                bindtap={() => {
                  setRenameDraft(null);
                  setActionError(null);
                }}
                style={{ padding: '12px 0' }}
              >
                <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
                  {lynxT(locale, 'lynx.projects.menu.cancel')}
                </LynxText>
              </LynxView>
            </LynxView>
          ) : (
            <>
              {sheetItems.map((item) => (
                <LynxView
                  key={item.id}
                  bindtap={() => {
                    if (actionBusy || item.disabled) return;
                    item.onClick();
                  }}
                  style={{
                    padding: '12px 0',
                    opacity: actionBusy || item.disabled ? 0.6 : 1,
                    marginTop: item.separated ? '8px' : '0px',
                  }}
                >
                  <LynxText style={{
                    color: item.destructive ? cssVar('status.error') : cssVar('primary.base'),
                    fontSize: '15px',
                  }}
                  >
                    {lynxT(locale, item.labelKey as 'lynx.projects.menu.pin')}
                  </LynxText>
                </LynxView>
              ))}
              <LynxView
                bindtap={closeActionSheet}
                style={{ padding: '12px 0', marginTop: '4px' }}
              >
                <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
                  {lynxT(locale, 'lynx.projects.menu.cancel')}
                </LynxText>
              </LynxView>
            </>
          )}
        </LynxView>
      ) : null}

      {editingProject ? (
        <LynxProjectEditSurface
          locale={locale}
          open
          project={editingProject}
          runtimeFetch={runtimeFetch}
          linkedSessions={editingProject.sessions}
          onClose={() => {
            setEditingProject(null);
            setActionError(null);
          }}
          onSaved={() => {
            setEditingProject(null);
            refreshAfterMutation();
          }}
          onWorktreesChanged={() => {
            refreshAfterMutation();
          }}
        />
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
            setNewWorktreeProject(null);
                refreshAfterMutation();
            onOpenDraft?.(path);
          }}
        />
      ) : null}

      <LynxDialogPortal>
        {closingProject ? (
          <LynxCenteredDialog
            locale={locale}
            open
            title={lynxT(locale, 'lynx.projects.closeConfirmTitle')}
            description={lynxT(locale, 'lynx.projects.closeConfirmDescription')}
            ariaLabel={lynxT(locale, 'lynx.projects.closeConfirmTitle')}
            busy={actionBusy}
            onClose={() => { if (!actionBusy) setClosingProject(null); }}
            footer={(
              <>
                <LynxCenteredDialogAction
                  label={lynxT(locale, 'lynx.projects.menu.cancel')}
                  disabled={actionBusy}
                  onTap={() => { setClosingProject(null); }}
                />
                <LynxCenteredDialogAction
                  label={lynxT(locale, 'lynx.projects.closeConfirmAction')}
                  destructive
                  disabled={actionBusy}
                  onTap={() => {
                    if (!closingProject || actionBusy) return;
                    setActionBusy(true);
                    void (async () => {
                      const result = await closeLynxProject(runtimeFetch, {
                        projectId: closingProject.id,
                        path: closingProject.path,
                      });
                      setActionBusy(false);
                      if (result.status === 'ok') {
                        setClosingProject(null);
                        refreshAfterMutation();
                        return;
                      }
                      setChromeNote(
                        result.status === 'unavailable'
                          ? result.reason
                          : result.status === 'no-runtime'
                            ? 'no-runtime'
                            : result.error,
                      );
                      setClosingProject(null);
                    })();
                  }}
                />
              </>
            )}
          >
            <LynxText
              style={{
                color: cssVar('surface.foreground'),
                fontSize: '12px',
                marginBottom: '8px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              }}
            >
              {closingProject.label}
            </LynxText>
          </LynxCenteredDialog>
        ) : null}

      </LynxDialogPortal>

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
            refreshAfterMutation();
          }}
          onErrorNote={(message) => {
            setChromeNote(message);
            setWorktreeToDelete(null);
          }}
        />
      ) : null}
    </LynxView>
  );
}
