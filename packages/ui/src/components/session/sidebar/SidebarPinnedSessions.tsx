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
    rows.map((item) => (
      <React.Fragment key={`${item.projectId ?? ''}:${item.node.session.id}`}>
        {renderSessionNode(
          item.node,
          0,
          item.groupDirectory,
          item.projectId,
          false,
          item.secondaryMeta,
          'pinned',
          getRenderExtras(item.node),
        )}
      </React.Fragment>
    ));

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
          {renderRows(items)}
          {renderRows(inProgressItems)}
        </div>
      ) : null}
    </div>
    </TooltipProvider>
  );
}
