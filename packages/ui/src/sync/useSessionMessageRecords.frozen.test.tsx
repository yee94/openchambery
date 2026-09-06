/**
 * Mounted useSessionMessageRecords freeze/scope tests.
 * Real createRoot + useSyncExternalStore — not pure helper unit tests.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Message } from '@opencode-ai/sdk/v2/client';

import { ChildStoreManager } from './child-store';
import {
  bindTranscriptRepositoryInstance,
  unbindTranscriptRepository,
  getTranscriptRepositoryBindingRevision,
} from './transcript-repository-runtime';
import {
  createStoreTranscriptRepository,
  type TranscriptStoreSurface,
} from './transcript-repository-store-adapter';
import { useSessionMessageRecords } from './sync-context';
import { resetObserveEnsureGate } from './transcript-repository-observers';
import {
  getRuntimeGeneration,
  switchRuntimeEndpoint,
} from '@/lib/runtime-switch';
import type { TranscriptChangeListener, TranscriptRepository } from './transcript-repository';
import type { SessionHistoryBoundary } from './types';
import { UNKNOWN_SESSION_HISTORY_BOUNDARY } from './types';

const SYNC_CONTEXT_GLOBAL_KEY = '__openchamber_sync_context__';

type SyncSystem = {
  childStores: ChildStoreManager;
  sdk: unknown;
  directory: string;
};

function getSyncContext(): React.Context<SyncSystem | null> {
  const ctx = (globalThis as Record<string, unknown>)[SYNC_CONTEXT_GLOBAL_KEY] as
    | React.Context<SyncSystem | null>
    | undefined;
  if (!ctx) throw new Error('SyncContext global missing — import sync-context first');
  return ctx;
}

function message(id: string, sessionID: string): Message {
  return {
    id,
    sessionID,
    role: 'user',
    time: { created: 1 },
  } as Message;
}

type HarnessState = {
  message: Record<string, Message[]>;
  part: Record<string, unknown[]>;
  session_history_boundary: Record<string, SessionHistoryBoundary>;
};

function createHarnessStore(initial?: Partial<HarnessState>): TranscriptStoreSurface {
  let state: HarnessState = {
    message: {},
    part: {},
    session_history_boundary: {},
    ...initial,
  };
  const listeners = new Set<(next: HarnessState, prev: HarnessState) => void>();
  return {
    getState: () => state as ReturnType<TranscriptStoreSurface['getState']>,
    setState: (partial) => {
      const prev = state;
      const nextPartial = typeof partial === 'function'
        ? partial(state as ReturnType<TranscriptStoreSurface['getState']>)
        : partial;
      state = { ...state, ...nextPartial } as HarnessState;
      for (const listener of listeners) {
        listener(state, prev);
      }
    },
    subscribe: (listener) => {
      const wrapped = (next: HarnessState, prev: HarnessState) => {
        listener(
          next as ReturnType<TranscriptStoreSurface['getState']>,
          prev as ReturnType<TranscriptStoreSurface['getState']>,
        );
      };
      listeners.add(wrapped);
      return () => {
        listeners.delete(wrapped);
      };
    },
  };
}

type InstrumentedRepo = {
  repository: TranscriptRepository;
  contentSubscribeCount: () => number;
  wrapBindingClone: () => TranscriptRepository;
};

function instrumentRepository(base: TranscriptRepository): InstrumentedRepo {
  let contentSubscribeCount = 0;
  const repository: TranscriptRepository = {
    ...base,
    subscribe: (scope, listener: TranscriptChangeListener) => {
      contentSubscribeCount += 1;
      const unsub = base.subscribe(scope, listener);
      return () => {
        contentSubscribeCount -= 1;
        unsub();
      };
    },
  };
  return {
    repository,
    contentSubscribeCount: () => contentSubscribeCount,
    wrapBindingClone: () => ({
      ...repository,
      // New object identity forces binding revision bump on re-bind.
      getTranscript: (scope) => repository.getTranscript(scope),
    }),
  };
}

type ProbeProps = {
  sessionID: string;
  directory: string;
  enabled: boolean;
  onList: (ids: string[]) => void;
};

function Probe({ sessionID, directory, enabled, onList }: ProbeProps) {
  const list = useSessionMessageRecords(sessionID, directory, { enabled });
  onList(list.map((entry) => entry.info.id));
  return <span data-ids={list.map((entry) => entry.info.id).join(',')} />;
}

describe('useSessionMessageRecords frozen scope (mounted)', () => {
  let root: Root;
  let container: HTMLDivElement;
  let childStores: ChildStoreManager;
  let storesByDir: Map<string, TranscriptStoreSurface>;
  let instrumented: InstrumentedRepo;
  let latestIds: string[] = [];

  const DIR_A = '/workspace-a';
  const DIR_B = '/workspace-b';
  const SESSION = 'ses_shared';

  const seed = (directory: string, sessionID: string, ids: string[]) => {
    const store = storesByDir.get(directory);
    if (!store) throw new Error(`missing store ${directory}`);
    store.setState({
      message: {
        ...store.getState().message,
        [sessionID]: ids.map((id) => message(id, sessionID)),
      },
      session_history_boundary: {
        ...store.getState().session_history_boundary,
        [sessionID]: UNKNOWN_SESSION_HISTORY_BOUNDARY,
      },
    });
  };

  beforeEach(() => {
    resetObserveEnsureGate();
    unbindTranscriptRepository();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    childStores = new ChildStoreManager();
    storesByDir = new Map([
      [DIR_A, createHarnessStore()],
      [DIR_B, createHarnessStore()],
    ]);
    const baseRepo = createStoreTranscriptRepository({
      getStore: (directory) => {
        const existing = storesByDir.get(directory);
        if (existing) return existing;
        const created = createHarnessStore();
        storesByDir.set(directory, created);
        return created;
      },
    });
    instrumented = instrumentRepository(baseRepo);
    bindTranscriptRepositoryInstance(instrumented.repository);
    latestIds = [];

    seed(DIR_A, SESSION, ['a1', 'a2']);
    seed(DIR_B, SESSION, ['b1']);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    unbindTranscriptRepository();
    resetObserveEnsureGate();
    switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost:4096', runtimeKey: 'local-test-restore' });
  });

  const SyncContext = getSyncContext();

  const renderProbe = (props: Omit<ProbeProps, 'onList'>) => {
    const system: SyncSystem = {
      childStores,
      sdk: {},
      directory: props.directory,
    };
    act(() => {
      root.render(
        <SyncContext.Provider value={system}>
          <Probe
            sessionID={props.sessionID}
            directory={props.directory}
            enabled={props.enabled}
            onList={(ids) => {
              latestIds = ids;
            }}
          />
        </SyncContext.Provider>,
      );
    });
  };

  test('active → inactive freezes list; same-scope content events do not update', () => {
    renderProbe({ sessionID: SESSION, directory: DIR_A, enabled: true });
    expect(latestIds).toEqual(['a1', 'a2']);
    expect(instrumented.contentSubscribeCount()).toBeGreaterThan(0);

    renderProbe({ sessionID: SESSION, directory: DIR_A, enabled: false });
    expect(latestIds).toEqual(['a1', 'a2']);
    expect(instrumented.contentSubscribeCount()).toBe(0);

    seed(DIR_A, SESSION, ['a1', 'a2', 'a3']);
    expect(latestIds).toEqual(['a1', 'a2']);
  });

  test('directory change with same session id reseeds while frozen', () => {
    renderProbe({ sessionID: SESSION, directory: DIR_A, enabled: true });
    renderProbe({ sessionID: SESSION, directory: DIR_A, enabled: false });
    expect(latestIds).toEqual(['a1', 'a2']);

    renderProbe({ sessionID: SESSION, directory: DIR_B, enabled: false });
    expect(latestIds).toEqual(['b1']);
  });

  test('session id change while frozen reseeds current scope only', () => {
    const other = 'ses_other';
    seed(DIR_A, other, ['o1']);

    renderProbe({ sessionID: SESSION, directory: DIR_A, enabled: true });
    renderProbe({ sessionID: SESSION, directory: DIR_A, enabled: false });
    expect(latestIds).toEqual(['a1', 'a2']);

    renderProbe({ sessionID: other, directory: DIR_A, enabled: false });
    expect(latestIds).toEqual(['o1']);
  });

  test('empty session id → real session while disabled seeds correctly', () => {
    renderProbe({ sessionID: '', directory: DIR_A, enabled: false });
    expect(latestIds).toEqual([]);

    renderProbe({ sessionID: SESSION, directory: DIR_A, enabled: false });
    expect(latestIds).toEqual(['a1', 'a2']);
  });

  test('binding revision change while frozen reseeds without outer prop churn', () => {
    renderProbe({ sessionID: SESSION, directory: DIR_A, enabled: true });
    renderProbe({ sessionID: SESSION, directory: DIR_A, enabled: false });
    expect(latestIds).toEqual(['a1', 'a2']);

    seed(DIR_A, SESSION, ['rebound']);
    // Content write while frozen must not paint yet.
    expect(latestIds).toEqual(['a1', 'a2']);

    const revBefore = getTranscriptRepositoryBindingRevision();
    act(() => {
      bindTranscriptRepositoryInstance(instrumented.wrapBindingClone());
    });
    expect(getTranscriptRepositoryBindingRevision()).toBeGreaterThan(revBefore);
    // Binding lifecycle notify alone should reseed the frozen scope.
    expect(latestIds).toEqual(['rebound']);
  });

  test('runtime identity change while frozen reseeds current scope', () => {
    renderProbe({ sessionID: SESSION, directory: DIR_A, enabled: true });
    renderProbe({ sessionID: SESSION, directory: DIR_A, enabled: false });
    expect(latestIds).toEqual(['a1', 'a2']);

    seed(DIR_A, SESSION, ['after-runtime']);
    expect(latestIds).toEqual(['a1', 'a2']);

    const genBefore = getRuntimeGeneration();
    act(() => {
      switchRuntimeEndpoint({
        apiBaseUrl: `http://runtime-frozen-${Date.now()}.example.test`,
        runtimeKey: `runtime-frozen-${Date.now()}`,
      });
    });
    expect(getRuntimeGeneration()).toBeGreaterThan(genBefore);
    expect(latestIds).toEqual(['after-runtime']);
  });

  test('resume active restores live authority and content subscription', () => {
    renderProbe({ sessionID: SESSION, directory: DIR_A, enabled: true });
    renderProbe({ sessionID: SESSION, directory: DIR_A, enabled: false });
    expect(instrumented.contentSubscribeCount()).toBe(0);

    act(() => {
      seed(DIR_A, SESSION, ['live-again']);
    });

    renderProbe({ sessionID: SESSION, directory: DIR_A, enabled: true });
    expect(latestIds).toEqual(['live-again']);
    expect(instrumented.contentSubscribeCount()).toBeGreaterThan(0);

    act(() => {
      seed(DIR_A, SESSION, ['live-again', 'stream']);
    });
    expect(latestIds).toEqual(['live-again', 'stream']);
  });

  test('repeated enable toggles return content subscription count to baseline', () => {
    renderProbe({ sessionID: SESSION, directory: DIR_A, enabled: true });
    const baseline = instrumented.contentSubscribeCount();
    expect(baseline).toBeGreaterThan(0);

    for (let i = 0; i < 6; i += 1) {
      renderProbe({ sessionID: SESSION, directory: DIR_A, enabled: false });
      expect(instrumented.contentSubscribeCount()).toBe(0);
      renderProbe({ sessionID: SESSION, directory: DIR_A, enabled: true });
      expect(instrumented.contentSubscribeCount()).toBe(baseline);
    }
  });
});
