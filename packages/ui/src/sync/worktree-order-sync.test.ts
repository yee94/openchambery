import { expect, test } from 'bun:test';
import { MessageQueueServerError, type MessageQueueSnapshot } from '@/lib/message-queue-server';
import { useWorktreeOrderStore } from '@/stores/useWorktreeOrderStore';
import { __worktreeOrderSyncTest, createWorktreeOrderObserver, type WorktreeOrderSyncDependencies } from './worktree-order-sync';

const reset = () => {
  __worktreeOrderSyncTest.cancelIntents();
  useWorktreeOrderStore.setState({
    runtimeIdentity: 'runtime',
    orderByProject: {},
    serverRevisionByProject: {},
    deferredServerOrderByProject: {},
    pendingProjectIDs: {},
    runtimeOrdersByIdentity: { runtime: { orderByProject: {}, pendingProjectIDs: {} } },
  });
};

const snapshot = (worktreeOrders: MessageQueueSnapshot['worktreeOrders'] = []): MessageQueueSnapshot => ({ revision: 1, scopes: [], worktreeOrders });
const dependencies = (overrides: Partial<WorktreeOrderSyncDependencies> = {}): WorktreeOrderSyncDependencies => {
  let id = 0;
  return {
    fetchSnapshot: async () => snapshot(),
    fetchOrder: async (projectDirectory) => ({ projectDirectory, orderedPaths: ['/remote'], revision: 2 }),
    setOrder: async (input) => ({ revision: input.expectedRevision + 1, worktreeOrder: { projectDirectory: input.projectDirectory, orderedPaths: input.orderedPaths, revision: input.expectedRevision + 1 } }),
    waitInvalidation: async () => { throw new MessageQueueServerError(501, 'unavailable'); },
    captureRuntime: () => ({ transportIdentity: 'runtime', generation: 1 }),
    isCurrent: () => true,
    sleep: async () => {},
    createRequestID: () => `request-${++id}`,
    ...overrides,
  };
};

const intent = (paths: string[]) => ({
  projectDirectory: '/project',
  orderedPaths: paths,
  capture: { transportIdentity: 'runtime', generation: 1 },
  controller: new AbortController(),
  backoffMs: 500,
  running: false,
});

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

test('retries transport failures with one request ID and resolves durable pending state', async () => {
  reset();
  useWorktreeOrderStore.setState({ orderByProject: { project: ['/local'] }, pendingProjectIDs: { project: true } });
  const requestIDs: string[] = [];
  let calls = 0;
  __worktreeOrderSyncTest.intents.set('project', intent(['/local']));
  await __worktreeOrderSyncTest.drainIntent('project', dependencies({
    setOrder: async (input) => {
      requestIDs.push(input.requestID);
      calls += 1;
      if (calls === 1) throw new MessageQueueServerError(0, 'unavailable');
      return { revision: 1, worktreeOrder: { projectDirectory: input.projectDirectory, orderedPaths: input.orderedPaths, revision: 1 } };
    },
  }));
  expect(requestIDs).toEqual(['request-1', 'request-1']);
  expect(useWorktreeOrderStore.getState().pendingProjectIDs).toEqual({});
});

test('uses a new request ID after a revision conflict', async () => {
  reset();
  useWorktreeOrderStore.setState({ orderByProject: { project: ['/latest'] }, pendingProjectIDs: { project: true } });
  const requests: Array<{ id: string; revision: number }> = [];
  __worktreeOrderSyncTest.intents.set('project', intent(['/latest']));
  await __worktreeOrderSyncTest.drainIntent('project', dependencies({
    setOrder: async (input) => {
      requests.push({ id: input.requestID, revision: input.expectedRevision });
      if (requests.length === 1) throw new MessageQueueServerError(409, 'revision_conflict');
      return { revision: 3, worktreeOrder: { projectDirectory: input.projectDirectory, orderedPaths: input.orderedPaths, revision: 3 } };
    },
  }));
  expect(requests).toEqual([{ id: 'request-1', revision: 0 }, { id: 'request-2', revision: 2 }]);
  expect(useWorktreeOrderStore.getState().orderByProject.project).toEqual(['/latest']);
});

test('drops stale mutation completion', async () => {
  reset();
  let current = true;
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  __worktreeOrderSyncTest.intents.set('project', intent(['/old']));
  const draining = __worktreeOrderSyncTest.drainIntent('project', dependencies({
    isCurrent: () => current,
    setOrder: async () => { await pending; return { revision: 1 }; },
  }));
  current = false;
  release!();
  await draining;
  expect(useWorktreeOrderStore.getState().serverRevisionByProject).toEqual({});
  expect(__worktreeOrderSyncTest.intents.size).toBe(0);
});

