import { useEffect, useMemo, useState } from 'react';

import type { LynxHostGlobalProps } from '../../host/embedding';
import { lynxT, tabLabel } from '../../i18n/catalog';
import { LynxScrollView, LynxText, LynxView } from '../../lynx-elements';
import {
  buildLynxSessionMenuItems,
  type LynxMenuItem,
} from '../../projects/sessionMenuModel';
import {
  archiveLynxSession,
  deleteLynxSession,
  toggleLynxSessionPin,
} from '../../projects/sessionActions';
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
  onOpenDraft?: () => void;
  onTogglePin?: (session: LynxHomeSessionRow) => void;
  /** Connect runtime for pin/archive/delete. Null → actions report no-runtime. */
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
  worktree,
  expanded,
  onToggle,
  onOpenSession,
  onSessionLongPress,
}: {
  worktree: LynxHomeWorktreeGroup;
  expanded: boolean;
  onToggle: () => void;
  onOpenSession?: (session: LynxHomeSessionRow) => void;
  onSessionLongPress?: (session: LynxHomeSessionRow) => void;
}) {
  return (
    <LynxView style={{ marginTop: '8px' }}>
      <LynxView
        bindtap={onToggle}
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
      {expanded
        ? worktree.sessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            onOpen={onOpenSession}
            onLongPress={onSessionLongPress}
            cue={session.inProgress ? 'busy' : null}
          />
        ))
        : null}
    </LynxView>
  );
}

function ProjectCard({
  project,
  expanded,
  onToggle,
  worktreeExpanded,
  onToggleWorktree,
  onOpenSession,
  onSessionLongPress,
}: {
  project: LynxHomeProject;
  expanded: boolean;
  onToggle: () => void;
  worktreeExpanded: Record<string, boolean>;
  onToggleWorktree: (worktreeId: string) => void;
  onOpenSession?: (session: LynxHomeSessionRow) => void;
  onSessionLongPress?: (session: LynxHomeSessionRow) => void;
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
        ? project.worktrees.map((worktree) => (
          <WorktreeGroup
            key={worktree.id}
            worktree={worktree}
            expanded={worktreeExpanded[worktree.id] ?? worktree.kind === 'main'}
            onToggle={() => onToggleWorktree(worktree.id)}
            onOpenSession={onOpenSession}
            onSessionLongPress={onSessionLongPress}
          />
        ))
        : null}
    </LynxView>
  );
}

/**
 * Projects home: session-index cards + worktree groups + search + pin/busy cues.
 * failure ≠ empty — failed refresh keeps previous snapshot and shows an error banner.
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
  const [actionSession, setActionSession] = useState<LynxHomeSessionRow | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [chromeNote, setChromeNote] = useState<string | null>(null);
  const searchQuery = searchQueryProp ?? internalQuery;
  const setSearchQuery = onSearchQueryChange ?? setInternalQuery;

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

  const model = useMemo(
    () => filterLynxProjectsHomeForSearch(baseModel, searchQuery),
    [baseModel, searchQuery],
  );

  const showFailure = indexState.status === 'failed';
  const showUnsupported = indexState.status === 'unsupported';
  const showLoading = indexState.status === 'loading' || indexState.status === 'idle';
  const noRuntime = !bindings && !modelOverride && !indexStateOverride;

  const progress = collapseProgress ?? headerProgress;

  const sessionMenuItems: LynxMenuItem[] = actionSession
    ? buildLynxSessionMenuItems({
      pinned: actionSession.pinned,
      shared: false,
      onTogglePin: () => {
        setActionBusy(true);
        setActionError(null);
        void (async () => {
          if (onTogglePin) {
            onTogglePin(actionSession);
            setActionBusy(false);
            setActionSession(null);
            onSessionMutated?.();
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
          setActionSession(null);
          onSessionMutated?.();
          void bindings?.refresh?.();
        })();
      },
      onArchive: () => {
        setActionBusy(true);
        setActionError(null);
        void (async () => {
          const result = await archiveLynxSession(runtimeFetch, {
            sessionId: actionSession.id,
            directory: actionSession.directory,
          });
          setActionBusy(false);
          if (result.status !== 'ok') {
            setActionError(result.status === 'no-runtime' ? 'no-runtime' : result.error);
            return;
          }
          setActionSession(null);
          onSessionMutated?.();
          void bindings?.refresh?.();
        })();
      },
      onDelete: () => {
        setActionBusy(true);
        setActionError(null);
        void (async () => {
          const result = await deleteLynxSession(runtimeFetch, {
            sessionId: actionSession.id,
            directory: actionSession.directory,
          });
          setActionBusy(false);
          if (result.status !== 'ok') {
            setActionError(result.status === 'no-runtime' ? 'no-runtime' : result.error);
            return;
          }
          setActionSession(null);
          onSessionMutated?.();
          void bindings?.refresh?.();
        })();
      },
    })
    : [];


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
        onPrimaryAction={onOpenDraft}
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
          // Harness: tapping body does not change collapse; host bindscroll drives it.
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

      {model.pinnedSessions.length > 0 ? (
        <LynxView style={{ marginBottom: '16px' }}>
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '13px', fontWeight: '600', marginBottom: '4px' }}>
            {lynxT(locale, 'lynx.projects.pinned')}
          </LynxText>
          {model.pinnedSessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              onOpen={onOpenSession}
              onLongPress={setActionSession}
              cue="pin"
            />
          ))}
        </LynxView>
      ) : null}

      {model.inProgressSessions.length > 0 ? (
        <LynxView style={{ marginBottom: '16px' }}>
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '13px', fontWeight: '600', marginBottom: '4px' }}>
            {lynxT(locale, 'lynx.projects.inProgress')}
          </LynxText>
          {model.inProgressSessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              onOpen={onOpenSession}
              onLongPress={setActionSession}
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
          project={project}
          expanded={projectExpanded[project.id] ?? true}
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
          onSessionLongPress={setActionSession}
        />
      ))}
      </LynxScrollView>

      {actionSession ? (
        <LynxView
          style={{
            padding: '16px',
            backgroundColor: cssVar('surface.elevated'),
            borderTopLeftRadius: '16px',
            borderTopRightRadius: '16px',
          }}
          accessibility-label={lynxT(locale, 'lynx.projects.menu.title')}
        >
          <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '700', marginBottom: '8px' }}>
            {actionSession.title}
          </LynxText>
          {actionError ? (
            <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '8px' }}>
              {actionError}
            </LynxText>
          ) : null}
          {sessionMenuItems.map((item) => (
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
                color: item.destructive ? cssVar('surface.mutedForeground') : cssVar('primary.base'),
                fontSize: '15px',
              }}
              >
                {lynxT(locale, item.labelKey as 'lynx.projects.menu.pin')}
              </LynxText>
            </LynxView>
          ))}
          <LynxView
            bindtap={() => {
              setActionSession(null);
              setActionError(null);
            }}
            style={{ padding: '12px 0', marginTop: '4px' }}
          >
            <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
              {lynxT(locale, 'lynx.projects.menu.cancel')}
            </LynxText>
          </LynxView>
        </LynxView>
      ) : null}
    </LynxView>
  );
}
