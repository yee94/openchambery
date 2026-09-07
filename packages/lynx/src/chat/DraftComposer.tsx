import { useEffect, useRef, useState } from 'react';

import { lynxT } from '../i18n/catalog';
import { LynxInput, LynxText, LynxView } from '../lynx-elements';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { cssVar } from '../theme/tokens';
import { createLynxSession } from '../projects/sessionActions';
import { LynxComposerAutocompleteList } from './ComposerAutocompleteList';
import { LynxComposerActionsInGlass } from './ComposerActionsInGlass';
import {
  setLynxSessionPermissionAutoAccept,
  toggleLynxPermissionAutoAccept,
  type LynxPermissionAutoAcceptSnapshotResult,
} from './permissionAutoAccept';
import { LynxComposerGlassCard } from './ComposerGlassCard';
import { LynxComposerPickerSheets } from './ComposerPickerSheets';
import type { LynxHostGlobalProps } from '../host/embedding';
import {
  applyLynxComposerSuggestion,
  detectLynxComposerTrigger,
  loadLynxComposerCatalogs,
  suggestionsForTrigger,
  type LynxComposerSuggestion,
} from './composerCatalog';
import {
  applyLynxAgentPickerSelection,
  applyLynxModelPickerSelection,
  type LynxComposerPickerKind,
} from './composerPicker';
import { abortSession, promptAsync, type LynxPromptAsyncResult } from './sessionApi';

export type LynxDraftComposerModel = {
  providerID: string;
  modelID: string;
  agent?: string;
};

export type LynxDraftMaterializeResult =
  | { status: 'ok'; sessionId: string; directory: string | null; promptResult: LynxPromptAsyncResult }
  | { status: 'no-runtime' }
  | { status: 'empty' }
  | { status: 'aborted' }
  | { status: 'failed'; error: string };

/**
 * Cap new-session draft secondary: composer body that materializes a real
 * OpenCode session on send (POST /session → prompt_async), then hands off to Chat.
 * `/` `@` catalogs match ChatScreen (same Cap list endpoints).
 */
export async function materializeLynxDraftSession(input: {
  runtimeFetch: LynxRuntimeFetch | null | undefined;
  text: string;
  directory?: string | null;
  model: LynxDraftComposerModel;
  signal?: AbortSignal;
  /** Fired once POST /session succeeds so Stop can abortSession. */
  onSessionCreated?: (session: { sessionId: string; directory: string | null }) => void;
}): Promise<LynxDraftMaterializeResult> {
  const text = input.text.trim();
  if (!text) return { status: 'empty' };
  if (!input.runtimeFetch) return { status: 'no-runtime' };
  if (input.signal?.aborted) return { status: 'aborted' };

  const created = await createLynxSession(input.runtimeFetch, {
    directory: input.directory,
  });
  if (input.signal?.aborted) return { status: 'aborted' };
  if (created.status !== 'ok') {
    if (created.status === 'no-runtime') return { status: 'no-runtime' };
    return { status: 'failed', error: created.error };
  }

  input.onSessionCreated?.({
    sessionId: created.sessionId,
    directory: created.directory,
  });
  if (input.signal?.aborted) return { status: 'aborted' };

  const promptResult = await promptAsync(
    { runtimeFetch: input.runtimeFetch },
    {
      sessionId: created.sessionId,
      directory: created.directory,
      text,
      providerID: input.model.providerID,
      modelID: input.model.modelID,
      agent: input.model.agent,
    },
  );

  if (input.signal?.aborted) return { status: 'aborted' };

  if (promptResult.status === 'failed') {
    return {
      status: 'failed',
      error: promptResult.error,
    };
  }

  return {
    status: 'ok',
    sessionId: created.sessionId,
    directory: created.directory,
    promptResult,
  };
}

