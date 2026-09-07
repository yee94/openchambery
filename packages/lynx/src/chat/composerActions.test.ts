import { describe, expect, test } from 'vitest';

import { createLynxComposerActions } from './composerActions';

describe('Lynx composer send/stop/queue', () => {
  test('without runtime never fake-succeeds', async () => {
    const actions = createLynxComposerActions({
      sessionId: 'ses_1',
      model: { providerID: 'anthropic', modelID: 'claude' },
      sessionApi: null,
    });
    expect(await actions.send('hi')).toMatchObject({ status: 'failed', reason: 'no-runtime' });
    expect(await actions.stop()).toMatchObject({ status: 'failed', reason: 'no-runtime' });
    expect(await actions.queue('hi')).toMatchObject({ status: 'failed', reason: 'no-runtime' });
  });

  test('send and stop call official APIs; queue flushes via prompt_async', async () => {
    const calls: string[] = [];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.includes('prompt_async')) {
        return { ok: true, status: 204, json: async () => true };
      }
      if (path.includes('/abort')) {
        return { ok: true, status: 200, json: async () => true };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    let working = false;
    const actions = createLynxComposerActions({
      sessionId: 'ses_1',
      directory: '/repo',
      model: { providerID: 'anthropic', modelID: 'claude' },
      sessionApi: { runtimeFetch },
      sessionIsWorking: () => working,
      createId: () => 'q1',
    });

    expect(await actions.send('hello')).toMatchObject({ status: 'ok' });
    expect(calls.some((c) => c.includes('prompt_async'))).toBe(true);

    working = true;
    expect(await actions.send('follow')).toMatchObject({
      status: 'failed',
      reason: 'busy-steer-required',
    });
    expect(await actions.queue('later')).toMatchObject({ status: 'ok', queuedId: 'q1' });
    expect(actions.getQueue()).toHaveLength(1);

    expect(await actions.flushQueue()).toMatchObject({
      status: 'failed',
      reason: 'busy-steer-required',
    });
    working = false;
    expect(await actions.flushQueue()).toMatchObject({ status: 'ok' });
    expect(actions.getQueue()).toHaveLength(0);

    expect(await actions.stop()).toMatchObject({ status: 'ok', aborted: true });
    expect(calls.some((c) => c.includes('/abort'))).toBe(true);
  });
});

describe('Lynx queue chip remove / sendNow / reorder', () => {
  const make = () => {
    const calls: string[] = [];
    const runtimeFetch = async (path: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.includes('prompt_async')) {
        return { ok: true, status: 204, json: async () => true };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    let working = false;
    let n = 0;
    const actions = createLynxComposerActions({
      sessionId: 'ses_1',
      model: { providerID: 'anthropic', modelID: 'claude' },
      sessionApi: { runtimeFetch },
      sessionIsWorking: () => working,
      createId: () => `q${++n}`,
    });
    return { actions, calls, setWorking: (v: boolean) => { working = v; } };
  };

  test('remove / reorder / sendNow on local queue', async () => {
    const { actions, setWorking } = make();
    expect(await actions.queue('one')).toMatchObject({ status: 'ok', queuedId: 'q1' });
    expect(await actions.queue('two')).toMatchObject({ status: 'ok', queuedId: 'q2' });
    expect(await actions.queue('three')).toMatchObject({ status: 'ok', queuedId: 'q3' });
    expect(actions.reorderQueue('q3', 'q1')).toMatchObject({ status: 'ok' });
    expect(actions.getQueue().map((q) => q.id)).toEqual(['q3', 'q1', 'q2']);
    expect(actions.removeFromQueue('q1')).toMatchObject({ status: 'ok' });
    expect(actions.getQueue().map((q) => q.id)).toEqual(['q3', 'q2']);

    setWorking(true);
    expect(await actions.sendNow('q3')).toMatchObject({ status: 'failed', reason: 'busy-steer-required' });
    setWorking(false);
    expect(await actions.sendNow('q3')).toMatchObject({ status: 'ok' });
    expect(actions.getQueue().map((q) => q.id)).toEqual(['q2']);
  });

  test('chip ops without runtime fail honestly', () => {
    const actions = createLynxComposerActions({
      sessionId: 'ses_1',
      model: { providerID: 'a', modelID: 'b' },
      sessionApi: null,
    });
    expect(actions.removeFromQueue('x')).toMatchObject({ status: 'failed', reason: 'no-runtime' });
    expect(actions.reorderQueue('a', 'b')).toMatchObject({ status: 'failed', reason: 'no-runtime' });
  });
});
