/**
 * Cap `sessionMenuModel.ts` for Lynx Projects long-press / swipe actions.
 * Callbacks gate visibility; missing callbacks omit that row.
 */

export type LynxSessionMenuItemId =
  | 'rename'
  | 'pin'
  | 'copyLink'
  | 'unshare'
  | 'share'
  | 'refreshTranscript'
  | 'archive'
  | 'delete';

export type LynxProjectMenuItemId =
  | 'newSession'
  | 'newWorktree'
  | 'syncSessions'
  | 'edit'
  | 'closeProject';

export type LynxWorktreeMenuItemId =
  | 'newSession'
  | 'deleteWorktree';

export type LynxMenuItemId =
  | LynxSessionMenuItemId
  | LynxProjectMenuItemId
  | LynxWorktreeMenuItemId;

export type LynxMenuItem = {
  id: LynxMenuItemId;
  /** Stable i18n-ish label key (Lynx catalog or Cap key spirit). */
  labelKey: string;
  onClick: () => void;
  destructive?: boolean;
  separated?: boolean;
  disabled?: boolean;
  spinning?: boolean;
};

type SessionMenuOptions = {
  pinned: boolean;
  shared: boolean;
  onRename?: () => void;
  onTogglePin?: () => void;
  onShare?: () => void;
  onCopyLink?: () => void;
  onUnshare?: () => void;
  onRefreshTranscript?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  refreshTranscriptDisabled?: boolean;
  refreshTranscriptSpinning?: boolean;
  extraItems?: LynxMenuItem[];
};

type ProjectMenuOptions = {
  gitRepository: boolean;
  onNewSession?: () => void;
  onNewWorktree?: () => void;
  onSyncSessions?: () => void;
  onEditProject?: () => void;
  onCloseProject?: () => void;
  extraItems?: LynxMenuItem[];
};

type WorktreeMenuOptions = {
  onNewSession?: () => void;
  onDeleteWorktree?: () => void;
  extraItems?: LynxMenuItem[];
};

const push = (items: LynxMenuItem[], item: LynxMenuItem | null): void => {
  if (item) items.push(item);
};

export const buildLynxSessionMenuItems = (
  options: SessionMenuOptions,
): LynxMenuItem[] => {
  const items: LynxMenuItem[] = [];
  push(items, options.onRename
    ? {
      id: 'rename',
      labelKey: 'lynx.projects.menu.rename',
      onClick: options.onRename,
    }
    : null);
  push(items, options.onTogglePin
    ? {
      id: 'pin',
      labelKey: options.pinned ? 'lynx.projects.menu.unpin' : 'lynx.projects.menu.pin',
      onClick: options.onTogglePin,
    }
    : null);
  if (options.shared) {
    push(items, options.onCopyLink
      ? {
        id: 'copyLink',
        labelKey: 'lynx.projects.menu.copyLink',
        onClick: options.onCopyLink,
      }
      : null);
    push(items, options.onUnshare
      ? {
        id: 'unshare',
        labelKey: 'lynx.projects.menu.unshare',
        onClick: options.onUnshare,
      }
      : null);
  } else {
    push(items, options.onShare
      ? {
        id: 'share',
        labelKey: 'lynx.projects.menu.share',
        onClick: options.onShare,
      }
      : null);
  }
  push(items, options.onRefreshTranscript
    ? {
      id: 'refreshTranscript',
      labelKey: 'lynx.projects.menu.refreshTranscript',
      onClick: options.onRefreshTranscript,
      disabled: options.refreshTranscriptDisabled,
      spinning: options.refreshTranscriptSpinning,
    }
    : null);
  push(items, options.onArchive
    ? {
      id: 'archive',
      labelKey: 'lynx.projects.menu.archive',
      onClick: options.onArchive,
    }
    : null);
  push(items, options.onDelete
    ? {
      id: 'delete',
      labelKey: 'lynx.projects.menu.delete',
      onClick: options.onDelete,
      destructive: true,
      separated: true,
    }
    : null);
  if (options.extraItems?.length) items.push(...options.extraItems);
  return items;
};

export const buildLynxProjectMenuItems = (
  options: ProjectMenuOptions,
): LynxMenuItem[] => {
  const items: LynxMenuItem[] = [];
  push(items, options.onNewSession
    ? {
      id: 'newSession',
      labelKey: 'lynx.projects.menu.newSession',
      onClick: options.onNewSession,
    }
    : null);
  push(items, options.gitRepository && options.onNewWorktree
    ? {
      id: 'newWorktree',
      labelKey: 'lynx.projects.menu.newWorktree',
      onClick: options.onNewWorktree,
    }
    : null);
  push(items, options.onSyncSessions
    ? {
      id: 'syncSessions',
      labelKey: 'lynx.projects.menu.syncSessions',
      onClick: options.onSyncSessions,
    }
    : null);
  push(items, options.onEditProject
    ? {
      id: 'edit',
      labelKey: 'lynx.projects.menu.edit',
      onClick: options.onEditProject,
    }
    : null);
  push(items, options.onCloseProject
    ? {
      id: 'closeProject',
      labelKey: 'lynx.projects.menu.closeProject',
      onClick: options.onCloseProject,
      destructive: true,
      separated: true,
    }
    : null);
  if (options.extraItems?.length) items.push(...options.extraItems);
  return items;
};

export const buildLynxWorktreeMenuItems = (
  options: WorktreeMenuOptions,
): LynxMenuItem[] => {
  const items: LynxMenuItem[] = [];
  push(items, options.onNewSession
    ? {
      id: 'newSession',
      labelKey: 'lynx.projects.menu.newSession',
      onClick: options.onNewSession,
    }
    : null);
  push(items, options.onDeleteWorktree
    ? {
      id: 'deleteWorktree',
      labelKey: 'lynx.projects.menu.deleteWorktree',
      onClick: options.onDeleteWorktree,
      destructive: true,
      separated: true,
    }
    : null);
  if (options.extraItems?.length) items.push(...options.extraItems);
  return items;
};
