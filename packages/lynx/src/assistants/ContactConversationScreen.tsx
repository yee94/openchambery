/**
 * Cap Assistant contact transcript secondary screen for Lynx.
 *
 * Opens from AssistantTab — NOT session ChatScreen. Loads Cap
 * `GET …/assistants/:id/messages`, sends via admit, aborts via session/abort.
 * Session message.* / session.status stay on `/api/global/event`.
 * Contact turn start / bubble delta / turn end ride the existing
 * `/api/openchamber/events` SSE (same runtimeFetch opener) and fold into
 * this LegendList with optimistic send rows (no TanStack Virtual, no overlay list).
 */
import { useEffect, useRef, useState } from 'react';

import { lynxT } from '../i18n/catalog';
import { LynxInput, LynxText, LynxView } from '../lynx-elements';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { cssVar } from '../theme/tokens';
import { LynxTimelineList } from '../chat/TimelineList';
import { LynxTurnCard } from '../chat/TurnCards';
import {
  createLynxSseOpenFromRuntimeFetch,
  subscribeLynxLiveTail,
} from '../chat/liveTail';
import {
  applyInitialFailure,
  applyInitialPage,
  beginLoadOlder,
  clearPrependSettle,
  createEmptyTimelineState,
  failLoadOlder,
  type LynxTimelineEntry,
  type LynxTimelineState,
} from '../chat/timelineModel';
import {
  admitLynxAssistantMessage,
  createLynxAssistantMessageId,
  type LynxSessionBinding,
} from './admission';
import { ensureAssistantSession } from './api';
import {
  LYNX_OPENCHAMBER_EVENTS_SSE_PATH,
  subscribeLynxContactEvents,
} from './contactEvents';
import {
  composeLynxContactTimeline,
  createLynxContactOptimisticTurn,
  createLynxContactPreviewState,
  markLynxContactOptimisticAdmitted,
  markLynxContactOptimisticFailed,
  pagesAfterLynxContactHistoryRefresh,
  reconcileLynxContactOverlays,
  reduceLynxContactTurnEvent,
  settleLynxContactPreviewsOnAbort,
  type LynxContactOptimisticTurn,
  type LynxContactPreviewState,
  type LynxContactTurnPreview,
} from './contactOptimistic';
import { type LynxContactCard } from './contactDisplay';
import {
  abortLynxAssistantSession,
  getNextLynxAssistantHistoryPageParam,
  loadLynxAssistantContactMessages,
  type LynxAssistantHistoryPage,
} from './contactMessages';
import { LynxAssistantReadMarker } from './ReadMarker';
import type { LynxAssistantMode, LynxAssistantReadPosition } from './types';

export type LynxContactConversationScreenProps = {
  locale: string;
  assistantId: string;
  title?: string | null;
  mode?: LynxAssistantMode | null;
  /** Snapshot binding hint — screen may soft-ensure when null. */
  initialSessionId?: string | null;
  initialSessionGeneration?: number;
  directory?: string | null;
  runtimeFetch?: LynxRuntimeFetch | null;
  onBack: () => void;
  readTip?: LynxAssistantReadPosition | null;
  onReadMarked?: () => void;
  /** Cap openSourceSession — nested session card → project ChatScreen. */
  onOpenSession?: (sessionId: string, directory: string | null) => void;
};

function ContactCardRow({
  locale,
  card,
  onOpenSession,
}: {
  locale: string;
  card: LynxContactCard;
  onOpenSession?: (sessionId: string, directory: string | null) => void;
}) {
  const canOpen = card.kind === 'session' && Boolean(card.targetId) && Boolean(onOpenSession);
  return (
    <LynxView
      bindtap={canOpen
        ? () => onOpenSession?.(card.targetId!, card.directory ?? null)
        : undefined}
      accessibility-role={canOpen ? 'button' : undefined}
      style={{
        marginTop: '6px',
        padding: '8px 10px',
        borderRadius: '10px',
        backgroundColor: cssVar('surface.elevated'),
        borderWidth: '1px',
        borderColor: cssVar('interactive.selection'),
        borderStyle: 'solid',
      }}
    >
      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '11px' }}>
        {card.kind === 'session-divider'
          ? lynxT(locale, 'lynx.assistant.contact.card.sessionDivider')
          : card.kind === 'session'
            ? lynxT(locale, 'lynx.assistant.contact.card.session')
            : card.kind === 'assistant'
              ? lynxT(locale, 'lynx.assistant.contact.card.assistant')
              : card.kind === 'schedule'
                ? lynxT(locale, 'lynx.assistant.contact.card.schedule')
                : lynxT(locale, 'lynx.assistant.contact.card.file')}
      </LynxText>
      <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '13px', marginTop: '2px' }}>
        {card.label}
      </LynxText>
    </LynxView>
  );
}

