import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';

export type MobileSessionMenuItemId =
  | 'rename'
  | 'pin'
  | 'copyLink'
  | 'unshare'
  | 'share'
  | 'refreshTranscript'
  | 'archive'
  | 'delete';

export type MobileProjectMenuItemId =
  | 'newSession'
  | 'newWorktree'
  | 'syncSessions'
  | 'edit'
  | 'closeProject';

export type MobileWorktreeMenuItemId =
  | 'newSession'
  | 'deleteWorktree';

export type MobileMenuItemId =
  | MobileSessionMenuItemId
  | MobileProjectMenuItemId
  | MobileWorktreeMenuItemId
  | (string & {});

export type MobileMenuItem = {
  id: MobileMenuItemId;
  icon: IconName;
  labelKey: I18nKey;
  onClick: () => void;
  destructive?: boolean;
  /** Visually separate this row from the preceding group (delete / close). */
  separated?: boolean;
  disabled?: boolean;
  spinning?: boolean;
};

type Translate = (key: I18nKey) => string;

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
  extraItems?: MobileMenuItem[];
};

type ProjectMenuOptions = {
  gitRepository: boolean;
  onNewSession?: () => void;
  onNewWorktree?: () => void;
  onSyncSessions?: () => void;
  onEditProject?: () => void;
  onCloseProject?: () => void;
  extraItems?: MobileMenuItem[];
};

type WorktreeMenuOptions = {
  onNewSession?: () => void;
  onDeleteWorktree?: () => void;
  extraItems?: MobileMenuItem[];
};

const push = (
  items: MobileMenuItem[],
  item: MobileMenuItem | null,
): void => {
  if (item) items.push(item);
};

/**
 * Shared ordered session menu for mobile home / sessions sheet / status bar.
 * Callbacks gate visibility; missing callbacks omit that row.
 */
export const buildSessionMenuItems = (
  options: SessionMenuOptions,
): MobileMenuItem[] => {
  const items: MobileMenuItem[] = [];
  push(items, options.onRename
    ? {
        id: 'rename',
        icon: 'pencil-ai',
        labelKey: 'sessions.sidebar.session.menu.rename',
        onClick: options.onRename,
      }
    : null);
  push(items, options.onTogglePin
    ? {
        id: 'pin',
        icon: options.pinned ? 'unpin' : 'pushpin',
        labelKey: options.pinned
          ? 'sessions.sidebar.session.menu.unpin'
          : 'sessions.sidebar.session.menu.pin',
        onClick: options.onTogglePin,
      }
    : null);
  if (options.shared) {
    push(items, options.onCopyLink
      ? {
          id: 'copyLink',
          icon: 'file-copy',
          labelKey: 'sessions.sidebar.session.menu.copyLink',
          onClick: options.onCopyLink,
        }
      : null);
    push(items, options.onUnshare
      ? {
          id: 'unshare',
          icon: 'link-unlink-m',
          labelKey: 'sessions.sidebar.session.menu.unshare',
          onClick: options.onUnshare,
        }
      : null);
  } else {
    push(items, options.onShare
      ? {
          id: 'share',
          icon: 'share-2',
          labelKey: 'sessions.sidebar.session.menu.share',
          onClick: options.onShare,
        }
      : null);
  }
  push(items, options.onRefreshTranscript
    ? {
        id: 'refreshTranscript',
        icon: 'refresh',
        labelKey: 'sessions.sidebar.session.menu.refreshTranscript',
        onClick: options.onRefreshTranscript,
        disabled: options.refreshTranscriptDisabled,
        spinning: options.refreshTranscriptSpinning,
      }
    : null);
  push(items, options.onArchive
    ? {
        id: 'archive',
        icon: 'archive',
        labelKey: 'sessions.sidebar.bulkActions.archive',
        onClick: options.onArchive,
      }
    : null);
  push(items, options.onDelete
    ? {
        id: 'delete',
        icon: 'delete-bin',
        labelKey: 'sessions.sidebar.bulkActions.delete',
        onClick: options.onDelete,
        destructive: true,
        separated: true,
      }
    : null);
  if (options.extraItems?.length) items.push(...options.extraItems);
  return items;
};

export const buildProjectMenuItems = (
  options: ProjectMenuOptions,
): MobileMenuItem[] => {
  const items: MobileMenuItem[] = [];
  push(items, options.onNewSession
    ? {
        id: 'newSession',
        icon: 'add',
        labelKey: 'sessions.sidebar.project.actions.newSession',
        onClick: options.onNewSession,
      }
    : null);
  push(items, options.gitRepository && options.onNewWorktree
    ? {
        id: 'newWorktree',
        icon: 'node-tree',
        labelKey: 'sessions.sidebar.project.actions.newWorktree',
        onClick: options.onNewWorktree,
      }
    : null);
  push(items, options.onSyncSessions
    ? {
        id: 'syncSessions',
        icon: 'refresh',
        labelKey: 'sessions.sidebar.project.actions.syncSessions',
        onClick: options.onSyncSessions,
      }
    : null);
  push(items, options.onEditProject
    ? {
        id: 'edit',
        icon: 'pencil-ai',
        labelKey: 'sessions.sidebar.project.actions.edit',
        onClick: options.onEditProject,
      }
    : null);
  push(items, options.onCloseProject
    ? {
        id: 'closeProject',
        icon: 'close',
        labelKey: 'sessions.sidebar.project.actions.closeProject',
        onClick: options.onCloseProject,
        destructive: true,
        separated: true,
      }
    : null);
  if (options.extraItems?.length) items.push(...options.extraItems);
  return items;
};

export const buildWorktreeMenuItems = (
  options: WorktreeMenuOptions,
): MobileMenuItem[] => {
  const items: MobileMenuItem[] = [];
  push(items, options.onNewSession
    ? {
        id: 'newSession',
        icon: 'add',
        labelKey: 'sessions.sidebar.project.actions.newSession',
        onClick: options.onNewSession,
      }
    : null);
  push(items, options.onDeleteWorktree
    ? {
        id: 'deleteWorktree',
        icon: 'delete-bin',
        labelKey: 'mobile.projectEdit.deleteWorktreeConfirmButton',
        onClick: options.onDeleteWorktree,
        destructive: true,
        separated: true,
      }
    : null);
  if (options.extraItems?.length) items.push(...options.extraItems);
  return items;
};

/** Resolve label keys through the caller's i18n `t` without baking locale into the model. */
export const resolveMobileMenuItemLabel = (
  item: MobileMenuItem,
  t: Translate,
): string => t(item.labelKey);
