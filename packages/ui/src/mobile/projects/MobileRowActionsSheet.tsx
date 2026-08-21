import { useEvent } from '@reactuses/core';
import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { useI18n, type I18nKey } from '@/lib/i18n';
import {
  buildProjectMenuItems,
  buildSessionMenuItems,
  buildWorktreeMenuItems,
  resolveMobileMenuItemLabel,
  type MobileMenuItem,
} from '@/mobile/sessionMenuModel';

export type MobileRowActionTarget =
  | { kind: 'session'; title: string; pinned: boolean; shared: boolean }
  | { kind: 'project'; title: string; gitRepository: boolean }
  | { kind: 'worktree'; title: string };

export type MobileRowActionCallbacks = {
  onRename?: () => void;
  onTogglePin?: () => void;
  onShare?: () => void;
  onCopyLink?: () => void;
  onUnshare?: () => void;
  onRefreshTranscript?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  onNewSession?: () => void;
  onNewWorktree?: () => void;
  onSyncSessions?: () => void;
  onEditProject?: () => void;
  onCloseProject?: () => void;
  onDeleteWorktree?: () => void;
};

export type MobileRowActionsSheetProps = {
  open: boolean;
  target: MobileRowActionTarget | null;
  actions: MobileRowActionCallbacks;
  onOpenChange: (open: boolean) => void;
  refreshTranscriptDisabled?: boolean;
  refreshTranscriptSpinning?: boolean;
};

type ActionRowProps = {
  icon: IconName;
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  spinning?: boolean;
};

function ActionRow({
  icon,
  label,
  onClick,
  destructive = false,
  disabled = false,
  spinning = false,
}: ActionRowProps) {
  const handleClick = useEvent(onClick);

  return (
    <Button
      type="button"
      variant={destructive ? 'destructive' : 'ghost'}
      size="lg"
      className="min-h-12 w-full justify-start gap-3 rounded-lg px-4"
      disabled={disabled}
      onClick={handleClick}
    >
      <Icon name={icon} className={spinning ? 'size-5 animate-spin' : 'size-5'} />
      <span className="truncate">{label}</span>
    </Button>
  );
}

function renderMenuItems(
  items: MobileMenuItem[],
  t: (key: I18nKey) => string,
  run: (action?: () => void) => () => void,
) {
  return items.map((item) => {
    const row = (
      <ActionRow
        key={item.id}
        icon={item.icon}
        label={resolveMobileMenuItemLabel(item, t)}
        onClick={run(item.onClick)}
        destructive={item.destructive}
        disabled={item.disabled}
        spinning={item.spinning}
      />
    );
    if (!item.separated) return row;
    return (
      <div key={item.id} className="mt-3 border-t border-[var(--surface-subtle)] pt-3">
        {row}
      </div>
    );
  });
}

export function MobileRowActionsSheet({
  open,
  target,
  actions,
  onOpenChange,
  refreshTranscriptDisabled = false,
  refreshTranscriptSpinning = false,
}: MobileRowActionsSheetProps) {
  const { t } = useI18n();
  const run = (action?: () => void) => () => {
    onOpenChange(false);
    action?.();
  };

  const menuItems = React.useMemo(() => {
    if (!target) return [] as MobileMenuItem[];
    if (target.kind === 'session') {
      return buildSessionMenuItems({
        pinned: target.pinned,
        shared: target.shared,
        onRename: actions.onRename,
        onTogglePin: actions.onTogglePin,
        onShare: actions.onShare,
        onCopyLink: actions.onCopyLink,
        onUnshare: actions.onUnshare,
        onRefreshTranscript: actions.onRefreshTranscript,
        onArchive: actions.onArchive,
        onDelete: actions.onDelete,
        refreshTranscriptDisabled,
        refreshTranscriptSpinning,
      });
    }
    if (target.kind === 'project') {
      return buildProjectMenuItems({
        gitRepository: target.gitRepository,
        onNewSession: actions.onNewSession,
        onNewWorktree: actions.onNewWorktree,
        onSyncSessions: actions.onSyncSessions,
        onEditProject: actions.onEditProject,
        onCloseProject: actions.onCloseProject,
      });
    }
    return buildWorktreeMenuItems({
      onNewSession: actions.onNewSession,
      onDeleteWorktree: actions.onDeleteWorktree,
    });
  }, [actions, refreshTranscriptDisabled, refreshTranscriptSpinning, target]);

  if (!target) return null;

  return (
    <MobileResizableSheet
      id="mobile-row-actions-sheet"
      open={open}
      onOpenChange={onOpenChange}
      title={<h2 className="truncate typography-ui-label font-semibold">{target.title}</h2>}
      ariaLabel={target.title}
      closeAriaLabel={t('mobile.surface.closeAria')}
      resizeAriaLabel={t('mobile.sessions.sheet.resizeAria')}
      fitContent
    >
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain px-2">
        {renderMenuItems(menuItems, t, run)}
      </div>
    </MobileResizableSheet>
  );
}
