import React from 'react';
import { useEvent } from '@reactuses/core';
import { AssistantWorkingAvatar } from './AssistantWorkingAvatar';
import { useAssistantWorking } from './assistantWorking';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { MobileDetailNavigation } from '@/mobile/MobileDetailNavigation';
import { getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useAssistantCapabilityQuery, useAssistantSnapshotQuery, type AssistantDTO } from '@/queries/assistantQueries';
import { openAssistantSettings, useAssistantUIStore } from '@/stores/useAssistantUIStore';
import { useUIStore } from '@/stores/useUIStore';
import { AssistantConversationSurface } from './AssistantConversationSurface';
import { AssistantDeleteConfirmDialog } from './AssistantDeleteConfirmDialog';
import { getAssistantPresentation } from './assistantPresentation';

type MobileAssistantConversationHeaderProps = {
  assistant?: Pick<AssistantDTO, 'id' | 'name' | 'assignedSessionIDs' | 'working'> | null;
  onBack: () => void;
};

const MobileAssistantConversationHeader: React.FC<MobileAssistantConversationHeaderProps> = ({ assistant, onBack }) => {
  const { t } = useI18n();
  const presentation = assistant ? getAssistantPresentation(assistant.name) : null;
  const displayName = assistant && presentation ? presentation.displayName || assistant.name : '';
  const working = useAssistantWorking(assistant?.id ?? '', assistant?.assignedSessionIDs ?? [], Boolean(assistant?.working));

  return (
    <MobileDetailNavigation
      title={
        assistant ? (
          <span className="inline-flex min-w-0 items-center gap-2">
            <AssistantWorkingAvatar
              name={assistant.id}
              emoji={presentation?.avatarEmoji}
              size={24}
              label={displayName}
              working={working}
            />
            <span className="truncate">{displayName || t('assistants.title')}</span>
          </span>
        ) : (displayName || t('assistants.title'))
      }
      backAriaLabel={t('assistants.actions.backToChat')}
      onBack={onBack}
      overlay
    />
  );
};

type AssistantListItemProps = {
  assistantID: string;
  displayName: string;
  avatarEmoji?: string;
  modeLabel: string;
  selected: boolean;
  enabled: boolean;
  editLabel: string;
  deleteLabel: string;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  assignedSessionIDs?: string[];
  serverWorking?: boolean;
};

const AssistantListItem: React.FC<AssistantListItemProps> = ({
  assistantID,
  displayName,
  avatarEmoji,
  modeLabel,
  selected,
  enabled,
  editLabel,
  deleteLabel,
  onSelect,
  onEdit,
  onDelete,
  assignedSessionIDs = [],
  serverWorking = false,
}) => {
  const working = useAssistantWorking(assistantID, assignedSessionIDs, serverWorking);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const handleSelect = useEvent(() => onSelect());
  const handleEdit = useEvent(() => {
    setMenuOpen(false);
    onEdit();
  });
  const handleDelete = useEvent(() => {
    setMenuOpen(false);
    onDelete();
  });

  return (
    <ContextMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <ContextMenuTrigger
        render={
          <button
            type="button"
            role="option"
            aria-selected={selected}
            onClick={handleSelect}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenuOpen(true);
            }}
            className={cn(
              'flex w-full min-h-11 items-center gap-3 rounded-xl border px-3 py-3 text-left outline-none transition-[background-color,border-color,opacity] duration-150 ease-out active:bg-interactive-active focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] motion-reduce:transition-none',
              selected
                ? 'border-border/50 bg-[var(--surface-elevated)]'
                : 'border-transparent hover:bg-interactive-hover',
              !enabled && 'opacity-65',
            )}
          />
        }
      >
        <AssistantWorkingAvatar name={assistantID} emoji={avatarEmoji} size={24} label={displayName} working={working} />
        <span className="min-w-0 flex-1">
          <span className="block truncate typography-ui-label font-medium">{displayName}</span>
          <span className="mt-0.5 block truncate typography-micro text-muted-foreground">
            {modeLabel}
          </span>
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[10rem]">
        <ContextMenuItem onClick={handleEdit}>
          <Icon name="edit" className="size-4" />
          {editLabel}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={handleDelete}
          className="text-[var(--status-error)] focus:text-[var(--status-error)] data-[highlighted]:text-[var(--status-error)] [&_svg]:text-[var(--status-error)]"
        >
          <Icon name="delete-bin" className="size-4" />
          {deleteLabel}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

