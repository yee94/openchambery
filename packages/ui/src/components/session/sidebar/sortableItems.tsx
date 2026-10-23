import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { SIDEBAR_ROW_HOVER_CLASS } from './utils';

export interface SortableProjectItemProps {
  id: string;
  disabled?: boolean;
  projectLabel: string;
  projectDescription: string;
  projectIcon?: string;
  projectColor?: string;
  projectIconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
  isCollapsed: boolean;
  isActiveProject: boolean;
  /** True while this project's session directories are still fetching. */
  isSessionsLoading?: boolean;
  isRepo: boolean;
  isDesktopShell: boolean;
  isStuck: boolean;
  hideDirectoryControls: boolean;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  onToggle: () => void;
  onNewSession: () => void;
  onNewWorktreeSession?: () => void;
  onSyncSessions: () => void;
  onRenameStart: () => void;
  onClose: () => void;
  sentinelRef: (el: HTMLDivElement | null) => void;
  children?: React.ReactNode;
  showCreateButtons?: boolean;
  hideHeader?: boolean;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  reorderEnabled?: boolean;
}

export type SortableDragHandleProps = {
  listeners: ReturnType<typeof useSortable>['listeners'];
  setActivatorNodeRef: ReturnType<typeof useSortable>['setActivatorNodeRef'];
};

