import React from 'react';
import { useWorktreeOrderStore } from '@/stores/useWorktreeOrderStore';
import { useEvent } from '@reactuses/core';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { TooltipProvider } from '@/components/ui/tooltip';
import { formatDirectoryName, formatPathForDisplay, cn } from '@/lib/utils';
import type { SessionGroup } from './types';
import type { SortableDragHandleProps } from './sortableItems';
import { SortableProjectItem, SortableGroupItem } from './sortableItems';
import { SIDEBAR_MUTED_HINT_CLASS, getSidebarRowPaddingLeft } from './utils';
import { useI18n } from '@/lib/i18n';
import type { MainTab } from '@/stores/useUIStore';
import { SidebarSectionHeader } from './SidebarSectionHeader';
import type { ProjectSortOrder } from '@/stores/useSessionDisplayStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isVSCodeRuntime } from '@/lib/desktop';
import { normalizePath } from './utils';

const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 8 } };
const KEYBOARD_SENSOR_OPTIONS = { coordinateGetter: sortableKeyboardCoordinates };

/**
 * Shared tooltip group for session hover cards + action tips.
 * delay=0 open, closeDelay bridges inter-row gaps, timeout keeps handoff instant
 * while the pointer moves between adjacent rows (Base UI grouping).
 */
const SidebarTooltipProvider = ({ children }: { children: React.ReactNode }) => (
  <TooltipProvider delay={0} closeDelay={150} timeout={600}>
    {children}
  </TooltipProvider>
);

type ProjectSection = {
  project: {
    id: string;
    label?: string;
    normalizedPath: string;
    icon?: string;
    color?: string;
    iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
    iconBackground?: string;
  };
  groups: SessionGroup[];
};

type Props = {
  topContent?: React.ReactNode;
  hasLeadingSection: boolean;
  headerAccessory?: React.ReactNode;
  sharedSessionsOnly?: boolean;
  hasSharedSessions?: boolean;
  sectionsForRender: ProjectSection[];
  projectSections: ProjectSection[];
  activeProjectId: string | null;
  showOnlyMainWorkspace: boolean;
  hasSessionSearchQuery: boolean;
  emptyState: React.ReactNode;
  searchEmptyState: React.ReactNode;
  renderGroupSessions: (
    group: SessionGroup,
    groupKey: string,
    projectId?: string | null,
    hideGroupLabel?: boolean,
    dragHandleProps?: SortableDragHandleProps | null,
    compactBodyPadding?: boolean,
    scrollContainerRef?: React.RefObject<HTMLElement | null>,
  ) => React.ReactNode;
  homeDirectory: string | null;
  collapsedProjects: Set<string>;
  hideDirectoryControls: boolean;
  projectRepoStatus: Map<string, boolean | null>;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  toggleProject: (id: string) => void;
  setActiveProjectIdOnly: (id: string) => void;
  setActiveMainTab: (tab: MainTab) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: { directoryOverride?: string | null }) => void;
  openNewWorktreeDialog: () => void;
  syncProjectSessions: (id: string) => void;
  openProjectEditDialog: (id: string) => void;
  removeProject: (id: string) => void;
  projectReorderEnabled?: boolean;
  reorderProjects: (activeId: string, overId: string) => void;
  projectSortOrder: ProjectSortOrder;
  getOrderedGroups: (projectId: string, groups: SessionGroup[]) => SessionGroup[];
  setGroupOrderByProject: React.Dispatch<React.SetStateAction<Map<string, string[]>>>;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  isInlineEditing: boolean;
};

