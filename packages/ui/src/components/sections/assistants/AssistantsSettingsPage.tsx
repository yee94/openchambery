import React from 'react';
import { useEvent } from '@reactuses/core';
import { toast } from 'sonner';
import { publishNativeAssistantCatalog, refreshNativeAssistantCatalog } from '@/apps/MobileShareBridge';
import { AssistantShareWelcome } from '@/components/assistants/AssistantShareWelcome';
import { getAssistantPresentation } from '@/components/assistants/assistantPresentation';
import { AgentAvatar } from '@/components/chat/AgentAvatar';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { SettingsSidebarItem } from '@/components/sections/shared/SettingsSidebarItem';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { SettingsField, SettingsGroup, SettingsRow, SettingsToggleRow } from '@/components/sections/shared/SettingsGroup';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import type { ProjectEntry } from '@/lib/api/types';
import type { GlobalScheduledTask, ScheduledTask, ScheduledTaskStatus } from '@/lib/scheduledTasksApi';
import {
  createAssistant,
  deleteAssistant,
  fetchAssistantCapability,
  setAssistantsEnabled,
  updateAssistant,
  useAssistantCapabilityQuery,
  useAssistantContactMessagesQuery,
  useAssistantScheduledTasksQuery,
  useAssistantSnapshotQuery,
  useGlobalScheduledTasksQuery,
  type AssistantDTO,
  type AssistantDraft,
  type AssistantScheduledTaskEntry,
} from '@/queries/assistantQueries';
import { useAssistantUIStore } from '@/stores/useAssistantUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useScopedProvidersQuery } from '@/queries/agentQueries';

const MANAGED_WORKSPACE_VALUE = '__managed_workspace__';
const LEGACY_WORKSPACE_VALUE = '__current_workspace__';

const DEFAULT_ASSISTANT_NAME = '默认助理';

/** Resolves an initial provider and model for default assistant creation. */
const resolveDefaultAssistantModel = (): { providerID: string; modelID: string } | null => {
  const configState = useConfigStore.getState();
  const settingsDefaultModel = configState.settingsDefaultModel;
  if (settingsDefaultModel) {
    const parsed = parseModelIdentifier(settingsDefaultModel);
    if (parsed?.providerId && parsed?.modelId) {
      return { providerID: parsed.providerId, modelID: parsed.modelId };
    }
  }
  if (configState.currentProviderId && configState.currentModelId) {
    return { providerID: configState.currentProviderId, modelID: configState.currentModelId };
  }
  const providers = configState.providers;
  for (const provider of providers) {
    const models = provider.models;
    if (Array.isArray(models) && models.length > 0) {
      const firstModel = models[0] as { id?: string };
      if (firstModel?.id) {
        return { providerID: provider.id, modelID: firstModel.id };
      }
    }
  }
  return null;
};

const emptyDraft = (defaultName = ''): AssistantDraft => {
  const defaultModel = resolveDefaultAssistantModel();
  return {
    enabled: true,
    name: defaultName,
    defaultPrompt: '',
    workspacePath: null,
    providerID: defaultModel?.providerID ?? '',
    modelID: defaultModel?.modelID ?? '',
  };
};

const draftFromAssistant = (assistant: AssistantDTO): AssistantDraft => ({
  enabled: assistant.enabled,
  name: assistant.name,
  defaultPrompt: assistant.defaultPrompt,
  workspacePath: assistant.workspacePath,
  providerID: assistant.providerID,
  modelID: assistant.modelID,
});

/**
 * Settings UI does not own agent/variant/mode. PATCH must omit them so the
 * server keeps prior values (undefined → retain; null would clear).
 */
const toAssistantSettingsUpdateDraft = (draft: AssistantDraft): AssistantDraft => ({
  enabled: draft.enabled,
  name: draft.name,
  defaultPrompt: draft.defaultPrompt,
  workspacePath: draft.workspacePath,
  providerID: draft.providerID,
  modelID: draft.modelID,
});

const projectName = (project: ProjectEntry): string => (
  project.label?.trim() || project.path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).at(-1) || project.path
);