export type LynxDraftComposerProps = {
  locale: string;
  onBack: () => void;
  /** Host chrome props for GlassChrome composer / autocomplete chips. */
  host: LynxHostGlobalProps;
  /** Mode A true; Mode B false. Composer glass still paints (dock-only gate). */
  fullPageAutoGlassSkin?: boolean;
  runtimeFetch?: LynxRuntimeFetch | null;
  directory?: string | null;
  model?: LynxDraftComposerModel;
  /** After successful create+prompt, open the real chat secondary. */
  onMaterialized?: (session: { sessionId: string; directory: string | null }) => void;
  initialText?: string;
};

const DEFAULT_MODEL: LynxDraftComposerModel = {
  providerID: 'anthropic',
  modelID: 'claude-sonnet-4-20250514',
};

export function LynxDraftComposer({
  locale,
  onBack,
  host,
  fullPageAutoGlassSkin = true,
  runtimeFetch = null,
  directory = null,
  model = DEFAULT_MODEL,
  onMaterialized,
  initialText = '',
}: LynxDraftComposerProps) {
  const [draft, setDraft] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftPermissionAutoAcceptEnabled, setDraftPermissionAutoAcceptEnabled] = useState(false);
  const [composerSuggestions, setComposerSuggestions] = useState<LynxComposerSuggestion[]>([]);
  const [composerCatalogHint, setComposerCatalogHint] = useState<string | null>(null);
  const [composerModel, setComposerModel] = useState<LynxDraftComposerModel>(model);
  const [pickerKind, setPickerKind] = useState<LynxComposerPickerKind | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const createdSessionRef = useRef<{ sessionId: string; directory: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const bundle = await loadLynxComposerCatalogs(runtimeFetch, { directory });
      if (cancelled) return;
      const { trigger, query } = detectLynxComposerTrigger(draft);
      if (trigger === 'none') {
        setComposerSuggestions([]);
        setComposerCatalogHint(null);
        return;
      }
      setComposerCatalogHint(
        trigger === 'slash'
          ? lynxT(locale, 'lynx.chat.composer.slashHint')
          : trigger === 'mention'
            ? lynxT(locale, 'lynx.chat.composer.mentionHint')
            : lynxT(locale, 'lynx.chat.composer.modelHint'),
      );
      setComposerSuggestions(suggestionsForTrigger(bundle, trigger, query));
    })();
    return () => { cancelled = true; };
  }, [draft, runtimeFetch, directory, locale]);

  const send = () => {
    if (busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    createdSessionRef.current = null;
    setBusy(true);
    setError(null);
    void (async () => {
      const result = await materializeLynxDraftSession({
        runtimeFetch,
        text: draft,
        directory,
        model: composerModel,
        signal: controller.signal,
        onSessionCreated: (session) => {
          createdSessionRef.current = session;
          // Cap finalizeDraftSession: apply draft auto-accept after POST /session.
          if (draftPermissionAutoAcceptEnabled) {
            void setLynxSessionPermissionAutoAccept(runtimeFetch, {
              sessionId: session.sessionId,
              enabled: true,
              directory: session.directory,
            }).then((apply: LynxPermissionAutoAcceptSnapshotResult) => {
              if (apply.status !== 'ok') {
                console.warn(
                  'Failed to apply draft permission auto-accept to new session:',
                  apply.status === 'failed' ? apply.error : apply.status,
                );
              }
            });
          }
        },
      });
      if (controller.signal.aborted || result.status === 'aborted') {
        setBusy(false);
        abortRef.current = null;
        return;
      }
      setBusy(false);
      abortRef.current = null;
      createdSessionRef.current = null;
      if (result.status === 'ok') {
        setDraft('');
        onMaterialized?.({ sessionId: result.sessionId, directory: result.directory });
        return;
      }
      if (result.status === 'empty') {
        setError(lynxT(locale, 'lynx.draft.empty'));
        return;
      }
      if (result.status === 'no-runtime') {
        setError(lynxT(locale, 'lynx.chat.runtime.missing'));
        return;
      }
      setError(result.error);
    })();
  };

  /** Cap Chat Stop spirit: abort in-flight materialize / session, never re-send. */
  const stop = () => {
    if (!busy) return;
    abortRef.current?.abort();
    const created = createdSessionRef.current;
    if (created && runtimeFetch) {
      void abortSession(
        { runtimeFetch },
        { sessionId: created.sessionId, directory: created.directory },
      );
    }
    createdSessionRef.current = null;
    abortRef.current = null;
    setBusy(false);
  };

  return (
    <LynxView
      style={{
        flexGrow: 1,
        position: 'relative',
        backgroundColor: cssVar('surface.background'),
      }}
      accessibility-label={lynxT(locale, 'mobile.nav.secondaryPageAria')}
    >
      <LynxView style={{ flexDirection: 'row', padding: '12px 16px', alignItems: 'center' }}>
        <LynxView bindtap={onBack} accessibility-label={lynxT(locale, 'lynx.shell.back')}>
          <LynxText style={{ color: cssVar('primary.base') }}>{lynxT(locale, 'lynx.shell.back')}</LynxText>
        </LynxView>
        <LynxText
          style={{
            marginLeft: '12px',
            color: cssVar('surface.foreground'),
            fontWeight: '600',
          }}
        >
          {lynxT(locale, 'lynx.draft.title')}
        </LynxText>
      </LynxView>

      <LynxView style={{ flexGrow: 1, padding: '16px' }}>
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '13px', marginBottom: '12px' }}>
          {lynxT(locale, 'lynx.draft.body')}
        </LynxText>
        {directory ? (
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '8px' }}>
            {directory}
          </LynxText>
        ) : null}
        {error ? (
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '13px', marginBottom: '8px' }}>
            {error}
          </LynxText>
        ) : null}
      </LynxView>

      <LynxView
        style={{
          padding: '12px 16px',
          borderTopWidth: '1px',
          borderTopColor: cssVar('surface.elevated'),
        }}
      >
        {/* Autocomplete ABOVE glass composer — sibling, not contentView child */}
        <LynxComposerAutocompleteList
          locale={locale}
          hint={composerCatalogHint}
          suggestions={composerSuggestions}
          onSelect={(suggestion) => setDraft((prev) => applyLynxComposerSuggestion(prev, suggestion))}
          host={host}
          fullPageAutoGlassSkin={fullPageAutoGlassSkin}
        />
        <LynxComposerGlassCard
          host={host}
          fullPageAutoGlassSkin={fullPageAutoGlassSkin}
          variant={draft.trim().length > 0 ? 'card' : 'pill'}
        >
          {draft.trim().length > 0 ? (
            <>
              <LynxInput
                value={draft}
                placeholder={lynxT(locale, 'lynx.chat.composer.placeholder')}
                bindinput={(event) => setDraft(event.detail?.value ?? '')}
                style={{ color: cssVar('surface.foreground') }}
              />
              <LynxComposerActionsInGlass
                locale={locale}
                variant="card"
                sessionIsWorking={busy}
                agentLabel={composerModel.agent || lynxT(locale, 'lynx.chat.composer.mentionHint')}
                modelLabel={composerModel.modelID}
                permissionAutoAccept={{
                  enabled: draftPermissionAutoAcceptEnabled,
                  onToggle: () => {
                    toggleLynxPermissionAutoAccept({
                      permissionScopeSessionId: null,
                      newSessionDraftOpen: true,
                      draftPermissionAutoAcceptEnabled,
                      permissionAutoAcceptEnabled: false,
                      setDraftPermissionAutoAcceptEnabled,
                      setSessionAutoAccept: async () => undefined,
                      onOpenSessionFirst: () => undefined,
                      onToggleFailed: () => undefined,
                    });
                  },
                }}
                onAttach={() => {
                  setError('no-host: media pick unavailable');
                }}
                onSend={send}
                onStop={stop}
                onAgent={() => { setPickerKind('agent'); }}
                onModel={() => { setPickerKind('model'); }}
              />
            </>
          ) : (
            <LynxView
              data-lynx-composer-actions-in-glass="true"
              data-lynx-composer-actions-variant="pill"
              data-lynx-composer-actions-order="attach,input,sendOrStop"
              style={{ flexDirection: 'row', alignItems: 'center' }}
            >
              <LynxView
                bindtap={() => {
                  setError('no-host: media pick unavailable');
                }}
                accessibility-role="button"
                accessibility-label={lynxT(locale, 'lynx.chat.composer.attach')}
                data-lynx-composer-action="attach"
                style={{ padding: '6px 8px' }}
              >
                <LynxText style={{ color: cssVar('surface.mutedForeground'), fontWeight: '600' }}>
                  +
                </LynxText>
              </LynxView>
              <LynxView
                bindtap={() => {
                  toggleLynxPermissionAutoAccept({
                    permissionScopeSessionId: null,
                    newSessionDraftOpen: true,
                    draftPermissionAutoAcceptEnabled,
                    permissionAutoAcceptEnabled: false,
                    setDraftPermissionAutoAcceptEnabled,
                    setSessionAutoAccept: async () => undefined,
                    onOpenSessionFirst: () => undefined,
                    onToggleFailed: () => undefined,
                  });
                }}
                accessibility-role="button"
                accessibility-label={lynxT(
                  locale,
                  draftPermissionAutoAcceptEnabled
                    ? 'lynx.chat.permissionAutoAccept.disable'
                    : 'lynx.chat.permissionAutoAccept.enable',
                )}
                data-lynx-composer-action="permissionAutoAccept"
                style={{ padding: '6px 8px' }}
              >
                <LynxText style={{
                  color: draftPermissionAutoAcceptEnabled
                    ? cssVar('primary.base')
                    : cssVar('surface.mutedForeground'),
                  fontSize: '12px',
                  fontWeight: '600',
                }}
                >
                  {lynxT(
                    locale,
                    draftPermissionAutoAcceptEnabled
                      ? 'lynx.chat.permissionAutoAccept.on'
                      : 'lynx.chat.permissionAutoAccept.off',
                  )}
                </LynxText>
              </LynxView>
              <LynxInput
                value={draft}
                placeholder={lynxT(locale, 'lynx.chat.composer.placeholder')}
                bindinput={(event) => setDraft(event.detail?.value ?? '')}
                style={{ flexGrow: 1, color: cssVar('surface.foreground') }}
              />
              <LynxView
                bindtap={busy ? stop : send}
                accessibility-role="button"
                accessibility-label={busy
                  ? lynxT(locale, 'lynx.chat.composer.stop')
                  : lynxT(locale, 'lynx.chat.composer.send')}
                data-lynx-composer-action="sendOrStop"
                style={{
                  marginLeft: '8px',
                  padding: '8px 12px',
                  borderRadius: '10px',
                  backgroundColor: cssVar('primary.base'),
                  opacity: 1,
                }}
              >
                <LynxText style={{ color: '#fff', fontWeight: '600' }}>
                  {busy
                    ? lynxT(locale, 'lynx.chat.composer.stop')
                    : lynxT(locale, 'lynx.chat.composer.send')}
                </LynxText>
              </LynxView>
            </LynxView>
          )}
        </LynxComposerGlassCard>
        <LynxComposerPickerSheets
          locale={locale}
          kind={pickerKind}
          runtimeFetch={runtimeFetch ?? null}
          directory={directory}
          selection={{
            providerID: composerModel.providerID,
            modelID: composerModel.modelID,
            agent: composerModel.agent,
          }}
          onClose={() => setPickerKind(null)}
          onSelectAgent={(agentName) => {
            setComposerModel((prev) => applyLynxAgentPickerSelection(prev, agentName));
          }}
          onSelectModel={(next) => {
            setComposerModel((prev) => applyLynxModelPickerSelection(prev, next));
          }}
        />
      </LynxView>
    </LynxView>
  );
}
