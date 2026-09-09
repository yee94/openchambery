import { useEffect, useState } from 'react';

import {
  deleteLynxAssistant,
  loadAssistantSnapshot,
  setLynxAssistantsEnabled,
} from '../../assistants/api';
import { LynxShareWelcome } from '../../assistants/ShareWelcome';
import type { LynxAssistantDTO, LynxAssistantLoadResult } from '../../assistants/types';
import { lynxT, tabLabel } from '../../i18n/catalog';
import { LynxScrollView, LynxText, LynxView } from '../../lynx-elements';
import type { LynxRuntimeFetch } from '../../runtime/fetch';
import { cssVar } from '../../theme/tokens';
import { LynxCenteredDialog, LynxCenteredDialogAction } from '../CenteredDialog';
import { LynxDialogPortal } from '../DialogPortal';

export type AssistantTabProps = {
  locale: string;
  runtimeFetch?: LynxRuntimeFetch | null;
  /** Open conversation as secondary chat chrome. */
  onOpenConversation?: (assistant: LynxAssistantDTO) => void;
  /** Labeled stub when snapshot has no session yet — do not invent ASR / fake session. */
  onOpenNeedsSession?: (assistant: LynxAssistantDTO) => void;
  /** Cap openAssistantSettings — Settings assistants EntityEditor for id. */
  onOpenAssistantSettings?: (assistantId: string) => void;
  /** Cap empty Create → open Settings assistants (Create CTA lives there). */
  onOpenAssistantsSettings?: () => void;
  resultOverride?: LynxAssistantLoadResult | null;
  /** Show Cap AssistantShareWelcome education chrome once. */
  shareWelcomeEnabled?: boolean;
};

function modeLabel(locale: string, mode: LynxAssistantDTO['mode']): string {
  return mode === 'continuous'
    ? lynxT(locale, 'lynx.assistant.mode.continuous')
    : lynxT(locale, 'lynx.assistant.mode.stateless');
}

function AssistantCard({
  locale,
  assistant,
  onOpen,
  onLongPress,
}: {
  locale: string;
  assistant: LynxAssistantDTO;
  onOpen: () => void;
  onLongPress: () => void;
}) {
  return (
    <LynxView
      bindtap={onOpen}
      bindlongpress={onLongPress}
      accessibility-role="button"
      accessibility-label={assistant.name}
      style={{
        marginBottom: '12px',
        padding: '14px',
        borderRadius: '16px',
        backgroundColor: cssVar('surface.elevated'),
        opacity: assistant.enabled ? '1' : '0.65',
      }}
    >
      <LynxView style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '16px', fontWeight: '700' }}>
          {assistant.name}
        </LynxText>
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
          {modeLabel(locale, assistant.mode)}
        </LynxText>
      </LynxView>
      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginTop: '6px' }}>
        {assistant.effectiveWorkspacePath}
      </LynxText>
      {assistant.defaultPrompt.trim() ? (
        <LynxText
          style={{
            color: cssVar('surface.mutedForeground'),
            fontSize: '13px',
            marginTop: '8px',
          }}
        >
          {assistant.defaultPrompt.trim().slice(0, 120)}
        </LynxText>
      ) : null}
      <LynxView
        bindtap={onLongPress}
        accessibility-role="button"
        accessibility-label={lynxT(locale, 'lynx.assistant.menu.overflow')}
        style={{ marginTop: '10px', alignSelf: 'flex-start', paddingTop: '4px' }}
      >
        <LynxText style={{ color: cssVar('primary.base'), fontSize: '12px', fontWeight: '600' }}>
          ⋯
        </LynxText>
      </LynxView>
    </LynxView>
  );
}

/**
 * Assistant catalog mapped to Cap MobileAssistantTab / assistants snapshot API.
 * Conversation opens as secondary chat chrome (LynxChatScreen). No invented ASR.
 * Next #51: Cap long-press Edit/Delete + empty Create + disabled Enable.
 */
