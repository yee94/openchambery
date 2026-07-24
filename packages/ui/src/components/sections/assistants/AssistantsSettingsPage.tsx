import React from 'react';
import { useEvent } from '@reactuses/core';
import { toast } from 'sonner';
import { publishNativeAssistantCatalog, refreshNativeAssistantCatalog } from '@/apps/MobileShareBridge';
import { AssistantShareWelcome } from '@/components/assistants/AssistantShareWelcome';
import { getAssistantPresentation } from '@/components/assistants/assistantPresentation';
import { AgentAvatar } from '@/components/chat/AgentAvatar';
import { Icon } from '@/components/icon/Icon';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { SettingsSidebarItem } from '@/components/sections/shared/SettingsSidebarItem';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { SettingsField, SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import type { ProjectEntry } from '@/lib/api/types';
import {
  createAssistant,
  deleteAssistant,
  fetchAssistantCapability,
  setAssistantsEnabled,
  updateAssistant,
  useAssistantCapabilityQuery,
  useAssistantSnapshotQuery,
  type AssistantDTO,
  type AssistantDraft,
} from '@/queries/assistantQueries';
import { useAssistantUIStore } from '@/stores/useAssistantUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useScopedAgentsQuery, useScopedProvidersQuery } from '@/queries/agentQueries';

const MANAGED_WORKSPACE_VALUE = '__managed_workspace__';
const LEGACY_WORKSPACE_VALUE = '__current_workspace__';

const emptyDraft = (): AssistantDraft => ({
  enabled: true,
  name: '',
  defaultPrompt: '',
  workspacePath: null,
  providerID: '',
  modelID: '',
  agent: null,
  mode: 'continuous',
});

const draftFromAssistant = (assistant: AssistantDTO): AssistantDraft => ({
  enabled: assistant.enabled,
  name: assistant.name,
  defaultPrompt: assistant.defaultPrompt,
  workspacePath: assistant.workspacePath,
  providerID: assistant.providerID,
  modelID: assistant.modelID,
  agent: assistant.agent,
  mode: assistant.mode,
});

const projectName = (project: ProjectEntry): string => (
  project.label?.trim() || project.path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).at(-1) || project.path
);

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
    } catch {
      toast.error(t('assistants.settings.toast.toggleFailed'));
    }
  });

  if (capabilityQuery.isSuccess && !capabilityQuery.data.supported) return null;

  return (
    <SettingsSidebarLayout
      variant="background"
      header={
        <div className="border-b px-3 pb-3 pt-4">
          <div className="mb-1 flex items-center justify-between gap-3">
            <h2 className="min-w-0 truncate text-base font-semibold text-foreground">{t('settings.page.assistants.title')}</h2>
            <label data-settings-item="assistants.instance-enabled" className="flex shrink-0 cursor-pointer items-center gap-1.5">
              <Checkbox checked={snapshot?.enabled ?? false} onChange={toggleEnabled} ariaLabel={t('assistants.settings.instanceEnabled')} />
              <span className="typography-meta text-foreground">{t('assistants.settings.instanceEnabled')}</span>
            </label>
          </div>
          <p className="mb-3 break-all typography-meta text-muted-foreground">
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
          </p>
          <AssistantShareWelcome open={welcomeOpen} onOpenChange={setWelcomeOpen} />
          <div className="flex items-center justify-between gap-2">
            <span className="typography-meta text-muted-foreground">{t('assistants.settings.listTitle')}</span>
            <Button data-settings-item="assistants.create" variant="ghost" size="icon" className="-my-1 size-7 text-muted-foreground" onClick={startCreate} aria-label={t('assistants.settings.create')}>
              <Icon name="add" className="size-4" />
            </Button>
          </div>
        </div>
      }
    >
      {snapshotQuery.isPending || capabilityQuery.isPending ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground"><Icon name="loader-4" className="mr-2 size-4 animate-spin" />{t('common.loading')}</div>
      ) : snapshot?.assistants.map((assistant) => {
        const presentation = getAssistantPresentation(assistant.name);
        return (
          <SettingsSidebarItem
            key={assistant.id}
            title={presentation.displayName}
            selected={selectedID === assistant.id}
            className="min-h-11 px-2.5 py-2"
            onSelect={() => {
              selectSettingsAssistant(assistant.id);
              onItemSelect?.();
            }}
            icon={<AgentAvatar name={assistant.id} emoji={presentation.avatarEmoji} size={24} label={presentation.displayName || assistant.name} />}
          />
        );
      })}
    </SettingsSidebarLayout>
  );
};

interface AssistantsSettingsPageProps {
  onItemDeleted?: () => void;
}

