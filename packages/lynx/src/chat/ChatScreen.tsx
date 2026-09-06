import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { lynxT } from '../i18n/catalog';
import { LynxInput, LynxText, LynxView } from '../lynx-elements';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { cssVar } from '../theme/tokens';
import {
  createLynxComposerActions,
  type LynxComposerActions,
  type LynxComposerModel,
} from './composerActions';
import { LynxChatSheet } from './ChatSheets';
import {
  LYNX_CHAT_OVERFLOW_ITEMS,
  chatSheetFromOverflowId,
  type LynxChatOverflowItemId,
  type LynxChatSheetKind,
} from './overflowMenu';
import type { LynxPermissionRequest, LynxQuestionRequest } from './messageParts';
import {
  fetchLynxPendingCards,
  rejectLynxQuestion,
  replyLynxPermission,
  replyLynxQuestion,
  type LynxPermissionReply,
} from './pendingCards';
import { fetchSessionMessages } from './sessionApi';
import { LynxTimelineList } from './TimelineList';
import { LynxPermissionCard, LynxQuestionCard } from './TurnCards';
import {
  createLynxSseOpenFromRuntimeFetch,
  subscribeLynxLiveTail,
  type LynxLiveTailConnectionState,
} from './liveTail';
import { resolveLynxComposerOccupancyInset } from './imeOccupancy';
import type { LynxChatRoute } from '../shell/navigation';
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
  /** Deep-link / host can open a sheet immediately. */
  initialSheet?: LynxChatSheetKind | null;
  onSheetClosed?: () => void;
  /**
   * Cap nested child stack: immediate predecessor route for underlay chrome.
   * Back pops to this session (ShellApp uses resolveLynxSecondaryBackDecision).
   */
  predecessor?: LynxChatRoute | null;
};

const DEFAULT_MODEL: LynxComposerModel = {
  providerID: 'anthropic',
  modelID: 'claude-sonnet-4-20250514',
};

/**
 * Pushed chat page: header + LegendList timeline + composer send/stop/queue.
 * Live Cap `/api/global/event` SSE folds into the same list (no overlay).
 * IME occupancy is collapsed-foot only — host binds native IME (no WebView FLIP).
 * Overflow menu opens Files/Changes/MCP sheets backed by Cap list endpoints.
 */
