import { afterEach, expect, it, vi } from 'vitest';
import { createQuestionAutoDelegateRuntime } from './runtime.js';
import { QUESTION_AUTO_DELEGATE_ANSWER } from './core.js';

const form = {
  id: 'frm_question', sessionID: 'ses_test', title: 'Choose',
  metadata: { kind: 'question' },
  fields: [{ key: 'approach', type: 'string', custom: true, options: [{ label: 'A', value: 'a' }] }],
};
const runtimes = [];
afterEach(() => {
  runtimes.splice(0).forEach((runtime) => runtime.dispose());
  vi.useRealTimers();
});

const setup = async (pending = []) => {
  vi.useFakeTimers();
  let onEvent;
  const fetchImpl = vi.fn(async (url, options) => {
    const path = url.pathname;
    if (path === '/api/form') return Response.json({ data: pending });
    if (path === '/api/session/ses_test') return Response.json({ data: { id: 'ses_test', location: { directory: '/project' } } });
    if (path === '/api/session/ses_test/form/frm_question') return Response.json({ data: form });
    if (path === '/api/session/ses_test/form/frm_question/reply' && options.method === 'POST') return new Response(null, { status: 204 });
    return Response.json({ error: 'Not found' }, { status: 404 });
  });
  const runtime = createQuestionAutoDelegateRuntime({
    globalEventHub: { subscribeEvent: (fn) => { onEvent = fn; return () => {}; } },
    buildOpenCodeUrl: (path) => `http://opencode.test/api${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    readSettingsFromDiskMigrated: async () => ({ projects: [{ path: '/project' }] }),
    fetchImpl,
  });
  runtimes.push(runtime);
  runtime.start();
  await vi.advanceTimersByTimeAsync(0);
  return {
    runtime, fetchImpl,
    emit: (type, data, directory = '/project') => onEvent({ directory: 'global', payload: {
      type, data, ...(directory ? { location: { directory } } : {}),
    } }),
    posts: () => fetchImpl.mock.calls.filter(([, options]) => options.method === 'POST'),
  };
};

it('auto-delegates a native question form after exactly 30 seconds without a UI', async () => {
  const { emit, posts, runtime } = await setup();
  emit('form.created', { sessionID: form.sessionID, form });
  await vi.advanceTimersByTimeAsync(29_999);
  expect(posts()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(posts()).toHaveLength(1);
  expect(posts()[0][0].pathname).toBe('/api/session/ses_test/form/frm_question/reply');
  expect(JSON.parse(posts()[0][1].body)).toEqual({ answer: { approach: QUESTION_AUTO_DELEGATE_ANSWER } });
  expect(runtime.snapshot().requests[0].state).toBe('settled');
});

it('recovers pending native question forms on startup', async () => {
  const { posts } = await setup([form]);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(posts()).toHaveLength(1);
});

it.each(['form.replied', 'form.cancelled'])('cancels the timer on %s', async (type) => {
  const { emit, posts, runtime } = await setup();
  emit('form.created', { sessionID: form.sessionID, form });
  expect(runtime.snapshot().requests).toHaveLength(1);
  emit(type, { sessionID: form.sessionID, id: form.id });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(posts()).toHaveLength(0);
  expect(runtime.snapshot().requests[0].state).toBe('settled');
});

it('does not auto-answer non-question forms', async () => {
  const other = { ...form, metadata: { kind: 'configuration' } };
  const { emit, posts, runtime } = await setup([other]);
  emit('form.created', { sessionID: other.sessionID, form: other });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(posts()).toHaveLength(0);
  expect(runtime.snapshot().requests).toEqual([]);
});

it('resolves a directory-less event through the native session location', async () => {
  const { emit, posts } = await setup();
  emit('form.created', { form }, '');
  await vi.advanceTimersByTimeAsync(30_000);
  expect(posts()).toHaveLength(1);
});

it('preserves pending questions when native list reconciliation fails', async () => {
  const { emit, runtime, fetchImpl, posts } = await setup();
  emit('form.created', { form });
  const original = fetchImpl.getMockImplementation();
  fetchImpl.mockImplementation((url, options) => url.pathname === '/api/form'
    ? Promise.resolve(new Response(null, { status: 503 })) : original(url, options));
  await runtime.reconcile();
  expect(runtime.snapshot().coverage.state).toBe('partial');
  expect(runtime.snapshot().requests[0].state).toBe('counting');
  await vi.advanceTimersByTimeAsync(30_000);
  expect(posts()).toHaveLength(1);
});

it('pauses for retry when schema lookup fails, without sending an answer', async () => {
  const { emit, runtime, fetchImpl, posts } = await setup();
  emit('form.created', { form });
  const original = fetchImpl.getMockImplementation();
  fetchImpl.mockImplementation((url, options) => url.pathname.endsWith('/form/frm_question')
    ? Promise.resolve(new Response(null, { status: 503 })) : original(url, options));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(posts()).toHaveLength(0);
  expect(runtime.snapshot().requests[0].state).toBe('paused');
});

it('honors user takeover and explicit delegation of native forms', async () => {
  const { emit, runtime, posts } = await setup();
  emit('form.created', { form });
  const identity = { requestID: form.id, sessionID: form.sessionID, directory: '/project' };
  await runtime.pause({ ...identity, reason: 'interaction' });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(posts()).toHaveLength(0);
  await runtime.delegate(identity);
  expect(posts()).toHaveLength(1);
});

it('uses the freshly read schema for multiple fields and array answers', async () => {
  const { emit, fetchImpl, posts } = await setup();
  const original = fetchImpl.getMockImplementation();
  fetchImpl.mockImplementation((url, options) => url.pathname.endsWith('/form/frm_question')
    ? Promise.resolve(Response.json({ data: { ...form, fields: [
      { key: 'actual_key', type: 'string', custom: true },
      { key: 'targets', type: 'multiselect', custom: true, options: [] },
    ] } })) : original(url, options));
  emit('form.created', { form: { ...form, fields: [...form.fields, { key: 'old', type: 'multiselect' }] } });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(JSON.parse(posts()[0][1].body)).toEqual({ answer: {
    actual_key: QUESTION_AUTO_DELEGATE_ANSWER, targets: [QUESTION_AUTO_DELEGATE_ANSWER],
  } });
});
