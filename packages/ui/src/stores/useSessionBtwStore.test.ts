import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type GenerateInput = { sessionId: string; directory?: string | null; prompt: string; signal?: AbortSignal };
type GenerateResult = { text: string } | Error | (() => Promise<{ text: string }>);

const harness = vi.hoisted(() => ({
  calls: [] as GenerateInput[],
  queue: [] as GenerateResult[],
  transport: 'transport-a',
  generation: 1,
  applySendSelection: vi.fn(async () => {}),
}));

vi.mock('@/lib/opencode/client', () => ({
  opencodeClient: {
    generateSessionAside: async (input: GenerateInput) => {
      harness.calls.push(input);
      const next = harness.queue.shift();
      if (typeof next === 'function') return next();
      if (next instanceof Error) throw next;
      return next ?? { text: 'default answer' };
    },
    applySendSelection: harness.applySendSelection,
  },
}));

vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => harness.transport,
  getRuntimeGeneration: () => harness.generation,
}));

vi.mock('@/stores/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({
      currentProviderId: '',
      currentModelId: '',
      currentAgentName: undefined,
      currentVariant: null,
    }),
  },
}));

vi.mock('@/sync/selection-store', () => ({
  useSelectionStore: {
    getState: () => ({
      getSessionModelSelection: () => null,
      getSessionAgentSelection: () => null,
      saveSessionModelSelection: vi.fn(),
      saveSessionAgentSelection: vi.fn(),
    }),
  },
}));

import {
  EMPTY_SESSION_BTW_ENTRY,
  getSessionBtwKey,
  resetSessionBtwStoreForRuntimeSwitch,
  useSessionBtwStore,
} from './useSessionBtwStore';

const scope = (sessionId: string, directory?: string | null) => ({ sessionId, directory });
const turns = (target: ReturnType<typeof scope>) =>
  (useSessionBtwStore.getState().entries[getSessionBtwKey(target)] ?? EMPTY_SESSION_BTW_ENTRY).turns
    .map(({ question, answer, error, pending }) => ({ question, answer, error, pending }));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve!: (value: { text: string }) => void;
  let reject!: (reason?: unknown) => void;
  harness.queue.push(() => new Promise<{ text: string }>((res, rej) => { resolve = res; reject = rej; }));
  return { resolve: (text: string) => resolve({ text }), reject: (error: unknown) => reject(error) };
};

beforeEach(() => {
  harness.applySendSelection.mockClear();
  harness.calls.length = 0;
  harness.queue.length = 0;
  harness.transport = 'transport-a';
  harness.generation = 1;
  resetSessionBtwStoreForRuntimeSwitch();
});
afterEach(() => resetSessionBtwStoreForRuntimeSwitch());

