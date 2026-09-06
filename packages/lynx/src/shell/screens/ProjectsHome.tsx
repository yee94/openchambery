import { useEffect, useMemo, useState } from 'react';

import type { LynxHostGlobalProps } from '../../host/embedding';
import { lynxT, tabLabel } from '../../i18n/catalog';
import { LynxScrollView, LynxText, LynxView } from '../../lynx-elements';
import { filterLynxProjectsHomeForSearch } from '../../projects/search';
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
  /** Test / story inject: skip store and render this model. */
  modelOverride?: LynxProjectsHomeModel | null;
  indexStateOverride?: SessionIndexState | null;
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
  cue,
}: {
  session: LynxHomeSessionRow;
  onOpen?: (session: LynxHomeSessionRow) => void;
  cue?: 'pin' | 'busy' | null;
}) {
  return (
    <LynxView
      bindtap={() => onOpen?.(session)}
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
}: {
  worktree: LynxHomeWorktreeGroup;
  expanded: boolean;
  onToggle: () => void;
  onOpenSession?: (session: LynxHomeSessionRow) => void;
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
}: {
  project: LynxHomeProject;
  expanded: boolean;
  onToggle: () => void;
  worktreeExpanded: Record<string, boolean>;
  onToggleWorktree: (worktreeId: string) => void;
  onOpenSession?: (session: LynxHomeSessionRow) => void;
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
  modelOverride = null,
  indexStateOverride = null,
}: ProjectsHomeProps) {
  const indexState = useSessionIndexState(bindings, indexStateOverride);
  const [internalQuery, setInternalQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(Boolean(searchQueryProp));
  const [headerProgress, setHeaderProgress] = useState(0);
  const [projectExpanded, setProjectExpanded] = useState<Record<string, boolean>>({});
  const [worktreeExpanded, setWorktreeExpanded] = useState<Record<string, boolean>>({});
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
            <SessionRow key={session.id} session={session} onOpen={onOpenSession} cue="pin" />
          ))}
        </LynxView>
      ) : null}

      {model.inProgressSessions.length > 0 ? (
        <LynxView style={{ marginBottom: '16px' }}>
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '13px', fontWeight: '600', marginBottom: '4px' }}>
            {lynxT(locale, 'lynx.projects.inProgress')}
          </LynxText>
          {model.inProgressSessions.map((session) => (
            <SessionRow key={session.id} session={session} onOpen={onOpenSession} cue="busy" />
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
        />
      ))}
      </LynxScrollView>
    </LynxView>
  );
}
