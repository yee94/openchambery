import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useEvent } from '@reactuses/core';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { refreshOpenCodeConfiguration } from '@/stores/useAgentsStore';
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import type { ModelMetadata } from '@/types';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { opencodeClient } from '@/lib/opencode/client';
import { filterMethodsWithIndex } from './providerAvailability';
import { getRuntimeGeneration, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { providerConnectionQueryOptions } from './providerConnectionQueries';
import { createProviderOAuthFlow } from './providerOAuth';
import { QuotaCredentials } from './QuotaCredentials';
import { SettingsGroup } from '@/components/sections/shared/SettingsGroup';

type ProviderSettingsSectionProps = {
  itemId?: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
};

const ProviderSettingsSection = ({
  itemId,
  label,
  description,
  action,
  children,
}: ProviderSettingsSectionProps) => (
  <div data-settings-item={itemId}>
    <SettingsGroup
      className="oc-settings-detail-group"
      label={action ? (
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="min-w-0">{label}</div>
          <div className="shrink-0">{action}</div>
        </div>
      ) : label}
      description={description}
    >
      <div className="oc-settings-group-row">{children}</div>
    </SettingsGroup>
  </div>
);

const formatCompactNumber = (value: number) => new Intl.NumberFormat(getCurrentIntlLocale(), {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
}).format(value);

const formatTokens = (value?: number | null) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  if (value === 0) {
    return '0';
  }
  const formatted = formatCompactNumber(value);
  return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
};

const ADD_PROVIDER_ID = '__add_provider__';

interface AuthMethod {
  type?: string;
  name?: string;
  label?: string;
  description?: string;
  help?: string;
  method?: number;
  [key: string]: unknown;
}

interface ProviderSourceInfo {
  exists: boolean;
  path?: string | null;
}

interface ProviderSources {
  auth: ProviderSourceInfo;
  user: ProviderSourceInfo;
  project: ProviderSourceInfo;
  custom?: ProviderSourceInfo;
}

const normalizeAuthType = (method: AuthMethod) => {
  const raw = typeof method.type === 'string' ? method.type : '';
  const label = `${method.name ?? ''} ${method.label ?? ''}`.toLowerCase();
  const merged = `${raw} ${label}`.toLowerCase();
  if (merged.includes('oauth')) return 'oauth';
  if (merged.includes('api')) return 'api';
  return raw.toLowerCase();
};

type IntegrationMethodLike = {
  id?: string;
  type?: string;
  label?: string;
  name?: string;
};

type IntegrationLike = {
  id?: string;
  name?: string;
  methods?: IntegrationMethodLike[];
  connections?: Array<{ type?: string; id?: string }>;
};

type ProviderLike = {
  id?: string;
  integrationID?: string;
  name?: string;
};

// eslint-disable-next-line react-refresh/only-export-components -- tests import these helpers
export const resolveIntegrationId = (
  providerId: string,
  providers: ProviderLike[],
  integrations: IntegrationLike[],
): string => {
  const provider = providers.find((entry) => entry.id === providerId);
  if (typeof provider?.integrationID === 'string' && provider.integrationID) {
    return provider.integrationID;
  }
  if (integrations.some((entry) => entry.id === providerId)) {
    return providerId;
  }
  return providerId;
};

// eslint-disable-next-line react-refresh/only-export-components -- tests import these helpers
export const buildAuthMethodsFromIntegrations = (
  providers: ProviderLike[],
  integrations: IntegrationLike[],
): { methodsByProvider: Record<string, AuthMethod[]>; integrationIdByProvider: Record<string, string> } => {
  const methodsByProvider: Record<string, AuthMethod[]> = {};
  const integrationIdByProvider: Record<string, string> = {};
  const integrationById = new Map(
    integrations
      .filter((entry): entry is IntegrationLike & { id: string } => typeof entry.id === 'string' && entry.id.length > 0)
      .map((entry) => [entry.id, entry]),
  );

  const assign = (providerId: string, integration: IntegrationLike) => {
    integrationIdByProvider[providerId] = integration.id ?? providerId;
    methodsByProvider[providerId] = (integration.methods ?? []).map((method) => ({
      type: method.type,
      id: method.id,
      name: method.label ?? method.name,
      label: method.label ?? method.name,
    }));
  };

  for (const provider of providers) {
    if (typeof provider.id !== 'string' || !provider.id) continue;
    const integrationId = resolveIntegrationId(provider.id, providers, integrations);
    const integration = integrationById.get(integrationId);
    if (integration) assign(provider.id, integration);
  }
  for (const integration of integrations) {
    if (typeof integration.id !== 'string' || !integration.id) continue;
    if (methodsByProvider[integration.id]) continue;
    assign(integration.id, integration);
  }

  return { methodsByProvider, integrationIdByProvider };
};

export const ProvidersPage: React.FC = () => {
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeGeneration, getRuntimeGeneration);
  const directory = useDirectoryStore((state) => state.currentDirectory);
  return <ProvidersPageContent key={`${generation}:${directory}`} />;
};