const scheduleTimes = (task: ScheduledTask): string[] => {
  const raw = Array.isArray(task.schedule.times)
    ? task.schedule.times
    : (task.schedule.time ? [task.schedule.time] : []);
  return Array.from(new Set(raw.filter((value) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(value)))).sort((a, b) => a.localeCompare(b));
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isScheduledTask = (value: unknown): value is ScheduledTask => {
  if (!isRecord(value) || !isRecord(value.schedule) || !isRecord(value.execution) || !isRecord(value.state)) return false;
  const timesValid = value.schedule.times === undefined
    || (Array.isArray(value.schedule.times) && value.schedule.times.every((time) => typeof time === 'string'));
  const weekdaysValid = value.schedule.weekdays === undefined
    || (Array.isArray(value.schedule.weekdays) && value.schedule.weekdays.every((day) => typeof day === 'number'));
  const statusValid = value.state.lastStatus === undefined
    || value.state.lastStatus === 'idle'
    || value.state.lastStatus === 'running'
    || value.state.lastStatus === 'success'
    || value.state.lastStatus === 'error';
  return typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.enabled === 'boolean'
    && (value.schedule.kind === 'daily' || value.schedule.kind === 'weekly' || value.schedule.kind === 'once' || value.schedule.kind === 'cron')
    && timesValid
    && weekdaysValid
    && statusValid
    && typeof value.execution.prompt === 'string'
    && typeof value.execution.providerID === 'string'
    && typeof value.execution.modelID === 'string';
};

const formatScheduledTask = (task: ScheduledTask, t: ReturnType<typeof useI18n>['t']): string => {
  const times = scheduleTimes(task).join(', ') || '—';
  const weekday = (value: number) => {
    if (value === 0) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.sun');
    if (value === 1) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.mon');
    if (value === 2) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.tue');
    if (value === 3) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.wed');
    if (value === 4) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.thu');
    if (value === 5) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.fri');
    if (value === 6) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.sat');
    return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.unknown');
  };
  if (task.schedule.kind === 'daily') {
    return task.schedule.timezone
      ? t('sessions.scheduledTasks.dialog.schedule.dailyWithTimezone', { time: times, timezone: task.schedule.timezone })
      : t('sessions.scheduledTasks.dialog.schedule.daily', { time: times });
  }
  if (task.schedule.kind === 'weekly') {
    const days = (task.schedule.weekdays ?? []).map(weekday).join(', ');
    return task.schedule.timezone
      ? t('sessions.scheduledTasks.dialog.schedule.weeklyWithTimezone', { days, time: times, timezone: task.schedule.timezone })
      : t('sessions.scheduledTasks.dialog.schedule.weekly', { days, time: times });
  }
  if (task.schedule.kind === 'once') {
    const date = task.schedule.date?.trim() || t('sessions.scheduledTasks.dialog.schedule.unknownDate');
    const time = task.schedule.time?.trim() || '—';
    return task.schedule.timezone
      ? t('sessions.scheduledTasks.dialog.schedule.onceWithTimezone', { date, time, timezone: task.schedule.timezone })
      : t('sessions.scheduledTasks.dialog.schedule.once', { date, time });
  }
  return task.schedule.timezone
    ? t('sessions.scheduledTasks.dialog.schedule.cronWithTimezone', { cron: task.schedule.cron ?? '', timezone: task.schedule.timezone })
    : t('sessions.scheduledTasks.dialog.schedule.cron', { cron: task.schedule.cron ?? '' });
};

type ScheduledTaskVisualStatus = ScheduledTaskStatus | 'paused';
const SCHEDULE_STATUS_META: Record<ScheduledTaskVisualStatus, { icon: IconName; className: string }> = {
  paused: { icon: 'pause', className: 'text-muted-foreground' },
  idle: { icon: 'pulse', className: 'text-muted-foreground' },
  running: { icon: 'loader-4', className: 'text-[var(--status-warning)]' },
  success: { icon: 'checkbox-circle', className: 'text-[var(--status-success)]' },
  error: { icon: 'error-warning', className: 'text-[var(--status-error)]' },
};

const scheduledTaskIdentity = (entry: Pick<GlobalScheduledTask, 'projectId' | 'task'>) => `${entry.projectId}:${entry.task.id}`;

const AssistantScheduledTasksGroup: React.FC<{ assistantID: string }> = ({ assistantID }) => {
  const { t } = useI18n();
  const scheduledTasksQuery = useAssistantScheduledTasksQuery(assistantID);
  const fallbackEnabled = scheduledTasksQuery.isError;
  const contactQuery = useAssistantContactMessagesQuery(assistantID, fallbackEnabled);
  const globalTasksQuery = useGlobalScheduledTasksQuery(fallbackEnabled);
  const fallbackIdentities = new Set<string>();
  for (const message of contactQuery.data?.messages ?? []) {
    for (const card of message.cards) {
      if (card.cardType === 'schedule') fallbackIdentities.add(`${card.projectID}:${card.taskID}`);
    }
  }
  const mappedTasks: GlobalScheduledTask[] = (scheduledTasksQuery.data?.tasks ?? []).flatMap((entry: AssistantScheduledTaskEntry) => (
    isScheduledTask(entry.task) ? [{ projectId: entry.projectID, task: entry.task }] : []
  ));
  const hasUnresolvedMappedTask = Boolean(scheduledTasksQuery.data?.tasks.some((entry: AssistantScheduledTaskEntry) => !isScheduledTask(entry.task)));
  const fallbackTasks = (globalTasksQuery.data?.tasks ?? []).filter((entry: GlobalScheduledTask) => fallbackIdentities.has(scheduledTaskIdentity(entry)));
  const tasks = [...(scheduledTasksQuery.data ? mappedTasks : (fallbackEnabled ? fallbackTasks : []))].sort((left, right) => {
    if (left.task.enabled !== right.task.enabled) return left.task.enabled ? -1 : 1;
    return left.task.name.localeCompare(right.task.name);
  });
  const failedFallbackProject = (globalTasksQuery.data?.failedProjectIds ?? []).some((projectID: string) => (
    Array.from(fallbackIdentities).some((identity) => identity.startsWith(`${projectID}:`))
  ));
  const loading = scheduledTasksQuery.isPending
    || (fallbackEnabled && (contactQuery.isPending || globalTasksQuery.isPending));
  const hasLoadError = scheduledTasksQuery.isError
    || contactQuery.isError
    || globalTasksQuery.isError
    || failedFallbackProject
    || hasUnresolvedMappedTask;
  const openScheduledTasks = useEvent(() => {
    useUIStore.getState().setActiveMainTab('schedule');
    useUIStore.getState().setScheduledTasksDialogOpen(true);
  });
  const retry = useEvent(() => {
    void scheduledTasksQuery.refetch();
    if (fallbackEnabled) {
      void contactQuery.refetch();
      void globalTasksQuery.refetch();
    }
  });

  return (
    <SettingsGroup label={t('assistants.settings.scheduledTasks.title')} ariaLabel={t('assistants.settings.scheduledTasks.title')}>
      {loading && tasks.length === 0 ? (
        <SettingsRow label={t('common.loading')}>
          <Icon name="loader-4" className="size-4 animate-spin text-muted-foreground" />
        </SettingsRow>
      ) : null}
      {tasks.map((entry) => {
        const status: ScheduledTaskVisualStatus = entry.task.enabled ? (entry.task.state?.lastStatus ?? 'idle') : 'paused';
        const statusMeta = SCHEDULE_STATUS_META[status];
        const statusLabel = status === 'paused'
          ? t('sessions.scheduledTasks.dialog.taskToggle.paused')
          : status === 'running'
            ? t('sessions.scheduledTasks.dialog.status.running')
            : status === 'success'
              ? t('sessions.scheduledTasks.dialog.status.success')
              : status === 'error'
                ? t('sessions.scheduledTasks.dialog.status.error')
                : t('sessions.scheduledTasks.dialog.status.idle');
        return (
          <SettingsRow
            key={scheduledTaskIdentity(entry)}
            className="group relative cursor-pointer transition-colors hover:bg-interactive-hover"
            label={(
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-muted)] text-muted-foreground">
                  <Icon name="calendar" className="size-3.5" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate typography-ui-label font-medium text-foreground">{entry.task.name}</span>
                  <span className="mt-0.5 block typography-micro truncate text-muted-foreground">{formatScheduledTask(entry.task, t)}</span>
                </span>
              </span>
            )}
            controlClassName="min-w-fit"
          >
            <span className="flex items-center gap-2 text-muted-foreground">
              <span className={`inline-flex items-center gap-1.5 typography-micro ${statusMeta.className}`}>
                <Icon name={statusMeta.icon} className={`size-3.5 ${status === 'running' ? 'animate-spin' : ''}`} />
                {statusLabel}
              </span>
              <Icon name="arrow-right-s" className="size-4" />
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute inset-0 z-10 h-auto w-auto rounded-none bg-transparent p-0 hover:bg-transparent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
              onClick={openScheduledTasks}
              aria-label={t('assistants.settings.scheduledTasks.open', { name: entry.task.name })}
            >
              <span className="sr-only">{t('assistants.settings.scheduledTasks.open', { name: entry.task.name })}</span>
            </Button>
          </SettingsRow>
        );
      })}
      {hasLoadError ? (
        <SettingsRow label={t('assistants.settings.scheduledTasks.loadError')}>
          <Button variant="outline" size="sm" onClick={retry}>{t('assistants.actions.retry')}</Button>
        </SettingsRow>
      ) : null}
      {!loading && !hasLoadError && tasks.length === 0 ? (
        <SettingsRow label={t('assistants.settings.scheduledTasks.empty')}>
          <Icon name="calendar" className="size-4 text-muted-foreground" />
        </SettingsRow>
      ) : null}
    </SettingsGroup>
  );
};

