import { useCallback, useEffect, useMemo, useState } from 'react';

import { lynxT } from '../i18n/catalog';
import { LynxInput, LynxText, LynxView } from '../lynx-elements';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { cssVar } from '../theme/tokens';
import {
  createLynxComposerActions,
  type LynxComposerActions,
  type LynxComposerModel,
} from './composerActions';
import { fetchSessionMessages } from './sessionApi';
import { LynxTimelineList } from './TimelineList';
import {
  applyInitialFailure,
  applyInitialPage,
  applyOlderPage,
  beginLoadOlder,
  clearPrependSettle,
  createEmptyTimelineState,
  failLoadOlder,
  setSessionWorking,
  type LynxTimelineState,
} from './timelineModel';

export type LynxChatScreenProps = {
  locale: string;
  sessionId: string;
  directory?: string | null;
  onBack: () => void;
  /** Connect runtime fetch. Null → labeled unconnected; actions fail honestly. */
  runtimeFetch?: LynxRuntimeFetch | null;
  model?: LynxComposerModel;
  title?: string;
};

const DEFAULT_MODEL: LynxComposerModel = {
  providerID: 'anthropic',
  modelID: 'claude-sonnet-4-20250514',
};

/**
 * Pushed chat page: header + LegendList timeline + composer send/stop/queue.
 * Maps Cap MobileChatScreen / TimelineList behaviors that fit Lynx without
 * inventing ASR, WebView FLIP, or TanStack split lists.
 */
export function LynxChatScreen({
  locale,
  sessionId,
  directory = null,
  onBack,
  runtimeFetch = null,
  model = DEFAULT_MODEL,
  title,
}: LynxChatScreenProps) {
  const [timeline, setTimeline] = useState<LynxTimelineState>(() =>
    createEmptyTimelineState(sessionId, directory),
  );
  const [draft, setDraft] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [queueCount, setQueueCount] = useState(0);

  const sessionApi = useMemo(
    () => (runtimeFetch ? { runtimeFetch } : null),
    [runtimeFetch],
  );

  const composer: LynxComposerActions = useMemo(
    () => createLynxComposerActions({
      sessionId,
      directory,
      model,
      sessionApi,
      sessionIsWorking: () => timeline.sessionIsWorking,
      followUpBehavior: 'queue',
    }),
    [sessionId, directory, model, sessionApi, timeline.sessionIsWorking],
  );

  useEffect(() => {
    let cancelled = false;
    setTimeline(createEmptyTimelineState(sessionId, directory));
    setActionError(null);

    if (!runtimeFetch) {
      setTimeline((state) => applyInitialFailure(
        state,
        'labeled stub: no connect runtime — transcript not loaded',
      ));
      return;
    }

    void (async () => {
      const result = await fetchSessionMessages(
        { runtimeFetch },
        { sessionId, directory, limit: 30 },
      );
      if (cancelled) return;
      if (result.status === 'ok') {
        setTimeline((state) => applyInitialPage(state, result.page));
      } else {
        setTimeline((state) => applyInitialFailure(state, result.error));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, directory, runtimeFetch]);

  const onLoadOlder = useCallback(() => {
    if (!runtimeFetch) {
      setTimeline((state) => failLoadOlder(
        beginLoadOlder(state),
        'no connect runtime',
      ));
      return;
    }
    setTimeline((state) => {
      const next = beginLoadOlder(state);
      if (!next.isLoadingOlder) return state;
      const before = next.olderCursor;
      void (async () => {
        const result = await fetchSessionMessages(
          { runtimeFetch },
          { sessionId, directory, limit: 30, before },
        );
        setTimeline((current) => {
          if (result.status !== 'ok') {
            return failLoadOlder(current, result.error);
          }
          const applied = applyOlderPage(current, result.page);
          // Settle after prepend so maintainVisibleContentPosition can release.
          queueMicrotask(() => {
            setTimeline((settled) => clearPrependSettle(settled));
          });
          return applied;
        });
      })();
      return next;
    });
  }, [runtimeFetch, sessionId, directory]);

  const onSend = useCallback(async () => {
    setActionError(null);
    const text = draft;
    const result = await composer.send(text);
    if (result.status !== 'ok') {
      setActionError(`${result.reason}: ${result.error}`);
      return;
    }
    setDraft('');
    setTimeline((state) => setSessionWorking(state, true));
  }, [composer, draft]);

  const onStop = useCallback(async () => {
    setActionError(null);
    const result = await composer.stop();
    if (result.status !== 'ok') {
      setActionError(`${result.reason}: ${result.error}`);
      return;
    }
    setTimeline((state) => setSessionWorking(state, false));
  }, [composer]);

  const onQueue = useCallback(async () => {
    setActionError(null);
    const result = await composer.queue(draft);
    if (result.status !== 'ok') {
      setActionError(`${result.reason}: ${result.error}`);
      return;
    }
    setDraft('');
    setQueueCount(composer.getQueue().length);
  }, [composer, draft]);

  const connected = Boolean(runtimeFetch);

  return (
    <LynxView
      style={{
        flexGrow: 1,
        backgroundColor: cssVar('surface.background'),
      }}
      accessibility-label={lynxT(locale, 'mobile.nav.secondaryPageAria')}
    >
      <LynxView style={{ flexDirection: 'row', padding: '12px 16px', alignItems: 'center' }}>
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
          {title ?? lynxT(locale, 'lynx.shell.chat.title')}
        </LynxText>
      </LynxView>

      {!connected ? (
        <LynxText style={{ padding: '0 16px 8px', color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
          {lynxT(locale, 'lynx.chat.runtime.missing')}
        </LynxText>
      ) : null}

      <LynxTimelineList
        locale={locale}
        state={timeline}
        onLoadOlder={onLoadOlder}
        footer={(
          <LynxView style={{ padding: '12px 16px' }}>
            <LynxView
              style={{
                padding: '10px 12px',
                borderRadius: '12px',
                backgroundColor: cssVar('surface.elevated'),
                marginBottom: '8px',
              }}
            >
              <LynxInput
                value={draft}
                placeholder={lynxT(locale, 'lynx.chat.composer.placeholder')}
                bindinput={(event) => setDraft(event.detail?.value ?? '')}
                accessibility-label={lynxT(locale, 'lynx.chat.composer.placeholder')}
                style={{ color: cssVar('surface.foreground'), fontSize: '14px' }}
              />
            </LynxView>
            <LynxView style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
              {timeline.sessionIsWorking ? (
                <LynxView bindtap={() => { void onStop(); }} style={{ padding: '8px 12px' }}>
                  <LynxText style={{ color: cssVar('primary.base') }}>
                    {lynxT(locale, 'lynx.chat.composer.stop')}
                  </LynxText>
                </LynxView>
              ) : (
                <LynxView bindtap={() => { void onSend(); }} style={{ padding: '8px 12px' }}>
                  <LynxText style={{ color: cssVar('primary.base') }}>
                    {lynxT(locale, 'lynx.chat.composer.send')}
                  </LynxText>
                </LynxView>
              )}
              <LynxView bindtap={() => { void onQueue(); }} style={{ padding: '8px 12px' }}>
                <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
                  {lynxT(locale, 'lynx.chat.composer.queue')}
                  {queueCount > 0 ? ` (${queueCount})` : ''}
                </LynxText>
              </LynxView>
            </LynxView>
            {actionError ? (
              <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginTop: '6px' }}>
                {actionError}
              </LynxText>
            ) : null}
          </LynxView>
        )}
      />
    </LynxView>
  );
}

