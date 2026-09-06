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
