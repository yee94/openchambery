import React from 'react';
import { useEvent } from '@reactuses/core';
import { toast } from 'sonner';
import { AgentAvatar } from '@/components/chat/AgentAvatar';
import { Icon } from '@/components/icon/Icon';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  createAssistant,
  deleteAssistant,
  setAssistantsEnabled,
  updateAssistant,
  useAssistantSnapshotQuery,
  type AssistantDTO,
  type AssistantDraft,
  fetchAssistantCapability,
  useAssistantCapabilityQuery,
} from '@/queries/assistantQueries';
import { useAssistantUIStore } from '@/stores/useAssistantUIStore';
import { publishNativeAssistantCatalog, refreshNativeAssistantCatalog } from '@/apps/MobileShareBridge';

const emptyDraft = (): AssistantDraft => ({
  enabled: true,
  name: '',
  defaultPrompt: '',
  workspacePath: null,
  skillRoots: [],
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
  skillRoots: assistant.skillRoots,
  providerID: assistant.providerID,
  modelID: assistant.modelID,
  agent: assistant.agent,
  mode: assistant.mode,
});

export const AssistantsSettingsPage: React.FC = () => {
  const { t } = useI18n();
  const snapshotQuery = useAssistantSnapshotQuery();
  const capabilityQuery = useAssistantCapabilityQuery();
  const snapshot = snapshotQuery.data;
  const defaultShareAssistant = useAssistantUIStore((state) => state.defaultShareAssistant);
  const setDefaultShareAssistant = useAssistantUIStore((state) => state.setDefaultShareAssistant);
  const [selectedID, setSelectedID] = React.useState<string | 'new' | null>(null);
  const [draft, setDraft] = React.useState<AssistantDraft>(emptyDraft);
  const [skillRootInput, setSkillRootInput] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  const selected = snapshot?.assistants.find((assistant) => assistant.id === selectedID) ?? null;

  React.useEffect(() => {
    if (selected) setDraft(draftFromAssistant(selected));
  }, [selected]);

  React.useEffect(() => {
    if (selectedID === null && snapshot?.assistants[0]) setSelectedID(snapshot.assistants[0].id);
  }, [selectedID, snapshot?.assistants]);

  React.useEffect(() => {
    if (snapshotQuery.isSuccess && selectedID && selectedID !== 'new' && !selected) {
      setSelectedID(snapshot?.assistants[0]?.id ?? null);
    }
  }, [selected, selectedID, snapshot?.assistants, snapshotQuery.isSuccess]);

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

  const startCreate = useEvent(() => {
    setSelectedID('new');
    setDraft(emptyDraft());
    setSkillRootInput('');
  });

  const save = useEvent(async () => {
    if (!draft.name.trim() || !draft.providerID || !draft.modelID) {
      toast.error(t('assistants.settings.validation.required'));
      return;
    }
    setSaving(true);
    try {
      const result = selected ? await updateAssistant(selected, draft) : await createAssistant(draft);
      setSelectedID(result.id);
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
      setSelectedID(null);
      toast.success(t('assistants.settings.toast.deleted'));
    } catch {
      toast.error(t('assistants.settings.toast.deleteFailed'));
    } finally {
      setSaving(false);
    }
  });

  const toggleInstance = useEvent(async (enabled: boolean) => {
    if (!snapshot) return;
    try {
      await setAssistantsEnabled(enabled, snapshot.revision);
    } catch {
      toast.error(t('assistants.settings.toast.toggleFailed'));
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

  const addSkillRoot = useEvent(() => {
    const root = skillRootInput.trim();
    if (!root || draft.skillRoots.includes(root)) return;
    patchDraft('skillRoots', [...draft.skillRoots, root]);
    setSkillRootInput('');
  });

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
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="typography-ui-header font-semibold text-foreground">{t('settings.page.assistants.title')}</h1>
            <p className="mt-1 typography-ui text-muted-foreground">{t('assistants.settings.description')}</p>
          </div>
          <label data-settings-item="assistants.instance-enabled" className="flex cursor-pointer items-center gap-2 py-1.5">
            <Checkbox checked={snapshot?.enabled ?? false} onChange={toggleInstance} ariaLabel={t('assistants.settings.instanceEnabled')} />
            <span className="typography-ui-label">{t('assistants.settings.instanceEnabled')}</span>
          </label>
        </div>
        {snapshotQuery.isError && snapshot ? <p className="mt-3 typography-meta text-[var(--status-warning)]">{t('assistants.state.staleSnapshot')}</p> : null}
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden md:grid-cols-[240px_minmax(0,1fr)] md:grid-rows-1">
        <aside className="flex max-h-36 min-h-0 flex-col border-b border-border bg-sidebar md:max-h-none md:border-b-0 md:border-r">
          <div className="flex items-center justify-between px-3 py-3">
            <span className="typography-ui-label font-medium">{t('assistants.settings.listTitle')}</span>
            <Button data-settings-item="assistants.create" variant="ghost" size="icon" onClick={startCreate} aria-label={t('assistants.settings.create')}>
              <Icon name="add" className="size-4" />
            </Button>
          </div>
          <div className="flex min-h-0 gap-1 overflow-x-auto px-2 pb-2 md:flex-1 md:flex-col md:overflow-y-auto md:overflow-x-hidden">
            {snapshot?.assistants.map((assistant) => (
              <button
                key={assistant.id}
                type="button"
                onClick={() => setSelectedID(assistant.id)}
                className={cn('flex min-w-44 items-center gap-2 rounded-md px-2 py-2 text-left transition-colors md:min-w-0', selectedID === assistant.id ? 'bg-interactive-selection text-interactive-selection-foreground' : 'hover:bg-interactive-hover')}
              >
                <AgentAvatar name={assistant.id} size={24} label={assistant.name} />
                <span className="min-w-0 flex-1 truncate typography-ui-label">{assistant.name}</span>
                {!assistant.enabled ? <span className="size-1.5 rounded-full bg-[var(--status-warning)]" /> : null}
              </button>
            ))}
          </div>
        </aside>

        <main className="min-h-0 overflow-y-auto">
          {selectedID ? (
            <div className="mx-auto max-w-3xl space-y-7 px-5 py-6">
              <div className="flex items-center gap-3">
                <AgentAvatar name={selected?.id ?? 'new'} size={38} label={draft.name || t('assistants.settings.create')} />
                <div className="min-w-0 flex-1">
                  <h2 className="typography-ui-header font-medium text-foreground">{selected ? selected.name : t('assistants.settings.create')}</h2>
                  <p className="typography-meta text-muted-foreground">{draft.mode === 'continuous' ? t('assistants.mode.continuous') : t('assistants.mode.stateless')}</p>
                </div>
                {selected ? <Button variant="ghost" size="sm" onClick={remove} disabled={saving} className="text-[var(--status-error)]"><Icon name="delete-bin" className="size-4" />{t('assistants.settings.delete')}</Button> : null}
              </div>

              <section className="space-y-3">
                <div data-settings-item="assistants.name" className="grid gap-2 md:grid-cols-[11rem_minmax(0,1fr)] md:items-center">
                  <label htmlFor="assistant-name" className="typography-ui-label text-foreground">{t('assistants.settings.name')}</label>
                  <Input id="assistant-name" value={draft.name} onChange={(event) => patchDraft('name', event.target.value)} />
                </div>
                <label className="flex cursor-pointer items-center gap-2 py-1.5">
                  <Checkbox checked={draft.enabled} onChange={(value) => patchDraft('enabled', value)} ariaLabel={t('assistants.settings.enabled')} />
                  <span className="typography-ui-label">{t('assistants.settings.enabled')}</span>
                </label>
                {selected ? (
                  <label data-settings-item="assistants.default-share" className="flex cursor-pointer items-center gap-2 py-1.5">
                    <Checkbox checked={defaultShareAssistant?.assistantID === selected.id && defaultShareAssistant.serverInstanceID === capabilityQuery.data?.serverInstanceID} onChange={(value) => void toggleDefaultShare(selected.id, value)} ariaLabel={t('assistants.settings.defaultShare')} />
                    <span className="typography-ui-label">{t('assistants.settings.defaultShare')}</span>
                  </label>
                ) : null}
              </section>

              <section data-settings-item="assistants.prompt" className="space-y-2">
                <label htmlFor="assistant-prompt" className="typography-ui-label font-medium">{t('assistants.settings.defaultPrompt')}</label>
                <Textarea id="assistant-prompt" value={draft.defaultPrompt} onChange={(event) => patchDraft('defaultPrompt', event.target.value)} placeholder={t('assistants.settings.defaultPromptPlaceholder')} />
              </section>

              <section className="space-y-3">
                <h3 className="typography-ui-header font-medium">{t('assistants.settings.runtime')}</h3>
                <div data-settings-item="assistants.model" className="grid gap-2 md:grid-cols-[11rem_minmax(0,1fr)] md:items-center">
                  <span className="typography-ui-label">{t('assistants.settings.model')}</span>
                  <ModelSelector providerId={draft.providerID} modelId={draft.modelID} onChange={(providerID, modelID) => setDraft((current) => ({ ...current, providerID, modelID }))} className="h-8 max-w-full" />
                </div>
                <div data-settings-item="assistants.agent" className="grid gap-2 md:grid-cols-[11rem_minmax(0,1fr)] md:items-center">
                  <span className="typography-ui-label">{t('assistants.settings.agent')}</span>
                  <AgentSelector agentName={draft.agent ?? ''} onChange={(agent) => patchDraft('agent', agent || null)} className="h-8" />
                </div>
                <div data-settings-item="assistants.mode" className="grid gap-2 md:grid-cols-[11rem_minmax(0,1fr)] md:items-start">
                  <span className="pt-1 typography-ui-label">{t('assistants.settings.mode')}</span>
                  <div className="flex flex-wrap gap-2">
                    {(['continuous', 'stateless'] as const).map((mode) => (
                      <Button key={mode} variant="chip" size="xs" aria-pressed={draft.mode === mode} onClick={() => patchDraft('mode', mode)}>{mode === 'continuous' ? t('assistants.mode.continuous') : t('assistants.mode.stateless')}</Button>
                    ))}
                  </div>
                </div>
              </section>

              <section className="space-y-3">
                <h3 className="typography-ui-header font-medium">{t('assistants.settings.paths')}</h3>
                <div data-settings-item="assistants.workspace" className="grid gap-2 md:grid-cols-[11rem_minmax(0,1fr)] md:items-center">
                  <label htmlFor="assistant-workspace" className="typography-ui-label">{t('assistants.settings.workspace')}</label>
                  <Input id="assistant-workspace" value={draft.workspacePath ?? ''} onChange={(event) => patchDraft('workspacePath', event.target.value.trim() ? event.target.value : null)} placeholder={t('assistants.settings.workspacePlaceholder')} />
                </div>
                <div data-settings-item="assistants.skills-roots" className="grid gap-2 md:grid-cols-[11rem_minmax(0,1fr)] md:items-start">
                  <label htmlFor="assistant-skill-root" className="pt-1 typography-ui-label">{t('assistants.settings.skillRoots')}</label>
                  <div className="space-y-2">
                    {draft.skillRoots.map((root) => (
                      <div key={root} className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 truncate typography-meta text-foreground">{root}</code>
                        <Button variant="ghost" size="icon" onClick={() => patchDraft('skillRoots', draft.skillRoots.filter((item) => item !== root))} aria-label={t('assistants.settings.removePath', { path: root })}><Icon name="close" className="size-4" /></Button>
                      </div>
                    ))}
                    <div className="flex gap-2">
                      <Input id="assistant-skill-root" value={skillRootInput} onChange={(event) => setSkillRootInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addSkillRoot(); } }} placeholder={t('assistants.settings.skillRootPlaceholder')} />
                      <Button variant="outline" size="sm" onClick={addSkillRoot}>{t('assistants.settings.addPath')}</Button>
                    </div>
                  </div>
                </div>
              </section>

              <div className="flex justify-end border-t border-border pt-4">
                <Button onClick={save} disabled={saving}>{saving ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}{t('assistants.settings.save')}</Button>
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
              <AgentAvatar name="assistants-empty" size={44} />
              <p className="typography-ui">{t('assistants.settings.empty')}</p>
              <Button data-settings-item="assistants.create" size="sm" onClick={startCreate}><Icon name="add" className="size-4" />{t('assistants.settings.create')}</Button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};
