import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryObserver } from '@tanstack/react-query';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), generation: 1, transport: 'runtime-a' }));
vi.mock('./runtime-fetch', () => ({ runtimeFetch: mocks.fetch }));
vi.mock('./runtime-switch', () => ({
  getRuntimeGeneration: () => mocks.generation,
  getRuntimeTransportIdentity: () => mocks.transport,
  subscribeRuntimeEndpointChanged: () => () => {},
}));
import { queryClient } from './queryRuntime';
import { ensureQuestionAutoDelegate, getQuestionAutoDelegateSnapshot, mergeQuestionDelegateData, mutateQuestionAutoDelegate, questionAutoDelegateQueryOptions, refreshQuestionAutoDelegate, type QuestionDelegateData } from './questionAutoDelegate';

function data(epoch = 'epoch-a', revision = 1, sequence = 1): QuestionDelegateData {
  return { receivedAt: 0, sequence, retiredEpochs: [], snapshot: {
    epoch, revision, enabled: true, delayMs: 30000, serverNow: 1000,
    coverage: { state: 'ready', failedDirectories: [] }, requests: [],
  } };
}
beforeEach(() => { mocks.fetch.mockReset(); mocks.generation = 1; mocks.transport = 'runtime-a'; });
afterEach(() => { queryClient.clear(); });

describe('question auto-delegate authoritative query', () => {
  test('rejects older revisions and retired epochs, including late high revisions', () => {
    const first = data('a', 8, 5);
    expect(mergeQuestionDelegateData(first, data('a', 7, 6))).toBe(first);
    const restarted = mergeQuestionDelegateData(first, data('b', 1, 6));
    expect(restarted.snapshot.epoch).toBe('b');
    expect(mergeQuestionDelegateData(restarted, data('a', 99, 7))).toBe(restarted);
    expect(mergeQuestionDelegateData(restarted, data('c', 1, 4))).toBe(restarted);
  });
  test('cold consumers share GET and forward cancellation; failed refresh keeps the snapshot', async () => {
    mocks.fetch.mockResolvedValue(Response.json(data().snapshot));
    await Promise.all([ensureQuestionAutoDelegate(), ensureQuestionAutoDelegate()]);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    const before = getQuestionAutoDelegateSnapshot();
    mocks.fetch.mockResolvedValue(new Response('', { status: 503 }));
    await expect(queryClient.fetchQuery({ ...questionAutoDelegateQueryOptions(), staleTime: 0, retry: false })).rejects.toThrow();
    expect(getQuestionAutoDelegateSnapshot()).toBe(before);
    expect(queryClient.getQueryState(questionAutoDelegateQueryOptions().queryKey)?.status).toBe('error');
  });
  test('mutation carries real identity and applies a 409 claimed snapshot', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ outcome: 'claimed', snapshot: data('a', 3).snapshot }, { status: 409 }));
    expect(await mutateQuestionAutoDelegate('pause', { requestID: 'q/1', sessionID: 'child', directory: '/child-project' }, 'interaction')).toBe('claimed');
    expect(mocks.fetch.mock.calls[0][0]).toBe('/api/question-auto-delegate/requests/q%2F1/pause');
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({ sessionID: 'child', directory: '/child-project', reason: 'interaction' });
    expect(getQuestionAutoDelegateSnapshot()?.snapshot.revision).toBe(3);
  });
  test('runtime switch rejects late mutation and GET results', async () => {
    let resolve!: (response: Response) => void;
    mocks.fetch.mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
    const pending = mutateQuestionAutoDelegate('delegate', { requestID: 'q', sessionID: 'child', directory: '/child' });
    mocks.generation++;
    mocks.transport = 'runtime-b';
    resolve(Response.json({ outcome: 'submitted', snapshot: data().snapshot }));
    await expect(pending).rejects.toThrow('Runtime changed');
    expect(getQuestionAutoDelegateSnapshot()).toBeUndefined();
    const options = questionAutoDelegateQueryOptions();
    const get = queryClient.fetchQuery({ ...options, retry: false });
    mocks.generation++;
    resolve(Response.json(data().snapshot));
    await expect(get).rejects.toThrow('Runtime changed');
    expect(getQuestionAutoDelegateSnapshot()).toBeUndefined();
  });
  test('malformed successful payload remains a failed read', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ requests: [] }));
    await expect(queryClient.fetchQuery({ ...questionAutoDelegateQueryOptions(), retry: false })).rejects.toThrow();
    expect(getQuestionAutoDelegateSnapshot()).toBeUndefined();
  });
  test('tip cancels a cold GET before fetching authority, and cancellation preserves mutation data', async () => {
    let reads = 0;
    const signals: AbortSignal[] = [];
    mocks.fetch.mockImplementation((_path: string, init: RequestInit) => {
      if (init.method === 'POST') return Promise.resolve(Response.json({ outcome: 'paused', snapshot: data('a', 3).snapshot }));
      reads++;
      signals.push(init.signal as AbortSignal);
      if (reads === 1 || reads === 3) return new Promise(() => {});
      return Promise.resolve(Response.json(data('a', reads === 2 ? 2 : 3).snapshot));
    });
    const observer = new QueryObserver(queryClient, questionAutoDelegateQueryOptions());
    const unsubscribe = observer.subscribe(() => {});
    await refreshQuestionAutoDelegate();
    expect(signals[0].aborted).toBe(true);
    expect(getQuestionAutoDelegateSnapshot()?.snapshot.revision).toBe(2);
    void observer.refetch();
    await mutateQuestionAutoDelegate('pause', { requestID: 'q', sessionID: 'child', directory: '/child' }, 'user');
    expect(getQuestionAutoDelegateSnapshot()?.snapshot.revision).toBe(3);
    expect(signals[2].aborted).toBe(true);
    unsubscribe(); observer.destroy();
  });
});
