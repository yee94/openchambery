import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { Platform } from 'react-native';

import { useConnection } from '@/context/ConnectionContext';
import {
  applyChatEventToTranscript,
  startGlobalEventStream,
  type EventTransportKind,
} from '@/lib/eventStream';
import {
  createTranscriptController,
  type TranscriptRow,
} from '@/lib/chatTranscript';
import {
  CHAT_INITIAL_TURNS,
  loadSessionMessages,
  SessionMessagesError,
} from '@/lib/sessionMessages';
import {
  abortSession,
  materializeDraftAndPrompt,
  promptAsync,
  SessionPromptError,
} from '@/lib/sessionPrompt';
import {
  admitTextQueueItem,
  editQueueItemContent,
  loadSessionQueueChips,
  removeQueueItem,
  reorderQueueScope,
  type MessageQueueChipItem,
  MessageQueueApiError,
} from '@/lib/messageQueueApi';
import {
  uploadStagedAttachment,
  type StagedPromptAttachment,
  PromptAttachmentUploadError,
} from '@/lib/promptAttachmentUpload';
import {
  buildMobileContextDisplay,
  getLatestAssistantTotalTokens,
  getLatestUserMessageModel,
  resolveContextLimitFromCatalog,
  type MobileContextDisplay,
} from '@/lib/contextUsage';
import { loadProviderCatalog } from '@/lib/providerCatalogApi';
import {
  resolveStreamingRenderCadence,
  StreamingMarkdownPacer,
  type StreamingPlatform,
} from '@/lib/streamingMarkdown';
import { isDraftSessionRouteId, resolveChatSessionId } from '@/lib/sessionHomeModel';
import {
  applyQuestionEvent,
  isQuestionNotFoundError,
  listPendingQuestions,
  rejectQuestion,
  replyToQuestion,
  type QuestionRequest,
  QuestionApiError,
} from '@/lib/questionApi';

export type ChatLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export type ChatSessionView = {
  sessionId: string;
  isDraft: boolean;
  status: ChatLoadStatus;
  error: string | null;
  rows: TranscriptRow[];
  structureEpoch: number;
  busy: boolean;
  transport: EventTransportKind | null;
  draft: string;
  setDraft: (value: string) => void;
  send: () => Promise<void>;
  stop: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Server message-queue chips for this session (Cap QueuedMessageChips subset). */
  queueItems: MessageQueueChipItem[];
  queueRevision: number;
  queueScopeId: string | null;
  directory: string | null;
  removeQueued: (item: MessageQueueChipItem) => Promise<void>;
  reorderQueued: (orderedIds: string[]) => Promise<void>;
  editQueued: (item: MessageQueueChipItem, content: string) => Promise<void>;
  attachments: StagedPromptAttachment[];
  setAttachments: (next: StagedPromptAttachment[]) => void;
  contextDisplay: MobileContextDisplay | null;
  /** Cap session question requests (interactive QuestionCard). */
  pendingQuestions: QuestionRequest[];
  replyQuestion: (request: QuestionRequest, answers: string[][]) => Promise<void>;
  dismissQuestion: (request: QuestionRequest) => Promise<void>;
  questionBusyId: string | null;
};

const platformCadence = (): StreamingPlatform => {
  if (Platform.OS === 'android') return 'android';
  if (Platform.OS === 'ios') return 'ios';
  return 'web';
};

