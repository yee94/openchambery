import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
import { Icon } from '@/components/icon/Icon';
import { ChangeRow } from './ChangeRow';
import {
  TREE_INDENT_PX,
  buildChangesTree,
  flattenChangesTree,
  type ChangesTreeDirectoryNode,
  type FlattenedTreeRow,
} from './changesTree';
import type { GitStatus } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';

export interface ChangesGroupConfig {
  /** Stable id (e.g. 'staged' | 'unstaged'). */
  id: string;
  title: string;
  entries: GitStatus['files'];
  /** Per-file primary action: '+' stages, '-' unstages. */
  actionSymbol: '+' | '-';
  /** aria/title for the bulk header action (stage all / unstage all). */
  actionAllLabel: string;
  getActionLabel: (path: string) => string;
  onActionFile: (path: string) => void;
  onActionAll: (paths: string[]) => void;
  onViewDiff: (path: string) => void;
  onRevertFile: (path: string) => void;
  showRevertActions?: boolean;
  /** Visually mark this group as "ready to commit". */
  accent?: boolean;
}

interface ChangesPanelProps {
  groups: ChangesGroupConfig[];
  diffStats: Record<string, { insertions: number; deletions: number }> | undefined;
  revertingPaths: Set<string>;
  isRevertingAll?: boolean;
  headerBackgroundClassName?: string;
  onVisiblePathsChange?: (paths: string[]) => void;
  /** Reverts every changed path across all groups; rendered once for the panel. */
  onRevertAll?: (paths: string[]) => Promise<void> | void;
  onRevertDirectory?: (paths: string[]) => Promise<void> | void;
  /**
   * Extra trailing toolbar icons (branch / sync / repo) rendered only on the first
   * sticky group header, before the stage/unstage-all action.
   */
  headerActions?: React.ReactNode;
}

const CHANGE_LIST_VIRTUALIZE_THRESHOLD = 1000;
const CHANGE_ROW_ESTIMATE_PX = 34;
const VISIBLE_PREFETCH_LIMIT = 30;

const ROW_PADDING_CLASSNAME = 'pl-0 pr-2';
/**
 * Equal-width trailing icon track.
 * Every child occupies exactly 1.5rem so header / directory / file columns share one grid.
 */
const TRAILING_RAIL_CLASSNAME = 'ml-auto grid shrink-0 grid-flow-col auto-cols-[1.5rem] items-center justify-end';
const TRAILING_COUNT_CLASSNAME =
  'flex size-6 items-center justify-center tabular-nums typography-code text-muted-foreground';
const TRAILING_ACTION_CLASSNAME =
  'flex size-6 items-center justify-center rounded typography-code font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50';
const TRAILING_ICON_BUTTON_CLASSNAME =
  'flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50';

type PanelRow =
  | { type: 'header'; key: string; groupIndex: number }
  | { type: 'file'; key: string; groupIndex: number; file: GitStatus['files'][number]; depth: number }
  | { type: 'directory'; key: string; groupIndex: number; directory: ChangesTreeDirectoryNode; depth: number }
  | { type: 'revert-all'; key: string };

type PendingDirectoryRevert = {
  path: string;
  paths: string[];
  count: number;
};

const expandedKey = (groupId: string, path: string): string => `${groupId} ${path}`;

