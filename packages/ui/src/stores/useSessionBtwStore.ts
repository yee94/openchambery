import { create } from 'zustand';
import { opencodeClient } from '@/lib/opencode/client';
import { normalizeDirectoryKey } from '@/lib/pathNormalization';
import {
  getRuntimeGeneration,
  getRuntimeTransportIdentity,
} from '@/lib/runtime-switch';

/**
 * Upstream OpenCode btw side-question semantics
 * (`packages/app/src/session/btw/model.ts`): quick aside about the conversation,
 * markdown answer from known context, no tools / no actions. Backend is a single
 * session.generate call (no tool loop even if tools remain in schema).
 */
const SESSION_BTW_INSTRUCTIONS = [
  'The user is asking a quick side question about the conversation so far.',
  'Answer directly and concisely in markdown from what you already know.',
  'Do not call any tools and do not take any actions.',
].join(' ');

const MAX_SESSION_BTW_ENTRIES = 40;

export type SessionBtwScope = {
  sessionId: string;
  directory?: string | null;
};

type SessionBtwEntry = {
  question: string;
  answer: string;
  error: string | null;
  pending: boolean;
};

export const EMPTY_SESSION_BTW_ENTRY: SessionBtwEntry = Object.freeze({
  question: '',
  answer: '',
  error: null,
  pending: false,
});

export const getSessionBtwKey = (scope: SessionBtwScope): string => {
  const sessionId = typeof scope.sessionId === 'string' ? scope.sessionId.trim() : '';
  const directory = normalizeDirectoryKey(scope.directory);
  return `${getRuntimeTransportIdentity()}\u0000${directory}\u0000${sessionId}`;
};

type SessionBtwStore = {
  entries: Record<string, SessionBtwEntry>;
  ask: (scope: SessionBtwScope, question: string) => Promise<void>;
  retry: (scope: SessionBtwScope) => Promise<void>;
  cancel: (scope: SessionBtwScope) => void;
};

/**
 * Active in-flight request per key. Controller object identity is the sole
 * request authority — never a reusable numeric token (ABA after eviction/reset).
 */
const controllers = new Map<string, AbortController>();
/** Insertion order for bounded eviction (non-pending first). */
let entryOrder: string[] = [];
let btwRuntimeGeneration = 0;

const formatBtwError = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'session.btw failed';
};

const isAbortError = (error: unknown, signal: AbortSignal): boolean => {
  if (signal.aborted) return true;
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? (error as { name?: unknown }).name : undefined;
  return name === 'AbortError';
};

/** True only while this exact controller still owns the key. */
const ownsRequest = (key: string, controller: AbortController): boolean =>
  controllers.get(key) === controller;

const rememberEntryKey = (key: string): void => {
  entryOrder = entryOrder.filter((entry) => entry !== key);
  entryOrder.push(key);
};

const boundEntries = (
  entries: Record<string, SessionBtwEntry>,
  protectKey?: string,
): Record<string, SessionBtwEntry> => {
  const keys = Object.keys(entries);
  if (keys.length <= MAX_SESSION_BTW_ENTRIES) return entries;

  const next = { ...entries };
  const order = entryOrder.filter((key) => key in next);
  for (const key of keys) {
    if (!order.includes(key)) order.push(key);
  }

  const canEvict = (key: string): boolean =>
    key !== protectKey && next[key] !== undefined && !next[key]!.pending;

  while (Object.keys(next).length > MAX_SESSION_BTW_ENTRIES) {
    const victim = order.find(canEvict) ?? order.find((key) => key !== protectKey);
    if (!victim) break;
    delete next[victim];
    controllers.get(victim)?.abort();
    controllers.delete(victim);
    const index = order.indexOf(victim);
    if (index >= 0) order.splice(index, 1);
  }

  entryOrder = order.filter((key) => key in next);
  return next;
};

const patchEntry = (
  key: string,
  patch: Partial<SessionBtwEntry>,
  base?: SessionBtwEntry,
): void => {
  useSessionBtwStore.setState((state) => {
    const previous = state.entries[key] ?? base ?? EMPTY_SESSION_BTW_ENTRY;
    const nextEntry: SessionBtwEntry = {
      question: patch.question ?? previous.question,
      answer: patch.answer ?? previous.answer,
      error: patch.error !== undefined ? patch.error : previous.error,
      pending: patch.pending ?? previous.pending,
    };
    rememberEntryKey(key);
    return {
      entries: boundEntries({ ...state.entries, [key]: nextEntry }, key),
    };
  });
};

