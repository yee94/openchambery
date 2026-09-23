import { create } from 'zustand';
import { opencodeClient } from '@/lib/opencode/client';
import { normalizeDirectoryKey } from '@/lib/pathNormalization';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSelectionStore } from '@/sync/selection-store';
import {
  getRuntimeGeneration,
  getRuntimeTransportIdentity,
} from '@/lib/runtime-switch';

/**
 * Upstream OpenCode btw side-question semantics
 * (`packages/app/src/session/btw/model.ts`): quick aside about the conversation,
 * markdown answer from known context, no tools / no actions. Backend is a single
 * session.generate call per turn (no tool loop, no session created or mutated);
 * the main session history is server-side context only and never loaded here.
 */
const SESSION_BTW_INSTRUCTIONS = [
  'The user is asking a quick side question about the conversation so far.',
  'Answer directly and concisely in markdown from what you already know.',
  'Do not call any tools and do not take any actions.',
].join(' ');

const MAX_SESSION_BTW_ENTRIES = 40;
const MAX_SESSION_BTW_TURNS = 50;
/** Earlier side turns replayed into each prompt; generate itself is stateless. */
const MAX_SESSION_BTW_PROMPT_TURNS = 12;
const MAX_SESSION_BTW_QUOTES = 10;

export type SessionBtwScope = {
  sessionId: string;
  directory?: string | null;
};

export type SessionBtwTurn = {
  id: string;
  /** Selected excerpts attached to this question ("Add to Side Chat"). */
  quotes: readonly string[];
  question: string;
  answer: string;
  error: string | null;
  pending: boolean;
};

/** Model/agent for native `session.generate` (upstream accepts prompt only). */
export type SessionBtwSendSelection = {
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string | null;
};

type SessionBtwEntry = {
  turns: readonly SessionBtwTurn[];
  /** Quotes staged in the composer; consumed by the next send. */
  quotes: readonly string[];
};

export const EMPTY_SESSION_BTW_ENTRY: SessionBtwEntry = Object.freeze({
  turns: Object.freeze([]) as readonly SessionBtwTurn[],
  quotes: Object.freeze([]) as readonly string[],
});

export const getSessionBtwKey = (scope: SessionBtwScope): string => {
  const sessionId = typeof scope.sessionId === 'string' ? scope.sessionId.trim() : '';
  const directory = normalizeDirectoryKey(scope.directory);
  return `${getRuntimeTransportIdentity()}\u0000${directory}\u0000${sessionId}`;
};

type SessionBtwStore = {
  entries: Record<string, SessionBtwEntry>;
  /** Per side-conversation model/agent; falls back to session memory then global defaults. */
  sendSelection: Record<string, SessionBtwSendSelection>;
  setSendSelection: (scope: SessionBtwScope, selection: SessionBtwSendSelection) => void;
  ask: (scope: SessionBtwScope, question: string) => Promise<void>;
  retry: (scope: SessionBtwScope) => Promise<void>;
  cancel: (scope: SessionBtwScope) => void;
  addQuote: (scope: SessionBtwScope, text: string) => void;
  removeQuote: (scope: SessionBtwScope, index: number) => void;
  /** Close the side conversation: abort in-flight work and drop its turns. */
  clear: (scope: SessionBtwScope) => void;
};

/**
 * Active in-flight request per key. Controller object identity is the sole
 * request authority — never a reusable numeric token (ABA after eviction/reset).
 */
const controllers = new Map<string, { controller: AbortController; turnId: string }>();
/** Insertion order for bounded eviction (non-pending first). */
let entryOrder: string[] = [];
let btwRuntimeGeneration = 0;
let turnSequence = 0;

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
  controllers.get(key)?.controller === controller;

const isEntryPending = (entry: SessionBtwEntry | undefined): boolean =>
  Boolean(entry?.turns.some((turn) => turn.pending));

const rememberEntryKey = (key: string): void => {
  entryOrder = entryOrder.filter((entry) => entry !== key);
  entryOrder.push(key);
};

