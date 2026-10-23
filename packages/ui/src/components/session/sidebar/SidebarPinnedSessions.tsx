import React from 'react';
import type { SessionNode } from './types';
import { useI18n } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  collectSubtreeContainingId,
  computeNodeStructureKey,
  resolveMenuOpenSessionId,
} from './sessionNodeItemUtils';
import type { SessionNodeRenderExtras } from './sessionNodeItemUtils';
import { SidebarSectionHeader } from './SidebarSectionHeader';
import { useSessionFocusStore } from '@/stores/useSessionFocusStore';
import { SessionFolderDndScope } from './sessionFolderDnd';
import { PINNED_SESSION_ORDER_SCOPE } from './pinnedSessions';

type PinnedItem = {
  node: SessionNode;
  projectId: string | null;
  groupDirectory: string | null;
  secondaryMeta: {
    projectLabel?: string | null;
    branchLabel?: string | null;
  } | null;
};

type Props = {
  items: PinnedItem[];
  reorderEnabled?: boolean;
  onSessionsReordered?: (activeSessionId: string, overSessionId: string) => void;
  /** Unlabeled in-progress/unread rows rendered below the pinned rows. */
  inProgressItems?: PinnedItem[];
  renderSessionNode: (
    node: SessionNode,
    depth?: number,
    groupDirectory?: string | null,
    projectId?: string | null,
    archivedBucket?: boolean,
    secondaryMeta?: { projectLabel?: string | null; branchLabel?: string | null } | null,
    renderContext?: 'project' | 'pinned',
    renderExtras?: SessionNodeRenderExtras,
  ) => React.ReactNode;
  currentSessionId: string | null;
  editingId: string | null;
  openSidebarMenuKey: string | null;
  headerAccessory?: React.ReactNode;
  onVisibleSessionIdsChange?: (sessionIds: readonly string[]) => void;
};

export function SidebarPinnedSessions({
  items,
  reorderEnabled = false,
  onSessionsReordered,
  inProgressItems = [],
  renderSessionNode,
  currentSessionId,
  editingId,
  openSidebarMenuKey,
  headerAccessory,
  onVisibleSessionIdsChange,
}: Props): React.ReactNode {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = React.useState(false);
  const canReorder = reorderEnabled && !editingId && items.length > 1 && Boolean(onSessionsReordered);
  const sessionIds = React.useMemo(() => items.map((item) => item.node.session.id), [items]);
  const folderIdBySessionId = React.useMemo(() => new Map(sessionIds.map((id) => [id, null])), [sessionIds]);
  const pinnedFocusSessionId = useSessionFocusStore((state) => (
    state.focus?.scope === 'pinned' ? state.focus.sessionId : null
  ));

  React.useLayoutEffect(() => {
    if (collapsed) {
      onVisibleSessionIdsChange?.([]);
      return;
    }
    onVisibleSessionIdsChange?.([
      ...items.map((item) => item.node.session.id),
      ...inProgressItems.map((item) => item.node.session.id),
    ]);
  }, [collapsed, inProgressItems, items, onVisibleSessionIdsChange]);

  React.useLayoutEffect(() => {
    if (
      pinnedFocusSessionId
      && (items.some((item) => item.node.session.id === pinnedFocusSessionId)
        || inProgressItems.some((item) => item.node.session.id === pinnedFocusSessionId))
    ) {
      setCollapsed(false);
    }
  }, [inProgressItems, items, pinnedFocusSessionId]);

  const getRenderExtras = React.useMemo(() => {
    const nodes = [...items, ...inProgressItems].map((item) => item.node);
    const subtreeContainsActive = new Set<string>();
    collectSubtreeContainingId(nodes, currentSessionId, subtreeContainsActive);
    const subtreeContainsEditing = new Set<string>();
    collectSubtreeContainingId(nodes, editingId, subtreeContainsEditing);
    const menuOpenSessionId = resolveMenuOpenSessionId(nodes, openSidebarMenuKey, 'pinned', false);
    const nodeStructureKeyByNode = new WeakMap<SessionNode, string>();
    const visit = (node: SessionNode): void => {
      nodeStructureKeyByNode.set(node, computeNodeStructureKey(node));
      node.children.forEach(visit);
    };
    nodes.forEach(visit);

    const childRenderExtrasFor = (child: SessionNode): SessionNodeRenderExtras => ({
      subtreeContainsActive,
      subtreeContainsEditing,
      menuOpenSessionId,
      nodeStructureKey: nodeStructureKeyByNode.get(child) ?? '',
      childRenderExtrasFor,
    });

    return (node: SessionNode): SessionNodeRenderExtras => ({
      subtreeContainsActive,
      subtreeContainsEditing,
      menuOpenSessionId,
      nodeStructureKey: nodeStructureKeyByNode.get(node) ?? '',
      childRenderExtrasFor,
    });
  }, [currentSessionId, editingId, inProgressItems, items, openSidebarMenuKey]);

  if (items.length + inProgressItems.length === 0) {
    return null;
  }

  const renderRows = (rows: PinnedItem[]): React.ReactNode =>
    rows.map((item) => {
      const row = renderSessionNode(
          item.node,
          0,
          item.groupDirectory,
          item.projectId,
          false,
          item.secondaryMeta,
          'pinned',
          getRenderExtras(item.node),
      );
      return <React.Fragment key={item.node.session.id}>{row}</React.Fragment>;
    });

  return (
    // Same grouping params as SidebarProjectsList so pinned ↔ project handoff
    // stays instant when both sections are visible.
    <TooltipProvider delay={0} closeDelay={150} timeout={600}>
    <div className="pb-1">
      <SidebarSectionHeader
        title={
          inProgressItems.length > 0
            ? t('directoryTree.section.pinnedInProgress')
            : t('directoryTree.section.pinned')
        }
        onToggle={() => setCollapsed((value) => !value)}
        expanded={!collapsed}
        accessory={headerAccessory}
      />
      {!collapsed ? (
        <div className="space-y-0.5">
          {canReorder ? (
            <SessionFolderDndScope
              scopeKey={PINNED_SESSION_ORDER_SCOPE}
              sessionIds={sessionIds}
              folderIdBySessionId={folderIdBySessionId}
              onSessionDroppedOnFolder={() => {}}
              onSessionsReordered={(activeId, overId) => onSessionsReordered?.(activeId, overId)}
            >
              {renderRows(items)}
            </SessionFolderDndScope>
          ) : renderRows(items)}
          {renderRows(inProgressItems)}
        </div>
      ) : null}
    </div>
    </TooltipProvider>
  );
}
