import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';

import { lynxT } from '../i18n/catalog';
import { LynxInput, LynxText, LynxView } from '../lynx-elements';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { cssVar } from '../theme/tokens';
import {
  applyLynxComposerSuggestion,
  detectLynxComposerTrigger,
  loadLynxComposerCatalogs,
  suggestionsForTrigger,
  type LynxComposerSuggestion,
} from './composerCatalog';
import { LynxComposerAutocompleteList } from './ComposerAutocompleteList';
import { LynxComposerActionsInGlass } from './ComposerActionsInGlass';
import { LynxComposerGlassCard } from './ComposerGlassCard';
import { LynxComposerPickerSheets } from './ComposerPickerSheets';
import {
  applyLynxAgentPickerSelection,
  applyLynxModelPickerSelection,
  type LynxComposerPickerKind,
} from './composerPicker';
import type { LynxHostGlobalProps } from '../host/embedding';
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
  buildLynxChatContextChrome,
  fetchLynxModelContextLimit,
  getLynxLatestUserMessageModel,
  type LynxContextDisplay,
  type LynxContextMessageLike,
} from './contextUsage';
import {
  createLynxEdgeSwipeSessionSwitchMachine,
  type LynxEdgeSwipeMachine,
} from './edgeSwipeSessionSwitch';
import {
  armLynxMarkdownPinReveal,
  createLynxMarkdownPinRevealState,
  markLynxMarkdownPinReady,
  type LynxMarkdownPinRevealState,
} from './markdownPinReveal';
import type { LynxHapticsAdapter } from '../host/haptics';
import type { LynxMediaAdapter } from '../host/media';
import { pickLynxComposerAttachments } from '../host/media';
import { applyLynxEdgeSwipeHaptic } from '../host/haptics';
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
  /** Host chrome props for GlassChrome composer / autocomplete chips. */
  host: LynxHostGlobalProps;
  /** Mode A true; Mode B false. Composer glass still paints (dock-only gate). */
  fullPageAutoGlassSkin?: boolean;
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
  /** Host-injected haptics (OpenChamberHaptics). Absent → no fake success. */
  haptics?: LynxHapticsAdapter | null;
  /** Host-injected media pick / HEIC (OpenChamberMedia). Absent → unavailable. */
  media?: LynxMediaAdapter | null;
  /**
   * Newest-first top-level session ids for composer edge-swipe switch.
   * Host/shell supplies; empty disables switch targets.
   */
  orderedSessionIds?: readonly string[];
  /** Called when edge-swipe commits a session switch. */
  onSessionSwipe?: (direction: 'prev' | 'next', targetId: string) => void;
  /**
   * Host/shell fills this ref with the edge-swipe dispatch so native pan can
   * feed events. Composer-surface ownership still enforced inside the machine.
   */
  edgeSwipeDispatchRef?: MutableRefObject<
    ((event: Parameters<LynxEdgeSwipeMachine['dispatch']>[0]) => void) | null
  >;
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
  host,
  fullPageAutoGlassSkin = true,
  runtimeFetch = null,
  model = DEFAULT_MODEL,
  title,
  initialSheet = null,
  onSheetClosed,
  predecessor = null,
  haptics = null,
  media = null,
  orderedSessionIds = [],
  onSessionSwipe,
  edgeSwipeDispatchRef,
}: LynxChatScreenProps) {
  const [timeline, setTimeline] = useState<LynxTimelineState>(() =>
    createEmptyTimelineState(sessionId, directory),
  );
  const [draft, setDraft] = useState('');
  const [composerSuggestions, setComposerSuggestions] = useState<LynxComposerSuggestion[]>([]);
  const [composerCatalogHint, setComposerCatalogHint] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [queueCount, setQueueCount] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheet, setSheet] = useState<LynxChatSheetKind | null>(initialSheet);
  const [questions, setQuestions] = useState<LynxQuestionRequest[]>([]);
  const [permissions, setPermissions] = useState<LynxPermissionRequest[]>([]);
  const [cardBusy, setCardBusy] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);
  const [liveConnection, setLiveConnection] = useState<LynxLiveTailConnectionState>('idle');
  const [contextDisplay, setContextDisplay] = useState<LynxContextDisplay>(null);
  const [contextLimit, setContextLimit] = useState(0);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [composerModel, setComposerModel] = useState<LynxComposerModel>(model);
  const [pickerKind, setPickerKind] = useState<LynxComposerPickerKind | null>(null);
  const [pinReveal, setPinReveal] = useState<LynxMarkdownPinRevealState>(() =>
    createLynxMarkdownPinRevealState(sessionId),
  );
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const edgeSwipeRef = useRef<LynxEdgeSwipeMachine | null>(null);
  const orderedSessionIdsRef = useRef(orderedSessionIds);
  orderedSessionIdsRef.current = orderedSessionIds;
  const onSessionSwipeRef = useRef(onSessionSwipe);
  onSessionSwipeRef.current = onSessionSwipe;
  const hapticsRef = useRef(haptics);
  hapticsRef.current = haptics;

  const sessionApi = useMemo(
    () => (runtimeFetch ? { runtimeFetch } : null),
    [runtimeFetch],
  );

  useEffect(() => {
    setComposerModel(model);
  }, [sessionId, model.providerID, model.modelID, model.agent, model.variant]);

  const composer: LynxComposerActions = useMemo(
    () => createLynxComposerActions({
      sessionId,
      directory,
      model: composerModel,
      sessionApi,
      sessionIsWorking: () => timelineRef.current.sessionIsWorking,
      followUpBehavior: 'queue',
    }),
    [sessionId, directory, composerModel, sessionApi],
  );
  const composerRef = useRef(composer);
  composerRef.current = composer;

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


  const occupancyInset = resolveLynxComposerOccupancyInset();

  const messagesForContext = useMemo((): LynxContextMessageLike[] => (
    timeline.entries.map((entry) => ({
      id: entry.messageId,
      role: entry.role,
      tokens: entry.tokens,
      model: entry.model,
    }))
  ), [timeline.entries]);

  const refreshContextUsage = useCallback(() => {
    const display = buildLynxChatContextChrome({
      messages: messagesForContext,
      contextLimit,
      isDraft: false,
      getParts: (messageId) => {
        const entry = timelineRef.current.entries.find((row) => row.messageId === messageId);
        return entry?.parts;
      },
    });
    setContextDisplay(display);
  }, [messagesForContext, contextLimit]);

  useEffect(() => {
    refreshContextUsage();
  }, [refreshContextUsage]);

  useEffect(() => {
    let cancelled = false;
    const modelRef = getLynxLatestUserMessageModel(messagesForContext);
    void (async () => {
      const result = await fetchLynxModelContextLimit(runtimeFetch, {
        directory,
        modelRef,
        fallbackModel: { providerID: composerModel.providerID, modelID: composerModel.modelID },
      });
      if (cancelled) return;
      if (result.status === 'ok' && result.limit) {
        setContextLimit(result.limit.contextLimit);
      } else {
        setContextLimit(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runtimeFetch, directory, messagesForContext, composerModel.providerID, composerModel.modelID]);

  // Cap markdown pin-reveal: arm on session open; Lynx rows stamp ready immediately
  // in this slice (no deferred markdown worker), then reveal after a microtask /
  // timeout so the contract stays testable for host binding.
  useEffect(() => {
    const entryKeys = timeline.entries.map((entry) => entry.key);
    setPinReveal((prev) => armLynxMarkdownPinReveal(prev, {
      reason: 'session-open',
      entryKeys,
      scopeKey: sessionId,
    }));
    const generationAtArm = Date.now();
    const readyTimer = setTimeout(() => {
      setPinReveal((prev) => {
        if (prev.scopeKey !== sessionId) return prev;
        return markLynxMarkdownPinReady(prev);
      });
    }, timeline.hydrated ? 0 : 600);
    void generationAtArm;
    return () => {
      clearTimeout(readyTimer);
    };
    // Re-arm only when session / hydration boundary changes — not on live-tail growth.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Cap: live-tail must not re-arm
  }, [sessionId, timeline.hydrated]);

  useEffect(() => {
    edgeSwipeRef.current = createLynxEdgeSwipeSessionSwitchMachine({
      resolveTargets: () => {
        const ordered = orderedSessionIdsRef.current;
        const index = ordered.findIndex((id) => id === sessionId);
        return {
          currentId: sessionId,
          prevId: index > 0 ? ordered[index - 1]! : null,
          nextId: index >= 0 && index < ordered.length - 1 ? ordered[index + 1]! : null,
        };
      },
    });
  }, [sessionId]);

  const applyEdgeSwipeEffects = useCallback(async (
    effects: ReturnType<LynxEdgeSwipeMachine['dispatch']>,
  ) => {
    for (const effect of effects) {
      if (effect.type === 'haptic' && hapticsRef.current) {
        await applyLynxEdgeSwipeHaptic(hapticsRef.current, effect.strength);
      }
      if (effect.type === 'switch') {
        onSessionSwipeRef.current?.(effect.direction, effect.targetId);
      }
    }
  }, []);

  /** Host may bind pan and call this with composer-surface ownership flags. */
  const onComposerEdgeSwipeEvent = useCallback((
    event: Parameters<LynxEdgeSwipeMachine['dispatch']>[0],
  ) => {
    const machine = edgeSwipeRef.current;
    if (!machine) return;
    const effects = machine.dispatch(event);
    void applyEdgeSwipeEffects(effects);
  }, [applyEdgeSwipeEffects]);

  useEffect(() => {
    if (!edgeSwipeDispatchRef) return;
    edgeSwipeDispatchRef.current = onComposerEdgeSwipeEvent;
    return () => {
      edgeSwipeDispatchRef.current = null;
    };
  }, [edgeSwipeDispatchRef, onComposerEdgeSwipeEvent]);

  const onAttach = useCallback(async () => {
    setAttachError(null);
    if (!media) {
      setAttachError('no-host: media pick unavailable');
      return;
    }
    const result = await pickLynxComposerAttachments(media);
    if (result.status === 'unavailable') {
      setAttachError(`unavailable: ${result.reason}`);
      return;
    }
    if (result.status === 'failed') {
      setAttachError(result.error);
      return;
    }
    if (result.status === 'cancelled') return;
    // Files accepted — host still owns upload/attach into prompt parts.
    setAttachError(null);
    void result.files;
  }, [media]);

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
        host={host}
        fullPageAutoGlassSkin={fullPageAutoGlassSkin}
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
        position: 'relative',
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
        {contextDisplay ? (
          <LynxText
            accessibility-label={lynxT(locale, 'lynx.chat.context.aria')}
            style={{
              marginRight: '10px',
              color: contextDisplay.status === 'error'
                ? 'var(--status-error)'
                : contextDisplay.status === 'warning'
                  ? 'var(--status-warning)'
                  : 'var(--status-success)',
              fontSize: '12px',
              fontWeight: '600',
            }}
          >
            {Math.round(contextDisplay.percentage)}% · {contextDisplay.tokens}
          </LynxText>
        ) : null}
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
        pinRevealPhase={pinReveal.phase}
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
            {/* Autocomplete ABOVE glass composer — never inside blur-view/contentView */}
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
              variant={draft.trim().length > 0 || timeline.sessionIsWorking ? 'card' : 'pill'}
              sessionSwipeSurface
              accessibilityLabel={lynxT(locale, 'lynx.chat.edgeSwipe.surface')}
              style={{ marginBottom: '8px' }}
            >
              {draft.trim().length > 0 || timeline.sessionIsWorking ? (
                <>
                  <LynxInput
                    value={draft}
                    placeholder={lynxT(locale, 'lynx.chat.composer.placeholder')}
                    bindinput={(event) => setDraft(event.detail?.value ?? '')}
                    accessibility-label={lynxT(locale, 'lynx.chat.composer.placeholder')}
                    style={{ color: cssVar('surface.foreground'), fontSize: '14px' }}
                  />
                  {/* Cap expanded footer: + · spacer · Agent · model · Send/Stop (± Queue) — inside glass */}
                  <LynxComposerActionsInGlass
                    locale={locale}
                    variant="card"
                    sessionIsWorking={timeline.sessionIsWorking}
                    queueCount={queueCount}
                    agentLabel={composerModel.agent || lynxT(locale, 'lynx.chat.composer.mentionHint')}
                    modelLabel={composerModel.modelID}
                    onAttach={() => { void onAttach(); }}
                    onSend={() => { void onSend(); }}
                    onStop={() => { void onStop(); }}
                    onQueue={() => { void onQueue(); }}
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
                  {/* Cap collapsed pill: + · input · Send/Stop — all inside glass */}
                  <LynxView
                    bindtap={() => { void onAttach(); }}
                    accessibility-role="button"
                    accessibility-label={lynxT(locale, 'lynx.chat.composer.attach')}
                    data-lynx-composer-action="attach"
                    style={{ padding: '6px 8px' }}
                  >
                    <LynxText style={{ color: cssVar('surface.mutedForeground'), fontWeight: '600' }}>
                      +
                    </LynxText>
                  </LynxView>
                  <LynxInput
                    value={draft}
                    placeholder={lynxT(locale, 'lynx.chat.composer.placeholder')}
                    bindinput={(event) => setDraft(event.detail?.value ?? '')}
                    accessibility-label={lynxT(locale, 'lynx.chat.composer.placeholder')}
                    style={{
                      flexGrow: 1,
                      color: cssVar('surface.foreground'),
                      fontSize: '14px',
                    }}
                  />
                  {timeline.sessionIsWorking ? (
                    <LynxView
                      bindtap={() => { void onStop(); }}
                      accessibility-role="button"
                      accessibility-label={lynxT(locale, 'lynx.chat.composer.stop')}
                      data-lynx-composer-action="sendOrStop"
                      style={{ padding: '6px 8px' }}
                    >
                      <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600' }}>
                        {lynxT(locale, 'lynx.chat.composer.stop')}
                      </LynxText>
                    </LynxView>
                  ) : (
                    <LynxView
                      bindtap={() => { void onSend(); }}
                      accessibility-role="button"
                      accessibility-label={lynxT(locale, 'lynx.chat.composer.send')}
                      data-lynx-composer-action="sendOrStop"
                      style={{ padding: '6px 8px' }}
                    >
                      <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600' }}>
                        {lynxT(locale, 'lynx.chat.composer.send')}
                      </LynxText>
                    </LynxView>
                  )}
                </LynxView>
              )}
            </LynxComposerGlassCard>
            <LynxComposerPickerSheets
              locale={locale}
              kind={pickerKind}
              runtimeFetch={runtimeFetch ?? null}
              directory={directory}
              selection={composerModel}
              onClose={() => setPickerKind(null)}
              onSelectAgent={(agentName) => {
                setComposerModel((prev) => applyLynxAgentPickerSelection(prev, agentName));
              }}
              onSelectModel={(next) => {
                setComposerModel((prev) => applyLynxModelPickerSelection(prev, next));
              }}
            />
            {actionError ? (
              <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginTop: '6px' }}>
                {actionError}
              </LynxText>
            ) : null}
            {attachError ? (
              <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginTop: '6px' }}>
                {attachError}
              </LynxText>
            ) : null}
          </LynxView>
        )}
      />
    </LynxView>
  );
}
