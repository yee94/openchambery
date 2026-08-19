import { describe, expect, test, vi } from 'vitest';

type Component = (props: Record<string, unknown>) => unknown;
type HookRecord = {
  values: unknown[];
  deps: Array<unknown[] | undefined>;
  cleanups: Array<(() => void) | undefined>;
};
type QuerySnapshot = { data?: string; isPending: boolean; isError: boolean };

const harness = vi.hoisted(() => {
  const hookRecords = new Map<unknown, HookRecord>();
  let currentRecord: HookRecord | null = null;
  let hookIndex = 0;
  let pendingEffects: Array<() => void> = [];
  let stateUpdates = 0;
  let pendingDiagramFile: string | null = null;
  let readFile: (path: string) => Promise<{ content: string }> = async () => ({ content: '' });
  let writeFile: (path: string, content: string) => Promise<{ success: boolean }> = async () => ({ success: true });
  let editorXml = '';
  let effectiveDirectory: string | undefined = '/project';
  let transport = 'runtime-a';
  const querySnapshots = new Map<string, QuerySnapshot>();
  const startedQueries = new Set<string>();
  const cacheOperations: string[] = [];
  const toastErrors: string[] = [];

  const queryKey = (scopeDirectory: string | null, path: string | null) => `${transport}:${scopeDirectory}:${path}`;

  const shallowEqualDeps = (left?: unknown[], right?: unknown[]): boolean => (
    Boolean(left && right)
    && left!.length === right!.length
    && left!.every((value, index) => Object.is(value, right![index]))
  );

  const getHookRecord = (): HookRecord => {
    if (!currentRecord) throw new Error('Hooks can only run during a render pass');
    return currentRecord;
  };

  const renderComponent = (component: Component, props: Record<string, unknown> = {}): unknown => {
    const previousRecord = currentRecord;
    const previousHookIndex = hookIndex;
    currentRecord = hookRecords.get(component) ?? { values: [], deps: [], cleanups: [] };
    hookRecords.set(component, currentRecord);
    hookIndex = 0;
    try {
      return component(props);
    } finally {
      currentRecord = previousRecord;
      hookIndex = previousHookIndex;
    }
  };

  function useState<T>(initialValue: T): readonly [T, (value: T) => void] {
    const record = getHookRecord();
    const index = hookIndex++;
    if (record.values[index] === undefined) record.values[index] = initialValue;
    return [record.values[index] as T, (value: T) => {
      stateUpdates += 1;
      record.values[index] = value;
    }] as const;
  }

  function useRef<T>(initialValue: T): { current: T } {
    const record = getHookRecord();
    const index = hookIndex++;
    if (record.values[index] === undefined) record.values[index] = { current: initialValue };
    return record.values[index] as { current: T };
  }

  function useCallback<T>(callback: T, deps: unknown[]): T {
    const record = getHookRecord();
    const index = hookIndex++;
    if (!shallowEqualDeps(record.deps[index], deps)) {
      record.values[index] = callback;
      record.deps[index] = deps;
    }
    return record.values[index] as T;
  }

  function useEffect(effect: () => void | (() => void), deps: unknown[]): void {
    const record = getHookRecord();
    const index = hookIndex++;
    if (!shallowEqualDeps(record.deps[index], deps)) {
      record.deps[index] = deps;
      pendingEffects.push(() => {
        record.cleanups[index] = effect() ?? undefined;
      });
    }
  }

  const jsx = (type: Component | string, props: Record<string, unknown>): unknown => (
    typeof type === 'function' ? renderComponent(type, props) : { type, props }
  );

  const ReactMock = { useState, useRef, useCallback, useEffect };

  const flushEffects = () => {
    const effects = pendingEffects;
    pendingEffects = [];
    effects.forEach((effect) => effect());
  };

  const cleanup = () => {
    for (const record of hookRecords.values()) record.cleanups.forEach((effect) => effect?.());
  };

  const resetHarness = () => {
    hookRecords.clear();
    currentRecord = null;
    hookIndex = 0;
    pendingEffects = [];
    stateUpdates = 0;
    pendingDiagramFile = null;
    readFile = async () => ({ content: '' });
    writeFile = async () => ({ success: true });
    editorXml = '';
    effectiveDirectory = '/project';
    transport = 'runtime-a';
    querySnapshots.clear();
    startedQueries.clear();
    cacheOperations.length = 0;
    toastErrors.length = 0;
  };

  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
      resolve = resolvePromise;
    });
    return { promise, resolve };
  };

  const getEditorXml = (node: unknown): string | undefined => {
    if (!node || typeof node !== 'object') return undefined;
    const element = node as { type?: string; props?: { xml?: string; children?: unknown } };
    if (element.type === 'diagram-editor') return element.props?.xml;
    const children = element.props?.children;
    if (Array.isArray(children)) return children.map(getEditorXml).find((xml) => xml !== undefined);
    return getEditorXml(children);
  };

  const getSaveButton = (node: unknown): { onClick?: () => void } | undefined => {
    if (!node || typeof node !== 'object') return undefined;
    const element = node as { type?: string; props?: { title?: string; onClick?: () => void; children?: unknown } };
    if (element.type === 'button' && element.props?.title === 'filesView.diagram.saveDiagram') return element.props;
    const children = element.props?.children;
    if (Array.isArray(children)) return children.map(getSaveButton).find((button) => button !== undefined);
    return getSaveButton(children);
  };

  return {
    ReactMock,
    jsx,
    renderComponent,
    flushEffects,
    cleanup,
    resetHarness,
    deferred,
    getEditorXml,
    getSaveButton,
    queryKey,
    querySnapshots,
    cacheOperations,
    toastErrors,
    get stateUpdates() { return stateUpdates; },
    set stateUpdates(value: number) { stateUpdates = value; },
    get pendingDiagramFile() { return pendingDiagramFile; },
    set pendingDiagramFile(value: string | null) { pendingDiagramFile = value; },
    get readFile() { return readFile; },
    set readFile(value: (path: string) => Promise<{ content: string }>) { readFile = value; },
    get writeFile() { return writeFile; },
    set writeFile(value: (path: string, content: string) => Promise<{ success: boolean }>) { writeFile = value; },
    get editorXml() { return editorXml; },
    set editorXml(value: string) { editorXml = value; },
    get effectiveDirectory() { return effectiveDirectory; },
    get transport() { return transport; },
    consumePendingDiagramFile: () => {
      const pending = pendingDiagramFile;
      pendingDiagramFile = null;
      return pending;
    },
    startFileQuery: (
      input: { scopeDirectory: string | null; path: string | null },
      options: { enabled?: boolean },
    ): QuerySnapshot => {
      const key = queryKey(input.scopeDirectory, input.path);
      const enabled = Boolean(options.enabled && input.path);
      ReactMock.useEffect(() => {
        if (!enabled || startedQueries.has(key) || !input.path) return;
        startedQueries.add(key);
        void readFile(input.path).then(
          (result) => querySnapshots.set(key, { data: result.content, isPending: false, isError: false }),
          () => querySnapshots.set(key, { isPending: false, isError: true }),
        );
      }, [enabled, key]);
      return querySnapshots.get(key) ?? { isPending: enabled, isError: false };
    },
    recordCacheSet: (key: readonly unknown[], content: string) => {
      cacheOperations.push('set');
      querySnapshots.set(`${key[0]}:${key[3]}:${key[4]}`, { data: content, isPending: false, isError: false });
    },
    recordCacheCancel: () => { cacheOperations.push('cancel'); },
    recordToastError: (message: string) => { toastErrors.push(message); },
  };
});

