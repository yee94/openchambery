import { describe, expect, test } from 'bun:test';
import { AssistantAPIError, type AssistantDTO } from '@/queries/assistantQueries';
import { commitAssistantSelection } from './assistantSelectionBackend';
import { AssistantSelectionCoordinator, AssistantSelectionStaleError, type AssistantSelectionIdentity } from './assistantSelectionCoordinator';

const identity: AssistantSelectionIdentity = { assistantID: 'assistant-a', transportIdentity: 'runtime-a', runtimeGeneration: 1 };
const assistant: AssistantDTO = { id: 'assistant-a', revision: 1, enabled: true, name: 'Assistant', defaultPrompt: '', workspacePath: null, effectiveWorkspacePath: '/workspace', managedWorkspacePath: null, providerID: 'provider-a', modelID: 'model-a', agent: null, variant: null, mode: 'continuous', sessionID: null, sessionGeneration: 1, historySessionIDs: [], historySessionCount: 0, createdAt: null, updatedAt: 1, tombstoneAt: null };

describe('Assistant selection backend', () => {
  test('stops a conflict refresh and retry after a runtime switch without changing the old cache', async () => {
    const oldCache = { assistants: [assistant] };
    let cache = oldCache;
    let authoritative = true;
    let refreshes = 0;
    let updates = 0;

    await expect(commitAssistantSelection(identity, { modelID: 'model-b' }, {
      readSnapshot: () => cache,
      ensureSnapshot: async () => {
        refreshes += 1;
        cache = { assistants: [{ ...assistant, revision: 2 }] };
        return cache;
      },
      updateAssistant: async () => {
        updates += 1;
        authoritative = false;
        throw new AssistantAPIError('revision_conflict', 409);
      },
      assertAuthoritative: () => {
        if (!authoritative) throw new AssistantSelectionStaleError();
      },
      signal: new AbortController().signal,
    })).rejects.toThrow(AssistantSelectionStaleError);

    expect(refreshes).toBe(0);
    expect(updates).toBe(1);
    expect(cache).toBe(oldCache);
  });

  test('aborts a pending conflict refresh on identity activation without retrying or touching the query cache', async () => {
    const coordinator = new AssistantSelectionCoordinator(() => {}, () => {});
    const cache = { assistants: [assistant] };
    const cacheAPICalls = { count: 0 };
    let updates = 0;
    let refreshSignal: AbortSignal | undefined;
    let refreshStarted: (() => void) | undefined;
    const refreshPending = new Promise<void>((resolve) => { refreshStarted = resolve; });
    coordinator.activate(identity);
    const pending = coordinator.enqueue(identity, { modelID: 'model-b' }, async ({ signal }) => {
      await commitAssistantSelection(identity, { modelID: 'model-b' }, {
        readSnapshot: () => cache,
        ensureSnapshot: (snapshotSignal) => new Promise((_, reject) => {
          refreshSignal = snapshotSignal;
          refreshStarted?.();
          snapshotSignal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        }),
        updateAssistant: async () => {
          updates += 1;
          throw new AssistantAPIError('revision_conflict', 409);
        },
        assertAuthoritative: () => coordinator.assertAuthoritative(identity),
        signal,
      });
    });

    await refreshPending;
    coordinator.activate({ ...identity, transportIdentity: 'runtime-b', runtimeGeneration: 2 });

    expect(refreshSignal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow(AssistantSelectionStaleError);
    expect(updates).toBe(1);
    expect(cache).toEqual({ assistants: [assistant] });
    expect(cacheAPICalls.count).toBe(0);
  });
});