/**
 * Apply a completion only while this controller still owns the key.
 * Superseded / cancelled / evicted / reset requests never write.
 */
const commitOwned = (
  key: string,
  controller: AbortController,
  runtime: { epoch: number; transport: string; generation: number },
  patch: Partial<SessionBtwEntry>,
): boolean => {
  if (!ownsRequest(key, controller)) return false;
  if (btwRuntimeGeneration !== runtime.epoch) return false;
  if (getRuntimeTransportIdentity() !== runtime.transport) {
    // Still own the slot on a stale transport: clear stuck pending, drop payload.
    patchEntry(key, { pending: false });
    return false;
  }
  if (getRuntimeGeneration() !== runtime.generation) {
    patchEntry(key, { pending: false });
    return false;
  }
  patchEntry(key, patch);
  return true;
};

const runAsk = async (scope: SessionBtwScope, rawQuestion: string): Promise<void> => {
  const question = typeof rawQuestion === 'string' ? rawQuestion.trim() : '';
  if (!question) return;

  const sessionId = typeof scope.sessionId === 'string' ? scope.sessionId.trim() : '';
  if (!sessionId) return;

  const directory =
    typeof scope.directory === 'string' && scope.directory.trim()
      ? scope.directory
      : scope.directory ?? null;
  const key = getSessionBtwKey({ sessionId, directory });
  const runtime = {
    epoch: btwRuntimeGeneration,
    transport: getRuntimeTransportIdentity(),
    generation: getRuntimeGeneration(),
  };

  controllers.get(key)?.abort();
  const controller = new AbortController();
  controllers.set(key, controller);

  patchEntry(key, {
    question,
    answer: '',
    error: null,
    pending: true,
  });

  try {
    const result = await opencodeClient.generateSessionAside({
      sessionId,
      directory,
      prompt: [SESSION_BTW_INSTRUCTIONS, question].join('\n\n'),
      signal: controller.signal,
    });

    if (!ownsRequest(key, controller)) return;

    const text = typeof result?.text === 'string' ? result.text.trim() : '';
    if (!text) {
      commitOwned(key, controller, runtime, {
        answer: '',
        error: 'empty response',
        pending: false,
      });
      return;
    }

    commitOwned(key, controller, runtime, {
      answer: text,
      error: null,
      pending: false,
    });
  } catch (error) {
    if (!ownsRequest(key, controller)) return;

    // Abort (signal or SDK AbortError): clear pending so the panel can retry.
    // Only the active owner may write — superseded requests never touch state.
    if (isAbortError(error, controller.signal)) {
      commitOwned(key, controller, runtime, { pending: false });
      return;
    }

    commitOwned(key, controller, runtime, {
      error: formatBtwError(error),
      pending: false,
    });
  } finally {
    if (ownsRequest(key, controller)) {
      controllers.delete(key);
    }
  }
};

const ask = (scope: SessionBtwScope, question: string): Promise<void> => runAsk(scope, question);

const retry = (scope: SessionBtwScope): Promise<void> => {
  const key = getSessionBtwKey(scope);
  const entry = useSessionBtwStore.getState().entries[key];
  return runAsk(scope, entry?.question ?? '');
};

const cancel = (scope: SessionBtwScope): void => {
  const key = getSessionBtwKey(scope);
  const controller = controllers.get(key);
  if (controller) {
    controller.abort();
    // Drop ownership immediately so a late completion cannot revive this slot.
    controllers.delete(key);
  }
  const entry = useSessionBtwStore.getState().entries[key];
  if (!entry?.pending) return;
  patchEntry(key, { pending: false });
};

export const useSessionBtwStore = create<SessionBtwStore>(() => ({
  entries: {},
  ask,
  retry,
  cancel,
}));

/** Abort in-flight /btw requests and drop in-memory entries on runtime identity switch. */
export const resetSessionBtwStoreForRuntimeSwitch = (): void => {
  btwRuntimeGeneration += 1;
  for (const controller of controllers.values()) {
    controller.abort();
  }
  controllers.clear();
  entryOrder = [];
  useSessionBtwStore.setState({ entries: {} });
};