export function SidebarProjectsList(props: Props): React.ReactNode {
  const { t } = useI18n();
  const projectSensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_SENSOR_OPTIONS),
  );
  const projectsHeader = !props.hasSessionSearchQuery ? (
    <SidebarSectionHeader
      title={t('sessions.sidebar.projectsTitle')}
      isFirst={!props.hasLeadingSection}
      accessory={props.headerAccessory}
    />
  ) : null;

  // Threaded into SessionGroupSection so the archived-bucket virtualizer
  // can resolve the scrolling ancestor synchronously (no getComputedStyle
  // walk) and skip the cost of a style recalc on every render.
  const scrollContainerRef = React.useRef<HTMLElement | null>(null);

  // Memoize the result of getOrderedGroups. The callback is stable
  // (deps: [groupOrderByProject]) and `section.groups` is a stable
  // reference from useSessionSidebarSections, but the caller discards
  // the result on every render and the callback allocates a new array
  // each time. With many projects and many sidebar re-renders this
  // builds O(P) arrays per render. The cache returns the same array
  // reference when the inputs haven't changed, so the downstream
  // orderedGroups.filter/find work and any consumer-memoization see a
  // stable reference.
  const orderedGroupsCacheRef = React.useRef<Map<string, { groups: SessionGroup[]; ordered: SessionGroup[] }>>(new Map());
  const orderedGroupsCacheGetOrderedGroupsRef = React.useRef<typeof props.getOrderedGroups>(props.getOrderedGroups);
  if (orderedGroupsCacheGetOrderedGroupsRef.current !== props.getOrderedGroups) {
    orderedGroupsCacheGetOrderedGroupsRef.current = props.getOrderedGroups;
    orderedGroupsCacheRef.current.clear();
  }
  const cachedGetOrderedGroups = (projectId: string, groups: SessionGroup[]): SessionGroup[] => {
    const cache = orderedGroupsCacheRef.current;
    const hit = cache.get(projectId);
    if (hit && hit.groups === groups) {
      return hit.ordered;
    }
    const ordered = props.getOrderedGroups(projectId, groups);
    cache.set(projectId, { groups, ordered });
    // Bound the cache so re-ordering projects (which replaces the
    // projects list and invalidates every projectId) doesn't grow
    // unboundedly.
    if (cache.size > 256) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    return ordered;
  };

  if (props.sharedSessionsOnly) {
    return (
      <SidebarTooltipProvider>
      <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 px-3 pb-1', props.mobileVariant ? '' : '')}>
        {props.topContent}
        {!props.hasSharedSessions ? (props.hasSessionSearchQuery ? props.searchEmptyState : props.emptyState) : null}
      </ScrollableOverlay>
      </SidebarTooltipProvider>
    );
  }

  if (props.projectSections.length === 0) {
    return (
      <SidebarTooltipProvider>
        <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 px-3 pb-1', props.mobileVariant ? '' : '')}>{props.topContent}{projectsHeader}{props.emptyState}</ScrollableOverlay>
      </SidebarTooltipProvider>
    );
  }

  if (props.sectionsForRender.length === 0) {
    return (
      <SidebarTooltipProvider>
        <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 px-3 pb-1', props.mobileVariant ? '' : '')}>{props.searchEmptyState}</ScrollableOverlay>
      </SidebarTooltipProvider>
    );
  }

  return (
    // [overflow-anchor:none] — the browser's native scroll anchoring otherwise
    // latches onto content BELOW a growing session group (e.g. the "Show more"
    // button) and holds it in place, which makes newly revealed sessions look
    // like they insert upward. With anchoring off, scrollTop stays put and new
    // rows appear below naturally.
    <SidebarTooltipProvider>
    <ScrollableOverlay ref={scrollContainerRef} useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 px-3 pb-1 [overflow-anchor:none]', props.mobileVariant ? '' : '')}>
      {props.topContent}
      {props.showOnlyMainWorkspace ? (
        <div className="space-y-[0.6rem] py-1">
          {(() => {
            const activeSection = props.sectionsForRender.find((section) => section.project.id === props.activeProjectId) ?? props.sectionsForRender[0];
            if (!activeSection) {
              return props.hasSessionSearchQuery ? props.searchEmptyState : props.emptyState;
            }
            const primaryGroup =
              activeSection.groups.find((candidate) => candidate.isMain && candidate.sessions.length > 0)
              ?? activeSection.groups.find((candidate) => candidate.sessions.length > 0)
              ?? activeSection.groups.find((candidate) => candidate.isMain)
              ?? activeSection.groups[0];
            if (!primaryGroup) {
              return <div className={SIDEBAR_MUTED_HINT_CLASS}>{t('sessions.sidebar.empty.noSessions.title')}</div>;
            }
            const archivedGroup = activeSection.groups.find((candidate) => candidate.isArchivedBucket);
            const groupsToRender = [
              primaryGroup,
              ...(archivedGroup && archivedGroup.id !== primaryGroup.id ? [archivedGroup] : []),
            ];

            return groupsToRender.map((group) => {
              const groupKey = `${activeSection.project.id}:${group.id}`;
              const hideGroupLabel = group.id === primaryGroup.id;
              return (
                <React.Fragment key={groupKey}>
                  {props.renderGroupSessions(group, groupKey, activeSection.project.id, hideGroupLabel, null, true, scrollContainerRef)}
                </React.Fragment>
              );
            });
          })()}
        </div>
      ) : (
        <>
          {/* Codex-style section label above the project tree.
              Per-project loading lives on the folder icon + body placeholder;
              do not reintroduce a global "syncing sessions" accessory here. */}
          {projectsHeader}
          <DndContext
            sensors={projectSensors}
            collisionDetection={closestCenter}
            onDragEnd={(event) => {
              if (props.isInlineEditing) return;
              // Drag only allowed in manual sort mode.
              if (props.projectSortOrder !== 'manual') return;
              const { active, over } = event;
              if (!over || active.id === over.id) return;
              props.reorderProjects(String(active.id), String(over.id));
            }}
          >
            <SortableContext items={props.sectionsForRender.map((section) => section.project.id)} strategy={verticalListSortingStrategy}>
              {props.sectionsForRender.map((section) => {
                const project = section.project;
                const projectKey = project.id;
                return (
                  <SidebarProjectSection
                    key={projectKey}
                    project={project}
                    orderedGroups={cachedGetOrderedGroups(projectKey, section.groups)}
                    isCollapsed={props.collapsedProjects.has(projectKey)}
                    isActiveProject={projectKey === props.activeProjectId}
                    isRepo={Boolean(props.projectRepoStatus.get(projectKey))}
                    hideDirectoryControls={props.hideDirectoryControls}
                    mobileVariant={props.mobileVariant}
                    alwaysShowActions={props.alwaysShowActions}
                    toggleProject={props.toggleProject}
                    setActiveProjectIdOnly={props.setActiveProjectIdOnly}
                    setActiveMainTab={props.setActiveMainTab}
                    setSessionSwitcherOpen={props.setSessionSwitcherOpen}
                    openNewSessionDraft={props.openNewSessionDraft}
                    openNewWorktreeDialog={props.openNewWorktreeDialog}
                    syncProjectSessions={props.syncProjectSessions}
                    openProjectEditDialog={props.openProjectEditDialog}
                    removeProject={props.removeProject}
                    openSidebarMenuKey={props.openSidebarMenuKey === `project:${projectKey}` ? props.openSidebarMenuKey : null}
                    setOpenSidebarMenuKey={props.setOpenSidebarMenuKey}
                    projectReorderEnabled={props.projectReorderEnabled}
                    projectSortOrder={props.projectSortOrder}
                    isInlineEditing={props.isInlineEditing}
                    setGroupOrderByProject={props.setGroupOrderByProject}
                    renderGroupSessions={props.renderGroupSessions}
                    scrollContainerRef={scrollContainerRef}
                    homeDirectory={props.homeDirectory}
                  />
                );
              })}
            </SortableContext>
            <DragOverlay dropAnimation={null} />
          </DndContext>
        </>
      )}
    </ScrollableOverlay>
    </SidebarTooltipProvider>
  );
}