export const ChangesPanel: React.FC<ChangesPanelProps> = ({
  groups,
  diffStats,
  revertingPaths,
  isRevertingAll = false,
  headerBackgroundClassName = 'bg-sidebar',
  onVisiblePathsChange,
  onRevertAll,
  onRevertDirectory,
  headerActions,
}) => {
  const { t } = useI18n();
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const gitChangesViewMode = useUIStore((state) => state.gitChangesViewMode);
  const setGitChangesViewMode = useUIStore((state) => state.setGitChangesViewMode);
  const isTreeView = gitChangesViewMode === 'tree';

  const visibleGroups = React.useMemo(() => groups.filter((group) => group.entries.length > 0), [groups]);

  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(new Set());
  const [expandedDirectories, setExpandedDirectories] = React.useState<Set<string>>(new Set());
  const [revertAllOpen, setRevertAllOpen] = React.useState(false);
  const [pendingDirectoryRevert, setPendingDirectoryRevert] = React.useState<PendingDirectoryRevert | null>(null);
  // Tracks directory keys seen in the previous tree pass so git status refreshes
  // can auto-expand newly discovered folders without undoing user-collapsed ones.
  const seenDirectoryKeysRef = React.useRef<Set<string>>(new Set());

  const trees = React.useMemo(
    () => visibleGroups.map((group) => buildChangesTree(group.entries)),
    [visibleGroups]
  );

  const directoryKeysByGroup = React.useMemo(() => {
    const keys = new Map<string, string[]>();

    visibleGroups.forEach((group, index) => {
      const groupKeys: string[] = [];
      const collect = (directory: ChangesTreeDirectoryNode) => {
        directory.children.forEach((child) => {
          groupKeys.push(expandedKey(group.id, child.path));
          collect(child);
        });
      };

      const tree = trees[index];
      if (tree) collect(tree);
      keys.set(group.id, groupKeys);
    });

    return keys;
  }, [trees, visibleGroups]);

  React.useEffect(() => {
    if (!isTreeView) {
      seenDirectoryKeysRef.current = new Set();
      return;
    }

    const allDirectoryKeys = new Set(Array.from(directoryKeysByGroup.values()).flat());
    const seenDirectoryKeys = seenDirectoryKeysRef.current;
    const isInitialSeed = seenDirectoryKeys.size === 0 && allDirectoryKeys.size > 0;

    setExpandedDirectories((previous) => {
      const next = new Set(previous);
      let changed = false;

      for (const key of next) {
        if (!allDirectoryKeys.has(key)) {
          next.delete(key);
          changed = true;
        }
      }

      for (const key of allDirectoryKeys) {
        const isNewDirectory = !seenDirectoryKeys.has(key);
        if ((isInitialSeed || isNewDirectory) && !next.has(key)) {
          next.add(key);
          changed = true;
        }
      }

      return changed ? next : previous;
    });

    seenDirectoryKeysRef.current = allDirectoryKeys;
  }, [directoryKeysByGroup, isTreeView]);

  const rows = React.useMemo<PanelRow[]>(() => {
    const result: PanelRow[] = [];

    visibleGroups.forEach((group, groupIndex) => {
      result.push({ type: 'header', key: `header:${group.id}`, groupIndex });

      if (collapsedGroups.has(group.id)) {
        return;
      }

      if (isTreeView) {
        const expandedForGroup = new Set<string>();
        expandedDirectories.forEach((key) => {
          if (key.startsWith(`${group.id} `)) {
            expandedForGroup.add(key.slice(group.id.length + 1));
          }
        });
        const treeRows = flattenChangesTree(trees[groupIndex], expandedForGroup);
        treeRows.forEach((row: FlattenedTreeRow) => {
          if (row.kind === 'file') {
            result.push({
              type: 'file',
              key: `${group.id}:${row.key}`,
              groupIndex,
              file: row.file,
              depth: row.depth,
            });
          } else {
            result.push({
              type: 'directory',
              key: `${group.id}:${row.key}`,
              groupIndex,
              directory: row.directory,
              depth: row.depth,
            });
          }
        });
        return;
      }

      group.entries.forEach((file) => {
        result.push({
          type: 'file',
          key: `${group.id}:file:${file.path}`,
          groupIndex,
          file,
          depth: 0,
        });
      });
    });

    // Revert-all lives as the final in-flow row beneath the last file, so it
    // scrolls with the list rather than sitting in a section header.
    if (onRevertAll && visibleGroups.length > 0) {
      result.push({ type: 'revert-all', key: 'revert-all' });
    }

    return result;
  }, [collapsedGroups, expandedDirectories, isTreeView, onRevertAll, trees, visibleGroups]);

  // Pin the first group header outside the scroll container so it truly sticks.
  const pinnedGroup = visibleGroups[0] ?? null;
  const scrollRows = React.useMemo(() => {
    if (!pinnedGroup) return rows;
    return rows.filter((row) => !(row.type === 'header' && row.groupIndex === 0));
  }, [pinnedGroup, rows]);

  const rowCount = scrollRows.length;
  const shouldVirtualize = rowCount >= CHANGE_LIST_VIRTUALIZE_THRESHOLD;
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rowCount,
    enabled: shouldVirtualize,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CHANGE_ROW_ESTIMATE_PX,
    overscan: 12,
    getItemKey: (index) => scrollRows[index]?.key ?? index,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  // First VISIBLE row index drives the visible-path prefetch window (the
  // virtua findItemIndex/onScroll pair this replaces). virtualRows starts at
  // the overscan boundary — up to `overscan` rows above the viewport — so
  // skip rows that end above the current scroll offset; otherwise the
  // prefetch budget leaks to offscreen files above the viewport.
  const visibleStartIndex = React.useMemo(() => {
    if (!shouldVirtualize) return 0;
    const scrollTop = scrollRef.current?.scrollTop ?? 0;
    const firstVisible = virtualRows.find((item) => item.end > scrollTop);
    return firstVisible?.index ?? 0;
  }, [shouldVirtualize, virtualRows, scrollRef]);

  React.useEffect(() => {
    if (!onVisiblePathsChange) {
      return;
    }

    const collectFromRow = (row: PanelRow | undefined): string | null =>
      row && row.type === 'file' ? row.file.path : null;

    if (rowCount === 0) {
      onVisiblePathsChange([]);
      return;
    }

    if (!shouldVirtualize) {
      const paths: string[] = [];
      for (const row of scrollRows) {
        if (row.type === 'file') {
          paths.push(row.file.path);
          if (paths.length >= VISIBLE_PREFETCH_LIMIT) break;
        }
      }
      onVisiblePathsChange(paths);
      return;
    }

    onVisiblePathsChange(
      scrollRows
        .slice(
          visibleStartIndex,
          visibleStartIndex + Math.ceil((scrollRef.current?.clientHeight ?? 0) / CHANGE_ROW_ESTIMATE_PX) + VISIBLE_PREFETCH_LIMIT
        )
        .map((row) => collectFromRow(row))
        .filter((value): value is string => Boolean(value))
        .slice(0, VISIBLE_PREFETCH_LIMIT)
    );
  }, [onVisiblePathsChange, rowCount, scrollRows, shouldVirtualize, visibleStartIndex]);

  const toggleGroupCollapsed = React.useCallback((groupId: string) => {
    setCollapsedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const toggleDirectoryExpanded = React.useCallback((groupId: string, path: string) => {
    setExpandedDirectories((previous) => {
      const next = new Set(previous);
      const key = expandedKey(groupId, path);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const expandAllDirectories = React.useCallback((groupId: string) => {
    const directoryKeys = directoryKeysByGroup.get(groupId) ?? [];
    setExpandedDirectories((previous) => {
      const next = new Set(previous);
      directoryKeys.forEach((key) => next.add(key));
      return next;
    });
  }, [directoryKeysByGroup]);

  const collapseAllDirectories = React.useCallback((groupId: string) => {
    const directoryKeys = directoryKeysByGroup.get(groupId) ?? [];
    setExpandedDirectories((previous) => {
      const next = new Set(previous);
      directoryKeys.forEach((key) => next.delete(key));
      return next;
    });
  }, [directoryKeysByGroup]);

  // Every distinct changed path across groups (a partially-staged file appears in
  // both, so dedupe). One revert-all discards all working-tree changes at once.
  const allChangePaths = React.useMemo(() => {
    const seen = new Set<string>();
    visibleGroups.forEach((group) => group.entries.forEach((entry) => seen.add(entry.path)));
    return Array.from(seen);
  }, [visibleGroups]);
  const revertAllCount = allChangePaths.length;
  const isPendingDirectoryReverting = pendingDirectoryRevert
    ? isRevertingAll || pendingDirectoryRevert.paths.some((path) => revertingPaths.has(path))
    : false;

  const handleConfirmRevertAll = React.useCallback(async () => {
    if (!onRevertAll || isRevertingAll || allChangePaths.length === 0) {
      return;
    }
    await onRevertAll(allChangePaths);
    setRevertAllOpen(false);
  }, [allChangePaths, isRevertingAll, onRevertAll]);

  const handleConfirmRevertDirectory = React.useCallback(async () => {
    if (!onRevertDirectory || !pendingDirectoryRevert || isPendingDirectoryReverting) {
      return;
    }
    await onRevertDirectory(pendingDirectoryRevert.paths);
    setPendingDirectoryRevert(null);
  }, [isPendingDirectoryReverting, onRevertDirectory, pendingDirectoryRevert]);

  const renderHeader = React.useCallback(
    (group: ChangesGroupConfig, options: { pinned?: boolean; showToolbar?: boolean } = {}) => {
      const { pinned = false, showToolbar = false } = options;
      const collapsed = collapsedGroups.has(group.id);
      const count = group.entries.length;
      const groupDirectoryKeys = directoryKeysByGroup.get(group.id) ?? [];
      const allDirectoriesExpanded = groupDirectoryKeys.length > 0
        && groupDirectoryKeys.every((key) => expandedDirectories.has(key));
      const toggleAllLabel = allDirectoriesExpanded
        ? t('diffView.actions.collapseAll')
        : t('diffView.actions.expandAll');
      const toggleViewLabel = isTreeView
        ? t('settings.openchamber.git.option.flatList')
        : t('settings.openchamber.git.option.treeView');
      return (
        <div
          className={cn(
            'flex h-8 items-center gap-0',
            pinned ? 'shrink-0' : 'sticky top-0 z-10',
            headerBackgroundClassName,
            ROW_PADDING_CLASSNAME,
            // Section headers always keep vertical breathing room from content above.
            !pinned && 'mt-3'
          )}
        >
          <button
            type="button"
            onClick={() => toggleGroupCollapsed(group.id)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
            aria-expanded={!collapsed}
          >
            <h3 className="truncate typography-ui-label font-semibold text-foreground">{group.title}</h3>
            <span className="typography-code text-muted-foreground">{count}</span>
            <Icon
              name="arrow-down-s"
              className={cn(
                'size-3 shrink-0 text-muted-foreground transition-transform',
                collapsed && '-rotate-90'
              )}
            />
          </button>
          <div className={TRAILING_RAIL_CLASSNAME}>
            {isTreeView ? (
              <button
                type="button"
                onClick={() => {
                  if (allDirectoriesExpanded) {
                    collapseAllDirectories(group.id);
                    return;
                  }
                  expandAllDirectories(group.id);
                }}
                className={TRAILING_ICON_BUTTON_CLASSNAME}
                aria-label={toggleAllLabel}
                title={toggleAllLabel}
              >
                <Icon name={allDirectoriesExpanded ? 'contract-up-down' : 'expand-up-down'} className="size-3.5" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setGitChangesViewMode(isTreeView ? 'flat' : 'tree')}
              aria-label={toggleViewLabel}
              title={toggleViewLabel}
              aria-pressed={isTreeView}
              className={TRAILING_ICON_BUTTON_CLASSNAME}
            >
              <Icon name={isTreeView ? 'node-tree' : 'list-unordered'} className="size-3.5" />
            </button>
            {showToolbar ? headerActions : null}
            <button
              type="button"
              onClick={() => group.onActionAll(group.entries.map((entry) => entry.path))}
              className={TRAILING_ACTION_CLASSNAME}
              aria-label={group.actionAllLabel}
              title={group.actionAllLabel}
            >
              {group.actionSymbol}
            </button>
          </div>
        </div>
      );
    },
    [collapseAllDirectories, collapsedGroups, directoryKeysByGroup, expandAllDirectories, expandedDirectories, headerActions, headerBackgroundClassName, isTreeView, setGitChangesViewMode, t, toggleGroupCollapsed]
  );

  const renderDirectory = React.useCallback(
    (group: ChangesGroupConfig, directory: ChangesTreeDirectoryNode, depth: number) => {
      const isExpanded = expandedDirectories.has(expandedKey(group.id, directory.path));
      const directoryPaths = directory.files.map((file) => file.path);
      const isDirectoryReverting = isRevertingAll || directoryPaths.some((path) => revertingPaths.has(path));
      const showRevert = group.showRevertActions !== false && !!onRevertDirectory;
      return (
        <div
          className={cn('group flex h-8 items-center', ROW_PADDING_CLASSNAME)}
          style={{ paddingLeft: `${depth * TREE_INDENT_PX}px` }}
        >
          <button
            type="button"
            onClick={() => toggleDirectoryExpanded(group.id, directory.path)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={
              isExpanded
                ? t('gitView.changes.collapseDirectoryAria', { path: directory.path })
                : t('gitView.changes.expandDirectoryAria', { path: directory.path })
            }
          >
            {isExpanded ? (
              <Icon name="folder-open-fill" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            ) : (
              <Icon name="folder-3-fill" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate typography-code text-foreground" title={directory.path}>
              {directory.name}
            </span>
          </button>
          {/* count | revert? | action — equal 1.5rem slots, right-aligned; no empty gap when revert is hidden */}
          <div className={TRAILING_RAIL_CLASSNAME}>
            <span className={TRAILING_COUNT_CLASSNAME}>{directory.files.length}</span>
            {showRevert ? (
              <button
                type="button"
                onClick={() => setPendingDirectoryRevert({ path: directory.path, paths: directoryPaths, count: directoryPaths.length })}
                disabled={isDirectoryReverting}
                className={TRAILING_ICON_BUTTON_CLASSNAME}
                aria-label={t('gitView.changes.revertDirectoryAria', { path: directory.path })}
                title={t('gitView.changes.revertDirectoryTooltip')}
              >
                {isDirectoryReverting ? (
                  <Icon name="loader-4" className="size-3.5 animate-spin" />
                ) : (
                  <Icon name="arrow-go-back" className="size-3.5" />
                )}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => group.onActionAll(directory.files.map((file) => file.path))}
              className={TRAILING_ACTION_CLASSNAME}
              aria-label={t(
                group.actionSymbol === '+' ? 'gitView.changes.stageDirectoryAria' : 'gitView.changes.unstageDirectoryAria',
                { path: directory.path }
              )}
              title={t(
                group.actionSymbol === '+' ? 'gitView.changes.stageDirectoryAria' : 'gitView.changes.unstageDirectoryAria',
                { path: directory.path }
              )}
            >
              {group.actionSymbol}
            </button>
          </div>
        </div>
      );
    },
    [expandedDirectories, isRevertingAll, onRevertDirectory, revertingPaths, t, toggleDirectoryExpanded]
  );

  const renderRow = React.useCallback(
    (row: PanelRow) => {
      if (row.type === 'revert-all') {
        return (
          <div className={cn('flex justify-end py-2', ROW_PADDING_CLASSNAME)}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRevertAllOpen(true)}
              disabled={isRevertingAll}
              className="gap-1.5 text-[var(--status-error)] hover:bg-[var(--status-error)]/10 hover:text-[var(--status-error)]"
            >
              <Icon name="arrow-go-back" className="size-3.5" />
              {t('gitView.changes.revertAll')}
            </Button>
          </div>
        );
      }

      const group = visibleGroups[row.groupIndex];
      if (!group) return null;

      if (row.type === 'header') {
        return renderHeader(group, { showToolbar: false });
      }

      if (row.type === 'directory') {
        return renderDirectory(group, row.directory, row.depth);
      }

      const file = row.file;
      return (
        <ChangeRow
          file={file}
          actionLabel={group.getActionLabel(file.path)}
          actionSymbol={group.actionSymbol}
          onAction={() => group.onActionFile(file.path)}
          stats={diffStats?.[file.path]}
          onViewDiff={() => group.onViewDiff(file.path)}
          onRevert={() => group.onRevertFile(file.path)}
          isReverting={revertingPaths.has(file.path) || isRevertingAll}
          rowPaddingClassName={ROW_PADDING_CLASSNAME}
          indentPx={row.depth * TREE_INDENT_PX}
          actionAtStart={false}
          showRevert={group.showRevertActions !== false}
        />
      );
    },
    [diffStats, isRevertingAll, renderDirectory, renderHeader, revertingPaths, t, visibleGroups]
  );

  // A divider is drawn above a file/directory row only when the row directly above
  // it belongs to the same group (so headers never get a spurious top border).
  const showDivider = React.useCallback(
    (index: number): boolean => {
      const row = scrollRows[index];
      const previous = scrollRows[index - 1];
      if (!row || !previous) return false;
      if (row.type !== 'file' && row.type !== 'directory') return false;
      if (previous.type !== 'file' && previous.type !== 'directory') return false;
      return previous.groupIndex === row.groupIndex;
    },
    [scrollRows]
  );

  return (
    <>
      <div className="oc-changes-panel relative flex h-full min-h-0 w-full flex-col overflow-hidden">
        {pinnedGroup ? (
          <div className={cn('shrink-0', headerBackgroundClassName)}>
            {renderHeader(pinnedGroup, { pinned: true, showToolbar: true })}
          </div>
        ) : null}
        <ScrollShadow
          ref={scrollRef}
          className="overlay-scrollbar-target overlay-scrollbar-container min-h-0 w-full flex-1 overflow-x-hidden overflow-y-auto"
        >
          {shouldVirtualize ? (
            <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
              {/* Absolutely positioned rows: variable-height rows can drift from
                  the computed total height under flow stacking until measured. */}
              {virtualRows.map((item) => {
                const row = scrollRows[item.index];
                if (!row) return null;
                return (
                  <div
                    key={row.key}
                    data-index={item.index}
                    ref={rowVirtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${item.start}px)`,
                    }}
                    className={cn(
                      showDivider(item.index) &&
                        'before:pointer-events-none before:absolute before:left-0 before:right-2 before:top-0 before:border-t before:border-border/60'
                    )}
                  >
                    {renderRow(row)}
                  </div>
                );
              })}
            </div>
          ) : (
            <div role="list" aria-label={t('gitView.changes.changedFilesAria')}>
              {scrollRows.map((row, index) => (
                <div
                  key={row.key}
                  className={cn(
                    'relative',
                    showDivider(index) &&
                      'before:pointer-events-none before:absolute before:left-0 before:right-2 before:top-0 before:border-t before:border-border/60'
                  )}
                >
                  {renderRow(row)}
                </div>
              ))}
            </div>
          )}
        </ScrollShadow>
        <OverlayScrollbar containerRef={scrollRef} disableHorizontal />
      </div>

      <Dialog
        open={revertAllOpen}
        onOpenChange={(open) => {
          if (!isRevertingAll && !open) setRevertAllOpen(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('gitView.changes.revertAllDialogTitle')}</DialogTitle>
            <DialogDescription>
              {revertAllCount === 1
                ? t('gitView.changes.revertAllDescriptionSingle', { count: revertAllCount })
                : t('gitView.changes.revertAllDescriptionPlural', { count: revertAllCount })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRevertAllOpen(false)} disabled={isRevertingAll}>
              {t('gitView.common.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleConfirmRevertAll()}
              disabled={isRevertingAll}
            >
              {isRevertingAll ? t('gitView.changes.reverting') : t('gitView.changes.revertAll')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!pendingDirectoryRevert}
        onOpenChange={(open) => {
          if (!isPendingDirectoryReverting && !open) setPendingDirectoryRevert(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('gitView.changes.revertDirectoryDialogTitle')}</DialogTitle>
            <DialogDescription>
              {pendingDirectoryRevert
                ? pendingDirectoryRevert.count === 1
                  ? t('gitView.changes.revertDirectoryDescriptionSingle', { count: pendingDirectoryRevert.count, path: pendingDirectoryRevert.path })
                  : t('gitView.changes.revertDirectoryDescriptionPlural', { count: pendingDirectoryRevert.count, path: pendingDirectoryRevert.path })
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingDirectoryRevert(null)} disabled={isPendingDirectoryReverting}>
              {t('gitView.common.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleConfirmRevertDirectory()}
              disabled={isPendingDirectoryReverting || !pendingDirectoryRevert}
            >
              {isPendingDirectoryReverting ? t('gitView.changes.reverting') : t('gitView.changes.revertDirectory')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
