import React from 'react';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { Radio } from '@/components/ui/radio';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { createFlexokiCodeMirrorTheme } from '@/lib/codemirror/flexokiTheme';
import type { Extension } from '@codemirror/state';
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';

const DEFAULT_SUMMARY_COMMIT_PROMPT = 'You are generating a Conventional Commits subject line from the diffs of the selected files.';

const DEFAULT_SESSION_TITLE_PROMPT = [
  'You are a title generator. Output ONLY a thread title.',
  'Name the main subject of the work.',
  'Keep that subject across follow-ups, polish, commit, push, tidy, and review.',
  'Switch only when the user clearly starts a different topic.',
  'One line, ≤50 characters, no explanation.',
  'Prefer ≤6 words or ≤6 CJK characters. No modifiers. No verbs.',
  'Use the language of the user messages.',
  'Keep technical terms, numbers, filenames, and HTTP codes exact.',
  'Never include tool names, summarizing, or generating.',
  'Always output a meaningful title.',
].join('\n');

const CUSTOM_MODEL_SUGGESTIONS_ID = 'summary-custom-model-suggestions';

type SummarySettingsPayload = {
  summaryModelMode?: 'provider' | 'custom';
  summaryProviderID?: string;
  summaryModelID?: string;
  summaryCustomModelID?: string;
  summaryCustomBaseURL?: string;
  hasSummaryCustomAPIToken?: boolean;
  summaryCommitPrompt?: string;
  summarySessionTitlePrompt?: string;
};

type CustomTestCode = 'incomplete' | 'token' | 'model' | 'baseURL';

const parseCustomApiBaseURL = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
      return null;
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
};

