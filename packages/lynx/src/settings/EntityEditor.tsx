import { useEffect, useState } from 'react';

import { lynxT } from '../i18n/catalog';
import { LynxInput, LynxScrollView, LynxText, LynxView } from '../lynx-elements';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { cssVar } from '../theme/tokens';
import type { LynxCatalogItem } from './catalogs';
import {
  deleteLynxEntity,
  loadLynxEntityDetail,
  saveLynxEntity,
  type LynxEntityDetail,
  type LynxEntityFieldKey,
  type LynxEntityKind,
} from './entityApi';
import {
  completeLynxProviderOAuth,
  loadLynxProviderAuthMethods,
  saveLynxProviderApiKey,
  startLynxProviderOAuth,
  type LynxProviderAuthMethod,
} from './providerAuth';

export type EntityEditorProps = {
  locale: string;
  runtimeFetch: LynxRuntimeFetch | null;
  kind: LynxEntityKind;
  item: LynxCatalogItem;
  directory?: string | null;
  onBack: () => void;
  onMutated?: () => void;
};

const FIELD_ORDER: LynxEntityFieldKey[] = [
  'name',
  'title',
  'path',
  'spec',
  'mode',
  'model',
  'command',
  'description',
  'prompt',
  'instructions',
  'content',
];

/**
 * Detail push for list-backed settings slugs. Save/delete hit Cap CRUD routes;
 * failures surface as banners — never fake-success.
 */
export function LynxEntityEditor({
  locale,
  runtimeFetch,
  kind,
  item,
  directory = null,
  onBack,
  onMutated,
}: EntityEditorProps) {
  const [detail, setDetail] = useState<LynxEntityDetail | null>(null);
  const [fields, setFields] = useState<Partial<Record<LynxEntityFieldKey, string>>>({});
  const [status, setStatus] = useState<'loading' | 'ok' | 'failed' | 'no-runtime' | 'unsupported' | 'not-found'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError(null);
    setNote(null);
    void (async () => {
      const result = await loadLynxEntityDetail(runtimeFetch, kind, item.id, {
        directory,
        listItem: item,
      });
      if (cancelled) return;
      if (result.status === 'ok') {
        setDetail(result.detail);
        setFields({ ...result.detail.fields });
        setStatus('ok');
        return;
      }
      setDetail(null);
      setStatus(result.status);
      if (result.status === 'failed') setError(result.error.message);
    })();
    return () => {
      cancelled = true;
    };
  }, [runtimeFetch, kind, item, directory]);

  const onSave = async () => {
    if (!detail) return;
    setBusy(true);
    setNote(null);
    setError(null);
    const result = await saveLynxEntity(runtimeFetch, detail, fields, { directory });
    setBusy(false);
    if (result.status === 'ok') {
      setNote(lynxT(locale, 'lynx.settings.editor.saved'));
      onMutated?.();
      return;
    }
    if (result.status === 'no-runtime') {
      setError(lynxT(locale, 'lynx.settings.noRuntime'));
      return;
    }
    if (result.status === 'unsupported') {
      setError(result.reason);
      return;
    }
    setError(result.error.message);
  };

  const onDelete = async () => {
    if (!detail) return;
    setBusy(true);
    setNote(null);
    setError(null);
    const result = await deleteLynxEntity(runtimeFetch, detail, { directory });
    setBusy(false);
    if (result.status === 'ok') {
      onMutated?.();
      onBack();
      return;
    }
    if (result.status === 'no-runtime') {
      setError(lynxT(locale, 'lynx.settings.noRuntime'));
      return;
    }
    if (result.status === 'unsupported') {
      setError(result.reason);
      return;
    }
    setError(result.error.message);
  };

  if (status === 'no-runtime') {
    return (
      <LynxView style={{ padding: '16px' }}>
        <BackRow locale={locale} onBack={onBack} title={item.title} />
        <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
          {lynxT(locale, 'lynx.settings.noRuntime')}
        </LynxText>
      </LynxView>
    );
  }
  if (status === 'unsupported') {
    return (
      <LynxView style={{ padding: '16px' }}>
        <BackRow locale={locale} onBack={onBack} title={item.title} />
        <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
          {lynxT(locale, 'lynx.settings.unsupported')}
        </LynxText>
      </LynxView>
    );
  }
  if (status === 'not-found') {
    return (
      <LynxView style={{ padding: '16px' }}>
        <BackRow locale={locale} onBack={onBack} title={item.title} />
        <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
          {lynxT(locale, 'lynx.settings.editor.notFound')}
        </LynxText>
      </LynxView>
    );
  }
  if (status === 'failed') {
    return (
      <LynxView style={{ padding: '16px' }}>
        <BackRow locale={locale} onBack={onBack} title={item.title} />
        <LynxText style={{ color: cssVar('surface.foreground') }}>
          {error || lynxT(locale, 'lynx.settings.loadFailed')}
        </LynxText>
      </LynxView>
    );
  }
  if (status === 'loading' || !detail) {
    return (
      <LynxView style={{ padding: '16px' }}>
        <BackRow locale={locale} onBack={onBack} title={item.title} />
        <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
          {lynxT(locale, 'lynx.settings.loading')}
        </LynxText>
      </LynxView>
    );
  }

  const visibleFields = FIELD_ORDER.filter((key) => fields[key] !== undefined);

  return (
    <LynxScrollView style={{ flexGrow: 1, padding: '16px', backgroundColor: cssVar('surface.background') }}>
      <BackRow locale={locale} onBack={onBack} title={detail.title} />
      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '12px' }}>
        {kind} · {detail.id}
      </LynxText>
      {detail.saveUnsupportedReason ? (
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '12px' }}>
          {detail.saveUnsupportedReason}
        </LynxText>
      ) : null}
      {visibleFields.map((key) => (
        <LynxView key={key} style={{ marginBottom: '12px' }}>
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '4px' }}>
            {key}
          </LynxText>
          <LynxInput
            value={fields[key] ?? ''}
            bindinput={(event) => {
              const value = event.detail?.value ?? '';
              setFields((current) => ({ ...current, [key]: value }));
            }}
            style={{ color: cssVar('surface.foreground'), fontSize: '14px' }}
          />
        </LynxView>
      ))}
      {kind === 'providers' ? (
        <ProviderAuthPanel
          locale={locale}
          runtimeFetch={runtimeFetch}
          providerId={detail.id}
        />
      ) : null}
      <LynxView style={{ flexDirection: 'row', marginTop: '8px' }}>
        {!detail.saveUnsupportedReason ? (
          <LynxView
            bindtap={() => { if (!busy) void onSave(); }}
            style={{ padding: '10px 14px', marginRight: '8px' }}
            accessibility-role="button"
            accessibility-label={lynxT(locale, 'lynx.settings.editor.save')}
          >
            <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600' }}>
              {busy ? lynxT(locale, 'lynx.settings.editor.saving') : lynxT(locale, 'lynx.settings.editor.save')}
            </LynxText>
          </LynxView>
        ) : null}
        <LynxView
          bindtap={() => { if (!busy) void onDelete(); }}
          style={{ padding: '10px 14px' }}
          accessibility-role="button"
          accessibility-label={lynxT(locale, 'lynx.settings.editor.delete')}
        >
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontWeight: '600' }}>
            {lynxT(locale, 'lynx.settings.editor.delete')}
          </LynxText>
        </LynxView>
      </LynxView>
      {error ? (
        <LynxText style={{ color: cssVar('surface.foreground'), marginTop: '12px' }}>{error}</LynxText>
      ) : null}
      {note ? (
        <LynxText style={{ color: cssVar('surface.mutedForeground'), marginTop: '12px' }}>{note}</LynxText>
      ) : null}
    </LynxScrollView>
  );
}