const WorkspaceOption = ({ name, path, icon = 'folder' }: { name: string; path?: string; icon?: 'folder' | 'cloud' | 'history' }) => (
  <span className="flex min-w-0 items-center gap-2">
    <Icon name={icon} className="size-4 shrink-0 text-muted-foreground" />
    <span className={path ? 'max-w-[40%] shrink-0 truncate typography-ui-label text-foreground' : 'min-w-0 truncate typography-ui-label text-foreground'}>{name}</span>
    {path ? <span className="min-w-0 flex-1 truncate typography-micro text-muted-foreground" title={path}>{path}</span> : null}
  </span>
);

export const AssistantsSettingsSidebar: React.FC<{ onItemSelect?: () => void }> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const snapshotQuery = useAssistantSnapshotQuery();
  const capabilityQuery = useAssistantCapabilityQuery();
  const snapshot = snapshotQuery.data;
  const selectedID = useAssistantUIStore((state) => state.settingsSelectedAssistantID);
  const selectSettingsAssistant = useAssistantUIStore((state) => state.selectSettingsAssistant);
  const requestCreate = useAssistantUIStore((state) => state.requestCreate);
  const [welcomeOpen, setWelcomeOpen] = React.useState(false);

  React.useEffect(() => {
    // The desktop split view always needs a detail selection. Mobile passes
    // onItemSelect and must stay on the list until the user opens an item.
    if (!onItemSelect && selectedID === null && snapshot?.assistants[0]) {
      selectSettingsAssistant(snapshot.assistants[0].id);
    }
  }, [onItemSelect, selectSettingsAssistant, selectedID, snapshot?.assistants]);

  React.useEffect(() => {
    if (snapshotQuery.isSuccess && selectedID && selectedID !== 'new' && !snapshot?.assistants.some((assistant) => assistant.id === selectedID)) {
      selectSettingsAssistant(onItemSelect ? null : (snapshot?.assistants[0]?.id ?? null));
    }
  }, [onItemSelect, selectSettingsAssistant, selectedID, snapshot?.assistants, snapshotQuery.isSuccess]);

  const startCreate = useEvent(() => {
    requestCreate();
    onItemSelect?.();
  });

  const toggleEnabled = useEvent(async (enabled: boolean) => {
    if (!snapshot) return;
    try {
      await setAssistantsEnabled(enabled, snapshot.revision);
      // When enabling with an empty catalog, seed the default assistant so the user
      // immediately has an active contact ready without manual onboarding.
      if (enabled && snapshot.assistants.length === 0) {
        const defaultModel = resolveDefaultAssistantModel();
        if (defaultModel) {
          const created = await createAssistant({
            enabled: true,
            name: DEFAULT_ASSISTANT_NAME,
            defaultPrompt: '',
            workspacePath: null,
            providerID: defaultModel.providerID,
            modelID: defaultModel.modelID,
          });
          selectSettingsAssistant(created.id);
        }
      }
    } catch {
      toast.error(t('assistants.settings.toast.toggleFailed'));
    }
  });

  if (capabilityQuery.isSuccess && !capabilityQuery.data.supported) return null;

  return (
    <SettingsSidebarLayout
      variant="background"
      header={
        <>
          <SettingsGroup
            description={(
              <>
                {t('assistants.settings.description')}
                <a
                  href="#assistant-share-welcome"
                  className="underline underline-offset-2"
                  onClick={(event) => {
                    event.preventDefault();
                    setWelcomeOpen(true);
                  }}
                >
                  {t('assistants.settings.descriptionLearnMore')}
                </a>
              </>
            )}
          >
            <SettingsToggleRow
              itemId="assistants.instance-enabled"
              checked={snapshot?.enabled ?? false}
              onChange={toggleEnabled}
              label={t('assistants.settings.instanceEnabled')}
              ariaLabel={t('assistants.settings.instanceEnabled')}
            />
          </SettingsGroup>
          <AssistantShareWelcome open={welcomeOpen} onOpenChange={setWelcomeOpen} />
        </>
      }
    >
      <SettingsGroup
        label={(
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 truncate">{t('assistants.settings.listTitle')}</span>
            <Button
              data-settings-item="assistants.create"
              variant="ghost"
              size="icon"
              onClick={startCreate}
              aria-label={t('assistants.settings.create')}
            >
              <Icon name="add" className="size-4" />
            </Button>
          </div>
        )}
      >
        {snapshotQuery.isPending || capabilityQuery.isPending ? (
          <div className="oc-settings-group-row flex items-center justify-center text-muted-foreground"><Icon name="loader-4" className="mr-2 size-4 animate-spin" />{t('common.loading')}</div>
        ) : snapshot?.assistants.length ? snapshot.assistants.map((assistant) => {
          const presentation = getAssistantPresentation(assistant.name);
          return (
            <SettingsSidebarItem
              key={assistant.id}
              title={presentation.displayName}
              selected={selectedID === assistant.id}
              onSelect={() => {
                selectSettingsAssistant(assistant.id);
                onItemSelect?.();
              }}
              icon={<AgentAvatar name={assistant.id} emoji={presentation.avatarEmoji} size={24} label={presentation.displayName || assistant.name} shape="circle" />}
            />
          );
        }) : (
          <div className="oc-settings-group-row text-muted-foreground">
            {t('assistants.settings.empty')}
          </div>
        )}
      </SettingsGroup>
    </SettingsSidebarLayout>
  );
};