const abortKey = (key: string): void => {
  controllers.get(key)?.controller.abort();
  controllers.delete(key);
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
    key !== protectKey && next[key] !== undefined && !isEntryPending(next[key]);

  while (Object.keys(next).length > MAX_SESSION_BTW_ENTRIES) {
    const victim = order.find(canEvict) ?? order.find((key) => key !== protectKey);
    if (!victim) break;
    delete next[victim];
    abortKey(victim);
    const index = order.indexOf(victim);
    if (index >= 0) order.splice(index, 1);
  }

  entryOrder = order.filter((key) => key in next);
  return next;
};

const writeEntry = (
  key: string,
  update: (entry: SessionBtwEntry) => SessionBtwEntry | null,
): void => {
  useSessionBtwStore.setState((state) => {
    const previous = state.entries[key] ?? EMPTY_SESSION_BTW_ENTRY;
    const next = update(previous);
    if (!next || next === previous) return state;
    rememberEntryKey(key);
    return {
      entries: boundEntries({ ...state.entries, [key]: next }, key),
    };
  });
};

const writeTurns = (
  key: string,
  update: (turns: readonly SessionBtwTurn[]) => readonly SessionBtwTurn[] | null,
): void => {
  writeEntry(key, (entry) => {
    const turns = update(entry.turns);
    return !turns || turns === entry.turns ? null : { ...entry, turns };
  });
};

/** Patch an existing turn; a cleared or evicted conversation stays gone. */
const patchTurn = (key: string, turnId: string, patch: Partial<SessionBtwTurn>): void => {
  if (!useSessionBtwStore.getState().entries[key]) return;
  writeTurns(key, (turns) => {
    const index = turns.findIndex((turn) => turn.id === turnId);
    if (index < 0) return null;
    const next = turns.slice();
    next[index] = { ...turns[index]!, ...patch };
    return next;
  });
};

const quoteBlock = (quote: string): string =>
  quote.split('\n').map((line) => `> ${line}`).join('\n');

const formatUserTurn = (turn: Pick<SessionBtwTurn, 'question' | 'quotes'>): string =>
  turn.quotes.length === 0
    ? turn.question
    : ['Quoted from the conversation:', ...turn.quotes.map(quoteBlock), turn.question].join('\n\n');

const buildBtwPrompt = (history: readonly SessionBtwTurn[], current: Pick<SessionBtwTurn, 'question' | 'quotes'>): string => {
  const earlier = history
    .filter((turn) => turn.answer)
    .slice(-MAX_SESSION_BTW_PROMPT_TURNS);
  if (earlier.length === 0) return [SESSION_BTW_INSTRUCTIONS, formatUserTurn(current)].join('\n\n');
  const transcript = earlier
    .map((turn) => `User: ${formatUserTurn(turn)}\n\nAssistant: ${turn.answer}`)
    .join('\n\n');
  return [
    SESSION_BTW_INSTRUCTIONS,
    'Earlier in this side conversation:',
    transcript,
    'Follow-up question:',
    formatUserTurn(current),
  ].join('\n\n');
};

/**
 * Apply a completion only while this controller still owns the key.
 * Superseded / cancelled / cleared / evicted / reset requests never write.
 */
const commitOwned = (
  key: string,
  turnId: string,
  controller: AbortController,
  runtime: { epoch: number; transport: string; generation: number },
  patch: Partial<SessionBtwTurn>,
): void => {
  if (!ownsRequest(key, controller)) return;
  if (btwRuntimeGeneration !== runtime.epoch) return;
  if (getRuntimeTransportIdentity() !== runtime.transport || getRuntimeGeneration() !== runtime.generation) {
    // Still own the slot on a stale transport: clear stuck pending, drop payload.
    patchTurn(key, turnId, { pending: false });
    return;
  }
  patchTurn(key, turnId, patch);
};

