import React from 'react';
import { Button } from '@/components/ui/button';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { Input } from '@/components/ui/input';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { Radio } from '@/components/ui/radio';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { createFlexokiCodeMirrorTheme } from '@/lib/codemirror/flexokiTheme';
import type { Extension } from '@codemirror/state';
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';

const DEFAULT_SUMMARY_COMMIT_PROMPT = 'You are generating a Conventional Commits subject line from the diffs of the selected files.';

const DEFAULT_SESSION_TITLE_PROMPT = [
  'You are a title generator. You output ONLY a thread title. Nothing else.',
  'Generate a brief title that would help the user find this conversation later.',
  'Title the MAIN SUBJECT of the work - the overall feature, goal, or problem being done.',
  'Keep the title on the durable subject across follow-ups, polish, commit, push, tidy, and review turns.',
  'Switch the subject only when the user clearly starts a different topic or feature.',
  'Your output must be a single line of 50 characters or fewer with no explanation.',
  'Use the language of the user messages.',
  'Keep technical terms, numbers, filenames, and HTTP codes exact.',
  'Never include tool names, summarizing, or generating in the title.',
  'Always output a meaningful title.',
].join('\n');

type SummarySettingsPayload = {
  summaryModelMode?: 'provider' | 'custom';
  summaryProviderID?: string;
  summaryModelID?: string;
  summaryCustomBaseURL?: string;
  hasSummaryCustomAPIToken?: boolean;
  summaryCommitPrompt?: string;
  summarySessionTitlePrompt?: string;
};

