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
import {
  LYNX_CHAT_OVERFLOW_ITEMS,
  chatSheetFromOverflowId,
  type LynxChatOverflowItemId,
  type LynxChatSheetKind,
} from './overflowMenu';
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
 * Overflow menu hooks Files/Changes as labeled stub sheets that navigate correctly.
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheet, setSheet] = useState<LynxChatSheetKind | null>(null);

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

  const reloadTranscript = useCallback(() => {
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
      if (result.status === 'ok') {
        setTimeline((state) => applyInitialPage(state, result.page));
      } else {
        setTimeline((state) => applyInitialFailure(state, result.error));
      }
    })();
  }, [runtimeFetch, sessionId, directory]);

  useEffect(() => {
    let cancelled = false;
    setTimeline(createEmptyTimelineState(sessionId, directory));
    setActionError(null);
    setMenuOpen(false);
    setSheet(null);

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

  const onOverflowSelect = (id: LynxChatOverflowItemId) => {
    setMenuOpen(false);
    const sheetKind = chatSheetFromOverflowId(id);
    if (sheetKind) {
      setSheet(sheetKind);
      return;
    }
    if (id === 'refreshTranscript') {
      reloadTranscript();
    }
  };

  const connected = Boolean(runtimeFetch);

  if (sheet) {
    return (
      <LynxView
        style={{
          flexGrow: 1,
          backgroundColor: cssVar('surface.background'),
        }}
        accessibility-label={lynxT(locale, sheet === 'files' ? 'lynx.chat.menu.files' : 'lynx.chat.menu.changes')}
      >
        <LynxView style={{ flexDirection: 'row', padding: '12px 16px', alignItems: 'center' }}>
          <LynxView
            bindtap={() => setSheet(null)}
            accessibility-label={lynxT(locale, 'lynx.shell.back')}
          >
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
            {lynxT(locale, sheet === 'files' ? 'lynx.chat.menu.files' : 'lynx.chat.menu.changes')}
          </LynxText>
        </LynxView>
        <LynxText style={{ padding: '16px', color: cssVar('surface.mutedForeground') }}>
          {lynxT(
            locale,
            sheet === 'files' ? 'lynx.chat.sheet.files.stub' : 'lynx.chat.sheet.changes.stub',
          )}
        </LynxText>
      </LynxView>
    );
  }

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
        <LynxView
          bindtap={() => setMenuOpen((open) => !open)}
          accessibility-role="button"
          accessibility-label={lynxT(locale, 'lynx.chat.menu.open')}
        >
          <LynxText style={{ color: cssVar('primary.base'), fontWeight: '700' }}>···</LynxText>
        </LynxView>
      </LynxView>

      {menuOpen ? (
        <LynxView
          style={{
            margin: '0 16px 8px',
            padding: '8px 12px',
            borderRadius: '12px',
            backgroundColor: cssVar('surface.elevated'),
          }}
        >
          {LYNX_CHAT_OVERFLOW_ITEMS.map((item) => (
            <LynxView
              key={item.id}
              bindtap={() => onOverflowSelect(item.id)}
              style={{ padding: '10px 0' }}
            >
              <LynxText style={{ color: cssVar('surface.foreground') }}>
                {lynxT(locale, item.labelKey)}
                {item.stubSheet ? ` · ${lynxT(locale, 'lynx.chat.menu.stubHint')}` : ''}
              </LynxText>
            </LynxView>
          ))}
        </LynxView>
      ) : null}

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