const normalizeScope = (scope: SessionBtwScope): { sessionId: string; directory: string | null } | null => {
  const sessionId = typeof scope.sessionId === 'string' ? scope.sessionId.trim() : '';
  if (!sessionId) return null;
  const directory = typeof scope.directory === 'string' && scope.directory.trim()
    ? scope.directory
    : scope.directory ?? null;
  return { sessionId, directory };
};

/** Settle a superseded pending turn so it shows as cancelled, not stuck. */
const settlePreviousRequest = (key: string): void => {
  const previous = controllers.get(key);
  if (!previous) return;
  abortKey(key);
  patchTurn(key, previous.turnId, { pending: false });
};

export const resolveSessionBtwSendSelection = (scope: SessionBtwScope): SessionBtwSendSelection | null => {
  const target = normalizeScope(scope);
  if (!target) return null;
  const key = getSessionBtwKey(target);
  const stored = useSessionBtwStore.getState().sendSelection[key];
  if (stored?.providerID && stored?.modelID) return stored;
  const remembered = useSelectionStore.getState().getSessionModelSelection(target.sessionId);
  if (remembered) {
    return {
      providerID: remembered.providerId,
      modelID: remembered.modelId,
      agent: useSelectionStore.getState().getSessionAgentSelection(target.sessionId) ?? undefined,
    };
  }
  const config = useConfigStore.getState();
  if (config.currentProviderId && config.currentModelId) {
    return {
      providerID: config.currentProviderId,
      modelID: config.currentModelId,
      agent: config.currentAgentName ?? undefined,
      variant: config.currentVariant ?? null,
    };
  }
  return null;
};

const applyBtwSendSelection = async (scope: { sessionId: string; directory: string | null }): Promise<void> => {
  const selection = resolveSessionBtwSendSelection({ sessionId: scope.sessionId, directory: scope.directory });
  if (!selection) return;
  const variant = typeof selection.variant === 'string' && selection.variant.trim()
    ? selection.variant.trim()
    : undefined;
  await opencodeClient.applySendSelection(scope.sessionId, {
    model: {
      providerID: selection.providerID,
      id: selection.modelID,
      ...(variant ? { variant } : {}),
    },
    ...(selection.agent ? { agent: selection.agent } : {}),
  }, scope.directory);
};

const setSendSelection = (scope: SessionBtwScope, selection: SessionBtwSendSelection): void => {
  const target = normalizeScope(scope);
  if (!target) return;
  const key = getSessionBtwKey(target);
  useSessionBtwStore.setState((state) => ({
    sendSelection: { ...state.sendSelection, [key]: selection },
  }));
  useSelectionStore.getState().saveSessionModelSelection(target.sessionId, selection.providerID, selection.modelID);
  if (selection.agent) {
    useSelectionStore.getState().saveSessionAgentSelection(target.sessionId, selection.agent);
  }
};

const runTurn = async (
  scope: { sessionId: string; directory: string | null },
  key: string,
  current: Pick<SessionBtwTurn, 'id' | 'question' | 'quotes'>,
  history: readonly SessionBtwTurn[],
): Promise<void> => {
  const turnId = current.id;
  const runtime = {
    epoch: btwRuntimeGeneration,
    transport: getRuntimeTransportIdentity(),
    generation: getRuntimeGeneration(),
  };
  const controller = new AbortController();
  controllers.set(key, { controller, turnId });

  try {
    await applyBtwSendSelection(scope);
    if (!ownsRequest(key, controller)) return;

    const result = await opencodeClient.generateSessionAside({
      sessionId: scope.sessionId,
      directory: scope.directory,
      prompt: buildBtwPrompt(history, current),
      signal: controller.signal,
    });

    const text = typeof result?.text === 'string' ? result.text.trim() : '';
    commitOwned(key, turnId, controller, runtime, text
      ? { answer: text, error: null, pending: false }
      : { answer: '', error: 'empty response', pending: false });
  } catch (error) {
    // Abort (signal or SDK AbortError): clear pending so the turn can retry.
    commitOwned(key, turnId, controller, runtime, isAbortError(error, controller.signal)
      ? { pending: false }
      : { error: formatBtwError(error), pending: false });
  } finally {
    if (ownsRequest(key, controller)) controllers.delete(key);
  }
};

