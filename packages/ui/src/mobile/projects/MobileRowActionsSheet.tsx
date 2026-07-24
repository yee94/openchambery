import { useEvent } from '@reactuses/core';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useI18n } from '@/lib/i18n';

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
  onArchive?: () => void;
  onDelete?: () => void;
  onNewSession?: () => void;
  onNewWorktree?: () => void;
  onEditProject?: () => void;
  onCloseProject?: () => void;
  onDeleteWorktree?: () => void;
};

export type MobileRowActionsSheetProps = {
  open: boolean;
  target: MobileRowActionTarget | null;
  actions: MobileRowActionCallbacks;
  onOpenChange: (open: boolean) => void;
};

type ActionRowProps = {
  icon: IconName;
  label: string;
  onClick: () => void;
  destructive?: boolean;
};

function ActionRow({ icon, label, onClick, destructive = false }: ActionRowProps) {
  const handleClick = useEvent(onClick);

  return (
    <Button
      type="button"
      variant={destructive ? 'destructive' : 'ghost'}
      size="lg"
      className="min-h-12 w-full justify-start gap-3 rounded-2xl px-4"
      onClick={handleClick}
    >
      <Icon name={icon} className="size-5" />
      <span className="truncate">{label}</span>
    </Button>
  );
}

export function MobileRowActionsSheet({
  open,
  target,
  actions,
  onOpenChange,
}: MobileRowActionsSheetProps) {
  const { t } = useI18n();
  const handleClose = useEvent(() => onOpenChange(false));
  const run = (action?: () => void) => () => {
    onOpenChange(false);
    action?.();
  };

  if (!target) return null;

  return (
    <MobileOverlayPanel
      open={open}
      title={target.title}
      onClose={handleClose}
      closeAriaLabel={t('mobile.surface.closeAria')}
      containedBody
      className="rounded-t-[30px] border-[var(--interactive-border)] bg-[color:color-mix(in_srgb,var(--surface-elevated)_94%,transparent)] pb-[var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px))] shadow-[0_-20px_60px_color-mix(in_srgb,var(--surface-foreground)_14%,transparent)] backdrop-blur-2xl supports-[corner-shape:squircle]:rounded-t-[68px] motion-reduce:transition-none"
      renderHeader={(closeButton) => (
        <div className="px-4 pb-2 pt-3">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[var(--surface-muted)]" aria-hidden />
          <div className="flex min-h-11 items-center justify-between gap-3">
            <h2 className="min-w-0 truncate typography-ui-label font-semibold">{target.title}</h2>
            {closeButton}
          </div>
        </div>
      )}
    >
      <div className="flex min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {target.kind === 'session' ? (
          <>
            {actions.onRename ? <ActionRow icon="pencil-ai" label={t('sessions.sidebar.session.menu.rename')} onClick={run(actions.onRename)} /> : null}
            {actions.onTogglePin ? (
              <ActionRow
                icon={target.pinned ? 'unpin' : 'pushpin'}
                label={target.pinned ? t('sessions.sidebar.session.menu.unpin') : t('sessions.sidebar.session.menu.pin')}
                onClick={run(actions.onTogglePin)}
              />
            ) : null}
            {target.shared ? (
              <>
                {actions.onCopyLink ? <ActionRow icon="file-copy" label={t('sessions.sidebar.session.menu.copyLink')} onClick={run(actions.onCopyLink)} /> : null}
                {actions.onUnshare ? <ActionRow icon="link-unlink-m" label={t('sessions.sidebar.session.menu.unshare')} onClick={run(actions.onUnshare)} /> : null}
              </>
            ) : actions.onShare ? (
              <ActionRow icon="share-2" label={t('sessions.sidebar.session.menu.share')} onClick={run(actions.onShare)} />
            ) : null}
            {actions.onArchive ? <ActionRow icon="archive" label={t('sessions.sidebar.bulkActions.archive')} onClick={run(actions.onArchive)} /> : null}
            {actions.onDelete ? (
              <div className="mt-2 border-t border-[var(--surface-subtle)] pt-2">
                <ActionRow icon="delete-bin" label={t('sessions.sidebar.bulkActions.delete')} onClick={run(actions.onDelete)} destructive />
              </div>
            ) : null}
          </>
        ) : null}

        {target.kind === 'project' ? (
          <>
            {actions.onNewSession ? <ActionRow icon="add" label={t('sessions.sidebar.project.actions.newSession')} onClick={run(actions.onNewSession)} /> : null}
            {target.gitRepository && actions.onNewWorktree ? <ActionRow icon="node-tree" label={t('sessions.sidebar.project.actions.newWorktree')} onClick={run(actions.onNewWorktree)} /> : null}
            {actions.onEditProject ? <ActionRow icon="pencil-ai" label={t('sessions.sidebar.project.actions.edit')} onClick={run(actions.onEditProject)} /> : null}
            {actions.onCloseProject ? (
              <div className="mt-2 border-t border-[var(--surface-subtle)] pt-2">
                <ActionRow icon="close" label={t('sessions.sidebar.project.actions.closeProject')} onClick={run(actions.onCloseProject)} destructive />
              </div>
            ) : null}
          </>
        ) : null}

        {target.kind === 'worktree' ? (
          <>
            {actions.onNewSession ? <ActionRow icon="add" label={t('sessions.sidebar.project.actions.newSession')} onClick={run(actions.onNewSession)} /> : null}
            {actions.onDeleteWorktree ? (
              <div className="mt-2 border-t border-[var(--surface-subtle)] pt-2">
                <ActionRow icon="delete-bin" label={t('mobile.projectEdit.deleteWorktreeConfirmButton')} onClick={run(actions.onDeleteWorktree)} destructive />
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </MobileOverlayPanel>
  );
}
