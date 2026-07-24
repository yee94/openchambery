import React from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { toast } from '@/components/ui';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Icon } from "@/components/icon/Icon";
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';
import {
  getResponseStylePresetInstructions,
  isResponseStylePreset,
  rememberResponseStyleSettings,
  RESPONSE_STYLE_PRESETS,
  type ResponseStylePreset,
} from '@/lib/responseStyle';
import type { DesktopSettings } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { projectSettingsBootstrapPatch } from '@/queries/settingsBootstrapParser';
import { ensureSettingsBootstrapQuery, patchSettingsBootstrapSnapshot } from '@/queries/settingsBootstrapQueries';

const AGENTS_MD_PATH = '~/.config/opencode/AGENTS.md';

const readApiError = async (response: Response, fallback: string) => {
  const data = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof data?.error === 'string' && data.error.trim() ? data.error : fallback;
};

const normalizeAgentsMdContent = (content: string) => {
  return content.length > 0 && !content.endsWith('\n') ? `${content}\n` : content;
};

type ResponseStyleValue = ResponseStylePreset | 'custom';

type BehaviorSettingsState = {
  prompt: string;
  responseStyleEnabled: boolean;
  responseStylePreset: ResponseStyleValue;
  responseStyleCustomInstructions: string;
};

type ResponseStyleDraft = {
  enabled: boolean;
  preset: ResponseStyleValue;
  custom: string;
};

const DEFAULT_BEHAVIOR_SETTINGS: BehaviorSettingsState = {
  prompt: '',
  responseStyleEnabled: false,
  responseStylePreset: 'concise',
  responseStyleCustomInstructions: '',
};

const getResponseStylePreview = (preset: ResponseStyleValue, customInstructions: string) => {
  return preset === 'custom' ? customInstructions : getResponseStylePresetInstructions(preset);
};

const sanitizeResponseStylePreset = (value: unknown): ResponseStyleValue => {
  if (value === 'custom') return 'custom';
  return isResponseStylePreset(value) ? value : 'concise';
};

const RESPONSE_STYLE_OPTION_LABEL_KEYS: Record<ResponseStylePreset, I18nKey> = {
  concise: 'settings.behavior.page.responseStyle.option.concise',
  detailed: 'settings.behavior.page.responseStyle.option.detailed',
  mentor: 'settings.behavior.page.responseStyle.option.mentor',
  pushback: 'settings.behavior.page.responseStyle.option.pushback',
  noFiller: 'settings.behavior.page.responseStyle.option.noFiller',
  matchEnergy: 'settings.behavior.page.responseStyle.option.matchEnergy',
  warmPeer: 'settings.behavior.page.responseStyle.option.warmPeer',
};

const saveBehaviorSetting = async (settings: Partial<DesktopSettings>, fallbackError: string) => {
  const response = await runtimeFetch('/api/config/settings', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(settings),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response, fallbackError));
  }
  return response.json().catch(() => null) as Promise<unknown>;
};

