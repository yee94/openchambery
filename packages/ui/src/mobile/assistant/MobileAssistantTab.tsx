import * as React from 'react';
import { useEvent } from '@reactuses/core';

import assistantGuideHero from '@/assets/assistant-guide/assistant-guide-hero-wide.jpg';
import androidDirectShareImage from '@/assets/assistant-share-welcome/android-direct-share.jpg';
import iosShareSheetImage from '@/assets/assistant-share-welcome/ios-share-sheet.jpg';
import selectAssistantImage from '@/assets/assistant-share-welcome/select-assistant.jpg';
import { AssistantWorkingAvatar } from '@/components/assistants/AssistantWorkingAvatar';
import { useAssistantWorking } from '@/components/assistants/assistantWorking';
import { AssistantDeleteConfirmDialog } from '@/components/assistants/AssistantDeleteConfirmDialog';
import { getAssistantPresentation } from '@/components/assistants/assistantPresentation';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  createMobileLongPressController,
  type MobileLongPressController,
} from '@/components/ui/mobileLongPress';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  useAssistantCapabilityQuery,
  useAssistantSnapshotQuery,
  type AssistantDTO,
} from '@/queries/assistantQueries';
import { openAssistantSettings, useAssistantUIStore } from '@/stores/useAssistantUIStore';
import { useMobileAppActions } from '@/apps/mobileAppContext';

import { MobileFloatingSurface, MobileLabeledSurfaceGroup, MobileTabPageScaffold } from '../MobileSurface';

export type MobileAssistantTabProps = {
  onEnable: () => void;
  onOpenAssistant: (assistantID: string) => void;
  className?: string;
};

const assistantGuideShareSteps = [
  {
    image: iosShareSheetImage,
    titleKey: 'assistants.guide.share.ios.title',
    descriptionKey: 'assistants.guide.share.ios.description',
  },
  {
    image: androidDirectShareImage,
    titleKey: 'assistants.guide.share.android.title',
    descriptionKey: 'assistants.guide.share.android.description',
  },
  {
    image: selectAssistantImage,
    titleKey: 'assistants.guide.share.pick.title',
    descriptionKey: 'assistants.guide.share.pick.description',
  },
] as const;

function MobileAssistantSkeleton() {
  const { t } = useI18n();

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 p-5"
      aria-busy="true"
      aria-label={t('common.loading')}
    >
      <div className="h-10 w-10 animate-pulse rounded-xl bg-[var(--surface-muted)] motion-reduce:animate-none" />
      <div className="mt-2 h-4 w-2/3 animate-pulse rounded-md bg-[var(--surface-muted)] motion-reduce:animate-none" />
      <div className="h-3.5 w-full animate-pulse rounded-md bg-[var(--surface-muted)] motion-reduce:animate-none" />
      <div className="h-3.5 w-4/5 animate-pulse rounded-md bg-[var(--surface-muted)] motion-reduce:animate-none" />
    </div>
  );
}

