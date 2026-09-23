import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const generateCalls: Array<{
  sessionId: string;
  directory?: string | null;
  prompt: string;
  signal?: AbortSignal;
}> = [];

type GenerateResult = { text: string } | Error | (() => Promise<{ text: string }>);
const generateQueue: GenerateResult[] = [];

const generateSessionAside = mock(async (input: {
  sessionId: string;
  directory?: string | null;
  prompt: string;
  signal?: AbortSignal;
}) => {
  generateCalls.push(input);
  const next = generateQueue.shift();
  if (typeof next === 'function') return next();
  if (next instanceof Error) throw next;
  if (next) return next;
  return { text: 'default answer' };
});

let transportIdentity = 'transport-a';
let runtimeGeneration = 1;

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: { generateSessionAside },
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => transportIdentity,
  getRuntimeGeneration: () => runtimeGeneration,
}));

const {
  EMPTY_SESSION_BTW_ENTRY,
  getSessionBtwKey,
  resetSessionBtwStoreForRuntimeSwitch,
  useSessionBtwStore,
} = await import('./useSessionBtwStore');

const scope = (sessionId: string, directory?: string | null) => ({ sessionId, directory });

const entry = (key: string) => useSessionBtwStore.getState().entries[key] ?? EMPTY_SESSION_BTW_ENTRY;

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  generateCalls.length = 0;
  generateQueue.length = 0;
  transportIdentity = 'transport-a';
  runtimeGeneration = 1;
  resetSessionBtwStoreForRuntimeSwitch();
});

afterEach(() => {
  resetSessionBtwStoreForRuntimeSwitch();
});

