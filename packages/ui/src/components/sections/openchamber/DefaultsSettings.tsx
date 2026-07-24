import React from 'react';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { updateDesktopSettings } from '@/lib/persistence';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useI18n } from '@/lib/i18n';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';

const getDisplayModel = (
  storedModel: string | undefined
): { providerId: string; modelId: string } => {
  const parsed = parseModelIdentifier(storedModel);
  if (parsed) {
    return parsed;
  }

  return { providerId: '', modelId: '' };
};

export const DefaultsSettings: React.FC = () => {
  const { t } = useI18n();
  const setProvider = useConfigStore((state) => state.setProvider);
  const setModel = useConfigStore((state) => state.setModel);
  const setAgent = useConfigStore((state) => state.setAgent);
  const setCurrentVariant = useConfigStore((state) => state.setCurrentVariant);
  const setSettingsDefaultModel = useConfigStore((state) => state.setSettingsDefaultModel);
  const setSettingsDefaultVariant = useConfigStore((state) => state.setSettingsDefaultVariant);
  const setSettingsDefaultAgent = useConfigStore((state) => state.setSettingsDefaultAgent);
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const setShowDeletionDialog = useUIStore((state) => state.setShowDeletionDialog);
  const providers = useConfigStore((state) => state.providers);

  const [defaultModel, setDefaultModel] = React.useState<string | undefined>();
  const [defaultVariant, setDefaultVariant] = React.useState<string | undefined>();
  const [defaultAgent, setDefaultAgent] = React.useState<string | undefined>();
  const [isLoading, setIsLoading] = React.useState(true);

  const parsedModel = React.useMemo(() => getDisplayModel(defaultModel), [defaultModel]);

  React.useEffect(() => {
    const loadSettings = async () => {
      try {
        let data: {
          defaultModel?: string;
          defaultVariant?: string;
          defaultAgent?: string;
        } | null = null;

        if (!data) {
          const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
          if (runtimeSettings) {
            try {
              const result = await runtimeSettings.load();
              const settings = result?.settings;
              if (settings) {
                const raw = settings as Record<string, unknown>;
                data = {
                  defaultModel: typeof settings.defaultModel === 'string' ? settings.defaultModel : undefined,
                  defaultVariant:
                    typeof raw.defaultVariant === 'string'
                      ? (raw.defaultVariant as string)
                      : undefined,
                  defaultAgent: typeof settings.defaultAgent === 'string' ? settings.defaultAgent : undefined,
                };
              }
            } catch {
              // fall through
            }
          }
        }

        if (!data) {
          const response = await runtimeFetch('/api/config/settings', {
            method: 'GET',
            headers: { Accept: 'application/json' },
          });
          if (response.ok) {
            data = await response.json();
          }
        }

        if (data) {
          const model =
            typeof data.defaultModel === 'string' && data.defaultModel.trim().length > 0
              ? data.defaultModel.trim()
              : undefined;
          const variant =
            typeof data.defaultVariant === 'string' && data.defaultVariant.trim().length > 0
              ? data.defaultVariant.trim()
              : undefined;
          const agent =
            typeof data.defaultAgent === 'string' && data.defaultAgent.trim().length > 0
              ? data.defaultAgent.trim()
              : undefined;

          if (model !== undefined) setDefaultModel(model);
          if (variant !== undefined) setDefaultVariant(variant);
          if (agent !== undefined) setDefaultAgent(agent);
        }
      } catch (error) {
        console.warn('Failed to load defaults settings:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadSettings();
  }, []);

  const handleModelChange = React.useCallback(
    async (providerId: string, modelId: string) => {
      const newValue = providerId && modelId ? `${providerId}/${modelId}` : undefined;
      setDefaultModel(newValue);
      setDefaultVariant(undefined);
      setSettingsDefaultVariant(undefined);
      setCurrentVariant(undefined);
      setSettingsDefaultModel(newValue);

      if (providerId && modelId) {
        const provider = providers.find((p) => p.id === providerId);
        if (provider) {
          setProvider(providerId);
          setModel(modelId);
        }
      }

      try {
        await updateDesktopSettings({ defaultModel: newValue ?? '', defaultVariant: '' });
        const response = await runtimeFetch('/api/config/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ defaultModel: newValue }),
        });
        if (!response.ok) {
          console.warn('Failed to save default model to server:', response.status, response.statusText);
        }
      } catch (error) {
        console.warn('Failed to save default model:', error);
      }
    },
    [providers, setCurrentVariant, setModel, setProvider, setSettingsDefaultModel, setSettingsDefaultVariant]
  );

  const DEFAULT_VARIANT_VALUE = '__default__';

  const formatVariantLabel = React.useCallback((variant: string) => {
    if (variant === DEFAULT_VARIANT_VALUE) {
      return t('settings.openchamber.defaults.option.default');
    }
    return variant.charAt(0).toUpperCase() + variant.slice(1);
  }, [t]);

  const handleVariantChange = React.useCallback(
    async (variant: string) => {
      const newValue = variant === DEFAULT_VARIANT_VALUE ? undefined : variant || undefined;
      setDefaultVariant(newValue);
      setSettingsDefaultVariant(newValue);
      setCurrentVariant(newValue);

      try {
        await updateDesktopSettings({ defaultVariant: newValue ?? '' });
      } catch (error) {
        console.warn('Failed to save default variant:', error);
      }
    },
    [setCurrentVariant, setSettingsDefaultVariant]
  );

  const handleAgentChange = React.useCallback(
    async (agentName: string) => {
      const newValue = agentName || undefined;
      setDefaultAgent(newValue);
      setSettingsDefaultAgent(newValue);

      if (agentName) {
        setAgent(agentName);
      }

      try {
        await updateDesktopSettings({ defaultAgent: newValue ?? '' });
      } catch (error) {
        console.warn('Failed to save default agent:', error);
      }
    },
    [setAgent, setSettingsDefaultAgent]
  );

  const availableVariants = React.useMemo(() => {
    if (!parsedModel.providerId || !parsedModel.modelId) return [];
    const provider = providers.find((p) => p.id === parsedModel.providerId);
    const model = provider?.models.find((m: Record<string, unknown>) => (m as { id?: string }).id === parsedModel.modelId) as
      | { variants?: Record<string, unknown> }
      | undefined;
    const variants = model?.variants;
    if (!variants) return [];
    return Object.keys(variants);
  }, [parsedModel.modelId, parsedModel.providerId, providers]);

  const supportsVariants = availableVariants.length > 0;

  React.useEffect(() => {
    if (!supportsVariants && defaultVariant) {
      setDefaultVariant(undefined);
      setSettingsDefaultVariant(undefined);
      setCurrentVariant(undefined);
      updateDesktopSettings({ defaultVariant: '' }).catch(() => {
        // best effort
      });
    }
  }, [defaultVariant, setCurrentVariant, setSettingsDefaultVariant, supportsVariants]);

  if (isLoading) {
    return null;
  }

  return (
    <SettingsGroup
      label={t('settings.openchamber.defaults.title')}
      description={(
        <>
          {t('settings.openchamber.defaults.summaryPrefix')}
          {' '}
          {parsedModel.providerId ? (
            <span className="text-foreground">
              {parsedModel.providerId}/{parsedModel.modelId}
              {supportsVariants ? ` (${defaultVariant ?? t('settings.openchamber.defaults.option.defaultLowercase')})` : ''}
            </span>
          ) : (
            <span className="text-foreground">{t('settings.openchamber.defaults.summaryOpenCodeDefault')}</span>
          )}
          {defaultAgent && (
            <>
              {' / '}
              <span className="text-foreground">{defaultAgent}</span>
            </>
          )}
        </>
      )}
    >
      <SettingsRow itemId="sessions.default-model" label={t('settings.openchamber.defaults.field.defaultModel')}>
        <ModelSelector
          providerId={parsedModel.providerId}
          modelId={parsedModel.modelId}
          onChange={handleModelChange}
          className="oc-settings-inline-value"
        />
      </SettingsRow>

      <SettingsRow itemId="sessions.default-thinking" label={t('settings.openchamber.defaults.field.defaultThinking')}>
        <Select value={defaultVariant ?? DEFAULT_VARIANT_VALUE} onValueChange={handleVariantChange} disabled={!supportsVariants}>
          <SelectTrigger className="w-fit min-w-[120px]">
            <SelectValue placeholder={t('settings.openchamber.defaults.field.thinkingPlaceholder')}>
              {formatVariantLabel(defaultVariant ?? DEFAULT_VARIANT_VALUE)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_VARIANT_VALUE}>{t('settings.openchamber.defaults.option.default')}</SelectItem>
            {availableVariants.map((variant) => (
              <SelectItem key={variant} value={variant}>
                {formatVariantLabel(variant)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>

      <SettingsRow itemId="sessions.default-agent" label={t('settings.openchamber.defaults.field.defaultAgent')}>
        <AgentSelector
          agentName={defaultAgent || ''}
          onChange={handleAgentChange}
          className="oc-settings-inline-value"
        />
      </SettingsRow>

      <div
        data-settings-item="sessions.deletion-dialog"
        className="oc-settings-group-row oc-settings-split-row group cursor-pointer"
        role="button"
        tabIndex={0}
        aria-pressed={showDeletionDialog}
        onClick={() => setShowDeletionDialog(!showDeletionDialog)}
        onKeyDown={(event) => {
          if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault();
            setShowDeletionDialog(!showDeletionDialog);
          }
        }}
      >
        <div className="oc-settings-split-row-copy">
          <div className="typography-ui-label text-foreground">
            {t('settings.openchamber.defaults.field.showDeletionDialog')}
          </div>
        </div>
        <div className="oc-settings-split-row-control">
          <Checkbox checked={showDeletionDialog} onChange={setShowDeletionDialog} ariaLabel={t('settings.openchamber.defaults.field.showDeletionDialogAria')} />
        </div>
      </div>
    </SettingsGroup>
  );
};