const ProvidersPageContent: React.FC = () => {
  const { t } = useI18n();
  const providers = useConfigStore((state) => state.providers);
  const selectedProviderId = useConfigStore((state) => state.selectedProviderId);
  const setSelectedProvider = useConfigStore((state) => state.setSelectedProvider);
  const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
  const hiddenModels = useUIStore((state) => state.hiddenModels);
  const toggleHiddenModel = useUIStore((state) => state.toggleHiddenModel);
  const hideAllModels = useUIStore((state) => state.hideAllModels);
  const showAllModels = useUIStore((state) => state.showAllModels);

  const connectionQuery = useQuery(providerConnectionQueryOptions());
  const { methodsByProvider: authMethodsByProvider, integrationIdByProvider } = React.useMemo(() =>
    buildAuthMethodsFromIntegrations(connectionQuery.data?.providers ?? [], connectionQuery.data?.integrations ?? []),
  [connectionQuery.data]);
  const authLoading = connectionQuery.isPending;
  React.useEffect(() => {
    if (connectionQuery.isError) toast.error(t('settings.providers.page.toast.authMethodsLoadFailed'));
  }, [connectionQuery.isError, t]);
  const [apiKeyInputs, setApiKeyInputs] = React.useState<Record<string, string>>({});
  const [authBusyKey, setAuthBusyKey] = React.useState<string | null>(null);
  const [modelQuery, setModelQuery] = React.useState('');
  const [pendingOAuth, setPendingOAuth] = React.useState<{ providerId: string; methodIndex: number; methodID: string; attemptID: string; mode: 'auto' | 'code' } | null>(null);
  const [oauthCodes, setOauthCodes] = React.useState<Record<string, string>>({});
  const [oauthDetails, setOauthDetails] = React.useState<Record<string, { url?: string; instructions?: string; userCode?: string; mode: 'auto' | 'code' }>>({});
  const availableLoading = connectionQuery.isPending;
  const availableError = connectionQuery.isError ? t('settings.providers.page.state.unableToLoadProviderList') : null;
  const [candidateProviderId, setCandidateProviderId] = React.useState('');
  const [providerSearchQuery, setProviderSearchQuery] = React.useState('');
  const [providerDropdownOpen, setProviderDropdownOpen] = React.useState(false);
  const [providerSources, setProviderSources] = React.useState<Record<string, ProviderSources>>({});
  const [showAuthPanel, setShowAuthPanel] = React.useState(false);
  const isAddMode = selectedProviderId === ADD_PROVIDER_ID;
  const mutationLifetime = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    mutationLifetime.current = controller;
    return () => controller.abort();
  }, []);
  const captureMutationScope = useEvent(() => {
    const controller = mutationLifetime.current;
    if (!controller || controller.signal.aborted) return null;
    const directory = opencodeClient.getDirectory();
    const generation = getRuntimeGeneration();
    return {
      directory,
      location: directory ? { directory } : undefined,
      transportIdentity: getRuntimeTransportIdentity(),
      signal: controller.signal,
      isCurrent: () => mutationLifetime.current === controller
        && !controller.signal.aborted
        && getRuntimeGeneration() === generation
        && opencodeClient.getDirectory() === directory,
    };
  });
  const oauthFlow = React.useRef<ReturnType<typeof createProviderOAuthFlow> | null>(null);
  const clearOAuth = useEvent(() => {
    oauthFlow.current?.cancel();
    oauthFlow.current = null;
    setPendingOAuth(null);
    setOauthDetails({});
    setOauthCodes({});
    setAuthBusyKey(null);
  });
  React.useEffect(() => {
    clearOAuth();
    return () => { oauthFlow.current?.cancel(); oauthFlow.current = null; };
  }, [selectedProviderId, candidateProviderId, clearOAuth]);

  React.useEffect(() => {
    if (!selectedProviderId && providers.length > 0) {
      setSelectedProvider(providers[0].id);
    }
  }, [providers, selectedProviderId, setSelectedProvider]);

  const unconnectedProviders = React.useMemo(
    () =>
      (connectionQuery.data?.integrations ?? [])
        .filter((integration) => !integration.id.startsWith('mcp_') && integration.connections.length === 0)
        .sort((a, b) => {
          const labelA = (a.name || a.id).toLowerCase();
          const labelB = (b.name || b.id).toLowerCase();
          return labelA.localeCompare(labelB);
        }),
    [connectionQuery.data]
  );

  React.useEffect(() => {
    if (selectedProviderId !== ADD_PROVIDER_ID) {
      return;
    }

    if (candidateProviderId && !unconnectedProviders.some((provider) => provider.id === candidateProviderId)) {
      setCandidateProviderId('');
    }
  }, [selectedProviderId, candidateProviderId, unconnectedProviders]);

  React.useEffect(() => {
    if (selectedProviderId === ADD_PROVIDER_ID) {
      setShowAuthPanel(true);
      return;
    }

    setShowAuthPanel(false);
  }, [selectedProviderId, t]);

  React.useEffect(() => {
    if (!selectedProviderId || selectedProviderId === ADD_PROVIDER_ID) {
      return;
    }

    let cancelled = false;

    const loadSources = async () => {
      try {
        // OpenChamber-only metadata endpoint: the SDK exposes provider data but
        // not local auth/source-file provenance used by this settings UI.
        const response = await runtimeFetch(`/api/provider/${encodeURIComponent(selectedProviderId)}/source`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error || t('settings.providers.page.toast.providerSourcesLoadFailed'));
        }

        const sources = (payload?.sources ?? payload?.data?.sources) as ProviderSources | undefined;
        if (!cancelled && sources) {
          setProviderSources((prev) => ({
            ...prev,
            [selectedProviderId]: sources,
          }));
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load provider sources:', error);
        }
      }
    };

    loadSources();

    return () => {
      cancelled = true;
    };
  }, [selectedProviderId, t]);

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
  const selectedSources = selectedProviderId ? providerSources[selectedProviderId] : undefined;

  const handleSaveApiKey = useEvent(async (providerId: string) => {
    const apiKey = apiKeyInputs[providerId]?.trim() ?? '';
    if (!apiKey) {
      toast.error(t('settings.providers.page.toast.apiKeyRequired'));
      return;
    }

    const scope = captureMutationScope();
    if (!scope) return;
    const busyKey = `api:${providerId}`;
    setAuthBusyKey(busyKey);

    try {
      const integrationID = integrationIdByProvider[providerId] || providerId;
      await opencodeClient.getSdkClient().integration.connect.key({
        integrationID,
        key: apiKey,
        location: scope.location,
      }, { signal: scope.signal });
      if (!scope.isCurrent()) return;

      setApiKeyInputs((prev) => ({ ...prev, [providerId]: '' }));
      await refreshOpenCodeConfiguration({ scopes: ['providers'], mode: 'active', queryDirectory: scope.directory, transportIdentity: scope.transportIdentity });
      if (!scope.isCurrent()) return;
      const refreshed = await connectionQuery.refetch({ throwOnError: true });
      if (!scope.isCurrent()) return;
      const connected = refreshed.data?.providers.find((provider) =>
        provider.id === providerId || provider.integrationID === integrationID);
      if (connected) setSelectedProvider(connected.id);
      toast.success(t('settings.providers.page.toast.apiKeySaved'));
    } catch {
      if (scope.isCurrent()) toast.error(t('settings.providers.page.toast.apiKeySaveFailed'));
    } finally {
      if (scope.isCurrent()) setAuthBusyKey(null);
    }
  });

  const handleOAuthStart = useEvent(async (providerId: string, methodIndex: number) => {
    clearOAuth();
    const busyKey = `oauth:${providerId}:${methodIndex}`;
    setAuthBusyKey(busyKey);
    const method = authMethodsByProvider[providerId]?.[methodIndex];
    const methodID = typeof method?.id === 'string' ? method.id : '';
    if (!methodID) {
      setAuthBusyKey(null);
      toast.error(t('settings.providers.page.toast.oauthStartFailed'));
      return;
    }
    const integrationID = integrationIdByProvider[providerId] || providerId;
    const flow = createProviderOAuthFlow({
      integrationID,
      onAttempt: ({ attemptID, mode, url, instructions }) => {
        setOauthDetails({ [`${providerId}:${methodIndex}`]: {
          url, instructions, mode, userCode: /[A-Z0-9]{4}-[A-Z0-9]{4,5}/.exec(instructions)?.[0],
        } });
        setPendingOAuth({ providerId, methodIndex, methodID, attemptID, mode });
        if (mode === 'code') setAuthBusyKey(null);
        if (url && integrationID !== 'claude-code') void openExternalUrl(url);
        toast.message(t('settings.providers.page.toast.completeOAuthInBrowser'));
      },
      onSuccess: async () => {
        setPendingOAuth(null);
        setOauthDetails({});
        setOauthCodes({});
        await refreshOpenCodeConfiguration({ scopes: ['providers'], mode: 'active' });
        if (!flow.isCurrent() || oauthFlow.current !== flow) return;
        const refreshed = await connectionQuery.refetch({ throwOnError: true });
        if (!flow.isCurrent() || oauthFlow.current !== flow) return;
        toast.success(t('settings.providers.page.toast.oauthCompleted'));
        // Integration IDs can differ from the activated provider ID.
        const connected = refreshed.data?.providers.find((provider) =>
          provider.id === providerId || provider.integrationID === integrationID);
        if (connected) setSelectedProvider(connected.id);
        setAuthBusyKey(null);
      },
      onError: (phase) => {
        setAuthBusyKey(null);
        setPendingOAuth(null);
        setOauthDetails({});
        setOauthCodes({});
        toast.error(t(phase === 'start' ? 'settings.providers.page.toast.oauthStartFailed' : 'settings.providers.page.toast.oauthCompleteFailed'));
      },
    });
    oauthFlow.current = flow;
    await flow.start(methodID);
  });

  const handleOAuthComplete = useEvent(async (providerId: string, methodIndex: number) => {
    const codeKey = `${providerId}:${methodIndex}`;
    const code = oauthCodes[codeKey]?.trim();
    if (!code || pendingOAuth?.mode !== 'code' || pendingOAuth.providerId !== providerId || pendingOAuth.methodIndex !== methodIndex) return;
    setAuthBusyKey(`oauth-complete:${providerId}:${methodIndex}`);
    await oauthFlow.current?.complete(code);
  });

  const handleCopyOAuthLink = async (url: string) => {
    const result = await copyTextToClipboard(url);
    if (result.ok) {
      toast.success(t('settings.providers.page.toast.oauthLinkCopied'));
      return;
    }
    toast.error(t('settings.providers.page.toast.oauthLinkCopyFailed'));
  };

  const handleCopyOAuthCode = async (code: string) => {
    const result = await copyTextToClipboard(code);
    if (result.ok) {
      toast.success(t('settings.providers.page.toast.deviceCodeCopied'));
      return;
    }
    toast.error(t('settings.providers.page.toast.deviceCodeCopyFailed'));
  };

  const handleDisconnectProvider = useEvent(async (providerId: string) => {
    const scope = captureMutationScope();
    if (!scope) return;
    const busyKey = `disconnect:${providerId}`;
    setAuthBusyKey(busyKey);

    try {
      const client = opencodeClient.getSdkClient();
      const integrationID = integrationIdByProvider[providerId] || providerId;
      const integration = await client.integration.get({ integrationID, location: scope.location }, { signal: scope.signal });
      if (!scope.isCurrent()) return;
      const connections = Array.isArray(integration.data?.connections) ? integration.data.connections : [];
      const credentialIds = connections.flatMap((connection) => (
        connection.type === 'credential' && typeof connection.id === 'string' && connection.id
          ? [connection.id]
          : []
      ));
      if (credentialIds.length === 0) {
        throw new Error(t('settings.providers.page.toast.providerDisconnectFailed'));
      }
      // Credentials are runtime-global in OpenCode 2; IDs come from the scoped integration read.
      await Promise.all(credentialIds.map((credentialID) => client.credential.remove({ credentialID }, { signal: scope.signal })));
      if (!scope.isCurrent()) return;

      await refreshOpenCodeConfiguration({ scopes: ['providers'], mode: 'active', queryDirectory: scope.directory, transportIdentity: scope.transportIdentity });
      if (!scope.isCurrent()) return;
      await connectionQuery.refetch({ throwOnError: true });
      if (!scope.isCurrent()) return;
      toast.success(t('settings.providers.page.toast.providerDisconnected'));
    } catch {
      if (scope.isCurrent()) toast.error(t('settings.providers.page.toast.providerDisconnectFailed'));
    } finally {
      if (scope.isCurrent()) setAuthBusyKey(null);
    }
  });

  if (!isAddMode && providers.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <Icon name="stack" className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{t('settings.providers.page.empty.noProvidersDetected')}</p>
          <p className="typography-meta mt-1 opacity-75">{t('settings.providers.page.empty.checkOpenCodeConfiguration')}</p>
        </div>
      </div>
    );
  }

  if (isAddMode) {
    return (
      <ScrollableOverlay outerClassName="h-full" className="w-full">
        <div className="oc-settings-section-stack mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">
          <div data-settings-item="providers.connect">
            <h1 className="typography-ui-header font-semibold text-foreground">{t('settings.providers.page.connect.title')}</h1>
          </div>

          <ProviderSettingsSection label={t('settings.providers.page.connect.selectProviderTitle')}>
              {availableError && <p role="alert" className="typography-meta text-muted-foreground">{availableError}</p>}
              <div className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="typography-ui-label text-foreground">{t('settings.providers.page.connect.providerField')}</span>
                  {availableLoading ? (
                    <p className="typography-meta text-muted-foreground">{t('settings.providers.page.state.loading')}</p>
                  ) : availableError && !connectionQuery.data ? (
                    <Button variant="outline" size="xs" onClick={() => void connectionQuery.refetch()}>{t('settings.providers.page.actions.reconnect')}</Button>
                  ) : unconnectedProviders.length === 0 ? (
                    <p className="typography-meta text-muted-foreground">{t('settings.providers.page.connect.allProvidersConnected')}</p>
                  ) : (
                    <DropdownMenu open={providerDropdownOpen} onOpenChange={(open) => {
                      setProviderDropdownOpen(open);
                      if (!open) setProviderSearchQuery('');
                    }}>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className={cn(
                            "flex items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-2 py-2 typography-ui-label whitespace-nowrap shadow-none outline-none hover:bg-interactive-hover h-6 w-fit",
                          )}
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            {candidateProviderId ? <ProviderLogo providerId={candidateProviderId} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
                            <span className={cn("truncate typography-ui-label font-normal", candidateProviderId ? "text-foreground" : "text-muted-foreground")}>
                              {candidateProviderId
                                ? (unconnectedProviders.find(p => p.id === candidateProviderId)?.name || candidateProviderId)
                                : t('settings.providers.page.connect.selectProviderPlaceholder')}
                            </span>
                          </span>
                          <Icon name="arrow-down-s" className="h-4 w-4 flex-shrink-0 text-muted-foreground/50" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="start"
                        className="w-[280px] p-0"
                        onCloseAutoFocus={(e) => e.preventDefault()}
                      >
                        <div
                          className="flex items-center gap-2 border-b border-[var(--surface-subtle)] px-3 py-2"
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <Icon name="search" className="h-4 w-4 text-muted-foreground" />
                          <input
                            type="text"
                            value={providerSearchQuery}
                            onChange={(e) => setProviderSearchQuery(e.target.value)}
                            onKeyDown={(e) => e.stopPropagation()}
                            placeholder={t('settings.providers.page.connect.searchProvidersPlaceholder')}
                            className="flex-1 bg-transparent typography-meta outline-none placeholder:text-muted-foreground"
                            autoFocus
                          />
                        </div>
                        <ScrollableOverlay outerClassName="max-h-[240px]" className="p-1">
                          {(() => {
                            const filtered = unconnectedProviders.filter(p => {
                              const query = providerSearchQuery.toLowerCase();
                              return (p.name || p.id).toLowerCase().includes(query) || p.id.toLowerCase().includes(query);
                            });
                            if (filtered.length === 0) {
                              return <p className="py-4 text-center typography-meta text-muted-foreground">{t('settings.providers.page.connect.noProvidersFound')}</p>;
                            }
                            return filtered.map((provider) => (
                              <DropdownMenuItem
                                key={provider.id}
                                onSelect={() => {
                                  setCandidateProviderId(provider.id);
                                  setProviderDropdownOpen(false);
                                  setProviderSearchQuery('');
                                }}
                                className="flex items-center justify-between"
                              >
                                <span className="flex items-center gap-2 min-w-0">
                                  <ProviderLogo providerId={provider.id} className="h-4 w-4 flex-shrink-0" />
                                  <span className="truncate">{provider.name || provider.id}</span>
                                </span>
                                {candidateProviderId === provider.id && (
                                  <Icon name="check" className="h-4 w-4 text-[var(--primary-base)]" />
                                )}
                              </DropdownMenuItem>
                            ));
                          })()}
                        </ScrollableOverlay>
                      </DropdownMenuContent>
                    </DropdownMenu>
                   )}
              </div>
          </ProviderSettingsSection>

          {candidateProviderId && (
            <ProviderSettingsSection itemId="providers.auth" label={t('settings.providers.page.auth.title')}>
              {authLoading ? (
                <p className="typography-meta text-muted-foreground">{t('settings.providers.page.auth.loadingMethods')}</p>
              ) : (
                <div className="space-y-4">
                  <div className="py-1.5">
                    <label className="typography-ui-label text-foreground flex items-center gap-1.5">
                      {t('settings.providers.page.auth.apiKeyLabel')}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent sideOffset={8} className="max-w-xs">
                          {t('settings.providers.page.auth.apiKeyTooltip')}
                        </TooltipContent>
                      </Tooltip>
                    </label>
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2 mt-1.5">
                      <Input
                        type="password"
                        value={apiKeyInputs[candidateProviderId] ?? ''}
                        onChange={(event) =>
                          setApiKeyInputs((prev) => ({
                            ...prev,
                            [candidateProviderId]: event.target.value,
                          }))
                        }
                        placeholder={t('settings.providers.page.auth.apiKeyPlaceholder')}
                        className="flex-1 font-mono text-xs"
                      />
                      <Button
                        size="xs"
                        className="!font-normal shrink-0"
                        onClick={() => handleSaveApiKey(candidateProviderId)}
                        disabled={authBusyKey === `api:${candidateProviderId}`}
                      >
                        {authBusyKey === `api:${candidateProviderId}` ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.saveKey')}
                      </Button>
                    </div>
                  </div>

                  {(() => {
                    const candidateAuthMethods = authMethodsByProvider[candidateProviderId] ?? [];
                    const candidateOAuthMethods = filterMethodsWithIndex(
                      candidateAuthMethods,
                      (method) => normalizeAuthType(method) === 'oauth'
                    );

                    if (candidateOAuthMethods.length === 0) {
                      return null;
                    }

                    return (
                      <div className="space-y-4 border-t border-[var(--surface-subtle)] pt-2">
                        {candidateOAuthMethods.map(({ method, methodIndex }, index) => {
                          const methodLabel = method.label || method.name || t('settings.providers.page.auth.oauthMethodFallback', { index: String(index + 1) });
                          const codeKey = `${candidateProviderId}:${methodIndex}`;
                          const isPending =
                            pendingOAuth?.providerId === candidateProviderId && pendingOAuth?.methodIndex === methodIndex;

                          return (
                            <div key={`${candidateProviderId}-${methodLabel}`} className="space-y-3">
                              <div className="flex items-center justify-between gap-2">
                                <div>
                                  <div className="typography-ui-label text-foreground">{methodLabel}</div>
                                  {(method.description || method.help) && (
                                    <div className="typography-meta text-muted-foreground">
                                      {String(method.description || method.help)}
                                    </div>
                                  )}
                                </div>
                                <Button
                                  variant="outline"
                                  size="xs"
                                  className="!font-normal"
                                  onClick={() => handleOAuthStart(candidateProviderId, methodIndex)}
                                  disabled={
                                    authBusyKey === `oauth:${candidateProviderId}:${methodIndex}` ||
                                    authBusyKey === `oauth-complete:${candidateProviderId}:${methodIndex}`
                                  }
                                >
                                  {isPending && pendingOAuth.mode === 'auto' ? t('settings.providers.page.state.loading') : t('settings.providers.page.actions.connect')}
                                </Button>
                                {isPending && <Button variant="ghost" size="xs" onClick={clearOAuth}>{t('settings.common.actions.cancel')}</Button>}
                              </div>

                              {oauthDetails[codeKey]?.instructions && (
                                <p className="typography-meta text-[var(--primary-base)] bg-[var(--primary-base)]/10 px-2 py-1.5 rounded">
                                  {oauthDetails[codeKey]?.instructions}
                                </p>
                              )}

                              {oauthDetails[codeKey]?.userCode && (
                                <div className="flex items-center gap-2 mt-2">
                                  <Input value={oauthDetails[codeKey]?.userCode} readOnly className="font-mono text-center tracking-widest" />
                                  <Button variant="outline" size="xs" className="!font-normal" onClick={() => handleCopyOAuthCode(oauthDetails[codeKey]?.userCode ?? '')}>{t('settings.providers.page.actions.copyCode')}</Button>
                                </div>
                              )}

                              {oauthDetails[codeKey]?.url && (
                                <div className="flex items-center gap-2 mt-2">
                                  <Input value={oauthDetails[codeKey]?.url} readOnly className="text-xs text-muted-foreground" />
                                  <div className="flex gap-1 shrink-0">
                                    <Button variant="outline" size="xs" className="!font-normal" onClick={() => openExternalUrl(oauthDetails[codeKey]?.url ?? '')}>{t('settings.providers.page.actions.open')}</Button>
                                    <Button variant="outline" size="xs" className="!font-normal" onClick={() => handleCopyOAuthLink(oauthDetails[codeKey]?.url ?? '')}>{t('settings.providers.page.actions.copy')}</Button>
                                  </div>
                                </div>
                              )}

                              {isPending && pendingOAuth?.mode === 'code' && (
                                <div className="flex items-center gap-2 mt-2">
                                  <Input
                                    value={oauthCodes[codeKey] ?? ''}
                                    onChange={(event) =>
                                      setOauthCodes((prev) => ({
                                        ...prev,
                                        [codeKey]: event.target.value,
                                      }))
                                    }
                                    placeholder={t('settings.providers.page.auth.pasteAuthorizationCodePlaceholder')}
                                    className="font-mono text-xs"
                                  />
                                  <Button
                                    size="xs"
                                    className="!font-normal"
                                    onClick={() => handleOAuthComplete(candidateProviderId, methodIndex)}
                                    disabled={authBusyKey === `oauth-complete:${candidateProviderId}:${methodIndex}`}
                                  >
                                    {authBusyKey === `oauth-complete:${candidateProviderId}:${methodIndex}` ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.complete')}
                                  </Button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              )}
            </ProviderSettingsSection>
          )}
        </div>
      </ScrollableOverlay>
    );
  }

  if (!selectedProvider) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <Icon name="stack" className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{t('settings.providers.page.empty.selectProviderFromSidebar')}</p>
          <p className="typography-meta mt-1 opacity-75">{t('settings.providers.page.empty.reviewDetailsAndConfigureAuth')}</p>
        </div>
      </div>
    );
  }

  const providerModels = Array.isArray(selectedProvider.models) ? selectedProvider.models : [];
  const providerAuthMethods = authMethodsByProvider[selectedProvider.id] ?? [];
  const oauthAuthMethods = filterMethodsWithIndex(
    providerAuthMethods,
    (method) => normalizeAuthType(method) === 'oauth'
  );

  const filteredModels = providerModels.filter((model) => {
    const name = typeof model?.name === 'string' ? model.name : '';
    const id = typeof model?.id === 'string' ? model.id : '';
    const query = modelQuery.trim().toLowerCase();
    if (!query) return true;
    return name.toLowerCase().includes(query) || id.toLowerCase().includes(query);
  });

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="oc-settings-section-stack mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">

        {/* Header */}
        <div className="flex items-center gap-3">
          <ProviderLogo providerId={selectedProvider.id} className="h-5 w-5 shrink-0" />
          <div className="min-w-0">
            <h2 className="typography-ui-header font-semibold text-foreground truncate">
              {selectedProvider.name || selectedProvider.id}
            </h2>
            <p className="typography-meta text-muted-foreground truncate">
              <span className="font-mono">{selectedProvider.id}</span>
            </p>
          </div>
        </div>

        {/* Authentication */}
        <ProviderSettingsSection
          itemId="providers.auth"
          label={t('settings.providers.page.auth.title')}
          action={(
            <Button
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => { clearOAuth(); setShowAuthPanel((prev) => !prev); }}
            >
              {showAuthPanel ? t('settings.providers.page.actions.hide') : t('settings.providers.page.actions.reconnect')}
            </Button>
          )}
        >
            {!showAuthPanel ? (
              <div className="flex items-center gap-1.5 py-1.5">
                <Icon name="check" className="w-4 h-4 text-[var(--status-success)] shrink-0" />
                <span className="typography-ui-label text-foreground">{t('settings.providers.page.auth.connected')}</span>
                <span className="typography-meta text-muted-foreground ml-1">{t('settings.providers.page.auth.useReconnectHint')}</span>
              </div>
            ) : authLoading ? (
              <div className="py-1.5 typography-meta text-muted-foreground">{t('settings.providers.page.auth.loadingMethods')}</div>
            ) : (
              <div className="space-y-4">
                <div className="py-1.5">
                  <label className="typography-ui-label text-foreground flex items-center gap-1.5">
                    {t('settings.providers.page.auth.apiKeyLabel')}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent sideOffset={8} className="max-w-xs">
                        {t('settings.providers.page.auth.apiKeyTooltip')}
                      </TooltipContent>
                    </Tooltip>
                  </label>
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 mt-1.5">
                    <Input
                      type="password"
                      value={apiKeyInputs[selectedProvider.id] ?? ''}
                      onChange={(event) =>
                        setApiKeyInputs((prev) => ({
                          ...prev,
                          [selectedProvider.id]: event.target.value,
                        }))
                      }
                      placeholder={t('settings.providers.page.auth.apiKeyPlaceholder')}
                      className="flex-1 font-mono text-xs"
                    />
                    <Button
                      size="xs"
                      className="!font-normal shrink-0"
                      onClick={() => handleSaveApiKey(selectedProvider.id)}
                      disabled={authBusyKey === `api:${selectedProvider.id}`}
                    >
                      {authBusyKey === `api:${selectedProvider.id}` ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.saveKey')}
                    </Button>
                  </div>
                </div>

                {oauthAuthMethods.length > 0 && (
                  <div className="space-y-4 border-t border-[var(--surface-subtle)] pt-2">
                    {oauthAuthMethods.map(({ method, methodIndex }, index) => {
                      const methodLabel = method.label || method.name || t('settings.providers.page.auth.oauthMethodFallback', { index: String(index + 1) });
                      const codeKey = `${selectedProvider.id}:${methodIndex}`;
                      const isPending =
                        pendingOAuth?.providerId === selectedProvider.id && pendingOAuth?.methodIndex === methodIndex;

                      return (
                        <div key={`${selectedProvider.id}-${methodLabel}`} className="space-y-3">
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <div className="typography-ui-label text-foreground">{methodLabel}</div>
                              {(method.description || method.help) && (
                                <div className="typography-meta text-muted-foreground">
                                  {String(method.description || method.help)}
                                </div>
                              )}
                            </div>
                            <Button
                              variant="outline"
                              size="xs"
                              className="!font-normal"
                              onClick={() => handleOAuthStart(selectedProvider.id, methodIndex)}
                              disabled={
                                authBusyKey === `oauth:${selectedProvider.id}:${methodIndex}` ||
                                authBusyKey === `oauth-complete:${selectedProvider.id}:${methodIndex}`
                              }
                            >
                              {isPending && pendingOAuth.mode === 'auto' ? t('settings.providers.page.state.loading') : t('settings.providers.page.actions.connect')}
                            </Button>
                            {isPending && <Button variant="ghost" size="xs" onClick={clearOAuth}>{t('settings.common.actions.cancel')}</Button>}
                          </div>

                          {oauthDetails[codeKey]?.instructions && (
                            <p className="typography-meta text-[var(--primary-base)] bg-[var(--primary-base)]/10 px-2 py-1.5 rounded">
                              {oauthDetails[codeKey]?.instructions}
                            </p>
                          )}

                          {oauthDetails[codeKey]?.userCode && (
                            <div className="flex items-center gap-2 mt-2">
                              <Input value={oauthDetails[codeKey]?.userCode} readOnly className="font-mono text-center tracking-widest" />
                              <Button variant="outline" size="xs" className="!font-normal" onClick={() => handleCopyOAuthCode(oauthDetails[codeKey]?.userCode ?? '')}>{t('settings.providers.page.actions.copyCode')}</Button>
                            </div>
                          )}

                          {oauthDetails[codeKey]?.url && (
                            <div className="flex items-center gap-2 mt-2">
                              <Input value={oauthDetails[codeKey]?.url} readOnly className="text-xs text-muted-foreground" />
                              <div className="flex gap-1 shrink-0">
                                <Button variant="outline" size="xs" className="!font-normal" onClick={() => openExternalUrl(oauthDetails[codeKey]?.url ?? '')}>{t('settings.providers.page.actions.open')}</Button>
                                <Button variant="outline" size="xs" className="!font-normal" onClick={() => handleCopyOAuthLink(oauthDetails[codeKey]?.url ?? '')}>{t('settings.providers.page.actions.copy')}</Button>
                              </div>
                            </div>
                          )}

                          {isPending && pendingOAuth?.mode === 'code' && (
                            <div className="flex items-center gap-2 mt-2">
                              <Input
                                value={oauthCodes[codeKey] ?? ''}
                                onChange={(event) =>
                                  setOauthCodes((prev) => ({
                                    ...prev,
                                    [codeKey]: event.target.value,
                                  }))
                                }
                                placeholder={t('settings.providers.page.auth.pasteAuthorizationCodePlaceholder')}
                                className="font-mono text-xs"
                              />
                              <Button
                                size="xs"
                                className="!font-normal"
                                onClick={() => handleOAuthComplete(selectedProvider.id, methodIndex)}
                                disabled={authBusyKey === `oauth-complete:${selectedProvider.id}:${methodIndex}`}
                              >
                                {authBusyKey === `oauth-complete:${selectedProvider.id}:${methodIndex}` ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.complete')}
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
        </ProviderSettingsSection>

        {(selectedProvider.id === 'opencode' || selectedProvider.id === 'opencode-go') && <QuotaCredentials providerId="opencode-go" providerName="OpenCode Go" />}
        {(selectedProvider.id === 'ollama' || selectedProvider.id === 'ollama-cloud') && <QuotaCredentials providerId="ollama-cloud" providerName="Ollama Cloud" />}
        {selectedProvider.id === 'cursor' && <QuotaCredentials providerId="cursor" providerName="Cursor" />}

        {/* Connection Details */}
        <ProviderSettingsSection
          itemId="providers.connection-details"
          label={t('settings.providers.page.connectionDetails.title')}
        >
            <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
              <div className="flex min-w-0 flex-col">
                {selectedSources && (selectedSources.auth.exists || selectedSources.user.exists || selectedSources.project.exists || selectedSources.custom?.exists) ? (
                  <span className="typography-meta text-muted-foreground">
                    {t('settings.providers.page.connectionDetails.configuredIn')}{' '}
                    {[
                      selectedSources.auth.exists ? t('settings.providers.page.connectionDetails.source.authCredentials') : null,
                      selectedSources.user.exists ? t('settings.providers.page.connectionDetails.source.userConfig') : null,
                      selectedSources.project.exists ? t('settings.providers.page.connectionDetails.source.projectConfig') : null,
                      selectedSources.custom?.exists ? t('settings.providers.page.connectionDetails.source.customConfig') : null,
                    ].filter(Boolean).join(', ')}
                  </span>
                ) : (
                  <span className="typography-meta text-muted-foreground">{t('settings.providers.page.connectionDetails.noActiveSource')}</span>
                )}
              </div>

              <Button
                variant="ghost"
                size="xs"
                className="!font-normal text-[var(--status-error)] hover:text-[var(--status-error)]"
                onClick={() => handleDisconnectProvider(selectedProvider.id)}
                disabled={authBusyKey === `disconnect:${selectedProvider.id}`}
              >
                {authBusyKey === `disconnect:${selectedProvider.id}` ? t('settings.providers.page.actions.disconnecting') : t('settings.providers.page.actions.disconnect')}
              </Button>
            </div>
        </ProviderSettingsSection>

        {/* Models */}
        <ProviderSettingsSection
          itemId="providers.models"
          label={(
            <>
              {t('settings.providers.page.models.title')}
              {providerModels.length > 0 && (
                <span className="ml-1.5 typography-micro text-muted-foreground font-normal">
                  ({providerModels.length})
                </span>
              )}
            </>
          )}
          action={(
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => {
                  const allIds = providerModels
                    .map((model) => (typeof model?.id === 'string' ? model.id : ''))
                    .filter((id) => id.length > 0);
                  hideAllModels(selectedProvider.id, allIds);
                }}
              >
                {t('settings.providers.page.actions.hideAll')}
              </Button>
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => showAllModels(selectedProvider.id)}
              >
                {t('settings.providers.page.actions.showAll')}
              </Button>
            </div>
          )}
        >
            <div className="relative mb-2">
              <Icon name="search" className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={modelQuery}
                onChange={(event) => setModelQuery(event.target.value)}
                placeholder={t('settings.providers.page.models.filterPlaceholder')}

                className="h-7 pl-8 w-full"
              />
            </div>

            {filteredModels.length === 0 ? (
              <p className="typography-meta text-muted-foreground py-4 text-center">{t('settings.providers.page.models.noModelsMatchFilter')}</p>
            ) : (
              <div className="divide-y divide-[var(--surface-subtle)]">
                {filteredModels.map((model) => {
                  const modelId = typeof model?.id === 'string' ? model.id : '';
                  const modelName = typeof model?.name === 'string' ? model.name : modelId;
                  const metadata = modelId ? getModelMetadata(selectedProvider.id, modelId) as ModelMetadata | undefined : undefined;
                  const isHidden = hiddenModels.some(
                    (item) => item.providerID === selectedProvider.id && item.modelID === modelId
                  );

                  const contextTokens = formatTokens(metadata?.limit?.context);
                  const outputTokens = formatTokens(metadata?.limit?.output);

                  const capabilityIcons: Array<{ key: string; icon: IconName; label: string }> = [];
                  if (metadata?.tool_call) capabilityIcons.push({ key: 'tools', icon: "tools", label: t('settings.providers.page.models.capability.toolCalling') });
                  if (metadata?.reasoning) capabilityIcons.push({ key: 'reasoning', icon: "brain-ai-3", label: t('settings.providers.page.models.capability.reasoning') });
                  if (metadata?.attachment) capabilityIcons.push({ key: 'image', icon: "file-image", label: t('settings.providers.page.models.capability.imageInput') });

                  return (
                    <div key={modelId} className="py-1.5">
                      <div
                        className={cn(
                          "flex flex-wrap items-center gap-x-3 gap-y-1.5 md:flex-nowrap md:gap-3",
                          isHidden && 'opacity-50',
                        )}
                      >
                      <span className="typography-meta font-medium text-foreground truncate w-full min-w-0 md:w-auto md:flex-1">
                        {modelName}
                      </span>
                      <div className="flex w-full flex-wrap items-center gap-2 flex-shrink-0 md:w-auto md:flex-nowrap">
                        {(contextTokens || outputTokens) && (
                          <span className="typography-micro text-muted-foreground flex-shrink-0 bg-[var(--surface-muted)] px-1.5 py-0.5 rounded">
                            {contextTokens ? `${contextTokens} ${t('settings.providers.page.models.tokenBadge.context')}` : ''}
                            {contextTokens && outputTokens ? ' · ' : ''}
                            {outputTokens ? `${outputTokens} ${t('settings.providers.page.models.tokenBadge.output')}` : ''}
                          </span>
                        )}
                        {capabilityIcons.length > 0 && (
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {capabilityIcons.map(({ key, icon: iconName, label }) => (
                              <span
                                key={key}
                                className="flex h-5 w-5 rounded items-center justify-center text-muted-foreground bg-[var(--surface-muted)]"
                                title={label}
                                aria-label={label}
                              >
                                <Icon name={iconName} className="h-3 w-3" />
                              </span>
                            ))}
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => toggleHiddenModel(selectedProvider.id, modelId)}
                          className="ml-auto flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]/50 md:ml-0"
                          title={isHidden ? t('settings.providers.page.models.actions.showModelInSelectors') : t('settings.providers.page.models.actions.hideModelFromSelectors')}
                          aria-label={isHidden ? t('settings.providers.page.models.actions.showModel') : t('settings.providers.page.models.actions.hideModel')}
                        >
                          {isHidden ? <Icon name="eye-off" className="h-3.5 w-3.5" /> : <Icon name="eye" className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
        </ProviderSettingsSection>
      </div>
    </ScrollableOverlay>
  );
};