type ProjectSectionProps = Pick<Props,
  'homeDirectory' | 'hideDirectoryControls' | 'mobileVariant' | 'alwaysShowActions' |
  'toggleProject' | 'setActiveProjectIdOnly' | 'setActiveMainTab' | 'setSessionSwitcherOpen' |
  'openNewSessionDraft' | 'openNewWorktreeDialog' | 'syncProjectSessions' | 'openProjectEditDialog' | 'removeProject' |
  'openSidebarMenuKey' | 'setOpenSidebarMenuKey' | 'projectReorderEnabled' |
  'projectSortOrder' | 'isInlineEditing' | 'setGroupOrderByProject' | 'renderGroupSessions'
> & {
  project: ProjectSection['project'];
  orderedGroups: SessionGroup[];
  isCollapsed: boolean;
  isActiveProject: boolean;
  isRepo: boolean;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
};

const SidebarProjectSection = React.memo(function SidebarProjectSection(props: ProjectSectionProps) {
  const { t } = useI18n();
  const { project, orderedGroups, isCollapsed, renderGroupSessions, scrollContainerRef, isInlineEditing } = props;
  const projectKey = project.id;
  const worktrees = useSessionUIStore((state) => isVSCodeRuntime() ? undefined : state.availableWorktreesByProject.get(project.normalizedPath));
  const directories = React.useMemo(() => [project.normalizedPath, ...(worktrees ?? []).flatMap((worktree) => {
    const path = normalizePath(worktree.path);
    return path ? [path] : [];
  })], [project.normalizedPath, worktrees]);
  // Per-project loading: only the project's own boolean can invalidate its header.
  const isSessionsLoading = useGlobalSessionsStore((state) => directories.some((directory) => state.loadingDirectories.has(directory)));
  const isSessionsRefreshing = useGlobalSessionsStore((state) => directories.some((directory) => state.refreshingDirectories.has(directory)));
  const groupSensors = useSensors(useSensor(PointerSensor, POINTER_SENSOR_OPTIONS));
  const rootGroup = orderedGroups.find((group) => group.isMain) ?? null;
  const nestedGroups = React.useMemo(() => rootGroup ? orderedGroups.filter((group) => group.id !== rootGroup.id) : orderedGroups, [orderedGroups, rootGroup]);
  const onToggle = useEvent(() => props.toggleProject(projectKey));
  const onNewSession = useEvent(() => {
    if (!props.isActiveProject) props.setActiveProjectIdOnly(projectKey);
    props.setActiveMainTab('chat');
    if (props.mobileVariant) props.setSessionSwitcherOpen(false);
    props.openNewSessionDraft({ directoryOverride: project.normalizedPath });
  });
  const onNewWorktreeSession = useEvent(() => {
    if (!props.isActiveProject) props.setActiveProjectIdOnly(projectKey);
    props.setActiveMainTab('chat');
    props.openNewWorktreeDialog();
  });
  const onSyncSessions = useEvent(() => props.syncProjectSessions(projectKey));
  const onRenameStart = useEvent(() => props.openProjectEditDialog(projectKey));
  const onClose = useEvent(() => props.removeProject(projectKey));
  const onGroupDragEnd = useEvent((event: DragEndEvent) => {
    if (isInlineEditing) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = nestedGroups.findIndex((item) => item.id === active.id);
    const newIndex = nestedGroups.findIndex((item) => item.id === over.id);
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
    const nextNested = arrayMove(nestedGroups, oldIndex, newIndex).map((item) => item.id);
    const next = rootGroup ? [rootGroup.id, ...nextNested] : nextNested;
    const byId = new Map(nestedGroups.map((group) => [group.id, group]));
    useWorktreeOrderStore.getState().setWorktreeOrder(projectKey, project.normalizedPath,
      nextNested.flatMap((id) => {
        const group = byId.get(id);
        return group?.worktree && group.directory ? [group.directory] : [];
      }));
    props.setGroupOrderByProject((prev) => new Map(prev).set(projectKey, next));
  });
  const groups = React.useMemo(() => (
    <DndContext sensors={groupSensors} collisionDetection={closestCenter} onDragEnd={onGroupDragEnd}>
      {rootGroup ? renderGroupSessions(rootGroup, `${projectKey}:${rootGroup.id}`, projectKey, true, null, undefined, scrollContainerRef) : null}
      <SortableContext items={nestedGroups.map((group) => group.id)} strategy={verticalListSortingStrategy}>
        {nestedGroups.map((group) => (
          <SortableGroupItem key={group.id} id={group.id} disabled={isInlineEditing}>
            {(dragHandleProps) => renderGroupSessions(group, `${projectKey}:${group.id}`, projectKey, false, dragHandleProps, undefined, scrollContainerRef)}
          </SortableGroupItem>
        ))}
      </SortableContext>
      <DragOverlay dropAnimation={null} />
    </DndContext>
  ), [groupSensors, onGroupDragEnd, rootGroup, renderGroupSessions, projectKey, scrollContainerRef, nestedGroups, isInlineEditing]);
  return (
    <SortableProjectItem
      id={projectKey} disabled={props.projectSortOrder !== 'manual'}
      projectLabel={formatDirectoryName(project.normalizedPath) || project.normalizedPath}
      projectDescription={formatPathForDisplay(project.normalizedPath, props.homeDirectory)}
      projectIcon={project.icon} projectColor={project.color} projectIconImage={project.iconImage}
      isCollapsed={isCollapsed} isActiveProject={props.isActiveProject} isSessionsLoading={isSessionsLoading || isSessionsRefreshing}
      isRepo={props.isRepo}
      hideDirectoryControls={props.hideDirectoryControls} mobileVariant={props.mobileVariant} alwaysShowActions={props.alwaysShowActions}
      onToggle={onToggle} onNewSession={onNewSession} onNewWorktreeSession={onNewWorktreeSession}
      onSyncSessions={onSyncSessions} onRenameStart={onRenameStart} onClose={onClose}
      showCreateButtons openSidebarMenuKey={props.openSidebarMenuKey} setOpenSidebarMenuKey={props.setOpenSidebarMenuKey}
      reorderEnabled={props.projectReorderEnabled ?? false}
    >
      <Collapsible open={!isCollapsed}>
        <CollapsibleContent data-sidebar-collapse className="h-[var(--collapsible-panel-height)] transition-[height] duration-200 ease-out data-[starting-style]:h-0 data-[ending-style]:h-0 data-[open]:animate-none data-[closed]:animate-none motion-reduce:transition-none" inert={isCollapsed || undefined}>
          <div className="space-y-0 pt-0 pb-0.5">
            {orderedGroups.length > 0 ? groups : isSessionsLoading ? (
              <div className="box-border w-full py-1.5 text-left typography-ui-label font-normal text-muted-foreground/80 animate-pulse select-none" style={{ paddingLeft: getSidebarRowPaddingLeft(1) }} role="status" aria-live="polite">
                {t('sessions.sidebar.project.loadingSessions')}
              </div>
            ) : <div className={SIDEBAR_MUTED_HINT_CLASS}>{t('sessions.sidebar.empty.noSessions.title')}</div>}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </SortableProjectItem>
  );
});