export const SummarySettings: React.FC = () => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const providers = useConfigStore((state) => state.providers);
  const [summaryModelMode, setSummaryModelMode] = React.useState<'provider' | 'custom'>('provider');
  const [summaryProviderID, setSummaryProviderID] = React.useState('');
  const [summaryModelID, setSummaryModelID] = React.useState('');
  const [summaryCustomBaseURL, setSummaryCustomBaseURL] = React.useState('');
  const [summaryCustomAPIToken, setSummaryCustomAPIToken] = React.useState('');
  const [hasSummaryCustomAPIToken, setHasSummaryCustomAPIToken] = React.useState(false);
  const [summaryCommitPrompt, setSummaryCommitPrompt] = React.useState(DEFAULT_SUMMARY_COMMIT_PROMPT);
  const [summarySessionTitlePrompt, setSummarySessionTitlePrompt] = React.useState(DEFAULT_SESSION_TITLE_PROMPT);
  const [callableModelsByProvider, setCallableModelsByProvider] = React.useState<Record<string, readonly string[]> | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const editorExtensions = React.useMemo<Extension[]>(
    () => [createFlexokiCodeMirrorTheme(currentTheme, { syntaxColors: false })],
    [currentTheme],
  );

  React.useEffect(() => {
    let active = true;
    const loadSettings = async () => {
      try {
        let data: SummarySettingsPayload | null = null;
        const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
        if (runtimeSettings) {
          const result = await runtimeSettings.load();
          const settings = result?.settings as SummarySettingsPayload | undefined;
          if (settings) data = settings;
        }
        if (!data) {
          const response = await runtimeFetch('/api/config/settings', {
            method: 'GET',
            headers: { Accept: 'application/json' },
          });
          if (response.ok) data = await response.json() as SummarySettingsPayload;
        }
        if (!active || !data) return;
        if (data.summaryModelMode) setSummaryModelMode(data.summaryModelMode);
        if (typeof data.summaryProviderID === 'string') setSummaryProviderID(data.summaryProviderID);
        if (typeof data.summaryModelID === 'string') setSummaryModelID(data.summaryModelID);
        if (typeof data.summaryCustomBaseURL === 'string') setSummaryCustomBaseURL(data.summaryCustomBaseURL);
        if (typeof data.hasSummaryCustomAPIToken === 'boolean') setHasSummaryCustomAPIToken(data.hasSummaryCustomAPIToken);
        setSummaryCommitPrompt(data.summaryCommitPrompt ?? DEFAULT_SUMMARY_COMMIT_PROMPT);
        setSummarySessionTitlePrompt(data.summarySessionTitlePrompt ?? DEFAULT_SESSION_TITLE_PROMPT);
      } catch (error) {
        console.warn('Failed to load summary settings:', error);
      } finally {
        if (active) setIsLoading(false);
      }
    };
    void loadSettings();
    return () => {
      active = false;
    };
  }, []);

  React.useEffect(() => {
    let active = true;
    const loadCapabilities = async () => {
      try {
        const response = await runtimeFetch('/api/small-model', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        const payload = await response.json().catch(() => null) as { callableModels?: unknown } | null;
        if (!response.ok || !payload?.callableModels || typeof payload.callableModels !== 'object') {
          throw new Error('Summary provider capabilities are unavailable');
        }
        const models = Object.fromEntries(
          Object.entries(payload.callableModels)
            .map(([providerID, modelIDs]) => [
              providerID,
              Array.isArray(modelIDs) ? modelIDs.filter((modelID): modelID is string => typeof modelID === 'string') : [],
            ])
            .filter(([, modelIDs]) => modelIDs.length > 0),
        );
        if (active) setCallableModelsByProvider(models);
      } catch {
        if (active) setCallableModelsByProvider({});
      }
    };
    void loadCapabilities();
    return () => {
      active = false;
    };
  }, []);

  const defaultSummaryProvider = React.useMemo(
    () => providers.find((provider) => provider.id === 'openai') ?? providers[0],
    [providers],
  );

  React.useEffect(() => {
    if (!summaryProviderID && defaultSummaryProvider?.id) {
      setSummaryProviderID(defaultSummaryProvider.id);
    }
  }, [defaultSummaryProvider?.id, summaryProviderID]);

  React.useEffect(() => {
    if (!callableModelsByProvider) return;
    const providerIDs = Object.keys(callableModelsByProvider);
    if (providerIDs.length === 0) return;
    const providerID = callableModelsByProvider[summaryProviderID]
      ? summaryProviderID
      : (callableModelsByProvider.openai ? 'openai' : providerIDs[0]);
    const modelIDs = callableModelsByProvider[providerID] ?? [];
    const modelID = modelIDs.includes(summaryModelID) ? summaryModelID : (modelIDs[0] ?? '');
    if (providerID !== summaryProviderID) setSummaryProviderID(providerID);
    if (modelID !== summaryModelID) setSummaryModelID(modelID);
  }, [callableModelsByProvider, summaryModelID, summaryProviderID]);

  const save = React.useCallback(async () => {
    setIsSaving(true);
    try {
      const changes: Parameters<typeof updateDesktopSettings>[0] = {
        summaryModelMode,
        summaryProviderID: summaryProviderID.trim(),
        summaryModelID: summaryModelID.trim(),
        summaryCustomBaseURL,
        summaryCommitPrompt,
        summarySessionTitlePrompt,
      };
      if (summaryCustomAPIToken.trim()) {
        changes.summaryCustomAPIToken = summaryCustomAPIToken;
      }
      await updateDesktopSettings(changes);
      if (summaryCustomAPIToken.trim()) setHasSummaryCustomAPIToken(true);
      setSummaryCustomAPIToken('');
    } catch (error) {
      console.warn('Failed to save summary settings:', error);
    } finally {
      setIsSaving(false);
    }
  }, [summaryCommitPrompt, summaryCustomAPIToken, summaryCustomBaseURL, summaryModelID, summaryModelMode, summaryProviderID, summarySessionTitlePrompt]);

  const clearToken = React.useCallback(async () => {
    setIsSaving(true);
    try {
      await updateDesktopSettings({ summaryCustomAPIToken: '' });
      setSummaryCustomAPIToken('');
      setHasSummaryCustomAPIToken(false);
    } catch (error) {
      console.warn('Failed to clear summary API token:', error);
    } finally {
      setIsSaving(false);
    }
  }, []);

  if (isLoading) return null;

  return (
    <div className="oc-settings-section-stack">
      <SettingsGroup
        label={t('settings.openchamber.defaults.summary.title')}
        description={t('settings.openchamber.defaults.summary.description')}
      >
        <SettingsRow
          itemId="summary-ai.configuration"
          label={t('settings.openchamber.defaults.summary.modelSourceTitle')}
          className="oc-settings-summary-model-source-row"
          controlClassName="items-start"
        >
          <div role="radiogroup" aria-label={t('settings.openchamber.defaults.summary.modelSourceAria')} className="flex flex-col gap-2">
            <div className="flex items-start gap-2 py-0.5">
              <Radio checked={summaryModelMode === 'provider'} onChange={() => setSummaryModelMode('provider')} ariaLabel={t('settings.openchamber.defaults.summary.provider')} />
              <div>
                <div className={summaryModelMode === 'provider' ? 'typography-ui-label text-foreground' : 'typography-ui-label text-foreground/50'}>{t('settings.openchamber.defaults.summary.provider')}</div>
                <div className="typography-micro text-muted-foreground">{t('settings.openchamber.defaults.summary.providerDescription')}</div>
              </div>
            </div>
            <div className="flex items-start gap-2 py-0.5">
              <Radio checked={summaryModelMode === 'custom'} onChange={() => setSummaryModelMode('custom')} ariaLabel={t('settings.openchamber.defaults.summary.custom')} />
              <div>
                <div className={summaryModelMode === 'custom' ? 'typography-ui-label text-foreground' : 'typography-ui-label text-foreground/50'}>{t('settings.openchamber.defaults.summary.custom')}</div>
                <div className="typography-micro text-muted-foreground">{t('settings.openchamber.defaults.summary.customDescription')}</div>
              </div>
            </div>
          </div>
        </SettingsRow>

        {summaryModelMode === 'provider' ? (
          <SettingsRow label={t('settings.openchamber.defaults.summary.providerModel')}>
            {callableModelsByProvider === null ? null : Object.keys(callableModelsByProvider).length > 0 ? (
              <ModelSelector
                providerId={summaryProviderID}
                modelId={summaryModelID}
                onChange={(providerID, modelID) => { setSummaryProviderID(providerID); setSummaryModelID(modelID); }}
                allowedProviderIds={Object.keys(callableModelsByProvider)}
                allowedModelIdsByProvider={callableModelsByProvider}
                className="oc-settings-inline-value"
              />
            ) : (
              <span className="typography-meta text-muted-foreground">{t('settings.openchamber.defaults.summary.providerUnavailable')}</span>
            )}
          </SettingsRow>
        ) : (
          <>
            <SettingsRow label={t('settings.openchamber.defaults.summary.baseUrl')}>
              <Input value={summaryCustomBaseURL} onChange={(event) => setSummaryCustomBaseURL(event.target.value)} placeholder={t('settings.openchamber.defaults.summary.baseUrlPlaceholder')} />
            </SettingsRow>
            <SettingsRow label={t('settings.openchamber.defaults.summary.modelId')}>
              <Input value={summaryModelID} onChange={(event) => setSummaryModelID(event.target.value)} placeholder={t('settings.openchamber.defaults.summary.modelIdPlaceholder')} />
            </SettingsRow>
            <SettingsRow label={t('settings.openchamber.defaults.summary.apiToken')}>
              <div className="flex flex-wrap items-center gap-2">
                <Input type="password" value={summaryCustomAPIToken} onChange={(event) => setSummaryCustomAPIToken(event.target.value)} placeholder={hasSummaryCustomAPIToken ? t('settings.openchamber.defaults.summary.apiTokenStored') : t('settings.openchamber.defaults.summary.apiTokenPlaceholder')} className="max-w-xl" />
                {hasSummaryCustomAPIToken ? <Button variant="outline" size="sm" onClick={() => void clearToken()} disabled={isSaving}>{t('settings.openchamber.defaults.summary.clearToken')}</Button> : null}
              </div>
            </SettingsRow>
          </>
        )}
      </SettingsGroup>

      <SettingsGroup label={t('settings.openchamber.defaults.summary.promptTitle')}>
        <SettingsRow
          label={t('settings.openchamber.defaults.summary.commitPrompt')}
          description={t('settings.openchamber.defaults.summary.commitPromptDescription')}
          className="oc-settings-split-row-stacked"
          controlClassName="w-full max-w-none justify-self-stretch"
        >
          <div className="h-64 w-full overflow-hidden bg-background">
            <CodeMirrorEditor value={summaryCommitPrompt} onChange={setSummaryCommitPrompt} extensions={editorExtensions} className="h-full" enableSearch />
          </div>
        </SettingsRow>
        <SettingsRow
          label={t('settings.openchamber.defaults.summary.sessionTitlePrompt')}
          description={t('settings.openchamber.defaults.summary.sessionTitlePromptDescription')}
          className="oc-settings-split-row-stacked"
          controlClassName="w-full max-w-none justify-self-stretch"
        >
          <div className="h-64 w-full overflow-hidden bg-background">
            <CodeMirrorEditor value={summarySessionTitlePrompt} onChange={setSummarySessionTitlePrompt} extensions={editorExtensions} className="h-full" enableSearch />
          </div>
        </SettingsRow>
        <div className="oc-settings-group-row flex items-center justify-end">
          <Button size="sm" onClick={() => void save()} disabled={isSaving}>{isSaving ? t('settings.common.actions.saving') : t('settings.openchamber.defaults.summary.save')}</Button>
        </div>
      </SettingsGroup>
    </div>
  );
};
