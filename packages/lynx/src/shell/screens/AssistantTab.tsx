import { useEffect, useState } from 'react';

import { loadAssistantSnapshot } from '../../assistants/api';
import type { LynxAssistantDTO, LynxAssistantLoadResult } from '../../assistants/types';
import { lynxT, tabLabel } from '../../i18n/catalog';
import { LynxScrollView, LynxText, LynxView } from '../../lynx-elements';
import type { LynxRuntimeFetch } from '../../runtime/fetch';
import { cssVar } from '../../theme/tokens';

export type AssistantTabProps = {
  locale: string;
  runtimeFetch?: LynxRuntimeFetch | null;
  /** Open conversation as secondary chat chrome. */
  onOpenConversation?: (assistant: LynxAssistantDTO) => void;
  /** Labeled stub when snapshot has no session yet — do not invent ASR / fake session. */
  onOpenNeedsSession?: (assistant: LynxAssistantDTO) => void;
  resultOverride?: LynxAssistantLoadResult | null;
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
}: {
  locale: string;
  assistant: LynxAssistantDTO;
  onOpen: () => void;
}) {
  return (
    <LynxView
      bindtap={onOpen}
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
    </LynxView>
  );
}

/**
 * Assistant catalog mapped to Cap MobileAssistantTab / assistants snapshot API.
 * Conversation opens as secondary chat chrome (LynxChatScreen). No invented ASR.
 */
export function AssistantTab({
  locale,
  runtimeFetch = null,
  onOpenConversation,
  onOpenNeedsSession,
  resultOverride = null,
}: AssistantTabProps) {
  const [result, setResult] = useState<LynxAssistantLoadResult | null>(resultOverride);

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
  }, [runtimeFetch, resultOverride]);

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
        <LynxText style={{ color: cssVar('surface.mutedForeground'), marginBottom: '12px' }}>
          {lynxT(locale, 'lynx.assistant.disabled')}
        </LynxText>
      ) : null}

      {result?.status === 'ok' && result.snapshot.enabled && result.snapshot.assistants.length === 0 ? (
        <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
          {lynxT(locale, 'lynx.assistant.empty')}
        </LynxText>
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
          />
        ))
        : null}
    </LynxScrollView>
  );
}
