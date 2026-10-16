import { afterEach, describe, expect, it, vi } from 'vitest';
import { completionEvent, createFamilyCompletionGate } from './family-completion-gate.js';

let gate;
afterEach(() => { gate?.dispose(); vi.useRealTimers(); });
const event = (kind, sessionId) => ({ kind, sessionId });
const setup = (overrides = {}) => {
  const state = { active: [], parents: { root: null, child: 'root', nested: 'child', other: null } };
  const onReady = vi.fn(async () => {});
  gate = createFamilyCompletionGate({
    loadActiveSessionIds: async () => state.active,
    loadParent: async id => state.parents[id],
    onReady,
    ...overrides,
  });
  return { state, onReady };
};

describe('family completion authority', () => {
  it('waits for an idle parent and all nested descendants, then emits only the parent once', async () => {
    const { state, onReady } = setup();
    state.active = ['child', 'nested', 'other'];
    await gate.observe(event('complete', 'root'), { id: 'root' });
    expect(onReady).not.toHaveBeenCalled();
    state.active = ['nested', 'other'];
    await gate.observe(event('complete', 'child'), { id: 'child' });
    expect(onReady).not.toHaveBeenCalled();
    state.active = ['other'];
    await gate.observe(event('complete', 'nested'), { id: 'nested' });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady.mock.calls[0][0]).toEqual({ id: 'root' });
    await gate.observe(event('complete', 'root'), { id: 'duplicate' });
    await gate.observe(event('complete', 'nested'), { id: 'duplicate-child' });
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('assistant-step stop never notifies while the parent is still active', async () => {
    const { state, onReady } = setup();
    state.active = ['root'];
    const partStop = { type: 'message.updated', properties: { info: { sessionID: 'root', role: 'assistant', finish: 'stop' } } };
    await gate.observe(completionEvent(partStop), partStop);
    expect(onReady).not.toHaveBeenCalled();
    state.active = [];
    await gate.observe(event('complete', 'root'), { id: 'final' });
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('failed authority defers completion and a bounded retry recovers missed terminal events', async () => {
    vi.useFakeTimers();
    const loadActiveSessionIds = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([]);
    const { onReady } = setup({ loadActiveSessionIds });
    await gate.observe(event('complete', 'root'), { id: 'root' });
    expect(onReady).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(onReady).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(loadActiveSessionIds).toHaveBeenCalledTimes(2);
  });

  it('unknown ancestry is not permission to send a completion', async () => {
    const { state, onReady } = setup();
    state.active = ['missing'];
    await gate.observe(event('complete', 'root'), {});
    expect(onReady).not.toHaveBeenCalled();
  });

  it('a resumed parent cancels the old candidate and only its next settled execution notifies', async () => {
    const { state, onReady } = setup();
    state.active = ['child'];
    await gate.observe(event('complete', 'root'), { id: 'old' });
    state.active = ['root'];
    await gate.observe(event('running', 'root'), {});
    state.active = [];
    await gate.observe(event('complete', 'child'), {});
    expect(onReady).not.toHaveBeenCalled();
    await gate.observe(event('complete', 'root'), { id: 'new' });
    expect(onReady.mock.calls[0][0]).toEqual({ id: 'new' });
    await gate.observe(event('running', 'root'), {});
    await gate.observe(event('complete', 'root'), { id: 'next' });
    expect(onReady).toHaveBeenCalledTimes(2);
  });

  it('live starts fence an older GET before it can announce completion', async () => {
    let resolve;
    const onReady = vi.fn(async () => {});
    const loadActiveSessionIds = vi.fn()
      .mockImplementationOnce(() => new Promise(done => { resolve = done; }))
      .mockResolvedValue(['child']);
    setup({ loadActiveSessionIds, onReady });
    const work = gate.observe(event('complete', 'root'), {});
    void gate.observe(event('running', 'child'), {});
    resolve([]);
    await work;
    expect(onReady).not.toHaveBeenCalled();
  });

  it('a parent failure/cancellation prevents a later child terminal from sending success', async () => {
    const { state, onReady } = setup();
    state.active = ['child'];
    await gate.observe(event('complete', 'root'), {});
    await gate.observe(event('cancel', 'root'), {});
    state.active = [];
    await gate.observe(event('complete', 'child'), {});
    await gate.observe(event('complete', 'root'), {});
    expect(onReady).not.toHaveBeenCalled();
  });

  it('dispose prevents late delivery', async () => {
    let resolve;
    const { onReady } = setup({ loadActiveSessionIds: () => new Promise(done => { resolve = done; }) });
    const work = gate.observe(event('complete', 'root'), {});
    gate.dispose();
    resolve([]);
    await work;
    expect(onReady).not.toHaveBeenCalled();
  });

  it('duplicate terminals during an already committed slow fanout cannot send twice', async () => {
    let finish;
    const onReady = vi.fn(() => new Promise(resolve => { finish = () => resolve(true); }));
    setup({ onReady });
    const first = gate.observe(event('complete', 'root'), { id: 'first' });
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    const duplicate = gate.observe(event('complete', 'root'), { id: 'duplicate' });
    finish();
    await Promise.all([first, duplicate]);
    await gate.observe(event('complete', 'root'), { id: 'later-duplicate' });
    expect(onReady).toHaveBeenCalledTimes(1);
  });
});