vi.mock('react', () => ({ __esModule: true, default: harness.ReactMock, ...harness.ReactMock }));
vi.mock('react/jsx-runtime', () => ({ Fragment: Symbol('Fragment'), jsx: harness.jsx, jsxs: harness.jsx, jsxDEV: harness.jsx }));
vi.mock('react/jsx-dev-runtime', () => ({ Fragment: Symbol('Fragment'), jsx: harness.jsx, jsxs: harness.jsx, jsxDEV: harness.jsx }));
vi.mock('@/components/diagram', () => ({
  DiagramEditor: (props: Record<string, unknown>) => {
    const ref = props.ref as { current: { getXml: () => string } | null } | undefined;
    if (ref) ref.current = { getXml: () => harness.editorXml };
    return { type: 'diagram-editor', props };
  },
}));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('sonner', () => ({ toast: { error: (message: string) => harness.recordToastError(message) } }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({ files: { readFile: harness.readFile, writeFile: harness.writeFile } }),
}));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => harness.effectiveDirectory }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => harness.transport }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    cancelQueries: async () => { harness.recordCacheCancel(); },
    setQueryData: (key: readonly unknown[], content: string) => {
      harness.recordCacheSet(key, content);
    },
  }),
}));
vi.mock('@/queries/fileQueries', () => ({
  fileContentQueryKey: (input: { scopeDirectory: string | null; path: string | null }, snapshotTransport: string) => [snapshotTransport, 'files', 'content', input.scopeDirectory, input.path],
  useFileContentQuery: (
    input: { scopeDirectory: string | null; path: string | null },
    options: { enabled?: boolean },
  ): QuerySnapshot => harness.startFileQuery(input, options),
  setFileContentSnapshot: (
    client: { setQueryData: (key: readonly unknown[], content: string) => void },
    input: { scopeDirectory: string | null; path: string | null },
    snapshotTransport: string,
    content: string,
  ) => client.setQueryData([snapshotTransport, 'files', 'content', input.scopeDirectory, input.path], content),
}));
vi.mock('@/stores/useUIStore', () => {
  const store = (selector: (state: { pendingDiagramFile: string | null }) => unknown) => selector({ pendingDiagramFile: harness.pendingDiagramFile });
  store.getState = () => ({
    consumePendingDiagramFile: () => harness.consumePendingDiagramFile(),
    setActiveMainTab: () => undefined,
  });
  return { useUIStore: store };
});