let localMessageSeq = 0;
const nextLocalId = (prefix: string) => {
  localMessageSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${localMessageSeq}`;
};

export function useChatSession(routeSessionId: string | undefined): ChatSessionView {
  const { state } = useConnection();
  const active = state.active;
  const router = useRouter();

  const isDraft = isDraftSessionRouteId(routeSessionId);
  const [sessionId, setSessionId] = useState(() => resolveChatSessionId(routeSessionId));
  const [status, setStatus] = useState<ChatLoadStatus>(isDraft ? 'ready' : 'idle');
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [rows, setRows] = useState<TranscriptRow[]>([]);
  const [structureEpoch, setStructureEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [transport, setTransport] = useState<EventTransportKind | null>(null);
  const [queueItems, setQueueItems] = useState<MessageQueueChipItem[]>([]);
  const [queueRevision, setQueueRevision] = useState(0);
  const [queueScopeId, setQueueScopeId] = useState<string | null>(null);
  const [directory, setDirectory] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<StagedPromptAttachment[]>([]);
  const [contextDisplay, setContextDisplay] = useState<MobileContextDisplay | null>(null);
  const [providerCatalog, setProviderCatalog] = useState<unknown>(null);
  const [pendingQuestions, setPendingQuestions] = useState<QuestionRequest[]>([]);
  const [questionBusyId, setQuestionBusyId] = useState<string | null>(null);
  const queueRevisionRef = useRef(0);
  const queueScopeIdRef = useRef<string | null>(null);

  const transcriptRef = useRef(createTranscriptController());
  const requestId = useRef(0);
  const directoryRef = useRef<string | null>(null);
  const pacersRef = useRef(new Map<string, StreamingMarkdownPacer>());

  const syncFromController = useCallback(() => {
    const controller = transcriptRef.current;
    setRows(controller.getRows());
    setStructureEpoch(controller.getState().structure.structureEpoch);
    setBusy(controller.getState().busy);
  }, []);

  useEffect(() => {
    const unsub = transcriptRef.current.subscribe(syncFromController);
    return () => {
      unsub();
      for (const pacer of pacersRef.current.values()) pacer.dispose();
      pacersRef.current.clear();
    };
  }, [syncFromController]);

  useEffect(() => {
    const next = resolveChatSessionId(routeSessionId);
    setSessionId(next);
    if (isDraftSessionRouteId(routeSessionId)) {
      transcriptRef.current.replaceFromRecords([]);
      setPendingQuestions([]);
      setStatus('ready');
      setError(null);
    }
  }, [routeSessionId]);

  const refresh = useCallback(async () => {
    if (!active || !sessionId) {
      setStatus(sessionId ? 'idle' : 'ready');
      return;
    }
    const id = ++requestId.current;
    setStatus((prev) => (prev === 'ready' ? 'ready' : 'loading'));
    setError(null);
    try {
      const page = await loadSessionMessages(active, {
        sessionId,
        directory: directoryRef.current,
        turns: CHAT_INITIAL_TURNS,
      });
      if (id !== requestId.current) return;
      transcriptRef.current.replaceFromRecords(page.records);
      syncFromController();
      setStatus('ready');
    } catch (err) {
      if (id !== requestId.current) return;
      const message =
        err instanceof SessionMessagesError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'failed to load messages';
      setError(message);
      setStatus('error');
    }
  }, [active, sessionId, syncFromController]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshQueue = useCallback(async () => {
    if (!active || !sessionId) {
      setQueueItems([]);
      setQueueRevision(0);
      queueRevisionRef.current = 0;
      setQueueScopeId(null);
      queueScopeIdRef.current = null;
      return;
    }
    try {
      const scope = await loadSessionQueueChips(active, sessionId);
      if (!scope) {
        setQueueItems([]);
        return;
      }
      setQueueItems(scope.items);
      setQueueRevision(scope.revision);
      queueRevisionRef.current = scope.revision;
      setQueueScopeId(scope.scopeID);
      queueScopeIdRef.current = scope.scopeID;
      if (scope.directory) {
        directoryRef.current = scope.directory;
        setDirectory(scope.directory);
      }
    } catch {
      // Queue is additive chrome — do not fail the chat surface.
    }
  }, [active, sessionId]);

  useEffect(() => {
    void refreshQueue();
    if (!active || !sessionId) return;
    const timer = setInterval(() => {
      void refreshQueue();
    }, busy ? 1500 : 5000);
    return () => clearInterval(timer);
  }, [active, sessionId, busy, refreshQueue]);

  const refreshQuestions = useCallback(async () => {
    if (!active || !sessionId) {
      setPendingQuestions([]);
      return;
    }
    try {
      const pending = await listPendingQuestions(active, {
        directory: directoryRef.current,
        sessionId,
      });
      setPendingQuestions(pending);
    } catch {
      // Questions are blocking chrome — do not fail the chat surface on list errors.
    }
  }, [active, sessionId]);

  useEffect(() => {
    void refreshQuestions();
  }, [refreshQuestions, directory]);

  // Events: prefer WS, SSE fallback, poll only reconnect fallback.
  useEffect(() => {
    if (!active || !sessionId) return;
    const cadence = resolveStreamingRenderCadence(platformCadence());
    const handle = startGlobalEventStream(active, {
      onTransport: setTransport,
      onEvent: (event) => {
        setPendingQuestions((prev) => applyQuestionEvent(prev, event, sessionId));
        const controller = transcriptRef.current;
        applyChatEventToTranscript(event, sessionId, {
          upsertLiveTail: (messageId, text, role) => {
            let pacer = pacersRef.current.get(messageId);
            if (!pacer) {
              pacer = new StreamingMarkdownPacer(cadence.markdownPaceMs, (paced) => {
                controller.upsertLiveTail(messageId, paced, role);
              });
              pacersRef.current.set(messageId, pacer);
            }
            // Immediate structure ensure + paced markdown publish.
            controller.upsertLiveTail(messageId, controller.getState().live?.messageId === messageId
              ? (controller.getState().live?.text ?? text)
              : text, role);
            pacer.push(text);
          },
          finalizeLiveTail: (messageId, text) => {
            const pacer = pacersRef.current.get(messageId);
            pacer?.flush();
            pacer?.dispose();
            pacersRef.current.delete(messageId);
            controller.finalizeLiveTail(messageId, text || controller.getState().texts[messageId] || '');
          },
          upsertLivePart: (messageId, part, role) => {
            controller.upsertLivePart(messageId, part, role);
          },
          setBusy: (next) => controller.setBusy(next),
        });
      },
    });
    return () => handle.cleanup();
  }, [active, sessionId]);

  const send = useCallback(async () => {
    if (!active) {
      setError('not connected');
      return;
    }
    const text = draft.trim();
    const pendingAttachments = attachments.slice();
    if (!text && pendingAttachments.length === 0) return;

    // Cap: when session is busy and we know directory, admit text-only to server queue.
    // Attachments on busy path still need prompt_async after upload (queue admit is text subset).
    if (sessionId && busy && directoryRef.current && pendingAttachments.length === 0) {
      const directory = directoryRef.current;
      setDraft('');
      try {
        const stamp = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        await admitTextQueueItem(active, {
          sessionID: sessionId,
          directory,
          content: text,
          requestID: `req_${stamp}`,
          queueItemID: `qi_${stamp}`,
          operationID: `op_${stamp}`,
          messageID: `msg_${stamp}`,
          expectedRevision: queueRevisionRef.current || undefined,
        });
        await refreshQueue();
      } catch (err) {
        const message =
          err instanceof MessageQueueApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'queue admit failed';
        setError(message);
        setDraft(text);
      }
      return;
    }

    const localUserId = nextLocalId('local_user');
    transcriptRef.current.appendLocalUser(localUserId, text || '(attachment)');
    setDraft('');
    setAttachments([]);
    transcriptRef.current.setBusy(true);
    syncFromController();

    try {
      const fileParts = [];
      for (const staged of pendingAttachments) {
        const uploaded = await uploadStagedAttachment(active, staged);
        fileParts.push({
          type: 'file' as const,
          mime: uploaded.mime,
          url: uploaded.url,
          filename: staged.filename,
        });
      }

      if (!sessionId) {
        const created = await materializeDraftAndPrompt(active, {
          text,
          directory: directoryRef.current,
          fileParts,
        });
        directoryRef.current = created.directory ?? directoryRef.current;
        if (created.directory) setDirectory(created.directory);
        setSessionId(created.id);
        // Replace draft route with real session id (keep stack).
        router.replace(`/chat/${encodeURIComponent(created.id)}`);
        return;
      }
      await promptAsync(active, {
        sessionId,
        text,
        directory: directoryRef.current,
        fileParts,
      });
    } catch (err) {
      const message =
        err instanceof PromptAttachmentUploadError
          ? err.message
          : err instanceof SessionPromptError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'send failed';
      setError(message);
      setAttachments(pendingAttachments);
      setDraft(text);
      transcriptRef.current.setBusy(false);
      syncFromController();
    }
  }, [active, attachments, busy, draft, refreshQueue, router, sessionId, syncFromController]);

  const removeQueued = useCallback(
    async (item: MessageQueueChipItem) => {
      if (!active || !sessionId) return;
      try {
        const stamp = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        await removeQueueItem(active, {
          queueItemID: item.queueItemID,
          requestID: `rm_${stamp}`,
          expectedRevision: queueRevisionRef.current,
          expectedRowVersion: item.rowVersion,
        });
        await refreshQueue();
      } catch (err) {
        const message =
          err instanceof MessageQueueApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'queue remove failed';
        setError(message);
      }
    },
    [active, refreshQueue, sessionId],
  );

  const reorderQueued = useCallback(
    async (orderedIds: string[]) => {
      if (!active || !queueScopeIdRef.current) return;
      try {
        const stamp = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        await reorderQueueScope(active, {
          scopeID: queueScopeIdRef.current,
          requestID: `ord_${stamp}`,
          expectedRevision: queueRevisionRef.current,
          queueItemIDs: orderedIds,
        });
        await refreshQueue();
      } catch (err) {
        const message =
          err instanceof MessageQueueApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'queue reorder failed';
        setError(message);
      }
    },
    [active, refreshQueue],
  );

  const editQueued = useCallback(
    async (item: MessageQueueChipItem, content: string) => {
      if (!active) return;
      const next = content.trim();
      if (!next) return;
      try {
        const stamp = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        await editQueueItemContent(active, {
          queueItemID: item.queueItemID,
          requestID: `ed_${stamp}`,
          expectedRevision: queueRevisionRef.current,
          expectedRowVersion: item.rowVersion,
          content: next,
        });
        await refreshQueue();
      } catch (err) {
        const message =
          err instanceof MessageQueueApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'queue edit failed';
        setError(message);
      }
    },
    [active, refreshQueue],
  );

  const stop = useCallback(async () => {
    if (!active || !sessionId) return;
    try {
      await abortSession(active, {
        sessionId,
        directory: directoryRef.current,
      });
      transcriptRef.current.setBusy(false);
      syncFromController();
    } catch (err) {
      const message =
        err instanceof SessionPromptError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'abort failed';
      setError(message);
    }
  }, [active, sessionId, syncFromController]);

  const replyQuestion = useCallback(
    async (request: QuestionRequest, answers: string[][]) => {
      if (!active) return;
      setQuestionBusyId(request.id);
      try {
        await replyToQuestion(active, {
          requestId: request.id,
          answers,
          directory: directoryRef.current,
        });
        setPendingQuestions((prev) => prev.filter((q) => q.id !== request.id));
      } catch (err) {
        if (isQuestionNotFoundError(err)) {
          setPendingQuestions((prev) => prev.filter((q) => q.id !== request.id));
          return;
        }
        const message =
          err instanceof QuestionApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'question reply failed';
        setError(message);
      } finally {
        setQuestionBusyId(null);
      }
    },
    [active],
  );

  const dismissQuestion = useCallback(
    async (request: QuestionRequest) => {
      if (!active) return;
      setQuestionBusyId(request.id);
      try {
        await rejectQuestion(active, {
          requestId: request.id,
          directory: directoryRef.current,
        });
        setPendingQuestions((prev) => prev.filter((q) => q.id !== request.id));
      } catch (err) {
        if (isQuestionNotFoundError(err)) {
          setPendingQuestions((prev) => prev.filter((q) => q.id !== request.id));
          return;
        }
        const message =
          err instanceof QuestionApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'question dismiss failed';
        setError(message);
      } finally {
        setQuestionBusyId(null);
      }
    },
    [active],
  );

  // Context usage ring — Cap MobileContextProgressButton data subset.
  useEffect(() => {
    if (!active || !sessionId) {
      setContextDisplay(null);
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        if (!providerCatalog) {
          const catalog = await loadProviderCatalog(active, directoryRef.current);
          if (cancelled) return;
          setProviderCatalog(catalog);
        }
      } catch {
        // Catalog optional — ring hides without limit.
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [active, sessionId, providerCatalog]);

  useEffect(() => {
    if (!sessionId) {
      setContextDisplay(null);
      return;
    }
    const usageMessages = transcriptRef.current.getUsageMessages();
    const totalTokens = getLatestAssistantTotalTokens(
      usageMessages,
      (messageId) => transcriptRef.current.getState().parts[messageId],
    );
    const model = getLatestUserMessageModel(usageMessages);
    const contextLimit = resolveContextLimitFromCatalog(providerCatalog, model);
    setContextDisplay(
      buildMobileContextDisplay({
        totalTokens,
        contextLimit,
        isDraft: !sessionId,
      }),
    );
  }, [rows, structureEpoch, sessionId, providerCatalog]);

  return useMemo(
    () => ({
      sessionId,
      isDraft: !sessionId,
      status,
      error,
      rows,
      structureEpoch,
      busy,
      transport,
      draft,
      setDraft,
      send,
      stop,
      refresh,
      queueItems,
      queueRevision,
      queueScopeId,
      directory,
      removeQueued,
      reorderQueued,
      editQueued,
      attachments,
      setAttachments,
      contextDisplay,
      pendingQuestions,
      replyQuestion,
      dismissQuestion,
      questionBusyId,
    }),
    [
      attachments,
      busy,
      contextDisplay,
      directory,
      dismissQuestion,
      draft,
      editQueued,
      error,
      pendingQuestions,
      questionBusyId,
      queueItems,
      queueRevision,
      queueScopeId,
      refresh,
      removeQueued,
      reorderQueued,
      replyQuestion,
      rows,
      send,
      sessionId,
      status,
      stop,
      structureEpoch,
      transport,
    ],
  );
}
