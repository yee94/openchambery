import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Agent } from '@opencode-ai/sdk/v2';

const DIRECTORY = '/workspace/project';
const OTHER_DIRECTORY = '/workspace/other';
const STORAGE_KEY = 'config-store';
type TestAgent = { name: string; mode?: string; hidden?: boolean; model?: { providerID?: string; modelID?: string }; variant?: string };

let storage = new Map<string, string>();
let liveProviderId = 'live';
let liveProviderIdsByDirectory = new Map<string, string>();
let liveProviderVariants: Record<string, Record<string, unknown>> | undefined;
let getProvidersCalls = 0;
let getConfigCalls = 0;
let listAgentsCalls = 0;
let settingsBootstrapCalls = 0;
let settingsBootstrapStatus = 200;
let liveAgents: TestAgent[] = [];
let listAgentsImpl: ((directory?: string | null) => Promise<TestAgent[]>) | null = null;
let withDirectoryCalls: Array<string | null> = [];
let currentFetchDirectory: string | null = DIRECTORY;
let configListener: ((event: { scopes: string[]; source?: string; timestamp: number }) => void | Promise<void>) | null = null;
let runtimeGeneration = 0;
let runtimeIdentity = 'test-runtime';

const makeStorage = (): Storage => ({
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value);
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => {
    storage.clear();
  },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() {
    return storage.size;
  },
}) as Storage;

const provider = (id: string, modelId = `${id}-model`, variants?: Record<string, Record<string, unknown>>) => ({
  id,
  name: id,
  source: 'config' as const,
  env: [],
  options: {},
  models: [
    {
      id: modelId,
      name: modelId,
      providerID: id,
      api: { id: 'chat', url: '', npm: '' },
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 0, output: 0 },
      options: {},
      release_date: '2024-01-01',
      status: 'active' as const,
      headers: {},
      attachment: false,
      reasoning: false,
      temperature: true,
      tool_call: true,
      ...(variants ? { variants } : {}),
    },
  ],
});

const providerResponse = (id: string, modelId = `${id}-model`, variants?: Record<string, Record<string, unknown>>) => ({
  id,
  name: id,
  source: 'config' as const,
  env: [],
  options: {},
  models: {
    [modelId]: {
      id: modelId,
      name: modelId,
      providerID: id,
      api: { id: 'chat', url: '', npm: '' },
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 0, output: 0 },
      options: {},
      release_date: '2024-01-01',
      status: 'active' as const,
      headers: {},
      attachment: false,
      reasoning: false,
      temperature: true,
      tool_call: true,
      ...(variants ? { variants } : {}),
    },
  },
});

let getProvidersForConfigImpl: ((directory?: string | null) => Promise<{
  providers: ReturnType<typeof providerResponse>[];
  default: Record<string, string>;
}>) | null = null;

const testAgent = (name: string, options?: Partial<TestAgent>): Agent => ({
  name,
  mode: options?.mode ?? 'primary',
  hidden: options?.hidden,
  model: options?.model,
  variant: options?.variant,
  permission: {},
  options: {},
}) as Agent;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

mock.module('@/stores/utils/safeStorage', () => ({
  getDeferredSafeStorage: () => makeStorage(),
  getSafeStorage: () => makeStorage(),
  createDeferredSafeJSONStorage: () => {
    const testStorage = makeStorage();
    return {
      getItem: (name: string) => {
        const value = testStorage.getItem(name);
        return value === null ? null : JSON.parse(value);
      },
      setItem: (name: string, value: unknown) => {
        testStorage.setItem(name, JSON.stringify(value));
      },
      removeItem: (name: string) => {
        testStorage.removeItem(name);
      },
    };
  },
}));

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      activeProjectId: 'project',
      projects: [
        { id: 'project', path: DIRECTORY, label: 'Project' },
        { id: 'other', path: OTHER_DIRECTORY, label: 'Other' },
      ],
    }),
  },
}));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    setDirectory: mock(() => undefined),
    getDirectory: mock(() => DIRECTORY),
    checkHealth: mock(async () => true),
    withDirectory: mock(async (directory: string | null, callback: () => Promise<unknown>) => {
      withDirectoryCalls.push(directory);
      const previous = currentFetchDirectory;
      currentFetchDirectory = directory;
      try {
        return await callback();
      } finally {
        currentFetchDirectory = previous;
      }
    }),
    getProviders: mock(async () => {
      getProvidersCalls += 1;
      const id = liveProviderIdsByDirectory.get(currentFetchDirectory ?? '') ?? liveProviderId;
      return { providers: [providerResponse(id, `${id}-model`, liveProviderVariants)], default: { default: id } };
    }),
    getProvidersForConfig: mock(async (directory?: string | null) => {
      getProvidersCalls += 1;
      if (getProvidersForConfigImpl) {
        return getProvidersForConfigImpl(directory);
      }
      const id = liveProviderIdsByDirectory.get(directory ?? '') ?? liveProviderId;
      return { providers: [providerResponse(id, `${id}-model`, liveProviderVariants)], default: { default: id } };
    }),
    listAgents: mock(async (directory?: string | null) => {
      listAgentsCalls += 1;
      const impl = listAgentsImpl as ((directory?: string | null) => Promise<TestAgent[]>) | null;
      return impl ? impl(directory) : liveAgents;
    }),
    getConfig: mock(async () => {
      getConfigCalls += 1;
      return {};
    }),
    clearConfigCache: mock(() => undefined),
  },
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (path: string, options?: RequestInit) => {
    if (path === '/api/config/settings/bootstrap') {
      settingsBootstrapCalls += 1;
      return new Response(JSON.stringify({ schemaVersion: 1 }), {
        status: settingsBootstrapStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (path === '/api/config/catalog/providers') {
      getProvidersCalls += 1;
      const directory = new Headers(options?.headers).get('x-opencode-directory') ?? '';
      if (getProvidersForConfigImpl) {
        const result = await getProvidersForConfigImpl(directory);
        return new Response(JSON.stringify({ schemaVersion: 1, ...result, partial: false }));
      }
      const id = liveProviderIdsByDirectory.get(directory) ?? liveProviderId;
      return new Response(JSON.stringify({ schemaVersion: 1, providers: [providerResponse(id, `${id}-model`, liveProviderVariants)], default: { default: id }, partial: false }));
    }
    return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
  }),
  setRuntimeInteractiveSessionRequestId: mock(() => undefined),
}));

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: mock(async () => undefined),
}));