test('keeps a completed mutation when an older long-poll order arrives', async () => {
  reset();
  useWorktreeOrderStore.setState({ orderByProject: { project: ['/local'] }, pendingProjectIDs: { project: true } });
  __worktreeOrderSyncTest.intents.set('project', intent(['/local']));
  await __worktreeOrderSyncTest.drainIntent('project', dependencies({
    setOrder: async (input) => ({ revision: 2, worktreeOrder: { projectDirectory: input.projectDirectory, orderedPaths: input.orderedPaths, revision: 2 } }),
  }));
  __worktreeOrderSyncTest.applyOrders([{ projectDirectory: '/project', orderedPaths: ['/stale'], revision: 1 }], [{ id: 'project', path: '/project' }], { transportIdentity: 'runtime', generation: 1 }, dependencies());
  expect(useWorktreeOrderStore.getState().orderByProject.project).toEqual(['/local']);
  expect(useWorktreeOrderStore.getState().serverRevisionByProject.project).toBe(2);
});

test('observer recovers from a transient fetch and applies cross-device changes', async () => {
  reset();
  let snapshots = 0;
  let waits = 0;
  const observer = createWorktreeOrderObserver(() => [{ id: 'project', path: '/project' }], dependencies({
    waitInvalidation: async () => {
      waits += 1;
      if (waits === 1) return 'tip';
      throw new MessageQueueServerError(501, 'unavailable');
    },
    fetchSnapshot: async () => {
      snapshots += 1;
      if (snapshots === 1) throw new MessageQueueServerError(0, 'unavailable');
      if (snapshots === 2) return snapshot([{ projectDirectory: '/project', orderedPaths: ['/snapshot'], revision: 1 }]);
      return { revision: 2, scopes: [], worktreeOrders: [{ projectDirectory: '/project', orderedPaths: ['/changed'], revision: 2 }] };
    },
  }));
  observer.start();
  await settle();
  observer.stop();
  expect(snapshots).toBe(3);
  expect(useWorktreeOrderStore.getState().orderByProject.project).toEqual(['/changed']);
});

test('observer exits immediately for an explicitly unsupported runtime', async () => {
  reset();
  let sleeps = 0;
  let waits = 0;
  const observer = createWorktreeOrderObserver(() => [], dependencies({
    fetchSnapshot: async () => { throw new MessageQueueServerError(501, 'unavailable'); },
    waitInvalidation: async () => { waits += 1; return 'tip'; },
    sleep: async () => { sleeps += 1; },
  }));
  observer.start();
  await settle();
  observer.stop();
  expect(sleeps).toBe(0);
  expect(waits).toBe(0);
});

test('observer exits immediately for permanent client failures', async () => {
  reset();
  let sleeps = 0;
  let waits = 0;
  const observer = createWorktreeOrderObserver(() => [], dependencies({
    fetchSnapshot: async () => { throw new MessageQueueServerError(400, 'validation_error'); },
    waitInvalidation: async () => { waits += 1; return 'tip'; },
    sleep: async () => { sleeps += 1; },
  }));
  observer.start();
  await settle();
  observer.stop();
  expect(sleeps).toBe(0);
  expect(waits).toBe(0);
});

test('observer marks a local-only order pending before seeding the server', async () => {
  reset();
  useWorktreeOrderStore.setState({
    orderByProject: { project: ['/local'] },
    runtimeOrdersByIdentity: { runtime: { orderByProject: { project: ['/local'] }, pendingProjectIDs: {} } },
  });
  let pendingAtWrite = false;
  const observer = createWorktreeOrderObserver(() => [{ id: 'project', path: '/project' }], dependencies({
    setOrder: async (input) => {
      pendingAtWrite = Boolean(useWorktreeOrderStore.getState().pendingProjectIDs.project);
      return { revision: 1, worktreeOrder: { projectDirectory: input.projectDirectory, orderedPaths: input.orderedPaths, revision: 1 } };
    },
  }));
  observer.start();
  await settle();
  observer.stop();
  expect(pendingAtWrite).toBe(true);
  expect(useWorktreeOrderStore.getState().pendingProjectIDs).toEqual({});
});

test('observer restores a pending empty order after restart', async () => {
  reset();
  useWorktreeOrderStore.setState({
    pendingProjectIDs: { project: true },
    runtimeOrdersByIdentity: { runtime: { orderByProject: {}, pendingProjectIDs: { project: true } } },
  });
  const writes: string[][] = [];
  const observer = createWorktreeOrderObserver(() => [{ id: 'project', path: '/project' }], dependencies({
    setOrder: async (input) => {
      writes.push(input.orderedPaths);
      return { revision: 1, worktreeOrder: { projectDirectory: input.projectDirectory, orderedPaths: input.orderedPaths, revision: 1 } };
    },
  }));
  observer.start();
  await settle();
  observer.stop();
  expect(writes).toEqual([[]]);
  expect(useWorktreeOrderStore.getState().pendingProjectIDs).toEqual({});
});