function ContactEntry({
  locale,
  entry,
  cards,
  onOpenSession,
}: {
  locale: string;
  entry: LynxTimelineEntry;
  cards: readonly LynxContactCard[];
  onOpenSession?: (sessionId: string, directory: string | null) => void;
}) {
  if (entry.parts?.some((part) => part.type === 'other' && part.rawType === 'session-divider')) {
    const divider = cards.find((card) => card.kind === 'session-divider');
    return divider
      ? <ContactCardRow locale={locale} card={divider} onOpenSession={onOpenSession} />
      : (
        <LynxView style={{ padding: '10px 16px' }}>
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
            {entry.text}
          </LynxText>
        </LynxView>
      );
  }

  return (
    <LynxView>
      <LynxTurnCard
        locale={locale}
        messageId={entry.messageId}
        role={entry.role}
        parts={entry.parts ?? []}
        textFallback={entry.text}
      />
      <LynxView style={{ padding: '0 16px 8px' }}>
        {cards
          .filter((card) => card.kind !== 'session-divider')
          .map((card) => (
            <ContactCardRow
              key={card.id}
              locale={locale}
              card={card}
              onOpenSession={onOpenSession}
            />
          ))}
      </LynxView>
    </LynxView>
  );
}

/**
 * Cap phone Assistant conversation — contact transcript secondary.
 */
