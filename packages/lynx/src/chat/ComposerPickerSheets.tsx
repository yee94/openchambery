/**
 * Cap MobileResizableSheet spirit for Agent / model composer pickers.
 * Overlay sheets — never nested under LynxComposerGlassCard contentView.
 */
import { useEffect, useMemo, useState } from 'react';

import { lynxT } from '../i18n/catalog';
import { LynxInput, LynxScrollView, LynxText, LynxView } from '../lynx-elements';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { LynxMobileResizableSheet } from '../shell/MobileResizableSheet';
import { cssVar } from '../theme/tokens';
import type { LynxComposerModel } from './composerActions';
import {
  filterLynxComposerPickerItems,
  loadLynxAgentPickerItems,
  loadLynxModelPickerItems,
  parseLynxModelPickerId,
  type LynxComposerPickerItem,
  type LynxComposerPickerKind,
} from './composerPicker';

export type LynxComposerPickerSheetsProps = {
  locale: string;
  kind: LynxComposerPickerKind | null;
  runtimeFetch: LynxRuntimeFetch | null;
  directory?: string | null;
  selection: LynxComposerModel;
  onClose: () => void;
  onSelectAgent: (agentName: string | null) => void;
  onSelectModel: (selection: { providerID: string; modelID: string }) => void;
};

/**
 * Agent or model picker overlay (Cap AgentSelector / MobileModelPickerPanel).
 * Half-height resizable sheet — not full-screen surface.background.
 * Returns null when closed.
 */
export function LynxComposerPickerSheets({
  locale,
  kind,
  runtimeFetch,
  directory = null,
  selection,
  onClose,
  onSelectAgent,
  onSelectModel,
}: LynxComposerPickerSheetsProps) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'failed' | 'no-runtime' | 'unsupported'>('idle');
  const [items, setItems] = useState<LynxComposerPickerItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!kind) {
      setItems([]);
      setQuery('');
      setError(null);
      setStatus('idle');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    setError(null);
    setQuery('');
    void (async () => {
      const result = kind === 'agent'
        ? await loadLynxAgentPickerItems(runtimeFetch, { directory })
        : await loadLynxModelPickerItems(runtimeFetch, { directory });
      if (cancelled) return;
      if (result.status === 'ok') {
        setItems(result.items);
        setStatus('ok');
        return;
      }
      setItems([]);
      if (result.status === 'no-runtime') {
        setStatus('no-runtime');
        return;
      }
      if (result.status === 'unsupported') {
        setStatus('unsupported');
        return;
      }
      setStatus('failed');
      setError(result.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, runtimeFetch, directory]);

  const filtered = useMemo(
    () => filterLynxComposerPickerItems(items, query),
    [items, query],
  );

  const titleKey = kind === 'agent'
    ? 'lynx.chat.composer.picker.agentTitle'
    : 'lynx.chat.composer.picker.modelTitle';
  const title = kind ? lynxT(locale, titleKey) : '';
  const selectedId = kind === 'agent'
    ? (selection.agent ?? '')
    : `${selection.providerID}/${selection.modelID}`;

  return (
    <LynxMobileResizableSheet
      locale={locale}
      open={kind != null}
      title={title}
      ariaLabel={title || 'picker'}
      onClose={onClose}
    >
      <LynxView
        data-lynx-composer-picker-sheet={kind ?? undefined}
        data-lynx-composer-picker-placement="overlay-sheet"
        style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: '0' }}
      >
        <LynxInput
          value={query}
          placeholder={lynxT(locale, 'lynx.chat.composer.picker.search')}
          bindinput={(event) => setQuery(event.detail?.value ?? '')}
          accessibility-label={lynxT(locale, 'lynx.chat.composer.picker.search')}
          style={{
            marginBottom: '12px',
            padding: '8px 10px',
            borderRadius: '10px',
            backgroundColor: cssVar('surface.background'),
            color: cssVar('surface.foreground'),
            flexShrink: 0,
          }}
        />

        {status === 'loading' ? (
          <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
            {lynxT(locale, 'lynx.chat.composer.picker.loading')}
          </LynxText>
        ) : null}
        {status === 'no-runtime' ? (
          <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
            {lynxT(locale, 'lynx.chat.composer.picker.noRuntime')}
          </LynxText>
        ) : null}
        {status === 'unsupported' || status === 'failed' ? (
          <LynxText style={{ color: cssVar('surface.foreground'), marginBottom: '8px' }}>
            {error || lynxT(locale, 'lynx.chat.composer.picker.failed')}
          </LynxText>
        ) : null}

        {status === 'ok' ? (
          <LynxScrollView style={{ flexGrow: 1, minHeight: '0' }}>
            {kind === 'agent' ? (
              <PickerRow
                title={lynxT(locale, 'lynx.chat.composer.picker.notSelected')}
                selected={!selection.agent}
                onPress={() => {
                  onSelectAgent(null);
                  onClose();
                }}
              />
            ) : null}
            {filtered.length === 0 ? (
              <LynxText style={{ color: cssVar('surface.mutedForeground'), marginTop: '8px' }}>
                {lynxT(locale, 'lynx.chat.composer.picker.empty')}
              </LynxText>
            ) : (
              filtered.map((item) => {
                const selected = kind === 'agent'
                  ? item.id === selectedId || item.title === selectedId
                  : item.id === selectedId;
                return (
                  <PickerRow
                    key={item.id}
                    title={item.title}
                    subtitle={item.subtitle}
                    selected={selected}
                    onPress={() => {
                      if (kind === 'agent') {
                        onSelectAgent(item.title || item.id);
                        onClose();
                        return;
                      }
                      const parsed = parseLynxModelPickerId(item.id);
                      if (!parsed) return;
                      onSelectModel(parsed);
                      onClose();
                    }}
                  />
                );
              })
            )}
          </LynxScrollView>
        ) : null}
      </LynxView>
    </LynxMobileResizableSheet>
  );
}

function PickerRow({
  title,
  subtitle,
  selected,
  onPress,
}: {
  title: string;
  subtitle?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <LynxView
      bindtap={onPress}
      accessibility-role="button"
      accessibility-label={title}
      data-lynx-composer-picker-row={selected ? 'selected' : 'idle'}
      style={{
        marginBottom: '8px',
        padding: '10px 12px',
        borderRadius: '12px',
        backgroundColor: selected ? cssVar('primary.base') : cssVar('surface.background'),
        opacity: selected ? 0.92 : 1,
      }}
    >
      <LynxText
        style={{
          color: selected ? '#fff' : cssVar('surface.foreground'),
          fontWeight: '600',
          fontSize: '14px',
        }}
      >
        {title}
      </LynxText>
      {subtitle ? (
        <LynxText
          style={{
            color: selected ? 'rgba(255,255,255,0.85)' : cssVar('surface.mutedForeground'),
            fontSize: '12px',
            marginTop: '2px',
          }}
        >
          {subtitle}
        </LynxText>
      ) : null}
    </LynxView>
  );
}
