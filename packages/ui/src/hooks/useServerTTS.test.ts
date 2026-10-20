import { describe, expect, mock, test } from 'bun:test';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createHookHarness = () => {
  const slots: unknown[] = [];
  const callbacks: Array<{ value: unknown; deps: readonly unknown[] }> = [];
  let hookIndex = 0;
  let renderHook: (() => void) | null = null;

  const dependenciesChanged = (previous: readonly unknown[] | undefined, next: readonly unknown[]) =>
    !previous || previous.length !== next.length || previous.some((dependency, index) => dependency !== next[index]);

  return {
    react: {
      useCallback: <T,>(callback: T, deps: readonly unknown[]) => {
        const index = hookIndex++;
        const previous = callbacks[index];
        if (!previous || dependenciesChanged(previous.deps, deps)) {
          callbacks[index] = { value: callback, deps };
        }
        return callbacks[index].value as T;
      },
      useEffect: () => {
        hookIndex++;
      },
      useRef: <T,>(value: T) => {
        const index = hookIndex++;
        if (!(index in slots)) {
          slots[index] = { current: value };
        }
        return slots[index] as { current: T };
      },
      useState: <T,>(initial: T | (() => T)) => {
        const index = hookIndex++;
        if (!(index in slots)) {
          slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
        }
        return [slots[index] as T, (value: T) => {
          slots[index] = value;
          renderHook?.();
        }] as const;
      },
    },
    render(callback: () => void) {
      renderHook = () => {
        hookIndex = 0;
        callback();
      };
      renderHook();
    },
  };
};

const harness = createHookHarness();
const requests: Array<Deferred<Response>> = [];
const requestBodies: Record<string, unknown>[] = [];
let transportIdentity = 'runtime-a';
const decodes: Array<Deferred<AudioBuffer>> = [];
const sources: Array<{ onended: (() => void) | null; start: () => void; stop: () => void; connect: () => void; buffer: AudioBuffer | null; detune: { value: number }; starts: number }> = [];

const testStorage = globalThis.localStorage;
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    localStorage: testStorage,
    AudioContext: class {
      state = 'running';
      destination = {};
      createBuffer = () => ({}) as AudioBuffer;
      createBufferSource = () => {
        const source = {
          onended: null as (() => void) | null,
          start: () => { source.starts += 1; },
          stop: () => undefined,
          connect: () => undefined,
          buffer: null as AudioBuffer | null,
          detune: { value: 0 },
          starts: 0,
        };
        sources.push(source);
        return source;
      };
      createGain = () => ({ gain: { value: 0 }, connect: () => undefined });
      decodeAudioData = () => decodes.shift()!.promise;
    },
  },
});

mock.module('react', () => harness.react);
mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: <T,>(selector: (state: Record<string, null>) => T) => selector({
    currentProviderId: null,
    currentModelId: null,
    openaiApiKey: null,
    openaiCompatibleUrl: null,
    openaiCompatibleApiKey: null,
  }),
}));
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (_path: string, init?: RequestInit) => {
    if (typeof init?.body === 'string') requestBodies.push(JSON.parse(init.body));
    const request = deferred<Response>();
    requests.push(request);
    return request.promise;
  },
}));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => transportIdentity,
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));

const { useServerTTS } = await import('./useServerTTS');

const response = (): Response => ({
  ok: true,
  blob: async () => ({ arrayBuffer: async () => new ArrayBuffer(1) }),
} as Response);

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('useServerTTS playback session identity', () => {
  test('uses Host speech settings without sending client-local credentials or voice overrides', async () => {
    let tts = useServerTTS({ enabled: false });
    harness.render(() => { tts = useServerTTS({ enabled: false }); });
    const playing = tts.speak('测试', { provider: 'volcengine' });
    await flush();
    expect(requestBodies.at(-1)).toMatchObject({ provider: 'volcengine' });
    expect(requestBodies.at(-1)?.apiKey).toBeUndefined();
    expect(requestBodies.at(-1)?.voice).toBeUndefined();
    expect(requestBodies.at(-1)?.resourceId).toBeUndefined();
    tts.stop();
    requests.pop()!.resolve(response());
    await playing;
  });
  test('keeps current playback isolated from stale fetch, decode, error, and ended work', async () => {
    requests.length = 0;
    decodes.length = 0;
    sources.length = 0;
    let tts = useServerTTS({ enabled: false });
    harness.render(() => {
      tts = useServerTTS({ enabled: false });
    });

    let firstEndCalls = 0;
    let firstErrorCalls = 0;
    const firstEnd = () => { firstEndCalls += 1; };
    const firstError = () => { firstErrorCalls += 1; };
    void tts.speak('first', { onEnd: firstEnd, onError: firstError });
    await flush();
    void tts.speak('second');
    await flush();
    requests.shift()!.resolve(response());
    await flush();
    expect(sources).toHaveLength(2);

    const secondDecode = deferred<AudioBuffer>();
    decodes.push(secondDecode);
    requests.shift()!.resolve(response());
    await flush();
    void tts.speak('third');
    await flush();
    secondDecode.resolve({} as AudioBuffer);
    await flush();
    expect(sources).toHaveLength(3);

    const thirdDecode = deferred<AudioBuffer>();
    decodes.push(thirdDecode);
    requests.shift()!.resolve(response());
    await flush();
    thirdDecode.resolve({} as AudioBuffer);
    await flush();

    const staleEnded = sources.at(-1)!.onended!;
    const fourthDecode = deferred<AudioBuffer>();
    decodes.push(fourthDecode);
    void tts.speak('fourth');
    await flush();
    requests.shift()!.resolve(response());
    await flush();
    fourthDecode.resolve({} as AudioBuffer);
    await flush();

    staleEnded();
    expect(firstEndCalls).toBe(0);
    expect(tts.isPlaying).toBe(true);

    void tts.speak('fifth', { onError: firstError });
    await flush();
    void tts.speak('sixth');
    await flush();
    requests.shift()!.reject(new Error('stale failure'));
    await flush();
    expect(firstErrorCalls).toBe(0);
    expect(tts.error).toBeNull();

    const stoppedRequest = requests.shift()!;
    tts.stop();
    stoppedRequest.resolve(response());
    await flush();
    expect(tts.isPlaying).toBe(false);
  });

  test('isolates availability requests and state updates by transport identity', async () => {
    requests.length = 0;
    transportIdentity = 'runtime-a';
    let tts = useServerTTS({ enabled: true });
    harness.render(() => {
      tts = useServerTTS({ enabled: true });
    });

    const first = tts.checkAvailability();
    await flush();
    transportIdentity = 'runtime-b';
    const second = tts.checkAvailability();
    await flush();
    requests[1]!.resolve({ ok: true, json: async () => ({ available: false }) } as Response);
    await second;
    requests[0]!.resolve({ ok: true, json: async () => ({ available: true }) } as Response);
    await first;

    expect(tts.isAvailable).toBe(false);
  });
});