export function LynxContactConversationScreen({
  locale,
  assistantId,
  title = null,
  mode = null,
  initialSessionId = null,
  initialSessionGeneration = 0,
  directory = null,
  runtimeFetch = null,
  onBack,
  readTip = null,
  onReadMarked,
  onOpenSession,
}: LynxContactConversationScreenProps) {
  const [binding, setBinding] = useState<LynxSessionBinding>(() => ({
    sessionID: initialSessionId,
    directory: directory ?? '',
    sessionGeneration: initialSessionGeneration,
  }));
  const [ensureNote, setEnsureNote] = useState<string | null>(null);
  const [pages, setPages] = useState<LynxAssistantHistoryPage[]>([]);
  const [timeline, setTimeline] = useState<LynxTimelineState>(() =>
    createEmptyTimelineState(assistantId, directory),
  );
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [liveConnection, setLiveConnection] = useState<string>('idle');
  const [messageCards, setMessageCards] = useState<Record<string, LynxContactCard[]>>({});
  const [optimistic, setOptimistic] = useState<LynxContactOptimisticTurn[]>([]);
  const [previews, setPreviews] = useState<LynxContactTurnPreview[]>([]);

  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const bindingRef = useRef(binding);
  bindingRef.current = binding;
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const optimisticRef = useRef(optimistic);
  optimisticRef.current = optimistic;
  const previewsRef = useRef(previews);
  previewsRef.current = previews;
  const previewStateRef = useRef<LynxContactPreviewState>(createLynxContactPreviewState());
  const sessionStreamWorkingRef = useRef(false);
  const contactPendingRef = useRef(false);
  const connectionsRef = useRef({ session: 'idle', contact: 'idle' });

  const publishConnection = () => {
    const { session, contact } = connectionsRef.current;
    if (contact === 'failed') {
      setLiveConnection('failed');
      return;
    }
    setLiveConnection(contact !== 'idle' ? contact : session);
  };

  const paintRef = useRef<(
    base: LynxTimelineState,
    overrides?: { pages?: readonly LynxAssistantHistoryPage[]; sessionStreamWorking?: boolean },
  ) => void>(() => {});
  paintRef.current = (base, overrides) => {
    const pagesNow = overrides?.pages ?? pagesRef.current;
    const composed = composeLynxContactTimeline({
      pages: pagesNow,
      sessionID: bindingRef.current.sessionID,
      assistantID: assistantId,
      optimistic: optimisticRef.current,
      previews: previewsRef.current,
    });
    setMessageCards(composed.cards);
    const streamWorking = overrides?.sessionStreamWorking ?? sessionStreamWorkingRef.current;
    const next: LynxTimelineState = {
      ...base,
      entries: composed.entries,
      sessionIsWorking: streamWorking || composed.working || contactPendingRef.current,
    };
    timelineRef.current = next;
    setTimeline(next);
  };

  const adoptHistoryPages = (nextPages: readonly LynxAssistantHistoryPage[]) => {
    const mutablePages = [...nextPages];
    pagesRef.current = mutablePages;
    setPages(mutablePages);
    const reconciled = reconcileLynxContactOverlays({
      pages: nextPages,
      sessionID: bindingRef.current.sessionID,
      optimistic: optimisticRef.current,
      previews: previewsRef.current,
    });
    if (reconciled.optimistic !== optimisticRef.current) {
      optimisticRef.current = reconciled.optimistic as LynxContactOptimisticTurn[];
      setOptimistic(optimisticRef.current);
    }
    if (reconciled.previews !== previewsRef.current) {
      previewsRef.current = reconciled.previews as LynxContactTurnPreview[];
      previewStateRef.current = {
        ...previewStateRef.current,
        previews: previewsRef.current,
      };
      setPreviews(previewsRef.current);
    }
  };

  // Soft ensure when unbound — never invent a session id.
  useEffect(() => {
    if (binding.sessionID || !runtimeFetch) {
      if (!runtimeFetch && !binding.sessionID) {
        setEnsureNote(lynxT(locale, 'lynx.assistant.noRuntime'));
      }
      return;
    }
    let cancelled = false;
    setEnsureNote(lynxT(locale, 'lynx.assistant.ensuring'));
    void (async () => {
      try {
        const next = await ensureAssistantSession(runtimeFetch, assistantId);
        if (cancelled) return;
        if (!next.sessionID) {
          setEnsureNote(lynxT(locale, 'lynx.assistant.ensureUnbound'));
          return;
        }
        setEnsureNote(null);
        setBinding(next);
      } catch (error) {
        if (cancelled) return;
        setEnsureNote(
          `${lynxT(locale, 'lynx.assistant.ensureFailed')}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assistantId, binding.sessionID, runtimeFetch, locale]);

  // Contact history load (stitched transcript). Failure ≠ empty success.
  useEffect(() => {
    let cancelled = false;
    optimisticRef.current = [];
    previewsRef.current = [];
    previewStateRef.current = createLynxContactPreviewState();
    contactPendingRef.current = false;
    setOptimistic([]);
    setPreviews([]);
    const empty = createEmptyTimelineState(assistantId, directory);
    timelineRef.current = empty;
    setTimeline(empty);
    pagesRef.current = [];
    setPages([]);
    setActionError(null);

    if (!runtimeFetch) {
      const failed = applyInitialFailure(
        empty,
        lynxT(locale, 'lynx.assistant.contact.noRuntime'),
      );
      paintRef.current(failed);
      return;
    }

    void (async () => {
      const result = await loadLynxAssistantContactMessages(runtimeFetch, assistantId);
      if (cancelled) return;
      if (result.status !== 'ok') {
        const error = result.status === 'failed'
          ? result.error.message
          : result.status;
        paintRef.current(applyInitialFailure(timelineRef.current, error));
        return;
      }
      const nextPages = [result.page];
      const olderCursor = getNextLynxAssistantHistoryPageParam(result.page) ?? null;
      adoptHistoryPages(nextPages);
      paintRef.current(applyInitialPage(timelineRef.current, {
        entries: [],
        olderCursor,
        canLoadEarlier: Boolean(olderCursor),
      }), { pages: nextPages });
    })();

    return () => {
      cancelled = true;
    };
  }, [assistantId, directory, runtimeFetch, locale]);

  // Session message.* / session.status on Cap `/api/global/event` (same opener).
  useEffect(() => {
    const sessionId = binding.sessionID;
    if (!runtimeFetch || !sessionId) {
      connectionsRef.current.session = 'idle';
      publishConnection();
      return;
    }
    const controller = new AbortController();
    const openStream = createLynxSseOpenFromRuntimeFetch(runtimeFetch);
    void subscribeLynxLiveTail({
      sessionId,
      directory: binding.directory || directory,
      openStream,
      signal: controller.signal,
      getTimeline: () => timelineRef.current,
      setTimeline: (next) => {
        sessionStreamWorkingRef.current = next.sessionIsWorking;
        paintRef.current(next, { sessionStreamWorking: next.sessionIsWorking });
      },
      onEffect: (effect) => {
        if (effect.type === 'connection') {
          connectionsRef.current.session = effect.state;
          publishConnection();
        }
      },
    });
    return () => {
      controller.abort();
    };
  }, [runtimeFetch, binding.sessionID, binding.directory, directory]);

  // Assistant-scoped contact-* SSE on the existing OpenChamber event bus.
  useEffect(() => {
    if (!runtimeFetch || !assistantId.trim()) {
      connectionsRef.current.contact = 'idle';
      publishConnection();
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const openStream = createLynxSseOpenFromRuntimeFetch(runtimeFetch);
    void subscribeLynxContactEvents({
      assistantID: assistantId,
      openStream,
      signal: controller.signal,
      path: LYNX_OPENCHAMBER_EVENTS_SSE_PATH,
      onConnection: (state) => {
        connectionsRef.current.contact = state;
        publishConnection();
      },
      onEvent: (event) => {
        previewStateRef.current = reduceLynxContactTurnEvent(previewStateRef.current, event);
        if (event.type === 'contact-turn-start' || event.type === 'contact-turn-end') {
          contactPendingRef.current = false;
        }
        previewsRef.current = previewStateRef.current.previews as LynxContactTurnPreview[];
        setPreviews(previewsRef.current);
        paintRef.current(timelineRef.current);
        if (event.type !== 'contact-turn-end') return;
        const beforePages = pagesRef.current;
        void (async () => {
          const result = await loadLynxAssistantContactMessages(runtimeFetch, assistantId);
          if (cancelled) return;
          const nextPages = pagesAfterLynxContactHistoryRefresh(beforePages, result);
          if (nextPages === beforePages) return;
          adoptHistoryPages(nextPages);
          paintRef.current(timelineRef.current, { pages: nextPages });
        })();
      },
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [runtimeFetch, assistantId]);

  const onLoadOlder = () => {
    if (!runtimeFetch) {
      setTimeline((state) => failLoadOlder(beginLoadOlder(state), 'no-runtime'));
      return;
    }
    setTimeline((state) => {
      const next = beginLoadOlder(state);
      if (!next.isLoadingOlder) return state;
      timelineRef.current = next;
      const before = next.olderCursor;
      void (async () => {
        const result = await loadLynxAssistantContactMessages(runtimeFetch, assistantId, { before });
        if (result.status !== 'ok') {
          const failed = failLoadOlder(
            timelineRef.current,
            result.status === 'failed' ? result.error.message : result.status,
          );
          paintRef.current(failed);
          return;
        }
        const nextPages = [...pagesRef.current, result.page];
        const olderCursor = getNextLynxAssistantHistoryPageParam(result.page) ?? null;
        adoptHistoryPages(nextPages);
        const authoritative: LynxTimelineState = {
          ...timelineRef.current,
          olderCursor,
          canLoadEarlier: Boolean(olderCursor),
          isLoadingOlder: false,
          loadOlderError: null,
          prependSettling: true,
          historyAnchorKeys: new Set(timelineRef.current.entries.map((entry) => entry.key)),
        };
        paintRef.current(authoritative, { pages: nextPages });
        queueMicrotask(() => {
          paintRef.current(clearPrependSettle(timelineRef.current), { pages: nextPages });
        });
      })();
      return next;
    });
  };

  const onSend = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setActionError(null);
    if (!runtimeFetch) {
      setActionError(lynxT(locale, 'lynx.assistant.contact.noRuntime'));
      return;
    }
    if (!binding.sessionID && mode !== 'stateless') {
      setActionError(lynxT(locale, 'lynx.assistant.openNeedsSession'));
      return;
    }
    const messageID = createLynxAssistantMessageId();
    const turn = createLynxContactOptimisticTurn(assistantId, messageID, text);
    optimisticRef.current = [...optimisticRef.current, turn];
    setOptimistic(optimisticRef.current);
    setDraft('');
    setSending(true);
    paintRef.current(timelineRef.current);
    try {
      const result = await admitLynxAssistantMessage(runtimeFetch, {
        assistantId,
        text,
        messageID,
        sessionID: binding.sessionID,
        sessionGeneration: binding.sessionGeneration,
        mode,
      });
      if (result.status !== 'ok') {
        const message = result.status === 'failed' ? result.error.message : result.status;
        optimisticRef.current = markLynxContactOptimisticFailed(
          optimisticRef.current,
          messageID,
          message,
        );
        setOptimistic(optimisticRef.current);
        setActionError(message);
        paintRef.current(timelineRef.current);
        return;
      }
      optimisticRef.current = markLynxContactOptimisticAdmitted(optimisticRef.current, messageID);
      setOptimistic(optimisticRef.current);
      contactPendingRef.current = !previewStateRef.current.settledTurnIDs.has(messageID);
      setBinding(result.admission.binding);
      bindingRef.current = result.admission.binding;
      const refresh = await loadLynxAssistantContactMessages(runtimeFetch, assistantId);
      const nextPages = pagesAfterLynxContactHistoryRefresh(pagesRef.current, refresh);
      if (nextPages !== pagesRef.current) {
        const olderCursor = refresh.status === 'ok'
          ? getNextLynxAssistantHistoryPageParam(refresh.page) ?? null
          : timelineRef.current.olderCursor;
        adoptHistoryPages(nextPages);
        paintRef.current({
          ...timelineRef.current,
          olderCursor,
          canLoadEarlier: Boolean(olderCursor),
          initialError: null,
          hydrated: true,
        }, { pages: nextPages });
      } else {
        paintRef.current(timelineRef.current);
      }
    } finally {
      setSending(false);
    }
  };

  const onStop = async () => {
    setActionError(null);
    if (!runtimeFetch || !binding.sessionID) {
      setActionError(lynxT(locale, 'lynx.assistant.contact.abortUnavailable'));
      return;
    }
    const result = await abortLynxAssistantSession(runtimeFetch, assistantId, binding);
    if (result.status !== 'ok') {
      setActionError(
        result.status === 'failed'
          ? result.error.message
          : result.status,
      );
      return;
    }
    setBinding(result.binding);
    bindingRef.current = result.binding;
    contactPendingRef.current = false;
    sessionStreamWorkingRef.current = false;
    previewsRef.current = settleLynxContactPreviewsOnAbort(previewsRef.current, assistantId);
    previewStateRef.current = {
      ...previewStateRef.current,
      previews: previewsRef.current,
    };
    setPreviews(previewsRef.current);
    paintRef.current(timelineRef.current, { sessionStreamWorking: false });
  };

  const occupancyInset = 12;
  const headerTitle = title?.trim() || lynxT(locale, 'mobile.tabs.assistant');

  return (
    <LynxView
      style={{
        flexGrow: 1,
        width: '100%',
        height: '100%',
        backgroundColor: cssVar('surface.background'),
      }}
    >
      <LynxAssistantReadMarker
        key={assistantId}
        runtimeFetch={runtimeFetch}
        assistantId={assistantId}
        readTip={readTip}
        viewing
        onMarked={onReadMarked}
      />

      <LynxView style={{ flexDirection: 'row', padding: '12px 16px', alignItems: 'center' }}>
        <LynxView bindtap={onBack} accessibility-label={lynxT(locale, 'lynx.shell.back')}>
          <LynxText style={{ color: cssVar('primary.base') }}>
            {lynxT(locale, 'lynx.shell.back')}
          </LynxText>
        </LynxView>
        <LynxView style={{ marginLeft: '12px', flexGrow: 1 }}>
          <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '600' }}>
            {headerTitle}
          </LynxText>
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '11px', marginTop: '2px' }}>
            {lynxT(locale, 'lynx.assistant.contact.subtitle')}
          </LynxText>
        </LynxView>
      </LynxView>

      {ensureNote ? (
        <LynxText style={{ padding: '0 16px 8px', color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
          {ensureNote}
        </LynxText>
      ) : null}

      {liveConnection !== 'idle' ? (
        <LynxText style={{ padding: '0 16px 6px', color: cssVar('surface.mutedForeground'), fontSize: '11px' }}>
          {lynxT(locale, 'lynx.chat.live.label')}: {liveConnection}
        </LynxText>
      ) : null}

      {timeline.initialError ? (
        <LynxText style={{ padding: '16px', color: cssVar('status.error'), fontSize: '13px' }}>
          {lynxT(locale, 'lynx.chat.timeline.loadError')}: {timeline.initialError}
        </LynxText>
      ) : null}

      {actionError ? (
        <LynxText style={{ padding: '0 16px 8px', color: cssVar('status.error'), fontSize: '12px' }}>
          {actionError}
        </LynxText>
      ) : null}

      <LynxTimelineList
        locale={locale}
        state={timeline}
        onLoadOlder={onLoadOlder}
        renderEntry={(entry) => (
          <ContactEntry
            locale={locale}
            entry={entry}
            cards={messageCards[entry.messageId] ?? []}
            onOpenSession={onOpenSession}
          />
        )}
        footer={(
          <LynxView style={{ height: `${56 + occupancyInset}px` }} />
        )}
      />

      <LynxView
        style={{
          padding: '10px 12px',
          paddingBottom: `${10 + occupancyInset}px`,
          borderTopWidth: '1px',
          borderTopColor: cssVar('interactive.selection'),
          borderTopStyle: 'solid',
          backgroundColor: cssVar('surface.background'),
          flexDirection: 'row',
          alignItems: 'center',
        }}
      >
        <LynxInput
          value={draft}
          placeholder={lynxT(locale, 'lynx.chat.composer.placeholder')}
          bindinput={(event) => setDraft(String(event?.detail?.value ?? ''))}
          style={{
            flexGrow: 1,
            padding: '10px 12px',
            borderRadius: '12px',
            backgroundColor: cssVar('surface.elevated'),
            color: cssVar('surface.foreground'),
            fontSize: '15px',
          }}
        />
        {timeline.sessionIsWorking ? (
          <LynxView
            bindtap={() => { void onStop(); }}
            accessibility-role="button"
            accessibility-label={lynxT(locale, 'lynx.chat.composer.stop')}
            style={{
              marginLeft: '8px',
              padding: '10px 14px',
              borderRadius: '12px',
              backgroundColor: cssVar('status.error'),
            }}
          >
            <LynxText style={{ color: cssVar('status.onError'), fontWeight: '700' }}>
              {lynxT(locale, 'lynx.chat.composer.stop')}
            </LynxText>
          </LynxView>
        ) : (
          <LynxView
            bindtap={() => { void onSend(); }}
            accessibility-role="button"
            accessibility-label={lynxT(locale, 'lynx.chat.composer.send')}
            style={{
              marginLeft: '8px',
              padding: '10px 14px',
              borderRadius: '12px',
              backgroundColor: cssVar('primary.base'),
              opacity: sending || !draft.trim() ? '0.55' : '1',
            }}
          >
            <LynxText style={{ color: cssVar('primary.foreground'), fontWeight: '700' }}>
              {lynxT(locale, 'lynx.chat.composer.send')}
            </LynxText>
          </LynxView>
        )}
      </LynxView>
    </LynxView>
  );
}