describe('useSessionBtwStore contract', () => {
  test('exports stable empty entry and transport-scoped keys', () => {
    expect(EMPTY_SESSION_BTW_ENTRY).toEqual({
      question: '',
      answer: '',
      error: null,
      pending: false,
    });
    expect(Object.isFrozen(EMPTY_SESSION_BTW_ENTRY)).toBe(true);

    const keyA = getSessionBtwKey(scope('ses_1', '/repo/a'));
    expect(keyA).toContain('transport-a');
    expect(keyA).toContain('ses_1');
    expect(getSessionBtwKey(scope('ses_1', '/repo/a/'))).toBe(keyA);

    transportIdentity = 'transport-b';
    expect(getSessionBtwKey(scope('ses_1', '/repo/a'))).not.toBe(keyA);

    const store = useSessionBtwStore.getState();
    expect(store.ask).toBe(useSessionBtwStore.getState().ask);
    expect(store.retry).toBe(useSessionBtwStore.getState().retry);
    expect(store.cancel).toBe(useSessionBtwStore.getState().cancel);
  });

  test('ask sends instructions+question through generateSessionAside with signal', async () => {
    generateQueue.push({ text: '  hello btw  ' });
    const target = scope('ses_1', '/workspace/app');
    await useSessionBtwStore.getState().ask(target, '  what next?  ');

    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]?.sessionId).toBe('ses_1');
    expect(generateCalls[0]?.directory).toBe('/workspace/app');
    expect(generateCalls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(generateCalls[0]?.prompt).toContain('Do not call any tools');
    expect(generateCalls[0]?.prompt).toContain('what next?');
    expect(generateCalls[0]?.prompt.startsWith('The user is asking a quick side question')).toBe(true);

    const key = getSessionBtwKey(target);
    expect(entry(key)).toEqual({
      question: 'what next?',
      answer: 'hello btw',
      error: null,
      pending: false,
    });
  });

  test('rejects empty questions without calling the SDK', async () => {
    await useSessionBtwStore.getState().ask(scope('ses_1', '/a'), '   ');
    expect(generateCalls).toEqual([]);
    expect(useSessionBtwStore.getState().entries).toEqual({});
  });

  test('empty response is a failure, not empty success', async () => {
    generateQueue.push({ text: '   ' });
    const target = scope('ses_1', '/a');
    await useSessionBtwStore.getState().ask(target, 'q');
    expect(entry(getSessionBtwKey(target))).toEqual({
      question: 'q',
      answer: '',
      error: 'empty response',
      pending: false,
    });
  });

  test('SDK error surfaces as entry.error and is not swallowed', async () => {
    generateQueue.push(new Error('upstream down'));
    const target = scope('ses_1', '/a');
    await useSessionBtwStore.getState().ask(target, 'q');
    expect(entry(getSessionBtwKey(target))).toEqual({
      question: 'q',
      answer: '',
      error: 'upstream down',
      pending: false,
    });
  });

  test('repeat ask aborts the previous controller and ignores late success', async () => {
    let resolveFirst: ((value: { text: string }) => void) | undefined;
    generateQueue.push(() => new Promise<{ text: string }>((resolve) => {
      resolveFirst = resolve;
    }));
    generateQueue.push({ text: 'second' });

    const target = scope('ses_1', '/a');
    const first = useSessionBtwStore.getState().ask(target, 'one');
    await flush();
    const firstSignal = generateCalls[0]?.signal;
    expect(firstSignal?.aborted).toBe(false);

    const second = useSessionBtwStore.getState().ask(target, 'two');
    await flush();
    expect(firstSignal?.aborted).toBe(true);

    resolveFirst?.({ text: 'late first' });
    await first;
    await second;

    expect(entry(getSessionBtwKey(target))).toEqual({
      question: 'two',
      answer: 'second',
      error: null,
      pending: false,
    });
  });

  test('late failure after supersede does not clobber the newer entry', async () => {
    let rejectFirst: ((reason?: unknown) => void) | undefined;
    generateQueue.push(() => new Promise<{ text: string }>((_resolve, reject) => {
      rejectFirst = reject;
    }));
    generateQueue.push({ text: 'ok' });

    const target = scope('ses_1', '/a');
    const first = useSessionBtwStore.getState().ask(target, 'one');
    await flush();
    const second = useSessionBtwStore.getState().ask(target, 'two');
    await flush();

    rejectFirst?.(new Error('stale failure'));
    await first.catch(() => undefined);
    await second;

    expect(entry(getSessionBtwKey(target))).toEqual({
      question: 'two',
      answer: 'ok',
      error: null,
      pending: false,
    });
  });

  test('cancel clears pending and allows retry of the same question', async () => {
    let resolvePending: ((value: { text: string }) => void) | undefined;
    generateQueue.push(() => new Promise<{ text: string }>((resolve) => {
      resolvePending = resolve;
    }));

    const target = scope('ses_1', '/a');
    const pending = useSessionBtwStore.getState().ask(target, 'retry me');
    await flush();
    expect(entry(getSessionBtwKey(target)).pending).toBe(true);

    useSessionBtwStore.getState().cancel(target);
    expect(entry(getSessionBtwKey(target))).toEqual({
      question: 'retry me',
      answer: '',
      error: null,
      pending: false,
    });
    expect(generateCalls[0]?.signal?.aborted).toBe(true);

    resolvePending?.({ text: 'should ignore' });
    await pending;

    generateQueue.push({ text: 'retried' });
    await useSessionBtwStore.getState().retry(target);
    expect(entry(getSessionBtwKey(target))).toEqual({
      question: 'retry me',
      answer: 'retried',
      error: null,
      pending: false,
    });
  });

  test('autonomous AbortError clears pending without error so retry works', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    generateQueue.push(abortError);

    const target = scope('ses_1', '/a');
    await useSessionBtwStore.getState().ask(target, 'side q');

    expect(entry(getSessionBtwKey(target))).toEqual({
      question: 'side q',
      answer: '',
      error: null,
      pending: false,
    });

    generateQueue.push({ text: 'after abort' });
    await useSessionBtwStore.getState().retry(target);
    expect(entry(getSessionBtwKey(target)).answer).toBe('after abort');
  });

  test('isolates different session and directory scopes', async () => {
    generateQueue.push({ text: 'a' }, { text: 'b' });
    const left = scope('ses_1', '/a');
    const right = scope('ses_1', '/b');
    await useSessionBtwStore.getState().ask(left, 'q1');
    await useSessionBtwStore.getState().ask(right, 'q2');

    expect(entry(getSessionBtwKey(left)).answer).toBe('a');
    expect(entry(getSessionBtwKey(right)).answer).toBe('b');
    expect(generateCalls.map((call) => call.directory)).toEqual(['/a', '/b']);
  });

  test('runtime reset aborts in-flight work and drops entries', async () => {
    let resolvePending: ((value: { text: string }) => void) | undefined;
    generateQueue.push(() => new Promise<{ text: string }>((resolve) => {
      resolvePending = resolve;
    }));

    const target = scope('ses_1', '/a');
    const pending = useSessionBtwStore.getState().ask(target, 'q');
    await flush();
    expect(entry(getSessionBtwKey(target)).pending).toBe(true);

    resetSessionBtwStoreForRuntimeSwitch();
    expect(useSessionBtwStore.getState().entries).toEqual({});
    expect(generateCalls[0]?.signal?.aborted).toBe(true);

    resolvePending?.({ text: 'stale' });
    await pending;
    expect(useSessionBtwStore.getState().entries).toEqual({});
  });

  test('reset then same-key ask ignores old resolve and reject', async () => {
    let resolveOld: ((value: { text: string }) => void) | undefined;
    let rejectOld: ((reason?: unknown) => void) | undefined;
    generateQueue.push(() => new Promise<{ text: string }>((resolve, reject) => {
      resolveOld = resolve;
      rejectOld = reject;
    }));

    const target = scope('ses_1', '/a');
    const oldAsk = useSessionBtwStore.getState().ask(target, 'before reset');
    await flush();

    resetSessionBtwStoreForRuntimeSwitch();

    generateQueue.push({ text: 'after reset' });
    await useSessionBtwStore.getState().ask(target, 'after reset');
    expect(entry(getSessionBtwKey(target))).toEqual({
      question: 'after reset',
      answer: 'after reset',
      error: null,
      pending: false,
    });

    resolveOld?.({ text: 'stale success' });
    await oldAsk;
    expect(entry(getSessionBtwKey(target)).answer).toBe('after reset');
    expect(entry(getSessionBtwKey(target)).question).toBe('after reset');

    // Second old-style flight after another reset path for reject isolation.
    let rejectOnly: ((reason?: unknown) => void) | undefined;
    generateQueue.push(() => new Promise<{ text: string }>((_resolve, reject) => {
      rejectOnly = reject;
    }));
    const rejectFlight = useSessionBtwStore.getState().ask(target, 'will reset');
    await flush();
    resetSessionBtwStoreForRuntimeSwitch();
    generateQueue.push({ text: 'fresh' });
    await useSessionBtwStore.getState().ask(target, 'fresh');
    rejectOnly?.(new Error('stale reject'));
    await rejectFlight.catch(() => undefined);
    expect(entry(getSessionBtwKey(target))).toEqual({
      question: 'fresh',
      answer: 'fresh',
      error: null,
      pending: false,
    });
    void rejectOld;
  });

  test('ignores completion when transport identity changes mid-flight', async () => {
    let resolvePending: ((value: { text: string }) => void) | undefined;
    generateQueue.push(() => new Promise<{ text: string }>((resolve) => {
      resolvePending = resolve;
    }));

    const target = scope('ses_1', '/a');
    const keyBefore = getSessionBtwKey(target);
    const pending = useSessionBtwStore.getState().ask(target, 'q');
    await flush();

    transportIdentity = 'transport-b';
    runtimeGeneration += 1;
    resolvePending?.({ text: 'wrong runtime' });
    await pending;

    expect(useSessionBtwStore.getState().entries[keyBefore]?.answer ?? '').toBe('');
    expect(useSessionBtwStore.getState().entries[keyBefore]?.error ?? null).toBeNull();
    expect(useSessionBtwStore.getState().entries[keyBefore]?.pending).toBe(false);
  });

  test('evict-then-reask same key: old resolve and reject cannot overwrite', async () => {
    const holders: Array<{
      resolve: (value: { text: string }) => void;
      reject: (reason?: unknown) => void;
    }> = [];

    // 40 concurrent pending slots fill the bound; 41st force-evicts the oldest.
    for (let i = 0; i < 40; i += 1) {
      generateQueue.push(() => new Promise<{ text: string }>((resolve, reject) => {
        holders.push({ resolve, reject });
      }));
      void useSessionBtwStore.getState().ask(scope(`ses_${i}`, '/fill'), `q${i}`);
    }
    await flush();
    expect(Object.keys(useSessionBtwStore.getState().entries)).toHaveLength(40);

    const victim = scope('ses_0', '/fill');
    const victimKey = getSessionBtwKey(victim);
    const oldResolve = holders[0]!.resolve;
    const oldReject = holders[0]!.reject;
    expect(entry(victimKey).pending).toBe(true);

    // 41st pending force-evicts ses_0 (oldest non-protect).
    generateQueue.push(() => new Promise<{ text: string }>(() => {
      // leave hanging
    }));
    void useSessionBtwStore.getState().ask(scope('ses_40', '/fill'), 'overflow');
    await flush();
    expect(useSessionBtwStore.getState().entries[victimKey]).toBeUndefined();
    expect(generateCalls[0]?.signal?.aborted).toBe(true);

    // Re-ask the same key with a new controller identity.
    let resolveNew: ((value: { text: string }) => void) | undefined;
    generateQueue.push(() => new Promise<{ text: string }>((resolve) => {
      resolveNew = resolve;
    }));
    const newAsk = useSessionBtwStore.getState().ask(victim, 'reborn');
    await flush();
    expect(entry(victimKey)).toEqual({
      question: 'reborn',
      answer: '',
      error: null,
      pending: true,
    });

    oldResolve({ text: 'ghost success' });
    await flush();
    expect(entry(victimKey)).toEqual({
      question: 'reborn',
      answer: '',
      error: null,
      pending: true,
    });

    oldReject(new Error('ghost failure'));
    await flush();
    expect(entry(victimKey)).toEqual({
      question: 'reborn',
      answer: '',
      error: null,
      pending: true,
    });

    resolveNew?.({ text: 'live answer' });
    await newAsk;
    expect(entry(victimKey)).toEqual({
      question: 'reborn',
      answer: 'live answer',
      error: null,
      pending: false,
    });

    // Cleanup remaining hangers so afterEach reset is quiet.
    for (let i = 1; i < holders.length; i += 1) {
      holders[i]!.resolve({ text: `cleanup-${i}` });
    }
  });
});