export function LynxChatScreen({
  locale,
  sessionId,
  directory = null,
  onBack,
  runtimeFetch = null,
  model = DEFAULT_MODEL,
  title,
  initialSheet = null,
  onSheetClosed,
  predecessor = null,
}: LynxChatScreenProps) {
  const [timeline, setTimeline] = useState<LynxTimelineState>(() =>
    createEmptyTimelineState(sessionId, directory),
  );
  const [draft, setDraft] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [queueCount, setQueueCount] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheet, setSheet] = useState<LynxChatSheetKind | null>(initialSheet);
  const [questions, setQuestions] = useState<LynxQuestionRequest[]>([]);
  const [permissions, setPermissions] = useState<LynxPermissionRequest[]>([]);
  const [cardBusy, setCardBusy] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);
  const [liveConnection, setLiveConnection] = useState<LynxLiveTailConnectionState>('idle');
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;

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
      sessionIsWorking: () => timelineRef.current.sessionIsWorking,
      followUpBehavior: 'queue',
    }),
    [sessionId, directory, model, sessionApi],
  );
  const composerRef = useRef(composer);
  composerRef.current = composer;

  const occupancyInset = resolveLynxComposerOccupancyInset();

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

  const reloadPendingCards = useCallback(() => {
    if (!runtimeFetch) {
      setQuestions([]);
      setPermissions([]);
      return;
    }
    void (async () => {
      const result = await fetchLynxPendingCards(runtimeFetch, { directory, sessionId });
      if (result.status === 'ok') {
        setQuestions(result.questions);
        setPermissions(result.permissions);
        setCardError(null);
      } else if (result.status === 'failed') {
        setCardError(result.error);
      }
    })();
  }, [runtimeFetch, directory, sessionId]);

  useEffect(() => {
    let cancelled = false;
    setTimeline(createEmptyTimelineState(sessionId, directory));
    setActionError(null);
    setMenuOpen(false);
    setSheet(initialSheet);
    setQuestions([]);
    setPermissions([]);
    setCardError(null);
    reloadPendingCards();

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
  }, [sessionId, directory, runtimeFetch, initialSheet, reloadPendingCards]);

  // Cap global-event SSE live tail → same LegendList (no overlay).
  useEffect(() => {
    if (!runtimeFetch) {
      setLiveConnection('idle');
      return;
    }
    const controller = new AbortController();
    const openStream = createLynxSseOpenFromRuntimeFetch(runtimeFetch);
    void subscribeLynxLiveTail({
      sessionId,
      directory,
      openStream,
      signal: controller.signal,
      getTimeline: () => timelineRef.current,
      setTimeline: (next) => {
        timelineRef.current = next;
        setTimeline(next);
      },
      onEffect: (effect) => {
        if (effect.type === 'connection') {
          setLiveConnection(effect.state);
          return;
        }
        if (effect.type === 'flush-queue') {
          void (async () => {
            const result = await composerRef.current.flushQueue();
            if (result.status === 'ok') {
              setQueueCount(composerRef.current.getQueue().length);
              setTimeline((state) => setSessionWorking(state, true));
            }
          })();
          return;
        }
        if (effect.type === 'reload-pending-cards') {
          reloadPendingCards();
        }
      },
    });
    return () => {
      controller.abort();
    };
  }, [runtimeFetch, sessionId, directory, reloadPendingCards]);

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


  const onQuestionReply = useCallback(async (requestId: string, answers: string[][]) => {
    setCardBusy(true);
    setCardError(null);
    const result = await replyLynxQuestion(runtimeFetch, { requestId, answers, directory });
    setCardBusy(false);
    if (result.status !== 'ok') {
      setCardError(result.status === 'no-runtime' ? 'no-runtime' : result.error);
      return;
    }
    reloadPendingCards();
  }, [runtimeFetch, directory, reloadPendingCards]);

  const onQuestionReject = useCallback(async (requestId: string) => {
    setCardBusy(true);
    setCardError(null);
    const result = await rejectLynxQuestion(runtimeFetch, { requestId, directory });
    setCardBusy(false);
    if (result.status !== 'ok') {
      setCardError(result.status === 'no-runtime' ? 'no-runtime' : result.error);
      return;
    }
    reloadPendingCards();
  }, [runtimeFetch, directory, reloadPendingCards]);

  const onPermissionReply = useCallback(async (requestId: string, reply: LynxPermissionReply) => {
    setCardBusy(true);
    setCardError(null);
    const result = await replyLynxPermission(runtimeFetch, { requestId, reply, directory });
    setCardBusy(false);
    if (result.status !== 'ok') {
      setCardError(result.status === 'no-runtime' ? 'no-runtime' : result.error);
      return;
    }
    reloadPendingCards();
  }, [runtimeFetch, directory, reloadPendingCards]);

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
      <LynxChatSheet
        locale={locale}
        kind={sheet}
        directory={directory}
        runtimeFetch={runtimeFetch}
        onBack={() => {
          setSheet(null);
          onSheetClosed?.();
        }}
      />
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

      {predecessor ? (
        <LynxView
          style={{ padding: '0 16px 8px', flexDirection: 'row', alignItems: 'center' }}
          bindtap={onBack}
          accessibility-role="button"
          accessibility-label={lynxT(locale, 'lynx.shell.chat.predecessor')}
        >
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
            {lynxT(locale, 'lynx.shell.chat.predecessor')}: {predecessor.sessionId}
          </LynxText>
        </LynxView>
      ) : null}

      {liveConnection !== 'idle' ? (
        <LynxText style={{ padding: '0 16px 6px', color: cssVar('surface.mutedForeground'), fontSize: '11px' }}>
          {lynxT(locale, 'lynx.chat.live.label')}: {liveConnection}
        </LynxText>
      ) : null}

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
          <LynxView style={{ padding: '12px 16px', paddingBottom: `${12 + occupancyInset}px` }}>
            {questions.map((question) => (
              <LynxQuestionCard
                key={question.id}
                locale={locale}
                question={question}
                busy={cardBusy}
                onReply={(answers) => { void onQuestionReply(question.id, answers); }}
                onReject={() => { void onQuestionReject(question.id); }}
              />
            ))}
            {permissions.map((permission) => (
              <LynxPermissionCard
                key={permission.id}
                locale={locale}
                permission={permission}
                busy={cardBusy}
                onReply={(reply) => { void onPermissionReply(permission.id, reply); }}
              />
            ))}
            {cardError ? (
              <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '8px' }}>
                {cardError}
              </LynxText>
            ) : null}
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