interface AssistantsSettingsPageProps {
  onItemDeleted?: () => void;
  /** Route-owned selection for a detail opened above an Assistant conversation. */
  assistantID?: string;
}

export const AssistantsSettingsPage: React.FC<AssistantsSettingsPageProps> = ({ onItemDeleted, assistantID }) => {
  const { t } = useI18n();
  const snapshotQuery = useAssistantSnapshotQuery();
  const capabilityQuery = useAssistantCapabilityQuery();
  const snapshot = snapshotQuery.data;
  const projects = useProjectsStore((state) => state.projects);
  const selectedID = useAssistantUIStore((state) => assistantID ?? state.settingsSelectedAssistantID);
  const selectSettingsAssistant = useAssistantUIStore((state) => state.selectSettingsAssistant);
  const defaultShareAssistant = useAssistantUIStore((state) => state.defaultShareAssistant);
  const setDefaultShareAssistant = useAssistantUIStore((state) => state.setDefaultShareAssistant);
  const createRequestRevision = useAssistantUIStore((state) => state.createRequestRevision);
  const requestCreate = useAssistantUIStore((state) => state.requestCreate);
  const [draft, setDraft] = React.useState<AssistantDraft>(emptyDraft);
  const [saving, setSaving] = React.useState(false);
  const handledCreateRequestRef = React.useRef(0);
  const selected = snapshot?.assistants.find((assistant) => assistant.id === selectedID) ?? null;
  const selectedPresentation = selected ? getAssistantPresentation(selected.name) : null;
  const draftPresentation = getAssistantPresentation(draft.name);
  const catalogDirectory = draft.workspacePath ?? selected?.managedWorkspacePath ?? null;
  const providersQuery = useScopedProvidersQuery(catalogDirectory, { enabled: true });
  const catalogProviders = providersQuery.data ?? [];

  React.useEffect(() => {
    if (selected) setDraft(draftFromAssistant(selected));
  }, [selected]);

  React.useEffect(() => {
    if (assistantID === undefined && snapshotQuery.isSuccess && selectedID && selectedID !== 'new' && !selected) {
      selectSettingsAssistant(null);
    }
  }, [assistantID, selectSettingsAssistant, selected, selectedID, snapshotQuery.isSuccess]);

  React.useEffect(() => {
    if (selectedID !== 'new' || createRequestRevision <= handledCreateRequestRef.current) return;
    handledCreateRequestRef.current = createRequestRevision;
    setDraft(emptyDraft(!snapshot?.assistants.length ? DEFAULT_ASSISTANT_NAME : ''));
    window.requestAnimationFrame(() => document.getElementById('assistant-name')?.focus());
  }, [createRequestRevision, selectedID, snapshot?.assistants.length]);

  React.useEffect(() => {
    if (snapshotQuery.isSuccess && capabilityQuery.data?.serverInstanceID && defaultShareAssistant?.serverInstanceID === capabilityQuery.data.serverInstanceID
      && !snapshot?.assistants.some((assistant) => assistant.id === defaultShareAssistant.assistantID)) {
      setDefaultShareAssistant(null);
    }
  }, [capabilityQuery.data, defaultShareAssistant, setDefaultShareAssistant, snapshot?.assistants, snapshotQuery.isSuccess]);

  React.useEffect(() => {
    if (snapshotQuery.isSuccess) void refreshNativeAssistantCatalog();
  }, [snapshot?.revision, snapshotQuery.isSuccess]);

  const patchDraft = <K extends keyof AssistantDraft>(key: K, value: AssistantDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const startCreate = useEvent(() => requestCreate());

  const save = useEvent(async () => {
    if (assistantID !== undefined && !selected) return;
    if (!draft.name.trim() || !draft.providerID || !draft.modelID) {
      toast.error(t('assistants.settings.validation.required'));
      return;
    }
    setSaving(true);
    try {
      const result = selected
        ? await updateAssistant(selected, toAssistantSettingsUpdateDraft(draft))
        : await createAssistant(draft);
      if (assistantID === undefined) selectSettingsAssistant(result.id);
      toast.success(t('assistants.settings.toast.saved'));
    } catch {
      toast.error(t('assistants.settings.toast.saveFailed'));
    } finally {
      setSaving(false);
    }
  });

  const remove = useEvent(async () => {
    if (!selected || !window.confirm(t('assistants.settings.deleteConfirm', { name: selected.name }))) return;
    setSaving(true);
    try {
      await deleteAssistant(selected);
      if (defaultShareAssistant?.assistantID === selected.id) {
        const capability = await fetchAssistantCapability();
        if (capability.serverInstanceID && defaultShareAssistant.serverInstanceID === capability.serverInstanceID) setDefaultShareAssistant(null);
      }
      if (assistantID === undefined) selectSettingsAssistant(null);
      onItemDeleted?.();
      toast.success(t('assistants.settings.toast.deleted'));
    } catch {
      toast.error(t('assistants.settings.toast.deleteFailed'));
    } finally {
      setSaving(false);
    }
  });

  const toggleDefaultShare = useEvent(async (assistantID: string, enabled: boolean) => {
    if (!enabled) {
      setDefaultShareAssistant(null);
      void publishNativeAssistantCatalog();
      return;
    }
    try {
      const capability = await fetchAssistantCapability();
      if (!capability.supported || !capability.serverInstanceID) return;
      setDefaultShareAssistant({ serverInstanceID: capability.serverInstanceID, assistantID });
      await publishNativeAssistantCatalog();
    } catch {
      toast.error(t('assistants.settings.toast.toggleFailed'));
    }
  });

  const selectedProject = draft.workspacePath === null ? null : projects.find((project) => project.path === draft.workspacePath) ?? null;
  const legacyWorkspacePath = draft.workspacePath !== null && !selectedProject ? draft.workspacePath : null;
  const workspaceValue = draft.workspacePath === null
    ? MANAGED_WORKSPACE_VALUE
    : selectedProject
      ? selectedProject.id
      : LEGACY_WORKSPACE_VALUE;
  const workspaceLabel = draft.workspacePath === null
    ? <WorkspaceOption name={t('assistants.settings.workspacePlaceholder')} icon="cloud" />
    : selectedProject
      ? <WorkspaceOption name={projectName(selectedProject)} path={selectedProject.path} />
      : <WorkspaceOption name={t('assistants.settings.workspaceCurrentPath')} path={legacyWorkspacePath ?? ''} icon="history" />;

  if (capabilityQuery.isSuccess && !capabilityQuery.data.supported) return null;

  if (snapshotQuery.isPending || capabilityQuery.isPending) {
    return <div className="flex h-full items-center justify-center text-muted-foreground"><Icon name="loader-4" className="mr-2 size-4 animate-spin" />{t('common.loading')}</div>;
  }

  if ((snapshotQuery.isError && !snapshot) || (assistantID !== undefined && !selected)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Icon name="cloud-off" className="size-6 text-muted-foreground" />
        <p className="typography-ui text-muted-foreground">{t('assistants.state.unavailable')}</p>
        <Button variant="outline" size="sm" onClick={() => void snapshotQuery.refetch()}>{t('assistants.actions.retry')}</Button>
      </div>
    );
  }

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="oc-settings-page-content mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">
        {snapshotQuery.isError && snapshot ? <p className="mb-4 px-2 typography-meta text-[var(--status-warning)]">{t('assistants.state.staleSnapshot')}</p> : null}

        {selectedID ? (
          <>
            <div className="mb-4 flex items-center gap-3">
              <AgentAvatar name={selected?.id ?? 'new'} emoji={draftPresentation.avatarEmoji} size={38} label={draftPresentation.displayName || draft.name || t('assistants.settings.create')} shape="circle" />
              <div className="min-w-0 flex-1">
                <h2 className="truncate typography-ui-header font-semibold text-foreground">{selected ? selectedPresentation?.displayName : t('assistants.settings.create')}</h2>
                {draft.providerID && draft.modelID ? (
                  <p className="mt-0.5 typography-micro leading-none text-muted-foreground/70">{`${draft.providerID}/${draft.modelID}`}</p>
                ) : null}
              </div>
              {selected ? <Button variant="ghost" size="sm" onClick={remove} disabled={saving} className="text-[var(--status-error)]"><Icon name="delete-bin" className="size-4" />{t('assistants.settings.delete')}</Button> : null}
            </div>

            <SettingsGroup>
                <SettingsRow itemId="assistants.name" label={t('assistants.settings.name')}>
                  <Input id="assistant-name" value={draft.name} onChange={(event) => patchDraft('name', event.target.value)} className="min-w-0 flex-1" />
                </SettingsRow>
                <SettingsRow label={t('assistants.settings.enabled')}>
                  <Checkbox checked={draft.enabled} onChange={(value) => patchDraft('enabled', value)} ariaLabel={t('assistants.settings.enabled')} />
                </SettingsRow>
                {selected ? (
                  <SettingsRow itemId="assistants.default-share" label={t('assistants.settings.defaultShare')}>
                    <Checkbox checked={defaultShareAssistant?.assistantID === selected.id && defaultShareAssistant.serverInstanceID === capabilityQuery.data?.serverInstanceID} onChange={(value) => void toggleDefaultShare(selected.id, value)} ariaLabel={t('assistants.settings.defaultShare')} />
                  </SettingsRow>
                ) : null}
            </SettingsGroup>

            <SettingsField
              itemId="assistants.prompt"
              label={t('assistants.settings.defaultPrompt')}
              className="oc-settings-split-row-stacked"
            >
              <Textarea
                embedded
                id="assistant-prompt"
                value={draft.defaultPrompt}
                onChange={(event) => patchDraft('defaultPrompt', event.target.value)}
                placeholder={t('assistants.settings.defaultPromptPlaceholder')}
                rows={12}
                outerClassName="min-h-[240px] max-h-[70vh]"
              />
            </SettingsField>

            <SettingsGroup
              label={t('assistants.settings.runtime')}
            >
                <SettingsRow itemId="assistants.model" label={t('assistants.settings.model')}>
                  <ModelSelector providerId={draft.providerID} modelId={draft.modelID} providers={catalogProviders} onChange={(providerID, modelID) => setDraft((current) => ({ ...current, providerID, modelID }))} className="oc-settings-inline-value" />
                </SettingsRow>
            </SettingsGroup>

            <SettingsField
              itemId="assistants.workspace"
              label={t('assistants.settings.workspace')}
              description={t('assistants.settings.workspaceChangeHint')}
              descriptionPlacement="outside"
            >
                <Select value={workspaceValue} onValueChange={(value) => {
                  if (value === MANAGED_WORKSPACE_VALUE) {
                    patchDraft('workspacePath', null);
                    return;
                  }
                  const project = projects.find((candidate) => candidate.id === value);
                  if (project) patchDraft('workspacePath', project.path);
                }}>
                  <SelectTrigger title={draft.workspacePath ?? t('assistants.settings.workspacePlaceholder')} className="w-full max-w-xl [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:flex-1 [&_[data-slot=select-value]]:overflow-hidden">
                    <SelectValue>{workspaceLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectContent align="start" className="w-[min(32rem,calc(100vw-2rem))]">
                    <SelectItem value={MANAGED_WORKSPACE_VALUE}><WorkspaceOption name={t('assistants.settings.workspacePlaceholder')} icon="cloud" /></SelectItem>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}><WorkspaceOption name={projectName(project)} path={project.path} /></SelectItem>
                    ))}
                    {legacyWorkspacePath ? (
                      <SelectItem value={LEGACY_WORKSPACE_VALUE} disabled><WorkspaceOption name={t('assistants.settings.workspaceCurrentPath')} path={legacyWorkspacePath} icon="history" /></SelectItem>
                    ) : null}
                  </SelectContent>
                </Select>
            </SettingsField>

            {selected ? <AssistantScheduledTasksGroup assistantID={selected.id} /> : null}

            <div className="flex justify-end">
              <Button onClick={save} disabled={saving}>{saving ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}{t('assistants.settings.save')}</Button>
            </div>
          </>
        ) : (
          <div className="flex min-h-80 flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
            <AgentAvatar name="assistants-empty" size={44} shape="circle" />
            <p className="typography-ui">{t('assistants.settings.empty')}</p>
            <Button data-settings-item="assistants.create" size="sm" onClick={startCreate}><Icon name="add" className="size-4" />{t('assistants.settings.create')}</Button>
          </div>
        )}
      </div>
    </ScrollableOverlay>
  );
};