describe('useSessionBtwStore side conversation', () => {
  test('keys are transport-scoped and directory-normalized; empty entry is frozen', () => {
    expect(Object.isFrozen(EMPTY_SESSION_BTW_ENTRY)).toBe(true);
    expect(EMPTY_SESSION_BTW_ENTRY.turns).toEqual([]);
    const key = getSessionBtwKey(scope('ses_1', '/repo/a'));
    expect(getSessionBtwKey(scope('ses_1', '/repo/a/'))).toBe(key);
    harness.transport = 'transport-b';
    expect(getSessionBtwKey(scope('ses_1', '/repo/a'))).not.toBe(key);
  });

  test('first turn sends instructions + question through session.generate only', async () => {
    harness.queue.push({ text: '  hello btw  ' });
    const target = scope('ses_1', '/workspace/app');
    useSessionBtwStore.getState().setSendSelection(target, { providerID: 'provider-a', modelID: 'model-a' });
    await useSessionBtwStore.getState().ask(target, '  what next?  ');
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]).toMatchObject({ sessionId: 'ses_1', directory: '/workspace/app' });
    expect(harness.calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(harness.calls[0]?.prompt.startsWith('The user is asking a quick side question')).toBe(true);
    expect(harness.calls[0]?.prompt).toContain('Do not call any tools');
    expect(harness.calls[0]?.prompt).not.toContain('Earlier in this side conversation');
    expect(harness.applySendSelection).toHaveBeenCalledWith(
      'ses_1',
      expect.objectContaining({ model: expect.objectContaining({ providerID: 'provider-a', id: 'model-a' }) }),
      '/workspace/app',
    );
    expect(turns(target)).toEqual([{ question: 'what next?', answer: 'hello btw', error: null, pending: false }]);
  });

  test('follow-up turns append and replay earlier answered side turns as context', async () => {
    harness.queue.push({ text: 'A1' }, new Error('boom'), { text: 'A3' });
    const target = scope('ses_1', '/a');
    await useSessionBtwStore.getState().ask(target, 'Q1');
    await useSessionBtwStore.getState().ask(target, 'Q2');
    await useSessionBtwStore.getState().ask(target, 'Q3');
    expect(turns(target).map((turn) => turn.question)).toEqual(['Q1', 'Q2', 'Q3']);
    const prompt = harness.calls[2]!.prompt;
    expect(prompt).toContain('User: Q1\n\nAssistant: A1');
    expect(prompt).not.toContain('Q2');
    expect(prompt.trimEnd().endsWith('Q3')).toBe(true);
  });

  test('staged quotes dedupe, can be removed, and are consumed into the next turn prompt', async () => {
    harness.queue.push({ text: 'A1' }, { text: 'A2' });
    const target = scope('ses_1', '/a');
    const quotes = () => (useSessionBtwStore.getState().entries[getSessionBtwKey(target)] ?? EMPTY_SESSION_BTW_ENTRY).quotes;
    useSessionBtwStore.getState().addQuote(target, '  line one\nline two  ');
    useSessionBtwStore.getState().addQuote(target, 'line one\nline two');
    useSessionBtwStore.getState().addQuote(target, 'drop me');
    useSessionBtwStore.getState().addQuote(target, '   ');
    expect(quotes()).toEqual(['line one\nline two', 'drop me']);
    useSessionBtwStore.getState().removeQuote(target, 1);
    expect(quotes()).toEqual(['line one\nline two']);
    expect(harness.calls).toEqual([]);

    await useSessionBtwStore.getState().ask(target, 'explain');
    expect(quotes()).toEqual([]);
    expect(harness.calls[0]?.prompt).toContain('Quoted from the conversation:\n\n> line one\n> line two\n\nexplain');
    expect(useSessionBtwStore.getState().entries[getSessionBtwKey(target)]?.turns[0]?.quotes).toEqual(['line one\nline two']);

    await useSessionBtwStore.getState().ask(target, 'next');
    expect(harness.calls[1]?.prompt).toContain('User: Quoted from the conversation:\n\n> line one\n> line two\n\nexplain\n\nAssistant: A1');
    expect(harness.calls[1]?.prompt.trimEnd().endsWith('next')).toBe(true);
  });

  test('empty questions and missing sessions never request', async () => {
    await useSessionBtwStore.getState().ask(scope('ses_1', '/a'), '   ');
    await useSessionBtwStore.getState().ask(scope('  ', '/a'), 'q');
    expect(harness.calls).toEqual([]);
    expect(useSessionBtwStore.getState().entries).toEqual({});
  });

  test('empty response and SDK errors are failures, not empty success', async () => {
    harness.queue.push({ text: '   ' }, new Error('upstream down'));
    const target = scope('ses_1', '/a');
    await useSessionBtwStore.getState().ask(target, 'q1');
    await useSessionBtwStore.getState().ask(target, 'q2');
    expect(turns(target)).toEqual([
      { question: 'q1', answer: '', error: 'empty response', pending: false },
      { question: 'q2', answer: '', error: 'upstream down', pending: false },
    ]);
  });

  test('a new send supersedes the pending turn; its late result never writes', async () => {
    const first = deferred();
    harness.queue.push({ text: 'second' });
    const target = scope('ses_1', '/a');
    const firstAsk = useSessionBtwStore.getState().ask(target, 'one');
    await flush();
    const secondAsk = useSessionBtwStore.getState().ask(target, 'two');
    expect(harness.calls[0]?.signal?.aborted).toBe(true);
    first.resolve('late first');
    await firstAsk;
    await secondAsk;
    expect(turns(target)).toEqual([
      { question: 'one', answer: '', error: null, pending: false },
      { question: 'two', answer: 'second', error: null, pending: false },
    ]);
  });

  test('cancel settles the pending turn; retry re-runs the last turn in place', async () => {
    harness.queue.push({ text: 'A1' });
    const pending = deferred();
    const target = scope('ses_1', '/a');
    await useSessionBtwStore.getState().ask(target, 'Q1');
    const ask = useSessionBtwStore.getState().ask(target, 'retry me');
    await flush();
    useSessionBtwStore.getState().cancel(target);
    expect(harness.calls[1]?.signal?.aborted).toBe(true);
    expect(turns(target)[1]).toEqual({ question: 'retry me', answer: '', error: null, pending: false });
    pending.resolve('should ignore');
    await ask;

    harness.queue.push({ text: 'retried' });
    await useSessionBtwStore.getState().retry(target);
    expect(turns(target)).toHaveLength(2);
    expect(turns(target)[1]).toEqual({ question: 'retry me', answer: 'retried', error: null, pending: false });
    expect(harness.calls[2]?.prompt).toContain('User: Q1\n\nAssistant: A1');
  });

  test('clear aborts in-flight work and drops the conversation; late results stay dropped', async () => {
    const pending = deferred();
    const target = scope('ses_1', '/a');
    const ask = useSessionBtwStore.getState().ask(target, 'q');
    await flush();
    useSessionBtwStore.getState().clear(target);
    expect(harness.calls[0]?.signal?.aborted).toBe(true);
    expect(useSessionBtwStore.getState().entries).toEqual({});
    pending.resolve('stale');
    await ask;
    expect(useSessionBtwStore.getState().entries).toEqual({});
  });

  test('isolates session and directory scopes', async () => {
    harness.queue.push({ text: 'a' }, { text: 'b' });
    const left = scope('ses_1', '/a');
    const right = scope('ses_1', '/b');
    await useSessionBtwStore.getState().ask(left, 'q1');
    await useSessionBtwStore.getState().ask(right, 'q2');
    expect(turns(left)[0]?.answer).toBe('a');
    expect(turns(right)[0]?.answer).toBe('b');
    expect(harness.calls.map((call) => call.directory)).toEqual(['/a', '/b']);
  });

  test('runtime reset and transport change drop stale completions', async () => {
    const beforeReset = deferred();
    const target = scope('ses_1', '/a');
    const ask = useSessionBtwStore.getState().ask(target, 'q');
    await flush();
    resetSessionBtwStoreForRuntimeSwitch();
    expect(harness.calls[0]?.signal?.aborted).toBe(true);
    beforeReset.resolve('stale');
    await ask;
    expect(useSessionBtwStore.getState().entries).toEqual({});

    const midFlight = deferred();
    const key = getSessionBtwKey(target);
    const second = useSessionBtwStore.getState().ask(target, 'q2');
    await flush();
    harness.transport = 'transport-b';
    harness.generation += 1;
    midFlight.resolve('wrong runtime');
    await second;
    expect(useSessionBtwStore.getState().entries[key]?.turns[0]).toMatchObject({ answer: '', error: null, pending: false });
  });

  test('conversation count is bounded and eviction aborts the evicted request', async () => {
    const holders = Array.from({ length: 40 }, () => deferred());
    for (let index = 0; index < 40; index += 1) {
      void useSessionBtwStore.getState().ask(scope(`ses_${index}`, '/fill'), `q${index}`);
    }
    await flush();
    harness.queue.push(() => new Promise(() => {}));
    void useSessionBtwStore.getState().ask(scope('ses_40', '/fill'), 'overflow');
    await flush();
    expect(Object.keys(useSessionBtwStore.getState().entries)).toHaveLength(40);
    expect(useSessionBtwStore.getState().entries[getSessionBtwKey(scope('ses_0', '/fill'))]).toBeUndefined();
    expect(harness.calls[0]?.signal?.aborted).toBe(true);
    holders[0]!.resolve('ghost');
    await flush();
    expect(useSessionBtwStore.getState().entries[getSessionBtwKey(scope('ses_0', '/fill'))]).toBeUndefined();
  });
});