export function AssistantTab({
  locale,
  runtimeFetch = null,
  onOpenConversation,
  onOpenNeedsSession,
  onOpenAssistantSettings,
  onOpenAssistantsSettings,
  resultOverride = null,
  shareWelcomeEnabled = true,
}: AssistantTabProps) {
  const [result, setResult] = useState<LynxAssistantLoadResult | null>(resultOverride);
  const [reloadToken, setReloadToken] = useState(0);
  const [menuAssistant, setMenuAssistant] = useState<LynxAssistantDTO | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LynxAssistantDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (resultOverride) {
      setResult(resultOverride);
      return;
    }
    let cancelled = false;
    setResult(null);
    void (async () => {
      const next = await loadAssistantSnapshot(runtimeFetch);
      if (!cancelled) setResult(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [runtimeFetch, resultOverride, reloadToken]);

  const refresh = () => setReloadToken((value) => value + 1);

  const handleEnable = () => {
    if (busy || result?.status !== 'ok') return;
    const expectedRevision = result.snapshot.revision;
    setBusy(true);
    setActionError(null);
    void (async () => {
      const outcome = await setLynxAssistantsEnabled(runtimeFetch, {
        enabled: true,
        expectedRevision,
      });
      setBusy(false);
      if (outcome.status !== 'ok') {
        setActionError(
          outcome.status === 'no-runtime'
            ? lynxT(locale, 'lynx.assistant.noRuntime')
            : outcome.error.message || lynxT(locale, 'lynx.assistant.enableFailed'),
        );
        return;
      }
      refresh();
    })();
  };

  const handleConfirmDelete = () => {
    if (busy || !deleteTarget) return;
    const target = deleteTarget;
    setBusy(true);
    setActionError(null);
    void (async () => {
      const outcome = await deleteLynxAssistant(runtimeFetch, {
        id: target.id,
        expectedRevision: target.revision,
      });
      setBusy(false);
      if (outcome.status !== 'ok') {
        setActionError(
          outcome.status === 'no-runtime'
            ? lynxT(locale, 'lynx.assistant.noRuntime')
            : outcome.error.message || lynxT(locale, 'lynx.assistant.deleteFailed'),
        );
        return;
      }
      setDeleteTarget(null);
      refresh();
    })();
  };

  return (
    <LynxScrollView
      style={{
        flexGrow: 1,
        padding: '24px 16px',
        backgroundColor: cssVar('surface.background'),
      }}
    >
      <LynxText
        style={{
          fontSize: '28px',
          fontWeight: '700',
          color: cssVar('surface.foreground'),
          marginBottom: '12px',
        }}
      >
        {tabLabel(locale, 'assistant')}
      </LynxText>

      <LynxShareWelcome locale={locale} enabled={shareWelcomeEnabled} />

      {actionError ? (
        <LynxView
          style={{
            marginBottom: '12px',
            padding: '10px 12px',
            borderRadius: '12px',
            backgroundColor: cssVar('surface.elevated'),
          }}
        >
          <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '13px' }}>
            {actionError}
          </LynxText>
        </LynxView>
      ) : null}

      {!result ? (
        <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
          {lynxT(locale, 'lynx.assistant.loading')}
        </LynxText>
      ) : null}

      {result?.status === 'no-runtime' ? (
        <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
          {lynxT(locale, 'lynx.assistant.noRuntime')}
        </LynxText>
      ) : null}

      {result?.status === 'unsupported' ? (
        <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
          {lynxT(locale, 'lynx.assistant.unsupported')}
        </LynxText>
      ) : null}

      {result?.status === 'failed' ? (
        <LynxView
          style={{
            marginBottom: '12px',
            padding: '10px 12px',
            borderRadius: '12px',
            backgroundColor: cssVar('surface.elevated'),
          }}
        >
          <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '600' }}>
            {lynxT(locale, 'lynx.assistant.failure')}
          </LynxText>
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginTop: '4px' }}>
            {result.error.message}
          </LynxText>
        </LynxView>
      ) : null}

      {result?.status === 'ok' && !result.snapshot.enabled ? (
        <LynxView style={{ marginBottom: '16px' }}>
          <LynxText style={{ color: cssVar('surface.mutedForeground'), marginBottom: '12px' }}>
            {lynxT(locale, 'lynx.assistant.disabled')}
          </LynxText>
          <LynxView
            bindtap={handleEnable}
            accessibility-role="button"
            accessibility-label={lynxT(locale, 'lynx.assistant.enable')}
            style={{
              padding: '12px 14px',
              borderRadius: '12px',
              backgroundColor: cssVar('primary.base'),
              opacity: busy ? 0.6 : 1,
              alignItems: 'center',
            }}
          >
            <LynxText style={{ color: cssVar('primary.foreground'), fontWeight: '700' }}>
              {lynxT(locale, 'lynx.assistant.enable')}
            </LynxText>
          </LynxView>
        </LynxView>
      ) : null}

      {result?.status === 'ok' && result.snapshot.enabled && result.snapshot.assistants.length === 0 ? (
        <LynxView style={{ marginBottom: '16px' }}>
          <LynxText style={{ color: cssVar('surface.mutedForeground'), marginBottom: '12px' }}>
            {lynxT(locale, 'lynx.assistant.empty')}
          </LynxText>
          <LynxView
            bindtap={() => onOpenAssistantsSettings?.()}
            accessibility-role="button"
            accessibility-label={lynxT(locale, 'lynx.assistant.create')}
            style={{
              padding: '12px 14px',
              borderRadius: '12px',
              backgroundColor: cssVar('primary.base'),
              alignItems: 'center',
            }}
          >
            <LynxText style={{ color: cssVar('primary.foreground'), fontWeight: '700' }}>
              {lynxT(locale, 'lynx.assistant.create')}
            </LynxText>
          </LynxView>
        </LynxView>
      ) : null}

      {result?.status === 'ok'
        ? result.snapshot.assistants.map((assistant) => (
          <AssistantCard
            key={assistant.id}
            locale={locale}
            assistant={assistant}
            onOpen={() => {
              if (assistant.sessionID) {
                onOpenConversation?.(assistant);
                return;
              }
              onOpenNeedsSession?.(assistant);
            }}
            onLongPress={() => {
              setActionError(null);
              setMenuAssistant(assistant);
            }}
          />
        ))
        : null}

      {menuAssistant ? (
        <LynxView
          data-lynx-assistant-actions="true"
          style={{
            position: 'absolute',
            left: '0',
            right: '0',
            bottom: '0',
            top: '0',
            zIndex: 5,
            backgroundColor: 'rgba(0,0,0,0.35)',
            justifyContent: 'flex-end',
          }}
        >
          <LynxView
            bindtap={() => setMenuAssistant(null)}
            style={{ position: 'absolute', left: '0', right: '0', top: '0', bottom: '0' }}
          />
          <LynxView
            style={{
              backgroundColor: cssVar('surface.elevated'),
              borderTopLeftRadius: '16px',
              borderTopRightRadius: '16px',
              padding: '16px',
            }}
          >
            <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '700', marginBottom: '8px' }}>
              {menuAssistant.name}
            </LynxText>
            <LynxView
              bindtap={() => {
                const id = menuAssistant.id;
                setMenuAssistant(null);
                onOpenAssistantSettings?.(id);
              }}
              style={{ padding: '12px 0' }}
            >
              <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '600' }}>
                {lynxT(locale, 'lynx.assistant.menu.edit')}
              </LynxText>
            </LynxView>
            <LynxView
              bindtap={() => {
                setDeleteTarget(menuAssistant);
                setMenuAssistant(null);
              }}
              style={{ padding: '12px 0' }}
            >
              <LynxText style={{ color: cssVar('status.error'), fontWeight: '600' }}>
                {lynxT(locale, 'lynx.assistant.menu.delete')}
              </LynxText>
            </LynxView>
            <LynxView bindtap={() => setMenuAssistant(null)} style={{ padding: '12px 0' }}>
              <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
                {lynxT(locale, 'lynx.assistant.menu.cancel')}
              </LynxText>
            </LynxView>
          </LynxView>
        </LynxView>
      ) : null}

      <LynxDialogPortal>
        <LynxCenteredDialog
          locale={locale}
          open={deleteTarget !== null}
          title={lynxT(locale, 'lynx.assistant.deleteTitle')}
          description={
            deleteTarget
              ? lynxT(locale, 'lynx.assistant.deleteConfirm', { name: deleteTarget.name })
              : undefined
          }
          ariaLabel={lynxT(locale, 'lynx.assistant.deleteTitle')}
          busy={busy}
          onClose={() => {
            if (!busy) setDeleteTarget(null);
          }}
          footer={(
            <LynxView style={{ flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <LynxCenteredDialogAction
                label={lynxT(locale, 'lynx.assistant.menu.cancel')}
                onTap={() => {
                  if (!busy) setDeleteTarget(null);
                }}
                disabled={busy}
              />
              <LynxCenteredDialogAction
                label={lynxT(locale, 'lynx.assistant.deleteAction')}
                onTap={handleConfirmDelete}
                destructive
                disabled={busy}
              />
            </LynxView>
          )}
        />
      </LynxDialogPortal>
    </LynxScrollView>
  );
}