export const SortableProjectItem = React.memo(function SortableProjectItem({
  id,
  disabled = false,
  projectLabel,
  projectDescription,
  projectIcon,
  projectColor,
  projectIconImage,
  isCollapsed,
  isActiveProject,
  isSessionsLoading = false,
  isRepo,
  isDesktopShell,
  isStuck,
  hideDirectoryControls,
  alwaysShowActions,
  onToggle,
  onNewSession,
  onNewWorktreeSession,
  onSyncSessions,
  onRenameStart,
  onClose,
  sentinelRef,
  children,
  showCreateButtons = true,
  hideHeader = false,
  openSidebarMenuKey,
  setOpenSidebarMenuKey,
  reorderEnabled = true,
}: SortableProjectItemProps) {
  const { t } = useI18n();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: disabled || !reorderEnabled });

  const suppressNextToggleRef = React.useRef(false);
  const menuInstanceKey = `project:${id}`;
  const isMenuOpen = openSidebarMenuKey === menuInstanceKey;
  const [isContextMenuOpen, setIsContextMenuOpen] = React.useState(false);
  const projectIconName = projectIcon ? PROJECT_ICON_MAP[projectIcon] : null;
  const projectIconColor = projectColor ? PROJECT_COLOR_MAP[projectColor] : undefined;
  const projectIconFallback = <Icon name={projectIconName ?? 'folder-open'} className="h-4 w-4" style={projectIconColor ? { color: projectIconColor } : undefined} />;

  const handleMenuOpenChange = React.useCallback((open: boolean) => {
    if (open) setIsContextMenuOpen(false);
    setOpenSidebarMenuKey(open ? menuInstanceKey : null);
  }, [menuInstanceKey, setOpenSidebarMenuKey]);

  const renderProjectMenuItems = (Item: React.ElementType) => (
    <>
      {showCreateButtons && !isRepo && !hideDirectoryControls && onNewSession && (
        <Item onClick={onNewSession}>
          <Icon name="add" className="mr-1.5 h-4 w-4" />
          {t('sessions.sidebar.project.actions.newSession')}
        </Item>
      )}
      <Item onClick={onSyncSessions}>
        <Icon name="refresh" className="mr-1.5 h-4 w-4" />
        {t('sessions.sidebar.project.actions.syncSessions')}
      </Item>
      <Item onClick={onRenameStart}>
        <Icon name="pencil-ai" className="mr-1.5 h-4 w-4" />
        {t('sessions.sidebar.project.actions.edit')}
      </Item>
      <Item onClick={onClose} className="text-destructive focus:text-destructive">
        <Icon name="close" className="mr-1.5 h-4 w-4" />
        {t('sessions.sidebar.project.actions.closeProject')}
      </Item>
    </>
  );

  const handleMenuTriggerClick = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const handleMenuTriggerPointerDown = React.useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const handleMenuTriggerMouseDown = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const handleToggleMouseDown = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (event.button === 2 || (event.button === 0 && event.ctrlKey)) {
      suppressNextToggleRef.current = true;
    }
  }, []);

  const handleToggleClick = React.useCallback(() => {
    if (suppressNextToggleRef.current) {
      suppressNextToggleRef.current = false;
      return;
    }
    onToggle();
  }, [onToggle]);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative', isDragging && 'opacity-30')}
    >
      {!hideHeader ? (
        <>
          {isDesktopShell && (
            <div
              ref={sentinelRef}
              data-project-id={id}
              className="absolute top-0 h-px w-full pointer-events-none"
              aria-hidden="true"
            />
          )}

          <ContextMenu open={isContextMenuOpen} onOpenChange={setIsContextMenuOpen}>
            <ContextMenuTrigger
              render={
                <div
                  className={cn('w-full text-left group/project select-none')}
                  style={{ backgroundColor: isDesktopShell && isStuck ? 'transparent' : undefined }}
                  onContextMenu={(event) => {
                    // VS Code hides project actions entirely (hideDirectoryControls).
                    if (hideDirectoryControls) return;
                    event.preventDefault();
                    setIsContextMenuOpen(true);
                  }}
                />
              }
            >
            <div className={cn('relative flex items-center gap-1.5 rounded-lg px-2 py-1.5', SIDEBAR_ROW_HOVER_CLASS)} {...attributes}>
              <Tooltip>
                <TooltipTrigger asChild>
                    <button
                      type="button"
                      onMouseDown={handleToggleMouseDown}
                      onClick={handleToggleClick}
                      {...(reorderEnabled ? listeners : {})}
                      className={cn(
                        'flex-1 min-w-0 flex items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 rounded-md transition-[padding]',
                        reorderEnabled ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
                        isRepo && !hideDirectoryControls
                          ? (alwaysShowActions ? 'pr-20' : 'pr-7 group-hover/project:pr-20 group-has-[:focus-visible]/project:pr-20')
                          : (alwaysShowActions ? 'pr-14' : 'pr-7 group-hover/project:pr-14 group-has-[:focus-visible]/project:pr-14'),
                      )}
                    >
                    <span
                      className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center overflow-hidden text-foreground"
                    >
                      {isSessionsLoading ? (
                        <Icon
                          name="loader-4"
                          className="h-4 w-4 animate-spin"
                          aria-label={t('sessions.sidebar.project.loadingSessions')}
                        />
                      ) : (
                        <>
                          <span className={cn(
                            'h-4 w-4 items-center justify-center',
                            alwaysShowActions ? 'inline-flex' : 'hidden group-hover/project:inline-flex group-has-[:focus-visible]/project:inline-flex',
                          )}>
                            {isCollapsed ? <Icon name="arrow-right-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-down-s" className="h-3.5 w-3.5" />}
                          </span>
                          <span className={cn(alwaysShowActions ? 'hidden' : 'group-hover/project:hidden group-has-[:focus-visible]/project:hidden')}>
                            {projectIconImage ? (
                              <ProjectIconImage
                                project={{ id, iconImage: projectIconImage }}
                                className="size-full object-contain"
                                fallback={projectIconFallback}
                              />
                            ) : projectIconFallback}
                          </span>
                        </>
                      )}
                    </span>
                    <span className={cn(
                      'text-[14px] font-normal truncate lowercase',
                      isActiveProject ? 'text-foreground' : 'text-foreground group-hover/project:text-foreground',
                    )}>
                      {projectLabel}
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {projectDescription}
                </TooltipContent>
              </Tooltip>

              <div className={cn(
                'absolute top-1/2 z-10 flex -translate-y-1/2 items-center gap-1',
                showCreateButtons ? 'right-7' : 'right-0.5',
              )}>
                {showCreateButtons && isRepo && !hideDirectoryControls && onNewWorktreeSession ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNewWorktreeSession();
                        }}
                        className={cn(
                        'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 hover:text-foreground transition-opacity',
                          alwaysShowActions ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-has-[:focus-visible]/project:opacity-100 group-has-[:focus-visible]/project:pointer-events-auto',
                        )}
                        aria-label={t('sessions.sidebar.project.actions.newWorktree')}
                      >
                        <Icon name="node-tree" className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={4}>
                      <p>{t('sessions.sidebar.project.actions.newWorktreeEllipsis')}</p>
                    </TooltipContent>
                  </Tooltip>
                ) : null}

                {!hideDirectoryControls ? (
                <DropdownMenu
                  open={isMenuOpen}
                  onOpenChange={handleMenuOpenChange}
                >
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 hover:text-foreground',
                          isMenuOpen
                            ? 'opacity-100 pointer-events-auto'
                            : alwaysShowActions
                              ? 'opacity-100'
                              : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-has-[:focus-visible]/project:opacity-100 group-has-[:focus-visible]/project:pointer-events-auto',
                        )}
                        aria-label={t('sessions.sidebar.project.actions.projectMenu')}
                        onPointerDown={handleMenuTriggerPointerDown}
                        onMouseDown={handleMenuTriggerMouseDown}
                        onClick={handleMenuTriggerClick}
                      >
                        <Icon name="more-2" className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[180px]">
                      {renderProjectMenuItems(DropdownMenuItem)}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>

              {showCreateButtons && onNewSession ? (
                <div className="absolute right-0.5 top-1/2 z-10 -translate-y-1/2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNewSession();
                        }}
                        className={cn(
                          'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-opacity',
                          alwaysShowActions ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-has-[:focus-visible]/project:opacity-100 group-has-[:focus-visible]/project:pointer-events-auto',
                        )}
                        aria-label={isRepo
                          ? t('sessions.sidebar.project.actions.newDraftSession')
                          : t('sessions.sidebar.project.actions.newSession')}
                      >
                        <Icon name="add" className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={4}>
                      <p>{isRepo
                        ? t('sessions.sidebar.project.actions.newDraftSession')
                        : t('sessions.sidebar.project.actions.newSession')}</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
              ) : null}
            </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="min-w-[180px]">
              {renderProjectMenuItems(ContextMenuItem)}
            </ContextMenuContent>
          </ContextMenu>
        </>
      ) : null}

      {children}
    </div>
  );
});

const SortableGroupItemBase: React.FC<{
  id: string;
  disabled?: boolean;
  children: React.ReactNode | ((dragHandleProps: SortableDragHandleProps) => React.ReactNode);
}> = ({ id, disabled = false, children }) => {
  const {
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  const dragHandleProps = React.useMemo<SortableDragHandleProps>(() => ({
    listeners,
    setActivatorNodeRef,
  }), [listeners, setActivatorNodeRef]);

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(
        'space-y-0.5 rounded-md',
        isDragging && 'opacity-50',
      )}
    >
      {typeof children === 'function' ? children(dragHandleProps) : children}
    </div>
  );
};

export const SortableGroupItem = React.memo(SortableGroupItemBase);