export const AssistantsSettingsPage: React.FC<AssistantsSettingsPageProps> = ({ onItemDeleted }) => {
  const { t } = useI18n();
  const snapshotQuery = useAssistantSnapshotQuery();
  const capabilityQuery = useAssistantCapabilityQuery();
  const snapshot = snapshotQuery.data;
  const projects = useProjectsStore((state) => state.projects);
  const selectedID = useAssistantUIStore((state) => state.settingsSelectedAssistantID);
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
  const agentsQuery = useScopedAgentsQuery(catalogDirectory, { enabled: true });
  const catalogProviders = providersQuery.data ?? [];
  const catalogAgents = agentsQuery.data ?? [];

  React.useEffect(() => {
    if (selected) setDraft(draftFromAssistant(selected));
  }, [selected]);

  React.useEffect(() => {
    if (snapshotQuery.isSuccess && selectedID && selectedID !== 'new' && !selected) {
      selectSettingsAssistant(null);
    }
  }, [selectSettingsAssistant, selected, selectedID, snapshotQuery.isSuccess]);

  React.useEffect(() => {
    if (selectedID !== 'new' || createRequestRevision <= handledCreateRequestRef.current) return;
    handledCreateRequestRef.current = createRequestRevision;
    setDraft(emptyDraft());
    window.requestAnimationFrame(() => document.getElementById('assistant-name')?.focus());
  }, [createRequestRevision, selectedID]);

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
    if (!draft.name.trim() || !draft.providerID || !draft.modelID) {
      toast.error(t('assistants.settings.validation.required'));
      return;
    }
    setSaving(true);
    try {
      const result = selected ? await updateAssistant(selected, draft) : await createAssistant(draft);
      selectSettingsAssistant(result.id);
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
      selectSettingsAssistant(null);
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

  if (snapshotQuery.isError && !snapshot) {
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
              <AgentAvatar name={selected?.id ?? 'new'} emoji={draftPresentation.avatarEmoji} size={38} label={draftPresentation.displayName || draft.name || t('assistants.settings.create')} />
              <div className="min-w-0 flex-1">
                <h2 className="truncate typography-ui-header font-semibold text-foreground">{selected ? selectedPresentation?.displayName : t('assistants.settings.create')}</h2>
                <p className="mt-0.5 typography-micro leading-none text-muted-foreground/70">{draft.mode === 'continuous' ? t('assistants.mode.continuous') : t('assistants.mode.stateless')}</p>
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
              <Textarea id="assistant-prompt" value={draft.defaultPrompt} onChange={(event) => patchDraft('defaultPrompt', event.target.value)} placeholder={t('assistants.settings.defaultPromptPlaceholder')} />
            </SettingsField>

            <SettingsGroup
              label={t('assistants.settings.runtime')}
            >
                <SettingsRow itemId="assistants.model" label={t('assistants.settings.model')}>
                  <ModelSelector providerId={draft.providerID} modelId={draft.modelID} providers={catalogProviders} onChange={(providerID, modelID) => setDraft((current) => ({ ...current, providerID, modelID }))} className="oc-settings-inline-value" />
                </SettingsRow>
                <SettingsRow itemId="assistants.agent" label={t('assistants.settings.agent')}>
                  <AgentSelector agentName={draft.agent ?? ''} agents={catalogAgents} onChange={(agent) => patchDraft('agent', agent || null)} className="oc-settings-inline-value" />
                </SettingsRow>
                <SettingsRow
                  itemId="assistants.mode"
                  label={t('assistants.settings.mode')}
                  description={draft.mode === 'stateless' ? t('assistants.conversation.statelessHint') : t('assistants.conversation.continuousHint')}
                >
                  <div className="flex min-w-0 flex-wrap justify-end gap-2">
                    <div className="flex flex-wrap gap-2">
                      {(['continuous', 'stateless'] as const).map((mode) => (
                        <Button key={mode} variant="chip" size="xs" aria-pressed={draft.mode === mode} onClick={() => patchDraft('mode', mode)}>{mode === 'continuous' ? t('assistants.mode.continuous') : t('assistants.mode.stateless')}</Button>
                      ))}
                    </div>
                  </div>
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

            <div className="flex justify-end">
              <Button onClick={save} disabled={saving}>{saving ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}{t('assistants.settings.save')}</Button>
            </div>
          </>
        ) : (
          <div className="flex min-h-80 flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
            <AgentAvatar name="assistants-empty" size={44} />
            <p className="typography-ui">{t('assistants.settings.empty')}</p>
            <Button data-settings-item="assistants.create" size="sm" onClick={startCreate}><Icon name="add" className="size-4" />{t('assistants.settings.create')}</Button>
          </div>
        )}
      </div>
    </ScrollableOverlay>
  );
};