const { DiagramView } = await import('./DiagramView');

const {
  renderComponent,
  flushEffects,
  cleanup,
  resetHarness,
  deferred,
  getEditorXml,
  getSaveButton,
  queryKey,
  querySnapshots,
  cacheOperations,
  toastErrors,
} = harness;

describe('DiagramView file loading', () => {
  test('keeps the latest diagram content when an earlier read resolves last', async () => {
    resetHarness();
    const first = deferred<{ content: string }>();
    const second = deferred<{ content: string }>();
    harness.readFile = (path) => path === '/first.drawio' ? first.promise : second.promise;

    harness.pendingDiagramFile = '/first.drawio';
    renderComponent(DiagramView);
    flushEffects();

    harness.pendingDiagramFile = '/second.drawio';
    renderComponent(DiagramView);
    flushEffects();
    renderComponent(DiagramView);
    flushEffects();

    second.resolve({ content: '<second />' });
    await Promise.resolve();
    await Promise.resolve();
    renderComponent(DiagramView);
    flushEffects();
    expect(getEditorXml(renderComponent(DiagramView))).toBe('<second />');

    first.resolve({ content: '<first />' });
    await Promise.resolve();
    await Promise.resolve();
    renderComponent(DiagramView);
    flushEffects();
    expect(getEditorXml(renderComponent(DiagramView))).toBe('<second />');
  });

  test('avoids state updates after unmount while a read is pending', async () => {
    resetHarness();
    const request = deferred<{ content: string }>();
    harness.readFile = () => request.promise;

    harness.pendingDiagramFile = '/diagram.drawio';
    renderComponent(DiagramView);
    flushEffects();
    harness.stateUpdates = 0;
    cleanup();

    request.resolve({ content: '<diagram />' });
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.stateUpdates).toBe(0);
  });

  test('keeps the active diagram content when a previous file save resolves after switching files', async () => {
    resetHarness();
    const save = deferred<{ success: boolean }>();
    harness.readFile = async (path) => ({ content: path === '/a.drawio' ? '<a />' : '<b />' });
    harness.writeFile = (path) => {
      expect(path).toBe('/a.drawio');
      return save.promise;
    };

    harness.pendingDiagramFile = '/a.drawio';
    renderComponent(DiagramView);
    flushEffects();
    await Promise.resolve();
    await Promise.resolve();
    renderComponent(DiagramView);
    flushEffects();
    harness.editorXml = '<a saved />';
    getSaveButton(renderComponent(DiagramView))?.onClick?.();
    await Promise.resolve();

    harness.pendingDiagramFile = '/b.drawio';
    renderComponent(DiagramView);
    flushEffects();
    renderComponent(DiagramView);
    flushEffects();
    await Promise.resolve();
    await Promise.resolve();
    renderComponent(DiagramView);
    flushEffects();
    expect(getEditorXml(renderComponent(DiagramView))).toBe('<b />');

    save.resolve({ success: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(getEditorXml(renderComponent(DiagramView))).toBe('<b />');
  });

  test('updates the active diagram query snapshot after a successful save', async () => {
    resetHarness();
    harness.readFile = async () => ({ content: '<diagram />' });

    harness.pendingDiagramFile = '/diagram.drawio';
    renderComponent(DiagramView);
    flushEffects();
    renderComponent(DiagramView);
    flushEffects();
    await Promise.resolve();
    renderComponent(DiagramView);
    flushEffects();

    harness.editorXml = '<saved />';
    getSaveButton(renderComponent(DiagramView))?.onClick?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(querySnapshots.get(queryKey('/project', '/diagram.drawio'))?.data).toBe('<saved />');
    expect(cacheOperations).toEqual(['cancel', 'set']);
  });

  test('keeps the query snapshot and editor baseline when saving resolves unsuccessfully', async () => {
    resetHarness();
    harness.readFile = async () => ({ content: '<diagram />' });
    harness.writeFile = async () => ({ success: false });

    harness.pendingDiagramFile = '/diagram.drawio';
    renderComponent(DiagramView);
    flushEffects();
    renderComponent(DiagramView);
    flushEffects();
    await Promise.resolve();
    await Promise.resolve();
    renderComponent(DiagramView);
    flushEffects();

    harness.editorXml = '<unsaved />';
    getSaveButton(renderComponent(DiagramView))?.onClick?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(querySnapshots.get(queryKey('/project', '/diagram.drawio'))?.data).toBe('<diagram />');
    expect(getEditorXml(renderComponent(DiagramView))).toBe('<diagram />');
    expect(cacheOperations).toEqual([]);
    expect(toastErrors).toEqual(['filesView.toast.writeFileFailed']);
  });

  test('keeps the query snapshot and editor baseline when saving throws', async () => {
    resetHarness();
    harness.readFile = async () => ({ content: '<diagram />' });
    harness.writeFile = async () => { throw new Error('write failed'); };

    harness.pendingDiagramFile = '/diagram.drawio';
    renderComponent(DiagramView);
    flushEffects();
    renderComponent(DiagramView);
    flushEffects();
    await Promise.resolve();
    await Promise.resolve();
    renderComponent(DiagramView);
    flushEffects();

    harness.editorXml = '<unsaved />';
    getSaveButton(renderComponent(DiagramView))?.onClick?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(querySnapshots.get(queryKey('/project', '/diagram.drawio'))?.data).toBe('<diagram />');
    expect(getEditorXml(renderComponent(DiagramView))).toBe('<diagram />');
    expect(cacheOperations).toEqual([]);
    expect(toastErrors).toEqual(['write failed']);
  });
});