const ask = async (scope: SessionBtwScope, rawQuestion: string): Promise<void> => {
  const question = typeof rawQuestion === 'string' ? rawQuestion.trim() : '';
  const target = normalizeScope(scope);
  if (!question || !target) return;
  const key = getSessionBtwKey(target);

  settlePreviousRequest(key);
  const entry = useSessionBtwStore.getState().entries[key] ?? EMPTY_SESSION_BTW_ENTRY;
  turnSequence += 1;
  const turn: SessionBtwTurn = { id: `btw_${turnSequence}`, quotes: entry.quotes, question, answer: '', error: null, pending: true };
  writeEntry(key, (current) => ({
    turns: [...current.turns, turn].slice(-MAX_SESSION_BTW_TURNS),
    quotes: EMPTY_SESSION_BTW_ENTRY.quotes,
  }));
  await runTurn(target, key, turn, entry.turns);
};

/** Re-run the latest turn in place, with the turns before it as history. */
const retry = async (scope: SessionBtwScope): Promise<void> => {
  const target = normalizeScope(scope);
  if (!target) return;
  const key = getSessionBtwKey(target);
  const turns = useSessionBtwStore.getState().entries[key]?.turns ?? [];
  const last = turns[turns.length - 1];
  if (!last) return;

  settlePreviousRequest(key);
  patchTurn(key, last.id, { answer: '', error: null, pending: true });
  await runTurn(target, key, last, turns.slice(0, -1));
};

const addQuote = (scope: SessionBtwScope, text: string): void => {
  const quote = typeof text === 'string' ? text.trim() : '';
  if (!quote || !normalizeScope(scope)) return;
  writeEntry(getSessionBtwKey(scope), (entry) => entry.quotes.includes(quote)
    ? null
    : { ...entry, quotes: [...entry.quotes, quote].slice(-MAX_SESSION_BTW_QUOTES) });
};

const removeQuote = (scope: SessionBtwScope, index: number): void => {
  const key = getSessionBtwKey(scope);
  if (!useSessionBtwStore.getState().entries[key]) return;
  writeEntry(key, (entry) => index < 0 || index >= entry.quotes.length
    ? null
    : { ...entry, quotes: entry.quotes.filter((_, position) => position !== index) });
};

const cancel = (scope: SessionBtwScope): void => {
  const key = getSessionBtwKey(scope);
  // Drop ownership immediately so a late completion cannot revive this turn.
  settlePreviousRequest(key);
};

const clear = (scope: SessionBtwScope): void => {
  const key = getSessionBtwKey(scope);
  abortKey(key);
  entryOrder = entryOrder.filter((entry) => entry !== key);
  useSessionBtwStore.setState((state) => {
    const hasEntry = key in state.entries;
    const hasSelection = key in state.sendSelection;
    if (!hasEntry && !hasSelection) return state;
    const entries = hasEntry ? { ...state.entries } : state.entries;
    const sendSelection = hasSelection ? { ...state.sendSelection } : state.sendSelection;
    if (hasEntry) delete entries[key];
    if (hasSelection) delete sendSelection[key];
    return { entries, sendSelection };
  });
};

export const useSessionBtwStore = create<SessionBtwStore>(() => ({
  entries: {},
  sendSelection: {},
  setSendSelection,
  ask,
  retry,
  cancel,
  addQuote,
  removeQuote,
  clear,
}));

/** Abort in-flight /btw requests and drop in-memory entries on runtime identity switch. */
export const resetSessionBtwStoreForRuntimeSwitch = (): void => {
  btwRuntimeGeneration += 1;
  for (const { controller } of controllers.values()) {
    controller.abort();
  }
  controllers.clear();
  entryOrder = [];
  useSessionBtwStore.setState({ entries: {}, sendSelection: {} });
};