export const BehaviorPage: React.FC = () => {
  const { t } = useI18n();
  const transport = React.useSyncExternalStore(
    subscribeRuntimeEndpointChanged,
    getRuntimeTransportIdentity,
    getRuntimeTransportIdentity,
  );
  const [prompt, setPrompt] = React.useState('');
  const [responseStyleEnabled, setResponseStyleEnabled] = React.useState(DEFAULT_BEHAVIOR_SETTINGS.responseStyleEnabled);
  const [responseStylePreset, setResponseStylePreset] = React.useState<ResponseStyleValue>(DEFAULT_BEHAVIOR_SETTINGS.responseStylePreset);
  const [responseStyleCustomInstructions, setResponseStyleCustomInstructions] = React.useState(DEFAULT_BEHAVIOR_SETTINGS.responseStyleCustomInstructions);
  const [promptReady, setPromptReady] = React.useState(false);
  const [responseStyleReady, setResponseStyleReady] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [initialPrompt, setInitialPrompt] = React.useState('');
  const lastCommittedResponseStyleRef = React.useRef<ResponseStyleDraft | null>(null);
  const latestRequestedResponseStyleRef = React.useRef<ResponseStyleDraft | null>(null);
  const responseStyleSaveGenerationRef = React.useRef(0);
  const responseStyleSaveQueueRef = React.useRef<Promise<void>>(Promise.resolve());

  React.useEffect(() => {
    let active = true;
    setResponseStyleReady(false);
    lastCommittedResponseStyleRef.current = null;
    latestRequestedResponseStyleRef.current = null;
    responseStyleSaveGenerationRef.current += 1;

    void ensureSettingsBootstrapQuery(transport)
      .then((data) => {
        if (!active || transport !== getRuntimeTransportIdentity()) return;
        const nextResponseStyle = {
          enabled: data.responseStyleEnabled === true,
          preset: sanitizeResponseStylePreset(data.responseStylePreset),
          custom: typeof data.responseStyleCustomInstructions === 'string'
            ? data.responseStyleCustomInstructions
            : '',
        };
        setResponseStyleEnabled(nextResponseStyle.enabled);
        setResponseStylePreset(nextResponseStyle.preset);
        setResponseStyleCustomInstructions(nextResponseStyle.custom);
        rememberResponseStyleSettings({
          enabled: nextResponseStyle.enabled,
          preset: nextResponseStyle.preset,
          customInstructions: nextResponseStyle.custom,
        }, transport);
        lastCommittedResponseStyleRef.current = nextResponseStyle;
        latestRequestedResponseStyleRef.current = nextResponseStyle;
        setResponseStyleReady(true);
      })
      .catch((error) => {
        if (active && (error as Error)?.name !== 'AbortError') {
          console.warn('Failed to load behavior settings:', error);
        }
      });

    return () => {
      active = false;
      responseStyleSaveGenerationRef.current += 1;
    };
  }, [transport]);

  React.useEffect(() => {
    const abort = new AbortController();
    let active = true;
    setPromptReady(false);
    setIsSaving(false);

    const loadPrompt = async () => {
      try {
        const response = await runtimeFetch('/api/behavior/agents-md', {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: abort.signal,
        });
        if (!response.ok) {
          throw new Error(`Behavior prompt request failed (${response.status})`);
        }
        const data = await response.json().catch(() => null) as { content?: unknown } | null;
        if (typeof data?.content !== 'string') {
          throw new Error('Invalid behavior prompt response');
        }
        if (!active || transport !== getRuntimeTransportIdentity()) return;
        setPrompt(data.content);
        setInitialPrompt(data.content);
        setPromptReady(true);
      } catch (error) {
        if (active && (error as Error)?.name !== 'AbortError') {
          console.warn('Failed to load behavior prompt:', error);
        }
      }
    };

    void loadPrompt();
    return () => {
      active = false;
      abort.abort();
    };
  }, [transport]);

  React.useEffect(() => {
    if (!responseStyleReady) return;

    const next = {
      enabled: responseStyleEnabled,
      preset: responseStylePreset,
      custom: responseStyleCustomInstructions,
    };
    const requested = latestRequestedResponseStyleRef.current;
    if (
      requested &&
      requested.enabled === next.enabled &&
      requested.preset === next.preset &&
      requested.custom === next.custom
    ) {
      return;
    }
    latestRequestedResponseStyleRef.current = next;
    const generation = responseStyleSaveGenerationRef.current + 1;
    responseStyleSaveGenerationRef.current = generation;

    const timer = setTimeout(() => {
      const run = async () => {
        if (transport !== getRuntimeTransportIdentity()) return;
        try {
          const updated = await saveBehaviorSetting({
            responseStyleEnabled: next.enabled,
            responseStylePreset: next.preset,
            responseStyleCustomInstructions: next.custom,
          }, t('settings.behavior.page.toast.saveFailed'));
          if (transport !== getRuntimeTransportIdentity()) return;
          const projected = projectSettingsBootstrapPatch(updated);
          const committed = {
            enabled: projected.responseStyleEnabled ?? next.enabled,
            preset: projected.responseStylePreset ?? next.preset,
            custom: projected.responseStyleCustomInstructions ?? next.custom,
          };
          rememberResponseStyleSettings({
            enabled: committed.enabled,
            preset: committed.preset,
            customInstructions: committed.custom,
          }, transport);
          patchSettingsBootstrapSnapshot({
            responseStyleEnabled: committed.enabled,
            responseStylePreset: committed.preset,
            responseStyleCustomInstructions: committed.custom,
          }, transport);
          lastCommittedResponseStyleRef.current = committed;
          if (generation !== responseStyleSaveGenerationRef.current) return;
          latestRequestedResponseStyleRef.current = committed;
          setResponseStyleEnabled(committed.enabled);
          setResponseStylePreset(committed.preset);
          setResponseStyleCustomInstructions(committed.custom);
        } catch (error) {
          if (transport === getRuntimeTransportIdentity() && generation === responseStyleSaveGenerationRef.current) {
            const committed = lastCommittedResponseStyleRef.current;
            latestRequestedResponseStyleRef.current = committed;
            if (committed) {
              setResponseStyleEnabled(committed.enabled);
              setResponseStylePreset(committed.preset);
              setResponseStyleCustomInstructions(committed.custom);
            }
            const message = error instanceof Error ? error.message : t('settings.behavior.page.toast.saveFailed');
            toast.error(message);
          }
        }
      };
      responseStyleSaveQueueRef.current = responseStyleSaveQueueRef.current.then(run, run);
    }, 400);

    return () => clearTimeout(timer);
  }, [responseStyleEnabled, responseStylePreset, responseStyleCustomInstructions, responseStyleReady, t, transport]);

  const responseStylePreview = getResponseStylePreview(responseStylePreset, responseStyleCustomInstructions);
  const isPromptDirty = prompt !== initialPrompt;

  const handleSave = async () => {
    const saveTransport = transport;
    if (saveTransport !== getRuntimeTransportIdentity()) return;
    setIsSaving(true);
    try {
      const content = normalizeAgentsMdContent(prompt);
      const response = await runtimeFetch('/api/behavior/agents-md', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ content }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, t('settings.behavior.page.toast.saveFailed')));
      }
      if (saveTransport !== getRuntimeTransportIdentity()) return;

      await saveBehaviorSetting({
        globalBehaviorPrompt: content,
      }, t('settings.behavior.page.toast.saveFailed'));
      if (saveTransport !== getRuntimeTransportIdentity()) return;

      setPrompt(content);
      setInitialPrompt(content);
      toast.success(t('settings.behavior.page.toast.saved'));
    } catch (error) {
      if (saveTransport !== getRuntimeTransportIdentity()) return;
      console.error('Failed to save behavior:', error);
      const message = error instanceof Error ? error.message : t('settings.behavior.page.toast.saveFailed');
      toast.error(message);
    } finally {
      if (saveTransport === getRuntimeTransportIdentity()) {
        setIsSaving(false);
      }
    }
  };

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="oc-settings-page-content mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">
        <div className="space-y-1">
          <h2 className="typography-ui-header font-semibold text-foreground">
            {t('settings.behavior.page.title')}
          </h2>
        </div>

        <SettingsGroup
          itemId="behavior.system-prompt"
          label={(
            <div className="flex items-center gap-1.5">
              <span>{t('settings.behavior.page.section.systemPrompt')}</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                </TooltipTrigger>
                <TooltipContent sideOffset={8} className="max-w-xs">
                  <div className="space-y-1">
                    <p className="font-medium text-foreground">
                      {t('settings.behavior.page.warning.title')}
                    </p>
                    <p>
                      {t('settings.behavior.page.warning.description', { path: AGENTS_MD_PATH })}
                    </p>
                  </div>
                </TooltipContent>
              </Tooltip>
            </div>
          )}
        >
          <div className="oc-settings-group-row flex flex-col gap-3">
            <Textarea
              embedded
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('settings.behavior.page.field.systemPromptPlaceholder')}
              rows={12}
              disabled={!promptReady}
              outerClassName="min-h-[160px] max-h-[70vh]"
              className="w-full font-mono typography-meta bg-transparent"
            />
            <Button
              onClick={handleSave}
              disabled={isSaving || !isPromptDirty || !promptReady}
              size="xs"
              className="!font-normal"
            >
              {isSaving ? t('settings.common.actions.saving') : t('settings.common.actions.saveChanges')}
            </Button>
          </div>
        </SettingsGroup>

        <SettingsGroup
          itemId="behavior.response-style"
          label={(
            <div className="flex items-center gap-1.5">
              <span>{t('settings.behavior.page.section.responseStyle')}</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                </TooltipTrigger>
                <TooltipContent sideOffset={8} className="max-w-xs">
                  {t('settings.behavior.page.responseStyle.tooltip')}
                </TooltipContent>
              </Tooltip>
            </div>
          )}
        >
          <SettingsRow label={t('settings.behavior.page.responseStyle.enable')}>
            <Checkbox
              checked={responseStyleEnabled}
              onChange={setResponseStyleEnabled}
              disabled={!responseStyleReady}
              ariaLabel={t('settings.behavior.page.responseStyle.enableAria')}
            />
            <Select<ResponseStyleValue>
              value={responseStylePreset}
              onValueChange={(value) => setResponseStylePreset(value)}
              disabled={!responseStyleReady || !responseStyleEnabled}
            >
              <SelectTrigger className="w-full sm:w-56">
                <SelectValue>
                  {(value) => {
                    if (value === 'custom') return t('settings.behavior.page.responseStyle.option.custom');
                    if (isResponseStylePreset(value)) return t(RESPONSE_STYLE_OPTION_LABEL_KEYS[value]);
                    return null;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {RESPONSE_STYLE_PRESETS.map((preset) => (
                  <SelectItem key={preset} value={preset}>
                    {t(RESPONSE_STYLE_OPTION_LABEL_KEYS[preset])}
                  </SelectItem>
                ))}
                <SelectItem value="custom">
                  {t('settings.behavior.page.responseStyle.option.custom')}
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>

          <div className="oc-settings-group-row">
            <Textarea
              embedded
              value={responseStylePreview}
              onChange={(event) => setResponseStyleCustomInstructions(event.target.value)}
              placeholder={t('settings.behavior.page.responseStyle.customPlaceholder')}
              rows={5}
              disabled={!responseStyleReady || !responseStyleEnabled || responseStylePreset !== 'custom'}
              outerClassName="min-h-[120px]"
              className="w-full font-mono typography-meta bg-transparent"
            />
          </div>
        </SettingsGroup>

      </div>
    </ScrollableOverlay>
  );
};
