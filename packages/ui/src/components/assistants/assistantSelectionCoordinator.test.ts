import { describe, expect, test } from 'bun:test';
import { AssistantSelectionCoordinator, AssistantSelectionStaleError, type AssistantSelectionIdentity } from './assistantSelectionCoordinator';

const identity = (assistantID: string, transportIdentity = 'runtime-a', runtimeGeneration = 1): AssistantSelectionIdentity => ({ assistantID, transportIdentity, runtimeGeneration });

describe('AssistantSelectionCoordinator', () => {
  test('settles old waiters and isolates a replacement identity from an old flight', async () => {
    let releaseOld: (() => void) | undefined;
    const oldFlight = new Promise<void>((resolve) => { releaseOld = resolve; });
    const executed: string[] = [];
    const coordinator = new AssistantSelectionCoordinator(() => {}, () => {});
    coordinator.activate(identity('assistant-a'));
    const old = coordinator.enqueue(identity('assistant-a'), { modelID: 'old' }, async ({ identity: item }) => {
      executed.push(item.assistantID);
      await oldFlight;
    });
    coordinator.activate(identity('assistant-b', 'runtime-b', 2));
    const current = coordinator.enqueue(identity('assistant-b', 'runtime-b', 2), { modelID: 'new' }, async ({ identity: item }) => { executed.push(item.assistantID); });

    await expect(old).rejects.toThrow(AssistantSelectionStaleError);
    await current;
    releaseOld?.();
    await Promise.resolve();
    expect(executed).toEqual(['assistant-a', 'assistant-b']);
  });

  test('rejects a stale flush without changing the authoritative identity', async () => {
    const coordinator = new AssistantSelectionCoordinator(() => {}, () => {});
    const current = identity('assistant-b', 'runtime-b', 2);
    coordinator.activate(current);

    await expect(coordinator.flush(identity('assistant-a'))).rejects.toThrow(AssistantSelectionStaleError);
    await coordinator.enqueue(current, { modelID: 'current' }, async () => {});
  });

  test('rejects a late old enqueue and preserves the new flight', async () => {
    const coordinator = new AssistantSelectionCoordinator(() => {}, () => {});
    const old = identity('assistant-a');
    const current = identity('assistant-b', 'runtime-b', 2);
    coordinator.activate(old);
    coordinator.activate(current);

    await expect(coordinator.enqueue(old, { modelID: 'old' }, async () => {})).rejects.toThrow(AssistantSelectionStaleError);
    await coordinator.enqueue(current, { modelID: 'current' }, async () => {});
  });

  test('rejects the idle submit waiter when an Assistant or runtime switch retires its flight', () => {
    const coordinator = new AssistantSelectionCoordinator(() => {}, () => {});
    const old = identity('assistant-a');
    let error: unknown;
    coordinator.activate(old);
    (coordinator as unknown as { flight: unknown }).flight = {
      identity: old,
      controller: new AbortController(),
      running: true,
      desired: null,
      waiters: [],
      activeWaiters: [],
      idleWaiters: [{ resolve: () => {}, reject: (reason: unknown) => { error = reason; } }],
      retired: false,
    };

    coordinator.activate(identity('assistant-b', 'runtime-b', 2));

    expect(error).toBeInstanceOf(AssistantSelectionStaleError);
  });

  test('coalesces queued selections and settles every waiter', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const selections: string[] = [];
    const coordinator = new AssistantSelectionCoordinator(() => {}, () => {});
    coordinator.activate(identity('assistant-a'));
    const first = coordinator.enqueue(identity('assistant-a'), { modelID: 'first' }, async ({ selection }) => { selections.push(selection.modelID!); await gate; });
    const second = coordinator.enqueue(identity('assistant-a'), { modelID: 'second' }, async ({ selection }) => { selections.push(selection.modelID!); });
    const third = coordinator.enqueue(identity('assistant-a'), { modelID: 'third' }, async ({ selection }) => { selections.push(selection.modelID!); });

    release?.();
    await Promise.all([first, second, third]);
    expect(selections).toEqual(['first', 'third']);
  });

  test('aborts the active flight when a runtime identity activates', async () => {
    let signal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const coordinator = new AssistantSelectionCoordinator(() => {}, () => {});
    coordinator.activate(identity('assistant-a'));
    const pending = coordinator.enqueue(identity('assistant-a'), { modelID: 'model-a' }, async (item) => {
      signal = item.signal;
      await gate;
    });

    await Promise.resolve();
    coordinator.activate(identity('assistant-b', 'runtime-b', 2));

    expect(signal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow(AssistantSelectionStaleError);
    release?.();
  });
});