function MobileAssistantDisabledGuide({ onEnable }: { onEnable: () => void }) {
  const { t } = useI18n();

  return (
    <article className="oc-mobile-assistant-guide">
      <div className="oc-mobile-assistant-guide-hero" aria-hidden="true">
        <img src={assistantGuideHero} alt="" />
      </div>

      <div className="oc-mobile-assistant-guide-body">
        <h2 className="oc-mobile-assistant-guide-title">
          {t('assistants.guide.disabledTitle')}
        </h2>
        <p className="oc-mobile-assistant-guide-description">
          {t('assistants.guide.disabledDescription')}
        </p>
        <Button type="button" size="lg" onClick={onEnable}>
          {t('assistants.guide.enableAction')}
        </Button>
      </div>

      <section className="oc-mobile-assistant-guide-share">
        <h3 className="oc-mobile-assistant-guide-share-title">
          {t('assistants.guide.shareTitle')}
        </h3>
        <div
          className="oc-mobile-assistant-guide-steps"
          aria-label={t('assistants.guide.shareAria')}
        >
          {assistantGuideShareSteps.map((step) => (
            <article key={step.titleKey} className="oc-mobile-assistant-guide-step">
              <div className="oc-mobile-assistant-guide-step-image">
                <img src={step.image} alt="" />
              </div>
              <div className="oc-mobile-assistant-guide-step-copy">
                <h4>{t(step.titleKey)}</h4>
                <p>{t(step.descriptionKey)}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </article>
  );
}

type MobileAssistantCardProps = {
  assistantID: string;
  displayName: string;
  avatarEmoji?: string;
  modeLabel: string;
  summary: string;
  enabled: boolean;
  editLabel: string;
  deleteLabel: string;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  assignedSessionIDs?: string[];
  serverWorking?: boolean;
};

function MobileAssistantCard({
  assistantID,
  displayName,
  avatarEmoji,
  modeLabel,
  summary,
  enabled,
  editLabel,
  deleteLabel,
  onOpen,
  onEdit,
  onDelete,
  assignedSessionIDs = [],
  serverWorking = false,
}: MobileAssistantCardProps) {
  const working = useAssistantWorking(assistantID, assignedSessionIDs, serverWorking);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [pressed, setPressed] = React.useState(false);
  const longPressRef = React.useRef<MobileLongPressController | null>(null);

  if (!longPressRef.current) {
    longPressRef.current = createMobileLongPressController({
      onPressedKeyChange: (key) => setPressed(key === assistantID),
    });
  }

  React.useEffect(() => () => longPressRef.current?.reset(), []);

  const handleOpen = useEvent(() => {
    if (longPressRef.current?.consumeClick(assistantID)) return;
    if (menuOpen) return;
    onOpen();
  });
  const handleEdit = useEvent(() => {
    setMenuOpen(false);
    onEdit();
  });
  const handleDelete = useEvent(() => {
    setMenuOpen(false);
    onDelete();
  });
  const openMenu = useEvent(() => {
    setPressed(false);
    setMenuOpen(true);
  });
  const handlePointerDown = useEvent((event: React.PointerEvent<HTMLButtonElement>) => {
    if ((event.pointerType !== 'touch' && event.pointerType !== 'pen') || event.button !== 0) return;
    longPressRef.current?.start({
      pointerId: event.pointerId,
      key: assistantID,
      clientX: event.clientX,
      clientY: event.clientY,
      onTrigger: openMenu,
    });
  });
  const handlePointerMove = useEvent((event: React.PointerEvent<HTMLButtonElement>) => {
    longPressRef.current?.move(event.pointerId, event.clientX, event.clientY);
  });
  const handlePointerUp = useEvent((event: React.PointerEvent<HTMLButtonElement>) => {
    longPressRef.current?.end(event.pointerId);
  });
  const handlePointerCancel = useEvent((event: React.PointerEvent<HTMLButtonElement>) => {
    longPressRef.current?.cancel(event.pointerId);
  });
  const handleContextMenu = useEvent((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    longPressRef.current?.openFromContextMenu(assistantID, openMenu);
  });

  return (
    <ContextMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <MobileFloatingSurface
        data-mobile-press-surface="soft"
        className={cn('oc-mobile-assistant-card-shell', pressed && 'bg-interactive-hover')}
      >
        <ContextMenuTrigger
          render={
            <button
              type="button"
              role="option"
              aria-selected="false"
              data-mobile-press-surface-trigger
              className={cn('oc-mobile-assistant-card', !enabled && 'opacity-65')}
              onClick={handleOpen}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onContextMenu={handleContextMenu}
              style={{ touchAction: 'pan-y' }}
            />
          }
        >
          <span className={cn(
            'oc-mobile-assistant-avatar',
            avatarEmoji
              ? 'oc-mobile-assistant-avatar--emoji'
              : 'oc-mobile-assistant-avatar--visual',
          )}>
            <AssistantWorkingAvatar
              name={assistantID}
              emoji={avatarEmoji}
              size={avatarEmoji ? 40 : 38}
              label={displayName}
              working={working}
            />
          </span>
          <span className="oc-mobile-assistant-card-content min-w-0 flex-1">
            <span className="oc-mobile-assistant-card-header">
              <span className="oc-mobile-entity-title oc-mobile-assistant-name min-w-0 flex-1 truncate font-semibold text-foreground">
                {displayName}
              </span>
              <span className="oc-mobile-entity-meta oc-mobile-assistant-mode shrink-0 text-muted-foreground">
                {modeLabel}
              </span>
            </span>
            <span className="oc-mobile-assistant-summary text-muted-foreground">
              {summary}
            </span>
          </span>
        </ContextMenuTrigger>
      </MobileFloatingSurface>
      <ContextMenuContent className="min-w-[10rem]">
        <ContextMenuItem className="min-h-10 px-3" onClick={handleEdit}>
          <Icon name="edit" className="size-4" />
          {editLabel}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className="min-h-10 px-3 text-[var(--status-error)] focus:text-[var(--status-error)] data-[highlighted]:text-[var(--status-error)] [&_svg]:text-[var(--status-error)]"
          onClick={handleDelete}
        >
          <Icon name="delete-bin" className="size-4" />
          {deleteLabel}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function MobileAssistantTab({ onEnable, onOpenAssistant, className }: MobileAssistantTabProps) {
  const { t } = useI18n();
  const mobileActions = useMobileAppActions();
  const capability = useAssistantCapabilityQuery();
  const snapshot = useAssistantSnapshotQuery();
  const requestCreate = useAssistantUIStore((state) => state.requestCreate);
  const [deleteTarget, setDeleteTarget] = React.useState<AssistantDTO | null>(null);
  const handleEnable = useEvent(() => onEnable());
  const handleCreate = useEvent(() => {
    requestCreate();
    mobileActions?.openSettings('assistants');
  });
  const handleOpenAssistant = useEvent((assistantID: string) => onOpenAssistant(assistantID));
  const handleEdit = useEvent((assistantID: string) => {
    openAssistantSettings(
      assistantID,
      mobileActions ? { openMobileSettings: mobileActions.openSettings } : undefined,
    );
  });
  const handleRequestDelete = useEvent((assistant: AssistantDTO) => {
    setDeleteTarget(assistant);
  });
  const handleDeleteDialogOpenChange = useEvent((open: boolean) => {
    if (!open) setDeleteTarget(null);
  });
  const pageTitle = t('assistants.title');
  const editLabel = t('assistants.menu.edit');
  const deleteLabel = t('assistants.settings.delete');

  if (capability.isPending || (capability.data?.supported && capability.data.enabled && snapshot.isPending)) {
    return (
      <MobileTabPageScaffold title={pageTitle} className={className} surface={false}>
        <MobileFloatingSurface className="oc-mobile-assistant-loading">
          <MobileAssistantSkeleton />
        </MobileFloatingSurface>
      </MobileTabPageScaffold>
    );
  }

  if (capability.data?.supported && capability.data.enabled && snapshot.data?.enabled && snapshot.data.assistants.length > 0) {
    return (
      <MobileTabPageScaffold title={pageTitle} className={className} surface={false} scrollsWithPage>
        <div
          className="oc-mobile-assistant-catalog"
          role="listbox"
          aria-label={t('assistants.listAria')}
        >
          {snapshot.data.assistants.map((assistant) => {
            const presentation = getAssistantPresentation(assistant.name);
            const displayName = presentation.displayName || assistant.name;
            const modeLabel = assistant.mode === 'stateless'
              ? t('assistants.mode.stateless')
              : t('assistants.mode.continuous');
            const summary = assistant.defaultPrompt.trim() || (assistant.mode === 'stateless'
              ? t('assistants.conversation.statelessHint')
              : t('assistants.conversation.continuousHint'));

            return (
              <MobileAssistantCard
                key={assistant.id}
                assistantID={assistant.id}
                displayName={displayName}
                avatarEmoji={presentation.avatarEmoji ?? undefined}
                modeLabel={modeLabel}
                summary={summary}
                enabled={assistant.enabled}
                editLabel={editLabel}
                deleteLabel={deleteLabel}
                assignedSessionIDs={assistant.assignedSessionIDs}
                serverWorking={assistant.working}
                onOpen={() => handleOpenAssistant(assistant.id)}
                onEdit={() => handleEdit(assistant.id)}
                onDelete={() => handleRequestDelete(assistant)}
              />
            );
          })}
        </div>
        <AssistantDeleteConfirmDialog
          assistant={deleteTarget}
          open={deleteTarget !== null}
          onOpenChange={handleDeleteDialogOpenChange}
        />
      </MobileTabPageScaffold>
    );
  }

  if (
    capability.data?.supported
    && capability.data.enabled
    && snapshot.data?.enabled
    && snapshot.data.assistants.length === 0
  ) {
    return (
      <MobileTabPageScaffold
        title={pageTitle}
        className={className}
        surface={false}
        surfaceClassName="oc-mobile-assistant-state"
      >
        <MobileFloatingSurface className="oc-mobile-assistant-onboarding">
          <span className="oc-mobile-assistant-onboarding-icon">
            <Icon name="ai-agent" className="size-5" />
          </span>
          <h2>{t('assistants.onboarding.title')}</h2>
          <p>{t('assistants.onboarding.description')}</p>
          <Button type="button" size="lg" className="mt-6 w-full" onClick={handleCreate}>
            <Icon name="add" className="size-[18px]" />
            {t('assistants.onboarding.action')}
          </Button>
        </MobileFloatingSurface>
      </MobileTabPageScaffold>
    );
  }

  const unsupported = capability.isSuccess && capability.data.supported === false;
  const unavailable = capability.isError
    || (capability.data?.supported === true && capability.data.enabled && snapshot.isError);
  const instanceDisabled = capability.data?.supported === true
    && (capability.data.enabled === false || snapshot.data?.enabled === false);
  const title = unavailable
    ? t('assistants.state.unavailable')
    : unsupported
      ? t('assistants.state.unsupportedTitle')
      : t('assistants.state.instanceDisabled');

  if (instanceDisabled && !unavailable) {
    return (
      <MobileTabPageScaffold
        title={pageTitle}
        className={className}
        surface={false}
        surfaceClassName="oc-mobile-assistant-guide-host"
      >
        <MobileAssistantDisabledGuide onEnable={handleEnable} />
      </MobileTabPageScaffold>
    );
  }

  return (
    <MobileTabPageScaffold
      title={pageTitle}
      className={className}
      surface={false}
      surfaceClassName="oc-mobile-assistant-state"
    >
      <MobileLabeledSurfaceGroup
        label={<span className="oc-mobile-page-section-label">{pageTitle}</span>}
        cardClassName="oc-mobile-assistant-state-card"
      >
        <section className="w-full max-w-md py-2">
          <div className="flex size-12 items-center justify-center rounded-xl bg-interactive-selection text-interactive-selection-foreground">
            <Icon name={unsupported ? 'cloud-off' : 'sparkling'} weight="medium" className="size-5" />
          </div>
          <h2 className="mt-5 max-w-xs text-lg font-semibold leading-snug tracking-[-0.02em] text-foreground">
            {title}
          </h2>
          {unavailable ? null : (
            <p className="mt-2 max-w-sm typography-small leading-relaxed text-muted-foreground">
              {unsupported ? t('assistants.state.unsupportedDescription') : t('assistants.state.instanceDisabledDescription')}
            </p>
          )}
        </section>
      </MobileLabeledSurfaceGroup>
    </MobileTabPageScaffold>
  );
}