function BackRow({
  locale,
  onBack,
  title,
}: {
  locale: string;
  onBack: () => void;
  title: string;
}) {
  return (
    <LynxView style={{ flexDirection: 'row', alignItems: 'center', marginBottom: '16px' }}>
      <LynxView bindtap={onBack} accessibility-label={lynxT(locale, 'lynx.shell.back')}>
        <LynxText style={{ color: cssVar('primary.base') }}>
          {lynxT(locale, 'lynx.shell.back')}
        </LynxText>
      </LynxView>
      <LynxText
        style={{
          marginLeft: '12px',
          color: cssVar('surface.foreground'),
          fontWeight: '600',
          flexGrow: 1,
        }}
      >
        {title}
      </LynxText>
    </LynxView>
  );
}

function ProviderAuthPanel({
  locale,
  runtimeFetch,
  providerId,
}: {
  locale: string;
  runtimeFetch: LynxRuntimeFetch | null;
  providerId: string;
}) {
  const [methods, setMethods] = useState<LynxProviderAuthMethod[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [oauthCode, setOauthCode] = useState('');
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [oauthInstructions, setOauthInstructions] = useState<string | null>(null);
  const [oauthUserCode, setOauthUserCode] = useState<string | null>(null);
  const [hostSteps, setHostSteps] = useState<string[]>([]);
  const [pendingMethod, setPendingMethod] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await loadLynxProviderAuthMethods(runtimeFetch);
      if (cancelled) return;
      if (result.status === 'ok') {
        setMethods(result.byProvider[providerId] ?? []);
        setLoadError(null);
        return;
      }
      setMethods([]);
      if (result.status === 'no-runtime') {
        setLoadError(lynxT(locale, 'lynx.settings.noRuntime'));
        return;
      }
      setLoadError(result.error.message);
    })();
    return () => { cancelled = true; };
  }, [runtimeFetch, providerId, locale]);

  const onSaveApiKey = async () => {
    setBusy(true);
    setNote(null);
    const result = await saveLynxProviderApiKey(runtimeFetch, providerId, apiKey);
    setBusy(false);
    if (result.status === 'ok') {
      setApiKey('');
      setNote(lynxT(locale, 'lynx.settings.providerAuth.apiKeySaved'));
      return;
    }
    if (result.status === 'no-runtime') {
      setNote(lynxT(locale, 'lynx.settings.noRuntime'));
      return;
    }
    setNote(result.error.message);
  };

  const onStartOAuth = async (methodIndex: number) => {
    setBusy(true);
    setNote(null);
    const result = await startLynxProviderOAuth(runtimeFetch, providerId, methodIndex);
    setBusy(false);
    if (result.status === 'ok') {
      setPendingMethod(methodIndex);
      setOauthUrl(result.url ?? null);
      setOauthInstructions(result.instructions ?? null);
      setOauthUserCode(result.userCode ?? null);
      setHostSteps(result.hostOnlySteps);
      setNote(lynxT(locale, 'lynx.settings.providerAuth.oauthStarted'));
      return;
    }
    if (result.status === 'no-runtime') {
      setNote(lynxT(locale, 'lynx.settings.noRuntime'));
      return;
    }
    setNote(result.error.message);
  };

  const onCompleteOAuth = async () => {
    if (pendingMethod === null) return;
    setBusy(true);
    setNote(null);
    const result = await completeLynxProviderOAuth(runtimeFetch, providerId, pendingMethod, oauthCode);
    setBusy(false);
    if (result.status === 'ok') {
      setNote(lynxT(locale, 'lynx.settings.providerAuth.oauthCompleted'));
      setOauthCode('');
      return;
    }
    if (result.status === 'no-runtime') {
      setNote(lynxT(locale, 'lynx.settings.noRuntime'));
      return;
    }
    setNote(result.error.message);
  };

  const oauthMethods = (methods ?? []).filter((method) => method.type.includes('oauth'));

  return (
    <LynxView style={{ marginBottom: '16px', paddingTop: '8px' }}>
      <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '600', marginBottom: '8px' }}>
        {lynxT(locale, 'lynx.settings.providerAuth.title')}
      </LynxText>
      {loadError ? (
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '8px' }}>
          {loadError}
        </LynxText>
      ) : null}
      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '4px' }}>
        {lynxT(locale, 'lynx.settings.providerAuth.apiKey')}
      </LynxText>
      <LynxInput
        value={apiKey}
        bindinput={(event) => setApiKey(event.detail?.value ?? '')}
        style={{ color: cssVar('surface.foreground'), fontSize: '14px' }}
      />
      <LynxView
        bindtap={() => { if (!busy) void onSaveApiKey(); }}
        style={{ padding: '10px 0' }}
        accessibility-role="button"
      >
        <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600' }}>
          {busy ? lynxT(locale, 'lynx.settings.editor.saving') : lynxT(locale, 'lynx.settings.providerAuth.saveApiKey')}
        </LynxText>
      </LynxView>
      {oauthMethods.map((method) => (
        <LynxView
          key={`oauth-${method.index}`}
          bindtap={() => { if (!busy) void onStartOAuth(method.index); }}
          style={{ padding: '8px 0' }}
          accessibility-role="button"
        >
          <LynxText style={{ color: cssVar('primary.base') }}>
            {lynxT(locale, 'lynx.settings.providerAuth.startOAuth')}: {method.label}
          </LynxText>
        </LynxView>
      ))}
      {oauthUrl ? (
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginTop: '8px' }}>
          {lynxT(locale, 'lynx.settings.providerAuth.oauthUrl')}: {oauthUrl}
        </LynxText>
      ) : null}
      {oauthUserCode ? (
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
          {lynxT(locale, 'lynx.settings.providerAuth.userCode')}: {oauthUserCode}
        </LynxText>
      ) : null}
      {oauthInstructions ? (
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
          {oauthInstructions}
        </LynxText>
      ) : null}
      {hostSteps.map((step) => (
        <LynxText key={step} style={{ color: cssVar('surface.mutedForeground'), fontSize: '11px', marginTop: '4px' }}>
          • {step}
        </LynxText>
      ))}
      {pendingMethod !== null ? (
        <LynxView style={{ marginTop: '8px' }}>
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '4px' }}>
            {lynxT(locale, 'lynx.settings.providerAuth.oauthCode')}
          </LynxText>
          <LynxInput
            value={oauthCode}
            bindinput={(event) => setOauthCode(event.detail?.value ?? '')}
            style={{ color: cssVar('surface.foreground'), fontSize: '14px' }}
          />
          <LynxView
            bindtap={() => { if (!busy) void onCompleteOAuth(); }}
            style={{ padding: '10px 0' }}
            accessibility-role="button"
          >
            <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600' }}>
              {lynxT(locale, 'lynx.settings.providerAuth.completeOAuth')}
            </LynxText>
          </LynxView>
        </LynxView>
      ) : null}
      {note ? (
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginTop: '8px' }}>
          {note}
        </LynxText>
      ) : null}
    </LynxView>
  );
}