export const SummarySettings: React.FC = () => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  // Same catalog as the Assistant model picker; generation goes through the
  // same LLM gateway, which checks the location-less connected catalog.
  const [summaryModelMode, setSummaryModelMode] = React.useState<'provider' | 'custom'>('provider');
  const [summaryProviderID, setSummaryProviderID] = React.useState('');
  const [summaryModelID, setSummaryModelID] = React.useState('');
  const [summaryCustomModelID, setSummaryCustomModelID] = React.useState('');
  const [summaryCustomBaseURL, setSummaryCustomBaseURL] = React.useState('');
  const [summaryCustomAPIToken, setSummaryCustomAPIToken] = React.useState('');
  const [hasSummaryCustomAPIToken, setHasSummaryCustomAPIToken] = React.useState(false);
  const [summaryCommitPrompt, setSummaryCommitPrompt] = React.useState(DEFAULT_SUMMARY_COMMIT_PROMPT);
  const [summarySessionTitlePrompt, setSummarySessionTitlePrompt] = React.useState(DEFAULT_SESSION_TITLE_PROMPT);
  const [customModelSuggestions, setCustomModelSuggestions] = React.useState<readonly string[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isTesting, setIsTesting] = React.useState(false);
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
        if (typeof data.summaryCustomModelID === 'string' && data.summaryCustomModelID) {
          setSummaryCustomModelID(data.summaryCustomModelID);
        } else if (data.summaryModelMode === 'custom' && typeof data.summaryModelID === 'string') {
          setSummaryCustomModelID(data.summaryModelID);
        }
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
    if (summaryModelMode !== 'custom') {
      setCustomModelSuggestions([]);
      return;
    }
    const baseURL = parseCustomApiBaseURL(summaryCustomBaseURL);
    if (!baseURL || (!summaryCustomAPIToken.trim() && !hasSummaryCustomAPIToken)) {
      setCustomModelSuggestions([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await runtimeFetch('/api/small-model/custom-models', {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({
              baseURL,
              ...(summaryCustomAPIToken.trim() ? { apiToken: summaryCustomAPIToken } : {}),
            }),
          });
          const payload = await response.json().catch(() => null) as { models?: unknown } | null;
          const models = Array.isArray(payload?.models)
            ? payload.models.filter((modelID): modelID is string => typeof modelID === 'string' && modelID.length > 0)
            : [];
          if (active) setCustomModelSuggestions(models);
        } catch {
          if (active) setCustomModelSuggestions([]);
        }
      })();
    }, 400);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [hasSummaryCustomAPIToken, summaryCustomAPIToken, summaryCustomBaseURL, summaryModelMode]);

  const customValidationCode = (): CustomTestCode | null => {
    if (!parseCustomApiBaseURL(summaryCustomBaseURL)) return summaryCustomBaseURL.trim() ? 'baseURL' : 'incomplete';
    if (!summaryCustomModelID.trim()) return 'incomplete';
    if (!summaryCustomAPIToken.trim() && !hasSummaryCustomAPIToken) return 'incomplete';
    return null;
  };

  const toastCustomError = (code: CustomTestCode) => {
    if (code === 'token') toast.error(t('settings.openchamber.defaults.summary.testError.token'));
    else if (code === 'model') toast.error(t('settings.openchamber.defaults.summary.testError.model'));
    else if (code === 'baseURL') toast.error(t('settings.openchamber.defaults.summary.testError.baseUrl'));
    else toast.error(t('settings.openchamber.defaults.summary.testError.incomplete'));
  };

  const save = useEvent(async () => {
    if (summaryModelMode === 'custom') {
      const code = customValidationCode();
      if (code) {
        toastCustomError(code);
        return;
      }
    }
    setIsSaving(true);
    try {
      const changes: Parameters<typeof updateDesktopSettings>[0] = {
        summaryModelMode,
        summaryCommitPrompt,
        summarySessionTitlePrompt,
      };
      if (summaryModelMode === 'provider') {
        changes.summaryProviderID = summaryProviderID.trim();
        changes.summaryModelID = summaryModelID.trim();
      } else {
        changes.summaryCustomBaseURL = summaryCustomBaseURL;
        changes.summaryCustomModelID = summaryCustomModelID.trim();
        if (summaryCustomAPIToken.trim()) {
          changes.summaryCustomAPIToken = summaryCustomAPIToken;
        }
      }
      await updateDesktopSettings(changes);
      if (summaryCustomAPIToken.trim()) setHasSummaryCustomAPIToken(true);
      setSummaryCustomAPIToken('');
    } catch (error) {
      console.warn('Failed to save summary settings:', error);
    } finally {
      setIsSaving(false);
    }
  });

  const clearToken = useEvent(async () => {
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
  });

  const testConnection = useEvent(async () => {
    const code = customValidationCode();
    if (code) {
      toastCustomError(code);
      return;
    }
    setIsTesting(true);
    try {
      const response = await runtimeFetch('/api/small-model/test', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseURL: summaryCustomBaseURL,
          modelID: summaryCustomModelID,
          ...(summaryCustomAPIToken.trim() ? { apiToken: summaryCustomAPIToken } : {}),
        }),
      });
      const payload = await response.json().catch(() => null) as { ok?: unknown; code?: unknown } | null;
      if (payload?.ok === true) {
        toast.success(t('settings.openchamber.defaults.summary.testConnectionOk'));
        return;
      }
      const failure = payload?.code === 'token' || payload?.code === 'model' || payload?.code === 'baseURL' || payload?.code === 'incomplete'
        ? payload.code
        : 'baseURL';
      toastCustomError(failure);
    } catch {
      toastCustomError('baseURL');
    } finally {
      setIsTesting(false);
    }
  });

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
            <ModelSelector
              providerId={summaryProviderID}
              modelId={summaryModelID}
              placeholder={t('settings.openchamber.defaults.summary.providerModelDefault')}
              onChange={(providerID, modelID) => { setSummaryProviderID(providerID); setSummaryModelID(modelID); }}
              className="oc-settings-inline-value"
            />
          </SettingsRow>
        ) : (
          <>
            <SettingsRow label={t('settings.openchamber.defaults.summary.baseUrl')}>
              <Input value={summaryCustomBaseURL} onChange={(event) => setSummaryCustomBaseURL(event.target.value)} placeholder={t('settings.openchamber.defaults.summary.baseUrlPlaceholder')} />
            </SettingsRow>
            <SettingsRow label={t('settings.openchamber.defaults.summary.modelId')}>
              <div className="w-full">
                <Input
                  value={summaryCustomModelID}
                  onChange={(event) => setSummaryCustomModelID(event.target.value)}
                  placeholder={t('settings.openchamber.defaults.summary.modelIdPlaceholder')}
                  list={customModelSuggestions.length > 0 ? CUSTOM_MODEL_SUGGESTIONS_ID : undefined}
                />
                {customModelSuggestions.length > 0 ? (
                  <datalist id={CUSTOM_MODEL_SUGGESTIONS_ID}>
                    {customModelSuggestions.map((modelID) => (
                      <option key={modelID} value={modelID} />
                    ))}
                  </datalist>
                ) : null}
              </div>
            </SettingsRow>
            <SettingsRow label={t('settings.openchamber.defaults.summary.apiToken')}>
              <div className="flex flex-wrap items-center gap-2">
                <Input type="password" value={summaryCustomAPIToken} onChange={(event) => setSummaryCustomAPIToken(event.target.value)} placeholder={hasSummaryCustomAPIToken ? t('settings.openchamber.defaults.summary.apiTokenStored') : t('settings.openchamber.defaults.summary.apiTokenPlaceholder')} className="max-w-xl" />
                {hasSummaryCustomAPIToken ? <Button variant="outline" size="sm" onClick={() => void clearToken()} disabled={isSaving}>{t('settings.openchamber.defaults.summary.clearToken')}</Button> : null}
              </div>
            </SettingsRow>
            <SettingsRow label={t('settings.openchamber.defaults.summary.testConnection')}>
              <Button variant="outline" size="sm" onClick={() => void testConnection()} disabled={isSaving || isTesting}>
                {isTesting ? t('settings.openchamber.defaults.summary.testingConnection') : t('settings.openchamber.defaults.summary.testConnection')}
              </Button>
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