export type AssistantViewProps = {
  /** Dedicated mobile navigation owns whether this mounted detail page is active. */
  activeOverride?: boolean;
  /** When present, mobile renders a second-level conversation header with Back. */
  onMobileBack?: () => void;
};

export const AssistantView: React.FC<AssistantViewProps> = ({ activeOverride, onMobileBack }) => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const mobileActions = useMobileAppActions();
  const transport = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeTransportIdentity, getRuntimeTransportIdentity);
  const mainTabActive = useUIStore((state) => state.activeMainTab === 'assistant');
  const active = activeOverride ?? mainTabActive;
  const mobileFromStore = useUIStore((state) => state.isMobile);
  // Dedicated mobile tabs can be rendered in a desktop-width browser during
  // preview. The app-owned mobile state is authoritative for their layout.
  const isMobileSurface = isMobile || mobileFromStore;
  const capabilityQuery = useAssistantCapabilityQuery();
  const snapshotQuery = useAssistantSnapshotQuery();
  const snapshot = snapshotQuery.data;
  const selectedAssistantID = useAssistantUIStore((state) => state.assistantByTransport[transport] ?? null);
  const selectAssistant = useAssistantUIStore((state) => state.selectAssistant);
  const requestCreate = useAssistantUIStore((state) => state.requestCreate);
  const assistant = snapshot?.assistants.find((item) => item.id === selectedAssistantID) ?? null;
  const selectedWorking = useAssistantWorking(assistant?.id ?? '', assistant?.assignedSessionIDs ?? [], Boolean(assistant?.working));

  React.useEffect(() => { if (!selectedAssistantID && snapshot?.assistants[0]) selectAssistant(snapshot.assistants[0].id); }, [selectAssistant, selectedAssistantID, snapshot?.assistants]);
  React.useEffect(() => { if (snapshotQuery.isSuccess && selectedAssistantID && !assistant) selectAssistant(snapshot?.assistants[0]?.id ?? null); }, [assistant, selectAssistant, selectedAssistantID, snapshot?.assistants, snapshotQuery.isSuccess]);

  const openCreateSettings = useEvent(() => { requestCreate(); if (mobileActions) { mobileActions.openSettings(); return; } const ui = useUIStore.getState(); ui.setSettingsPage('assistants'); ui.setSettingsDialogOpen(true); });
  const openEditSettings = useEvent((assistantID: string) => {
    openAssistantSettings(assistantID, mobileActions ? { openMobileSettings: mobileActions.openSettings } : undefined);
  });
  const [deleteTarget, setDeleteTarget] = React.useState<AssistantDTO | null>(null);
  const requestDeleteAssistant = useEvent((item: AssistantDTO) => {
    setDeleteTarget(item);
  });
  const handleDeleteDialogOpenChange = useEvent((open: boolean) => {
    if (!open) setDeleteTarget(null);
  });
  const returnToChat = useEvent(() => { useUIStore.getState().setActiveMainTab('chat'); });
  const handleMobileBack = useEvent(() => {
    if (onMobileBack) {
      onMobileBack();
      return;
    }
    returnToChat();
  });
  const renderState = (icon: 'cloud-off' | 'error-warning' | 'ai-agent', title: string, description?: string, action?: React.ReactNode) => <div className="relative flex h-full min-h-0 flex-col">{isMobileSurface ? <MobileAssistantConversationHeader assistant={assistant} onBack={handleMobileBack} /> : null}<div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pt-[calc(max(0.25rem,var(--oc-safe-area-top,0px))+var(--oc-mobile-detail-navigation-height,3.5rem))] text-center"><Icon name={icon} className="size-6 text-muted-foreground" /><h1 className="mt-4 typography-ui-header font-semibold">{title}</h1>{description ? <p className="mt-2 max-w-md typography-ui text-muted-foreground">{description}</p> : null}{action ? <div className="mt-5">{action}</div> : null}</div></div>;
  if (capabilityQuery.isPending || snapshotQuery.isPending) return renderState('ai-agent', t('assistants.state.unavailable'));
  if (capabilityQuery.isError || !capabilityQuery.data?.supported || !capabilityQuery.data.enabled || !snapshot?.enabled) return renderState('cloud-off', t('assistants.state.unavailable'));
  if (!snapshot.assistants.length) return renderState('ai-agent', t('assistants.onboarding.title'), t('assistants.onboarding.description'), <Button onClick={openCreateSettings}>{t('assistants.onboarding.action')}</Button>);
  if (!assistant) return renderState('ai-agent', t('assistants.state.unavailable'));
  const presentation = getAssistantPresentation(assistant.name);
  const warning = !assistant.enabled ? t('assistants.state.assistantDisabled') : snapshotQuery.isError ? t('assistants.state.staleSnapshot') : null;
  return (
    <div className="relative flex h-full min-h-0 overflow-hidden bg-background" data-presentation="workspace">
      {isMobileSurface ? null : (
        <section className="flex h-full min-h-0 w-[clamp(16rem,22vw,20rem)] shrink-0 flex-col overflow-hidden">
          <header className="shrink-0 px-4 pb-3 pt-4 sm:px-5">
            <h1 className="truncate typography-ui-label font-semibold text-foreground">{t('assistants.title')}</h1>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 sm:px-4" role="listbox" aria-label={t('assistants.listAria')}>
            <div className="flex flex-col gap-1 border-t border-border/40 pt-3">
              {snapshot.assistants.map((item) => {
                const selected = item.id === selectedAssistantID;
                const itemPresentation = getAssistantPresentation(item.name);
                return (
                  <AssistantListItem
                    key={item.id}
                    assistantID={item.id}
                    displayName={itemPresentation.displayName}
                    avatarEmoji={itemPresentation.avatarEmoji ?? undefined}
                    modeLabel={item.mode === 'stateless' ? t('assistants.mode.stateless') : t('assistants.mode.continuous')}
                    selected={selected}
                    enabled={item.enabled}
                    editLabel={t('assistants.menu.edit')}
                    deleteLabel={t('assistants.settings.delete')}
                    assignedSessionIDs={item.assignedSessionIDs}
                    serverWorking={item.working}
                    onSelect={() => selectAssistant(item.id)}
                    onEdit={() => openEditSettings(item.id)}
                    onDelete={() => requestDeleteAssistant(item)}
                  />
                );
              })}
            </div>
          </div>
        </section>
      )}
      <AssistantDeleteConfirmDialog
        assistant={deleteTarget}
        open={deleteTarget !== null}
        onOpenChange={handleDeleteDialogOpenChange}
      />
      <div className={cn('relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background', !isMobileSurface && 'border-l border-border/60')}>
        {isMobileSurface ? (
          <MobileAssistantConversationHeader assistant={assistant} onBack={handleMobileBack} />
        ) : (
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/40 px-4 sm:px-5">
            <AssistantWorkingAvatar name={assistant.id} emoji={presentation.avatarEmoji} size={24} label={presentation.displayName || assistant.name} working={selectedWorking} />
            <div className="min-w-0 flex-1">
              <div className="truncate typography-ui-label font-medium">{presentation.displayName}</div>
              <div className="mt-0.5 truncate typography-micro leading-none text-muted-foreground/70">
                {t('assistants.conversation.contactHint')}
              </div>
            </div>
          </header>
        )}
        <AssistantConversationSurface
          assistant={assistant}
          warning={warning}
          active={active}
        />
      </div>
    </div>
  );
};
