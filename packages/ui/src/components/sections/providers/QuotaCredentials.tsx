import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import { refreshOpenCodeConfiguration } from '@/stores/useAgentsStore';
import { SettingsGroup } from '@/components/sections/shared/SettingsGroup';
import { providerConnectionQueryOptions } from './providerConnectionQueries';
import { createProviderOAuthFlow } from './providerOAuth';
import {
  consoleAccountConnected,
  findSignInIntegration,
  getSignInIntegrationId,
  signInOAuthMethods,
} from './providerSignIn';

type ProviderId = 'opencode-go' | 'ollama-cloud' | 'cursor';
type Status = { configured: boolean; workspaceId?: string; secretMasked?: string };
type ConsoleAttempt = { methodID: string; mode: 'auto' | 'code'; url?: string; instructions?: string; userCode?: string };

export const QuotaCredentials: React.FC<{ providerId: ProviderId; providerName: string }> = ({ providerId, providerName }) => {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<Status | null>(null);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [consoleAttempt, setConsoleAttempt] = React.useState<ConsoleAttempt | null>(null);
  const [consoleCode, setConsoleCode] = React.useState('');
  const [consoleBusy, setConsoleBusy] = React.useState(false);
  const consoleFlow = React.useRef<ReturnType<typeof createProviderOAuthFlow> | null>(null);
  const connectionQuery = useQuery({ ...providerConnectionQueryOptions(), enabled: providerId === 'opencode-go' });
  const route = `/api/quota/credentials/${providerId}`;
  const consoleIntegration = providerId === 'opencode-go'
    ? findSignInIntegration(providerId, connectionQuery.data?.integrations)
    : undefined;
  const consoleConnected = consoleAccountConnected(consoleIntegration);
  const consoleMethods = signInOAuthMethods(consoleIntegration);

  React.useEffect(() => { void runtimeFetch(route).then(async (response) => {
    if (!response.ok) throw new Error();
    const next = await response.json() as Status;
    setStatus(next); setValues(next.workspaceId ? { workspaceId: next.workspaceId } : {});
  }).catch(() => setStatus({ configured: false })); }, [route]);

  const clearConsoleFlow = useEvent(() => {
    consoleFlow.current?.cancel();
    consoleFlow.current = null;
    setConsoleAttempt(null);
    setConsoleCode('');
    setConsoleBusy(false);
  });
  React.useEffect(() => () => { consoleFlow.current?.cancel(); consoleFlow.current = null; }, []);

  const request = async (path: string, method: string, body?: object) => {
    setBusy(true);
    try {
      const response = await runtimeFetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error);
      if (payload?.configured !== undefined) setStatus(payload);
      setValues((current) => current.workspaceId ? { workspaceId: current.workspaceId } : {} as Record<string, string>);
      toast.success(t('settings.providers.page.quotaCredentials.saved', { provider: providerName }));
    } catch (error) { toast.error(error instanceof Error && error.message ? error.message : t('settings.providers.page.openCodeGo.saveFailed')); }
    finally { setBusy(false); }
  };

  const startConsoleSignIn = useEvent(async (methodID: string) => {
    const integrationID = getSignInIntegrationId('opencode-go');
    if (!methodID || integrationID === 'opencode-go') {
      toast.error(t('settings.providers.page.toast.oauthStartFailed'));
      return;
    }
    clearConsoleFlow();
    setConsoleBusy(true);
    const flow = createProviderOAuthFlow({
      integrationID,
      onAttempt: ({ mode, url, instructions }) => {
        setConsoleAttempt({
          methodID,
          mode,
          url,
          instructions,
          userCode: /[A-Z0-9]{4}-[A-Z0-9]{4,5}/.exec(instructions)?.[0],
        });
        if (mode === 'code') setConsoleBusy(false);
        if (url) void openExternalUrl(url);
        toast.message(t('settings.providers.page.toast.completeOAuthInBrowser'));
      },
      onSuccess: async () => {
        setConsoleAttempt(null);
        setConsoleCode('');
        setConsoleBusy(false);
        try {
          await refreshOpenCodeConfiguration({ scopes: ['providers'], mode: 'active' });
          if (!flow.isCurrent() || consoleFlow.current !== flow) return;
          await connectionQuery.refetch({ throwOnError: true });
        } catch {
          if (flow.isCurrent() && consoleFlow.current === flow) {
            toast.error(t('settings.providers.page.toast.authMethodsLoadFailed'));
          }
        }
        if (!flow.isCurrent() || consoleFlow.current !== flow) return;
        toast.success(t('settings.providers.page.toast.oauthCompleted'));
      },
      onError: (phase) => {
        setConsoleBusy(false);
        setConsoleAttempt(null);
        setConsoleCode('');
        toast.error(t(phase === 'start' ? 'settings.providers.page.toast.oauthStartFailed' : 'settings.providers.page.toast.oauthCompleteFailed'));
      },
    });
    consoleFlow.current = flow;
    await flow.start(methodID);
  });

  const completeConsoleSignIn = useEvent(async () => {
    if (!consoleCode.trim() || consoleAttempt?.mode !== 'code') return;
    setConsoleBusy(true);
    await consoleFlow.current?.complete(consoleCode);
  });

  const copyValue = useEvent(async (value: string, successKey: 'settings.providers.page.toast.oauthLinkCopied' | 'settings.providers.page.toast.deviceCodeCopied', failureKey: 'settings.providers.page.toast.oauthLinkCopyFailed' | 'settings.providers.page.toast.deviceCodeCopyFailed') => {
    const result = await copyTextToClipboard(value);
    if (result.ok) toast.success(t(successKey));
    else toast.error(t(failureKey));
  });

  const field = (name: string, label: string, placeholder: string) => (
    <label className="oc-settings-group-row flex flex-col gap-1 typography-ui-label text-foreground">
      {label}
      <Input
        className="font-mono text-xs"
        type={name === 'workspaceId' ? 'text' : 'password'}
        autoComplete="off"
        value={values[name] ?? ''}
        onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
        placeholder={status?.secretMasked ?? placeholder}
      />
    </label>
  );
  return (
    <div data-settings-item={`providers.${providerId}-credentials`}>
      <SettingsGroup label={providerName} className="oc-settings-detail-group">
      {providerId === 'opencode-go' && (
        <div className="oc-settings-group-row space-y-3">
          {connectionQuery.isPending ? (
            <p className="typography-meta text-muted-foreground">{t('settings.providers.page.auth.loadingMethods')}</p>
          ) : consoleConnected ? (
            <div className="flex items-start gap-1.5 py-1.5" role="status">
              <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-success)]" />
              <p className="min-w-0 typography-ui-label text-foreground">{t('settings.providers.page.openCodeGo.consoleConnected')}</p>
            </div>
          ) : (
            <>
              <p className="typography-meta text-muted-foreground">{t('settings.providers.page.openCodeGo.consoleHint')}</p>
              {(consoleMethods.length > 0 ? consoleMethods : [{ id: '', label: undefined }]).map((method) => {
                const pending = consoleAttempt?.methodID === method.id;
                return (
                  <div key={method.id || 'console'} className="space-y-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <p className="min-w-0 typography-ui-label text-foreground">{method.label || t('settings.providers.page.openCodeGo.consoleSignIn')}</p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="xs"
                          className="!font-normal w-full sm:w-auto"
                          aria-busy={consoleBusy}
                          disabled={consoleBusy || !method.id}
                          onClick={() => void startConsoleSignIn(method.id)}
                        >
                          {consoleBusy && consoleAttempt?.mode === 'auto'
                            ? t('settings.providers.page.state.loading')
                            : t('settings.providers.page.openCodeGo.consoleSignIn')}
                        </Button>
                        {pending && (
                          <Button variant="ghost" size="xs" className="!font-normal" onClick={clearConsoleFlow}>
                            {t('settings.common.actions.cancel')}
                          </Button>
                        )}
                      </div>
                    </div>
                    {pending && consoleAttempt?.instructions && (
                      <p className="typography-meta text-[var(--primary-base)] bg-[var(--primary-base)]/10 px-2 py-1.5 rounded">
                        {consoleAttempt.instructions}
                      </p>
                    )}
                    {pending && consoleAttempt?.userCode && (
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <Input value={consoleAttempt.userCode} readOnly className="min-w-0 flex-1 font-mono text-center tracking-widest" />
                        <Button variant="outline" size="xs" className="!font-normal" onClick={() => void copyValue(consoleAttempt.userCode ?? '', 'settings.providers.page.toast.deviceCodeCopied', 'settings.providers.page.toast.deviceCodeCopyFailed')}>{t('settings.providers.page.actions.copyCode')}</Button>
                      </div>
                    )}
                    {pending && consoleAttempt?.url && (
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <Input value={consoleAttempt.url} readOnly className="min-w-0 flex-1 text-xs text-muted-foreground" />
                        <div className="flex flex-wrap gap-1">
                          <Button variant="outline" size="xs" className="!font-normal" onClick={() => openExternalUrl(consoleAttempt.url ?? '')}>{t('settings.providers.page.actions.open')}</Button>
                          <Button variant="outline" size="xs" className="!font-normal" onClick={() => void copyValue(consoleAttempt.url ?? '', 'settings.providers.page.toast.oauthLinkCopied', 'settings.providers.page.toast.oauthLinkCopyFailed')}>{t('settings.providers.page.actions.copy')}</Button>
                        </div>
                      </div>
                    )}
                    {pending && consoleAttempt?.mode === 'code' && (
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <Input
                          value={consoleCode}
                          onChange={(event) => setConsoleCode(event.target.value)}
                          placeholder={t('settings.providers.page.auth.pasteAuthorizationCodePlaceholder')}
                          className="min-w-0 flex-1 font-mono text-xs"
                          aria-label={t('settings.providers.page.auth.pasteAuthorizationCodePlaceholder')}
                        />
                        <Button
                          size="xs"
                          className="!font-normal"
                          onClick={() => void completeConsoleSignIn()}
                          disabled={consoleBusy || !consoleCode.trim()}
                        >
                          {consoleBusy ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.complete')}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
      {providerId === 'opencode-go' && field('workspaceId', t('settings.providers.page.openCodeGo.workspaceId'), 'wrk_...')}
      {providerId === 'opencode-go' && field('authCookie', t('settings.providers.page.openCodeGo.authCookie'), 'auth=...')}
      {providerId === 'ollama-cloud' && field('cookie', t('settings.providers.page.openCodeGo.authCookie'), 'session=...')}
      {providerId === 'cursor' && field('accessToken', t('settings.providers.page.auth.apiKeyLabel'), t('settings.providers.page.auth.apiKeyPlaceholder'))}
      {providerId === 'cursor' && field('refreshToken', t('settings.providers.page.auth.apiKeyLabel'), t('settings.providers.page.auth.apiKeyPlaceholder'))}
      <div className="oc-settings-group-row flex flex-wrap gap-2">
        <Button size="xs" disabled={busy} onClick={() => request(route, 'PUT', values)}>{status?.configured ? t('settings.providers.page.openCodeGo.replace') : t('settings.providers.page.openCodeGo.save')}</Button>
        {status?.configured && <Button variant="outline" size="xs" disabled={busy} onClick={() => request(`${route}/validate`, 'POST')}>{t('settings.providers.page.openCodeGo.validate')}</Button>}
        {providerId === 'cursor' && <Button variant="outline" size="xs" disabled={busy} onClick={() => request(`${route}/import`, 'POST')}>{t('settings.providers.page.actions.connect')}</Button>}
        {status?.configured && <Button variant="destructive" size="xs" disabled={busy} onClick={() => request(route, 'DELETE')}>{t('settings.providers.page.openCodeGo.delete')}</Button>}
      </div>
      </SettingsGroup>
    </div>
  );
};