mock.module('@/lib/startupTrace', () => ({
  markStartupTrace: mock(() => undefined),
  measureStartupTrace: mock(async (_name: string, callback: () => Promise<unknown>) => callback()),
}));

mock.module('@/lib/configSync', () => ({
  emitConfigChange: mock(() => undefined),
  scopeMatches: mock((event: { scopes: string[] }, scope: string) => event.scopes.includes('all') || event.scopes.includes(scope)),
  subscribeToConfigChanges: mock((listener: typeof configListener) => {
    configListener = listener;
    return () => {
      if (configListener === listener) {
        configListener = null;
      }
    };
  }),
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: () => '',
  getRuntimeGeneration: () => runtimeGeneration,
  getRuntimeKey: () => runtimeIdentity,
  getRuntimeTransportIdentity: () => runtimeIdentity,
  isRuntimeEndpointIdentityChange: () => false,
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));

const { useConfigStore } = await import('./useConfigStore');
const { queryClient } = await import('@/lib/queryRuntime');
const { emitSyncConfigChanged, setSyncRefs } = await import('@/sync/sync-refs');
const { useSelectionStore } = await import('@/sync/selection-store');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { getRuntimeTransportIdentity } = await import('@/lib/runtime-switch');

describe('useConfigStore provider persistence', () => {
  beforeEach(() => {
    queryClient.clear();
    storage = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: makeStorage(),
    });
    liveProviderId = 'live';
    liveProviderIdsByDirectory = new Map<string, string>();
    liveProviderVariants = undefined;
    getProvidersForConfigImpl = null;
    getProvidersCalls = 0;
    getConfigCalls = 0;
    listAgentsCalls = 0;
    settingsBootstrapCalls = 0;
    settingsBootstrapStatus = 200;
    liveAgents = [];
    listAgentsImpl = null;
    withDirectoryCalls = [];
    currentFetchDirectory = DIRECTORY;
    runtimeGeneration = 0;
    runtimeIdentity = 'test-runtime';
    setSyncRefs({} as never, { children: new Map(), getState: () => undefined } as never, DIRECTORY);
    useSelectionStore.setState({
      sessionModelSelections: new Map(),
      sessionAgentSelections: new Map(),
      sessionAgentModelSelections: new Map(),
      lastUsedProvider: null,
    });
    useSessionUIStore.setState({ currentSessionId: null });
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      directoryScoped: {},
      providerConfigLoadingByDirectory: {},
      agentConfigLoadingByDirectory: {},
      providers: [],
      defaultProviders: {},
      currentProviderId: '',
      currentModelId: '',
      currentVariant: undefined,
      selectedProviderId: '',
      currentAgentName: undefined,
      agents: [],
      agentModelSelections: {},
      opencodeDefaultAgent: undefined,
      opencodeDefaultModel: undefined,
      selectionSource: 'auto',
      isConnected: true,
      isInitialized: false,
    });
  });

  test('legacy persisted catalogs without transport identity are discarded before live refresh', async () => {
    storage.set(STORAGE_KEY, JSON.stringify({
      state: {
        activeDirectoryKey: DIRECTORY,
        directoryScoped: {
          [DIRECTORY]: {
            providers: [provider('stale')],
            agents: [{ name: 'build', mode: 'primary' }],
            currentProviderId: 'stale',
            currentModelId: 'stale-model',
            currentAgentName: 'build',
            selectedProviderId: 'stale',
            agentModelSelections: { build: { providerId: 'stale', modelId: 'stale-model' } },
            defaultProviders: { default: 'stale' },
          },
          [OTHER_DIRECTORY]: {
            providers: [provider('other-stale')],
            agents: [{ name: 'review', mode: 'primary' }],
            currentProviderId: 'other-stale',
            currentModelId: 'other-stale-model',
            currentAgentName: 'review',
            selectedProviderId: 'other-stale',
            agentModelSelections: {},
            defaultProviders: { default: 'other-stale' },
          },
        },
        currentProviderId: 'stale',
        currentModelId: 'stale-model',
        selectedProviderId: 'stale',
        defaultProviders: { default: 'stale' },
      },
      version: 0,
    }));

    await useConfigStore.persist.rehydrate();

    const hydrated = useConfigStore.getState();
    expect(hydrated.providers).toEqual([]);
    expect(hydrated.defaultProviders).toEqual({});
    expect(hydrated.directoryScoped).toEqual({});

    liveProviderId = 'fresh';
    await hydrated.initializeApp();

    const reloaded = useConfigStore.getState();
    expect(getProvidersCalls).toBe(1);
    expect(reloaded.providers.map((entry) => entry.id)).toEqual(['fresh']);
    expect(reloaded.directoryScoped[DIRECTORY]?.providers.map((entry) => entry.id)).toEqual(['fresh']);
    expect(reloaded.currentProviderId).toBe('fresh');
    expect(reloaded.currentModelId).toBe('fresh-model');
  });

  test('provider config events refresh all known directory provider caches immediately', async () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('active-stale')],
      defaultProviders: { default: 'active-stale' },
      currentProviderId: 'active-stale',
      currentModelId: 'active-stale-model',
      selectedProviderId: 'active-stale',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('active-stale')],
          agents: [],
          currentProviderId: 'active-stale',
          currentModelId: 'active-stale-model',
          currentAgentName: undefined,
          selectedProviderId: 'active-stale',
          agentModelSelections: {},
          defaultProviders: { default: 'active-stale' },
        },
        [OTHER_DIRECTORY]: {
          providers: [provider('inactive-cached')],
          agents: [],
          currentProviderId: 'inactive-cached',
          currentModelId: 'inactive-cached-model',
          currentAgentName: undefined,
          selectedProviderId: 'inactive-cached',
          agentModelSelections: {},
          defaultProviders: { default: 'inactive-cached' },
        },
      },
    });

    liveProviderIdsByDirectory = new Map([
      [DIRECTORY, 'active-live'],
      [OTHER_DIRECTORY, 'inactive-live'],
    ]);
    expect(configListener).not.toBeNull();
    await configListener?.({ scopes: ['providers'], timestamp: Date.now() });

    const state = useConfigStore.getState();
    expect(getProvidersCalls).toBe(2);
    expect(state.directoryScoped[DIRECTORY]?.providers.map((entry) => entry.id)).toEqual(['active-live']);
    expect(state.directoryScoped[OTHER_DIRECTORY]?.providers.map((entry) => entry.id)).toEqual(['inactive-live']);
    expect(state.directoryScoped[OTHER_DIRECTORY]?.defaultProviders).toEqual({ default: 'inactive-live' });
  });

  test('provider reload preserves a valid current variant', async () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      currentProviderId: 'live',
      currentModelId: 'live-model',
      currentVariant: 'fast',
      selectedProviderId: 'live',
      settingsDefaultVariant: 'slow',
      directoryScoped: {},
    });

    liveProviderId = 'live';
    liveProviderVariants = { fast: {}, slow: {} };
    await useConfigStore.getState().loadProviders({ source: 'test:variant' });

    const state = useConfigStore.getState();
    expect(state.currentProviderId).toBe('live');
    expect(state.currentModelId).toBe('live-model');
    expect(state.currentVariant).toBe('fast');
  });

  test('provider reload preserves the add-provider sentinel selection', async () => {
    // The user has opened the "Add provider" form, which sets selectedProviderId
    // to the sentinel. A background provider refresh must not navigate them away
    // (and discard their unsaved input) just because the sentinel is not a real
    // provider id. See issue #1765.
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      currentProviderId: 'live',
      currentModelId: 'live-model',
      selectedProviderId: '__add_provider__',
      directoryScoped: {},
    });

    liveProviderId = 'live';
    await useConfigStore.getState().loadProviders({ source: 'test:add-provider' });

    expect(useConfigStore.getState().selectedProviderId).toBe('__add_provider__');
  });

  test('add-provider sentinel is not persisted as a stable provider selection', async () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      currentProviderId: 'live',
      currentModelId: 'live-model',
      selectedProviderId: '__add_provider__',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('live')],
          agents: [],
          currentProviderId: 'live',
          currentModelId: 'live-model',
          currentAgentName: undefined,
          selectedProviderId: '__add_provider__',
          agentModelSelections: {},
          defaultProviders: { default: 'live' },
        },
      },
    });

    const persisted = JSON.parse(storage.get(STORAGE_KEY) ?? '{}');
    expect(persisted.state.selectedProviderId).toBe('');
    expect(persisted.state.directoryScoped[DIRECTORY].selectedProviderId).toBe('');
  });

  test('rehydrate and partialize remove provider secret sentinels from every catalog projection', async () => {
    const sentinel = '__provider_secret__';
    storage.set(STORAGE_KEY, JSON.stringify({
      state: {
        catalogTransportIdentity: getRuntimeTransportIdentity(),
        activeDirectoryKey: DIRECTORY,
        providers: [{ ...provider('unsafe'), key: sentinel }],
        defaultProviders: { default: 'unsafe' },
        directoryScoped: {
          [DIRECTORY]: {
            providers: [{ ...provider('unsafe'), headers: { authorization: sentinel } }],
            agents: [], currentProviderId: 'unsafe', currentModelId: 'unsafe-model', selectedProviderId: 'unsafe', agentModelSelections: {}, defaultProviders: { default: 'unsafe' },
          },
        },
      }, version: 0,
    }));
    await useConfigStore.persist.rehydrate();
    const state = useConfigStore.getState();
    const partial = useConfigStore.persist.getOptions().partialize?.(state);
    expect(JSON.stringify(state.providers)).not.toContain(sentinel);
    expect(JSON.stringify(state.directoryScoped)).not.toContain(sentinel);
    expect(JSON.stringify(partial)).not.toContain(sentinel);
  });

  test('migration rewrites the allowlisted preference envelope without credential sentinels', async () => {
    const sentinel = '__credential_sentinel__';
    storage.set(STORAGE_KEY, JSON.stringify({
      state: {
        settingsDefaultModel: 'safe/model',
        settingsAutoCreateWorktree: true,
        speechRate: 1.2,
        openaiApiKey: sentinel,
        openaiCompatibleApiKey: sentinel,
        sttApiKey: sentinel,
        unknownPreference: sentinel,
      },
      version: 0,
    }));

    await useConfigStore.persist.rehydrate();

    const state = useConfigStore.getState();
    expect(state.settingsDefaultModel).toBe('safe/model');
    expect(state.settingsAutoCreateWorktree).toBe(true);
    expect(state.speechRate).toBe(1.2);
    const rewritten = storage.get(STORAGE_KEY) ?? '';
    expect(JSON.parse(rewritten).version).toBe(1);
    expect(rewritten).not.toContain(sentinel);
    expect(rewritten).not.toContain('unknownPreference');
    expect(JSON.stringify(useConfigStore.persist.getOptions().partialize?.(state))).not.toContain(sentinel);
  });

  test('transport mismatch clears catalogs while retaining only legal persisted preferences', async () => {
    storage.set(STORAGE_KEY, JSON.stringify({
      state: {
        catalogTransportIdentity: 'old-runtime',
        providers: [provider('stale')],
        settingsGitmojiEnabled: true,
        settingsMessageStreamTransport: 'ws',
        settingsAutoCreateWorktree: 'invalid',
        openaiApiKey: '__credential_sentinel__',
      },
      version: 1,
    }));
    await useConfigStore.persist.rehydrate();
    const state = useConfigStore.getState();
    expect(state.providers).toEqual([]);
    expect(state.settingsGitmojiEnabled).toBe(true);
    expect(state.settingsMessageStreamTransport).toBe('ws');
  });

  test('setAgent applies settings default variant for an agent configured model', () => {
    useSessionUIStore.setState({ currentSessionId: 'ses_agent_default_variant' });
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', { low: {}, high: {} })],
      agents: [testAgent('plan', { model: { providerID: 'openai', modelID: 'gpt-5.5' } })],
      settingsDefaultVariant: 'high',
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentVariant: undefined,
      directoryScoped: {},
    });

    useConfigStore.getState().setAgent('plan');

    const state = useConfigStore.getState();
    expect(state.currentProviderId).toBe('openai');
    expect(state.currentModelId).toBe('gpt-5.5');
    expect(state.currentVariant).toBe('high');
    expect(state.directoryScoped[DIRECTORY]?.currentVariant).toBe('high');
  });

  test('setAgent prefers saved and agent variants before settings default', () => {
    const sessionId = 'ses_agent_saved_variant';
    useSessionUIStore.setState({ currentSessionId: sessionId });
    useSelectionStore.getState().saveAgentModelVariantForSession(sessionId, 'plan', 'openai', 'gpt-5.5', 'low');
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', { low: {}, medium: {}, high: {} })],
      agents: [testAgent('plan', {
        model: { providerID: 'openai', modelID: 'gpt-5.5' },
        variant: 'medium',
      })],
      settingsDefaultVariant: 'high',
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentVariant: undefined,
      directoryScoped: {},
    });

    useConfigStore.getState().setAgent('plan');
    expect(useConfigStore.getState().currentVariant).toBe('low');

    useSelectionStore.getState().saveAgentModelVariantForSession(sessionId, 'plan', 'openai', 'gpt-5.5', undefined);
    useConfigStore.setState({ currentVariant: undefined, directoryScoped: {} });

    useConfigStore.getState().setAgent('plan');
    expect(useConfigStore.getState().currentVariant).toBe('medium');
  });

  test('setAgent applies settings default variant for a saved session agent model', () => {
    const sessionId = 'ses_existing_agent_model_default_variant';
    useSessionUIStore.setState({ currentSessionId: sessionId });
    useSelectionStore.getState().saveAgentModelForSession(sessionId, 'plan', 'openai', 'gpt-5.5');
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', { low: {}, high: {} })],
      agents: [testAgent('plan')],
      settingsDefaultVariant: 'high',
      currentProviderId: 'other',
      currentModelId: 'other-model',
      currentVariant: undefined,
      directoryScoped: {},
    });

    useConfigStore.getState().setAgent('plan');

    const state = useConfigStore.getState();
    expect(state.currentProviderId).toBe('openai');
    expect(state.currentModelId).toBe('gpt-5.5');
    expect(state.currentVariant).toBe('high');
  });

  test('setAgent prefers last user agent model+variant over OpenCode agent pin', () => {
    useSessionUIStore.setState({ currentSessionId: null });
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [
        provider('openai', 'gpt-5.5', { low: {}, high: {} }),
        provider('anthropic', 'claude-sonnet'),
      ],
      agents: [testAgent('build', {
        model: { providerID: 'anthropic', modelID: 'claude-sonnet' },
        variant: undefined,
      })],
      agentModelSelections: {
        build: { providerId: 'openai', modelId: 'gpt-5.5', variant: 'low' },
      },
      settingsDefaultModel: undefined,
      settingsDefaultVariant: 'high',
      opencodeDefaultModel: 'anthropic/claude-sonnet',
      currentProviderId: 'anthropic',
      currentModelId: 'claude-sonnet',
      currentVariant: undefined,
      directoryScoped: {},
    });

    useConfigStore.getState().setAgent('build');

    const state = useConfigStore.getState();
    expect(state.currentProviderId).toBe('openai');
    expect(state.currentModelId).toBe('gpt-5.5');
    expect(state.currentVariant).toBe('low');
  });

  test('applyDefaultModelAgentSelection restores per-agent last user pick on new draft', () => {
    useSelectionStore.setState({
      lastUsedProvider: { providerID: 'anthropic', modelID: 'claude-sonnet' },
      sessionAgentSelections: new Map([['ses_old', 'plan']]),
      sessionModelSelections: new Map(),
      sessionAgentModelSelections: new Map(),
    });
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [
        provider('openai', 'gpt-5.5', { low: {}, high: {} }),
        provider('anthropic', 'claude-sonnet'),
      ],
      agents: [
        testAgent('build', { model: { providerID: 'anthropic', modelID: 'claude-sonnet' } }),
        testAgent('plan'),
      ],
      agentModelSelections: {
        build: { providerId: 'openai', modelId: 'gpt-5.5', variant: 'high' },
      },
      settingsDefaultAgent: 'build',
      settingsDefaultModel: undefined,
      settingsDefaultVariant: undefined,
      opencodeDefaultModel: 'anthropic/claude-sonnet',
      currentProviderId: 'anthropic',
      currentModelId: 'claude-sonnet',
      currentVariant: undefined,
      currentAgentName: 'plan',
      directoryScoped: {},
    });

    useConfigStore.getState().applyDefaultModelAgentSelection();

    const state = useConfigStore.getState();
    expect(state.currentAgentName).toBe('build');
    expect(state.currentProviderId).toBe('openai');
    expect(state.currentModelId).toBe('gpt-5.5');
    expect(state.currentVariant).toBe('high');
  });

  test('applyDefaultModelAgentSelection prefers per-agent memory over settings default model', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [
        provider('openai', 'gpt-5.5', { low: {}, high: {} }),
        provider('anthropic', 'claude-sonnet'),
      ],
      agents: [testAgent('build')],
      agentModelSelections: {
        build: { providerId: 'openai', modelId: 'gpt-5.5', variant: 'low' },
      },
      settingsDefaultAgent: 'build',
      settingsDefaultModel: 'anthropic/claude-sonnet',
      settingsDefaultVariant: undefined,
      currentProviderId: 'anthropic',
      currentModelId: 'claude-sonnet',
      currentVariant: undefined,
      currentAgentName: 'build',
      directoryScoped: {},
    });

    useConfigStore.getState().applyDefaultModelAgentSelection();

    const state = useConfigStore.getState();
    expect(state.currentProviderId).toBe('openai');
    expect(state.currentModelId).toBe('gpt-5.5');
    expect(state.currentVariant).toBe('low');
  });

  test('applyDefaultModelAgentSelection does not use last session model as default', () => {
    useSelectionStore.setState({
      lastUsedProvider: { providerID: 'anthropic', modelID: 'claude-sonnet' },
      sessionAgentSelections: new Map([['ses_old', 'build']]),
      sessionModelSelections: new Map([
        ['ses_old', { providerId: 'anthropic', modelId: 'claude-sonnet' }],
      ]),
      sessionAgentModelSelections: new Map(),
    });
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [
        provider('openai', 'gpt-5.5', { low: {}, high: {} }),
        provider('anthropic', 'claude-sonnet'),
      ],
      agents: [testAgent('build', { model: { providerID: 'openai', modelID: 'gpt-5.5' } })],
      agentModelSelections: {},
      settingsDefaultAgent: 'build',
      settingsDefaultModel: undefined,
      settingsDefaultVariant: undefined,
      opencodeDefaultModel: undefined,
      currentProviderId: 'anthropic',
      currentModelId: 'claude-sonnet',
      currentVariant: undefined,
      currentAgentName: 'build',
      directoryScoped: {},
    });

    useConfigStore.getState().applyDefaultModelAgentSelection();

    const state = useConfigStore.getState();
    expect(state.currentProviderId).toBe('openai');
    expect(state.currentModelId).toBe('gpt-5.5');
  });

  test('saveAgentModelSelection persists model and variant per agent', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      agentModelSelections: {},
      directoryScoped: {},
    });

    useConfigStore.getState().saveAgentModelSelection('build', 'openai', 'gpt-5.5', 'high');

    expect(useConfigStore.getState().getAgentModelSelection('build')).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5.5',
      variant: 'high',
    });
    expect(useConfigStore.getState().directoryScoped[DIRECTORY]?.agentModelSelections.build).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5.5',
      variant: 'high',
    });
  });

  test('loadAgents does not fetch OpenCode config directly', async () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5')],
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('openai', 'gpt-5.5')],
          agents: [],
          currentProviderId: 'openai',
          currentModelId: 'gpt-5.5',
          currentAgentName: undefined,
          selectedProviderId: 'openai',
          agentModelSelections: {},
          defaultProviders: {},
          selectionSource: 'auto',
        },
      },
    });
    liveAgents = [testAgent('build')];

    await useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:noConfigFetch' });

    expect(listAgentsCalls).toBe(1);
    expect(getConfigCalls).toBe(0);
  });

  test('重复的跨目录 loadAgents 共享 settings bootstrap Query', async () => {
    liveAgents = [testAgent('build')];

    await useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:settingsBootstrapA' });
    await useConfigStore.getState().loadAgents({ directory: OTHER_DIRECTORY, source: 'test:settingsBootstrapB' });

    expect(listAgentsCalls).toBe(2);
    expect(settingsBootstrapCalls).toBe(1);
  });

  test('settings bootstrap 失败时保留当前 Store 默认值', async () => {
    settingsBootstrapStatus = 503;
    liveAgents = [testAgent('build')];
    useConfigStore.setState({
      providers: [provider('openai', 'gpt-5.5', { high: {} })],
      settingsDefaultModel: 'openai/gpt-5.5',
      settingsDefaultVariant: 'high',
      settingsDefaultAgent: 'build',
      settingsAutoCreateWorktree: true,
      settingsGitmojiEnabled: true,
      settingsDefaultFileViewerPreview: true,
    });

    await useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:settingsBootstrapFailure' });

    const state = useConfigStore.getState();
    expect(state.settingsDefaultModel).toBe('openai/gpt-5.5');
    expect(state.settingsDefaultVariant).toBe('high');
    expect(state.settingsDefaultAgent).toBe('build');
    expect(state.settingsAutoCreateWorktree).toBe(true);
    expect(state.settingsGitmojiEnabled).toBe(true);
    expect(state.settingsDefaultFileViewerPreview).toBe(true);
  });

  test('manual selection survives an in-flight loadAgents refresh', async () => {
    const pendingAgents = deferred<TestAgent[]>();
    listAgentsImpl = async () => pendingAgents.promise;
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('manual'), provider('default')],
      agents: [testAgent('build')],
      currentProviderId: 'default',
      currentModelId: 'default-model',
      currentAgentName: 'build',
      selectedProviderId: 'default',
      selectionSource: 'auto',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('manual'), provider('default')],
          agents: [testAgent('build')],
          currentProviderId: 'default',
          currentModelId: 'default-model',
          currentAgentName: 'build',
          selectedProviderId: 'default',
          agentModelSelections: {},
          defaultProviders: {},
          selectionSource: 'auto',
        },
      },
    });

    const load = useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:manualRace' });
    useConfigStore.setState((state) => ({
      currentProviderId: 'manual',
      currentModelId: 'manual-model',
      currentAgentName: 'manual-agent',
      selectedProviderId: 'manual',
      selectionSource: 'manual',
      directoryScoped: {
        ...state.directoryScoped,
        [DIRECTORY]: {
          ...state.directoryScoped[DIRECTORY],
          currentProviderId: 'manual',
          currentModelId: 'manual-model',
          currentAgentName: 'manual-agent',
          selectedProviderId: 'manual',
          selectionSource: 'manual',
        },
      },
    }));
    pendingAgents.resolve([
      testAgent('build', { model: { providerID: 'default', modelID: 'default-model' } }),
      testAgent('manual-agent'),
    ]);
    await load;

    const state = useConfigStore.getState();
    expect(state.currentAgentName).toBe('manual-agent');
    expect(state.currentProviderId).toBe('manual');
    expect(state.currentModelId).toBe('manual-model');
    expect(state.selectionSource).toBe('manual');
  });

  test('worktree sync config applies to the project-scoped snapshot', () => {
    const worktree = '/workspace/project-worktree';
    storage.set('oc.worktreeProjectMap', JSON.stringify({ [worktree]: DIRECTORY }));
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5')],
      agents: [testAgent('build'), testAgent('review')],
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentAgentName: 'build',
      selectedProviderId: 'openai',
      selectionSource: 'auto',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('openai', 'gpt-5.5')],
          agents: [testAgent('build'), testAgent('review')],
          currentProviderId: 'openai',
          currentModelId: 'gpt-5.5',
          currentAgentName: 'build',
          selectedProviderId: 'openai',
          agentModelSelections: {},
          defaultProviders: {},
          selectionSource: 'auto',
        },
      },
    });

    emitSyncConfigChanged(worktree, { default_agent: 'review', model: 'openai/gpt-5.5' });

    const state = useConfigStore.getState();
    expect(state.directoryScoped[DIRECTORY]?.opencodeDefaultAgent).toBe('review');
    expect(state.directoryScoped[worktree]).toBe(undefined);
    expect(state.currentAgentName).toBe('review');
  });

  test('sync config defaults do not close the add-provider settings flow', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5'), provider('anthropic', 'claude')],
      agents: [
        testAgent('build', { model: { providerID: 'anthropic', modelID: 'claude' } }),
        testAgent('review', { model: { providerID: 'openai', modelID: 'gpt-5.5' } }),
      ],
      currentProviderId: 'anthropic',
      currentModelId: 'claude',
      currentAgentName: 'build',
      selectedProviderId: '__add_provider__',
      selectionSource: 'auto',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('openai', 'gpt-5.5'), provider('anthropic', 'claude')],
          agents: [
            testAgent('build', { model: { providerID: 'anthropic', modelID: 'claude' } }),
            testAgent('review', { model: { providerID: 'openai', modelID: 'gpt-5.5' } }),
          ],
          currentProviderId: 'anthropic',
          currentModelId: 'claude',
          currentAgentName: 'build',
          selectedProviderId: '__add_provider__',
          agentModelSelections: {},
          defaultProviders: {},
          selectionSource: 'auto',
        },
      },
    });

    emitSyncConfigChanged(DIRECTORY, { default_agent: 'review', model: 'openai/gpt-5.5' });

    const state = useConfigStore.getState();
    expect(state.currentAgentName).toBe('review');
    expect(state.currentProviderId).toBe('openai');
    expect(state.currentModelId).toBe('gpt-5.5');
    expect(state.selectedProviderId).toBe('__add_provider__');
    expect(state.directoryScoped[DIRECTORY]?.selectedProviderId).toBe('__add_provider__');
  });

  test('duplicate sync config event is a no-op when defaults and selection are unchanged', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5')],
      agents: [testAgent('build'), testAgent('review')],
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentAgentName: 'review',
      selectedProviderId: 'openai',
      opencodeDefaultAgent: 'review',
      opencodeDefaultModel: 'openai/gpt-5.5',
      selectionSource: 'auto',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('openai', 'gpt-5.5')],
          agents: [testAgent('build'), testAgent('review')],
          currentProviderId: 'openai',
          currentModelId: 'gpt-5.5',
          currentAgentName: 'review',
          selectedProviderId: 'openai',
          agentModelSelections: {},
          defaultProviders: {},
          opencodeDefaultAgent: 'review',
          opencodeDefaultModel: 'openai/gpt-5.5',
          selectionSource: 'auto',
        },
      },
    });

    let updates = 0;
    const unsubscribe = useConfigStore.subscribe(() => {
      updates += 1;
    });
    emitSyncConfigChanged(DIRECTORY, { default_agent: 'review', model: 'openai/gpt-5.5' });
    unsubscribe();

    expect(updates).toBe(0);
  });

  test('project loadAgents preserves defaults previously applied from a worktree config event', async () => {
    const worktree = '/workspace/project-worktree';
    storage.set('oc.worktreeProjectMap', JSON.stringify({ [worktree]: DIRECTORY }));
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5')],
      agents: [testAgent('build'), testAgent('review')],
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentAgentName: 'build',
      selectedProviderId: 'openai',
      selectionSource: 'auto',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('openai', 'gpt-5.5')],
          agents: [testAgent('build'), testAgent('review')],
          currentProviderId: 'openai',
          currentModelId: 'gpt-5.5',
          currentAgentName: 'build',
          selectedProviderId: 'openai',
          agentModelSelections: {},
          defaultProviders: {},
          selectionSource: 'auto',
        },
      },
    });
    liveAgents = [testAgent('build'), testAgent('review')];

    emitSyncConfigChanged(worktree, { default_agent: 'review', model: 'openai/gpt-5.5' });
    await useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:preserveWorktreeDefaults' });

    const state = useConfigStore.getState();
    expect(state.directoryScoped[DIRECTORY]?.opencodeDefaultAgent).toBe('review');
    expect(state.directoryScoped[DIRECTORY]?.opencodeDefaultModel).toBe('openai/gpt-5.5');
    expect(state.opencodeDefaultAgent).toBe('review');
    expect(state.opencodeDefaultModel).toBe('openai/gpt-5.5');
  });

  test('in-flight loadAgents does not restore defaults cleared by a sync config event', async () => {
    const pendingAgents = deferred<TestAgent[]>();
    listAgentsImpl = async () => pendingAgents.promise;
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5')],
      agents: [testAgent('build'), testAgent('review')],
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentAgentName: 'review',
      selectedProviderId: 'openai',
      selectionSource: 'auto',
      opencodeDefaultAgent: 'review',
      opencodeDefaultModel: 'openai/gpt-5.5',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('openai', 'gpt-5.5')],
          agents: [testAgent('build'), testAgent('review')],
          currentProviderId: 'openai',
          currentModelId: 'gpt-5.5',
          currentAgentName: 'review',
          selectedProviderId: 'openai',
          agentModelSelections: {},
          defaultProviders: {},
          opencodeDefaultAgent: 'review',
          opencodeDefaultModel: 'openai/gpt-5.5',
          selectionSource: 'auto',
        },
      },
    });

    const load = useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:staleDefaultsRace' });
    emitSyncConfigChanged(DIRECTORY, {});
    pendingAgents.resolve([testAgent('build'), testAgent('review')]);
    await load;

    const state = useConfigStore.getState();
    expect(state.opencodeDefaultAgent).toBe(undefined);
    expect(state.opencodeDefaultModel).toBe(undefined);
    expect(state.directoryScoped[DIRECTORY]?.opencodeDefaultAgent).toBe(undefined);
    expect(state.directoryScoped[DIRECTORY]?.opencodeDefaultModel).toBe(undefined);
  });

  test('in-flight loadAgents does not restore pre-await sync config defaults after a clearing event', async () => {
    const pendingAgents = deferred<TestAgent[]>();
    const syncConfigs = new Map<string, Record<string, unknown>>([
      [DIRECTORY, { default_agent: 'review', model: 'openai/gpt-5.5' }],
    ]);
    setSyncRefs(
      {} as never,
      {
        children: new Map(),
        getState: (directory: string) => ({ config: syncConfigs.get(directory) ?? {} }),
      } as never,
      DIRECTORY,
    );
    listAgentsImpl = async () => pendingAgents.promise;
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5')],
      agents: [testAgent('build'), testAgent('review')],
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentAgentName: 'review',
      selectedProviderId: 'openai',
      selectionSource: 'auto',
      opencodeDefaultAgent: 'review',
      opencodeDefaultModel: 'openai/gpt-5.5',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('openai', 'gpt-5.5')],
          agents: [testAgent('build'), testAgent('review')],
          currentProviderId: 'openai',
          currentModelId: 'gpt-5.5',
          currentAgentName: 'review',
          selectedProviderId: 'openai',
          agentModelSelections: {},
          defaultProviders: {},
          opencodeDefaultAgent: 'review',
          opencodeDefaultModel: 'openai/gpt-5.5',
          selectionSource: 'auto',
        },
      },
    });

    const load = useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:preAwaitSyncConfigRace' });
    syncConfigs.set(DIRECTORY, {});
    emitSyncConfigChanged(DIRECTORY, {});
    pendingAgents.resolve([testAgent('build'), testAgent('review')]);
    await load;

    const state = useConfigStore.getState();
    expect(state.opencodeDefaultAgent).toBe(undefined);
    expect(state.opencodeDefaultModel).toBe(undefined);
    expect(state.directoryScoped[DIRECTORY]?.opencodeDefaultAgent).toBe(undefined);
    expect(state.directoryScoped[DIRECTORY]?.opencodeDefaultModel).toBe(undefined);
  });

  test('directory activation isolates selection source and OpenCode defaults', async () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      selectionSource: 'manual',
      opencodeDefaultAgent: 'active-default',
      opencodeDefaultModel: 'active/model',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('active')],
          agents: [testAgent('active-agent')],
          currentProviderId: 'active',
          currentModelId: 'active-model',
          currentAgentName: 'active-agent',
          selectedProviderId: 'active',
          agentModelSelections: {},
          defaultProviders: {},
          opencodeDefaultAgent: 'active-default',
          opencodeDefaultModel: 'active/model',
          selectionSource: 'manual',
        },
        [OTHER_DIRECTORY]: {
          providers: [provider('other')],
          agents: [testAgent('other-agent')],
          currentProviderId: 'other',
          currentModelId: 'other-model',
          currentAgentName: 'other-agent',
          selectedProviderId: 'other',
          agentModelSelections: {},
          defaultProviders: {},
          opencodeDefaultAgent: 'other-default',
          opencodeDefaultModel: 'other/model',
          selectionSource: 'auto',
        },
      },
      isConnected: false,
    });

    await useConfigStore.getState().activateDirectory(OTHER_DIRECTORY);

    const state = useConfigStore.getState();
    expect(state.activeDirectoryKey).toBe(OTHER_DIRECTORY);
    expect(state.selectionSource).toBe('auto');
    expect(state.opencodeDefaultAgent).toBe('other-default');
    expect(state.opencodeDefaultModel).toBe('other/model');
  });

  test('directory activation exposes uncached provider and agent loading independently', async () => {
    const pendingProviders = deferred<{ providers: ReturnType<typeof providerResponse>[]; default: Record<string, string> }>();
    const pendingAgents = deferred<TestAgent[]>();
    getProvidersForConfigImpl = () => pendingProviders.promise;
    listAgentsImpl = () => pendingAgents.promise;

    const activation = useConfigStore.getState().activateDirectory(OTHER_DIRECTORY);

    expect(useConfigStore.getState().providerConfigLoadingByDirectory[OTHER_DIRECTORY]).toBe(true);
    expect(useConfigStore.getState().agentConfigLoadingByDirectory[OTHER_DIRECTORY]).toBe(true);

    const providerLoad = useConfigStore.getState().loadProviders({
      directory: OTHER_DIRECTORY,
      source: 'test:joinProviderLoad',
    });
    pendingProviders.resolve({ providers: [providerResponse('other')], default: {} });
    await providerLoad;

    expect(useConfigStore.getState().providerConfigLoadingByDirectory[OTHER_DIRECTORY]).toBe(false);
    expect(useConfigStore.getState().agentConfigLoadingByDirectory[OTHER_DIRECTORY]).toBe(true);

    const agentLoad = useConfigStore.getState().loadAgents({
      directory: OTHER_DIRECTORY,
      source: 'test:joinAgentLoad',
    });
    pendingAgents.resolve([testAgent('build')]);
    await Promise.all([agentLoad, activation]);

    expect(useConfigStore.getState().agentConfigLoadingByDirectory[OTHER_DIRECTORY]).toBe(false);
  });

  test('directory activation keeps cached provider and agent controls ready during refresh', async () => {
    const pendingProviders = deferred<{ providers: ReturnType<typeof providerResponse>[]; default: Record<string, string> }>();
    const pendingAgents = deferred<TestAgent[]>();
    getProvidersForConfigImpl = () => pendingProviders.promise;
    listAgentsImpl = () => pendingAgents.promise;
    useConfigStore.setState({
      directoryScoped: {
        [OTHER_DIRECTORY]: {
          providers: [provider('cached')],
          agents: [testAgent('build')],
          currentProviderId: 'cached',
          currentModelId: 'cached-model',
          currentAgentName: 'build',
          selectedProviderId: 'cached',
          agentModelSelections: {},
          defaultProviders: {},
        },
      },
    });

    await useConfigStore.getState().activateDirectory(OTHER_DIRECTORY);

    expect(useConfigStore.getState().providerConfigLoadingByDirectory[OTHER_DIRECTORY]).toBe(false);
    expect(useConfigStore.getState().agentConfigLoadingByDirectory[OTHER_DIRECTORY]).toBe(false);

    pendingProviders.resolve({ providers: [providerResponse('fresh')], default: {} });
    pendingAgents.resolve([testAgent('review')]);
  });

  test('stale provider completion cannot revive catalog or loading after an A to B runtime switch', async () => {
    const pendingProviders = deferred<{ providers: ReturnType<typeof providerResponse>[]; default: Record<string, string> }>();
    getProvidersForConfigImpl = () => pendingProviders.promise;
    useConfigStore.setState({ catalogTransportIdentity: 'test-runtime', activeDirectoryKey: DIRECTORY, providers: [], directoryScoped: {} });
    const load = useConfigStore.getState().loadProviders({ directory: DIRECTORY, source: 'test:staleProvider' });
    expect(useConfigStore.getState().providerConfigLoadingByDirectory[DIRECTORY]).toBe(true);

    runtimeIdentity = 'runtime-b';
    runtimeGeneration += 1;
    useConfigStore.setState({ catalogTransportIdentity: 'runtime-b', providers: [provider('runtime-b')], directoryScoped: {}, providerConfigLoadingByDirectory: {} });
    pendingProviders.resolve({ providers: [providerResponse('runtime-a')], default: { default: 'runtime-a' } });
    await load;

    expect(useConfigStore.getState().providers.map((entry) => entry.id)).toEqual(['runtime-b']);
    expect(useConfigStore.getState().providerConfigLoadingByDirectory).toEqual({});
  });

  test('stale agent resolve and rejection stay silent through an A to B to A generation sequence', async () => {
    const pendingAgents = deferred<TestAgent[]>();
    listAgentsImpl = () => pendingAgents.promise;
    useConfigStore.setState({ catalogTransportIdentity: 'test-runtime', activeDirectoryKey: DIRECTORY, agents: [], directoryScoped: {}, agentConfigLoadingByDirectory: {} });
    const resolveLoad = useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:staleAgentResolve' });

    runtimeIdentity = 'runtime-b';
    runtimeGeneration += 1;
    runtimeIdentity = 'test-runtime';
    runtimeGeneration += 1;
    useConfigStore.setState({ catalogTransportIdentity: 'test-runtime', agents: [testAgent('current')], directoryScoped: {}, agentConfigLoadingByDirectory: {} });
    pendingAgents.resolve([testAgent('stale')]);
    await resolveLoad;
    expect(useConfigStore.getState().agents.map((agent) => agent.name)).toEqual(['current']);
    expect(useConfigStore.getState().agentConfigLoadingByDirectory).toEqual({});

    listAgentsImpl = async () => { throw new Error('stale failure'); };
    let errorCalls = 0;
    const originalError = console.error;
    console.error = () => { errorCalls += 1; };
    const rejectLoad = useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:staleAgentReject' });
    runtimeGeneration += 1;
    await rejectLoad;
    console.error = originalError;
    expect(errorCalls).toBe(0);
    expect(useConfigStore.getState().agents.map((agent) => agent.name)).toEqual(['current']);
  });

  test('sync config without defaults clears stored OpenCode defaults without changing manual selection', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('manual')],
      agents: [testAgent('manual-agent')],
      currentProviderId: 'manual',
      currentModelId: 'manual-model',
      currentAgentName: 'manual-agent',
      selectedProviderId: 'manual',
      selectionSource: 'manual',
      opencodeDefaultAgent: 'old-agent',
      opencodeDefaultModel: 'old/model',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('manual')],
          agents: [testAgent('manual-agent')],
          currentProviderId: 'manual',
          currentModelId: 'manual-model',
          currentAgentName: 'manual-agent',
          selectedProviderId: 'manual',
          agentModelSelections: {},
          defaultProviders: {},
          opencodeDefaultAgent: 'old-agent',
          opencodeDefaultModel: 'old/model',
          selectionSource: 'manual',
        },
      },
    });

    emitSyncConfigChanged(DIRECTORY, {});

    const state = useConfigStore.getState();
    expect(state.opencodeDefaultAgent).toBe(undefined);
    expect(state.opencodeDefaultModel).toBe(undefined);
    expect(state.directoryScoped[DIRECTORY]?.opencodeDefaultAgent).toBe(undefined);
    expect(state.directoryScoped[DIRECTORY]?.opencodeDefaultModel).toBe(undefined);
    expect(state.currentAgentName).toBe('manual-agent');
    expect(state.currentProviderId).toBe('manual');
    expect(state.selectionSource).toBe('manual');
  });
});
