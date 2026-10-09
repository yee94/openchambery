import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQuestionAutoDelegateRuntime } from './runtime.js';
import { QUESTION_AUTO_DELEGATE_ANSWER } from './core.js';
import { createQuestionPauseStore } from './pause-store.js';

const form = {
  id: 'frm_question', sessionID: 'ses_test', title: 'Choose',
  metadata: { kind: 'question' },
  fields: [{ key: 'approach', type: 'string', custom: true, options: [{ label: 'A', value: 'a' }] }],
};
const runtimes = [];
let pauseDirectory;
beforeEach(() => { pauseDirectory = mkdtempSync(join(tmpdir(), 'question-pauses-')); });
afterEach(() => {
  runtimes.splice(0).forEach((runtime) => runtime.dispose());
  vi.useRealTimers();
  rmSync(pauseDirectory, { recursive: true, force: true });
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
    pauseStore: createQuestionPauseStore(pauseDirectory),
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

it('a confirmed desktop pause stops a second host and survives host recreation', async () => {
  const desktop = await setup();
  const web = await setup();
  desktop.emit('form.created', { form });
  web.emit('form.created', { form });
  const result = await desktop.runtime.pause({ requestID: form.id, sessionID: form.sessionID, reason: 'interaction' });
  expect(result.outcome).toBe('paused');
  const restarted = await setup([form]);
  await vi.advanceTimersByTimeAsync(60_000);
  for (const host of [desktop, web, restarted]) {
    expect(host.posts()).toHaveLength(0);
    expect(host.runtime.snapshot().requests[0].state).toBe('paused');
  }
  await web.runtime.delegate({ requestID: form.id, sessionID: form.sessionID });
  expect(web.posts()).toHaveLength(1);
  expect(createQuestionPauseStore(pauseDirectory).has(form.id, form.sessionID)).toBe(false);
});

it('a shared hold for one question does not stop another question in the same session', async () => {
  const { emit, runtime, fetchImpl, posts } = await setup();
  const other = { ...form, id: 'frm_other' };
  const original = fetchImpl.getMockImplementation();
  fetchImpl.mockImplementation((url, options) => {
    if (url.pathname.endsWith('/form/frm_other')) return Promise.resolve(Response.json({ data: other }));
    if (url.pathname.endsWith('/form/frm_other/reply')) return Promise.resolve(new Response(null, { status: 204 }));
    return original(url, options);
  });
  emit('form.created', { form });
  emit('form.created', { form: other });
  await runtime.pause({ requestID: form.id, sessionID: form.sessionID, reason: 'interaction' });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(posts()).toHaveLength(1);
  expect(posts()[0][0].pathname).toContain('/frm_other/reply');
});

it('checks a cross-host pause again after the asynchronous form schema read', async () => {
  const desktop = await setup();
  const web = await setup();
  web.emit('form.created', { form });
  await vi.advanceTimersByTimeAsync(1000);
  desktop.emit('form.created', { form });
  const original = web.fetchImpl.getMockImplementation();
  let finishSchema;
  web.fetchImpl.mockImplementation((url, options) => url.pathname.endsWith('/form/frm_question')
    ? new Promise((resolve) => { finishSchema = () => resolve(Response.json({ data: form })); })
    : original(url, options));
  // Only the web host reaches its timer; desktop takeover arrives while its schema GET waits.
  await vi.advanceTimersByTimeAsync(29_000);
  expect(finishSchema).toBeTypeOf('function');
  await desktop.runtime.pause({ requestID: form.id, sessionID: form.sessionID, reason: 'interaction' });
  finishSchema();
  await vi.advanceTimersByTimeAsync(0);
  expect(web.posts()).toHaveLength(0);
  expect(web.runtime.snapshot().requests[0].state).toBe('paused');
});

it('retains a hold sent before this host discovers the form', async () => {
  const desktop = await setup();
  const result = await desktop.runtime.pause({ requestID: form.id, sessionID: form.sessionID, reason: 'interaction' });
  expect(result.outcome).toBe('not_found');
  const web = await setup([form]);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(web.posts()).toHaveLength(0);
  expect(web.runtime.snapshot().requests[0].state).toBe('paused');
});

it('publishes the hold before a slow missing-identity recovery can cross the other host deadline', async () => {
  const desktop = await setup();
  const web = await setup([form]);
  const original = desktop.fetchImpl.getMockImplementation();
  let finishList;
  desktop.fetchImpl.mockImplementation((url, options) => url.pathname === '/api/form'
    ? new Promise((resolve) => { finishList = () => resolve(Response.json({ data: [form] })); })
    : original(url, options));
  const pausing = desktop.runtime.pause({ requestID: form.id, sessionID: form.sessionID, directory: '/project', reason: 'interaction' });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(web.posts()).toHaveLength(0);
  finishList();
  expect((await pausing).outcome).toBe('paused');
});

it('reports shared pause publication failure and allows explicit retry', async () => {
  const { runtime, emit } = await setup();
  emit('form.created', { form });
  const store = createQuestionPauseStore(pauseDirectory);
  const identity = { requestID: form.id, sessionID: form.sessionID, reason: 'interaction' };
  // A file where a directory belongs is a deterministic write failure on every platform.
  rmSync(pauseDirectory, { recursive: true });
  writeFileSync(pauseDirectory, 'blocked');
  expect((await runtime.pause(identity)).outcome).toBe('error');
  rmSync(pauseDirectory);
  expect((await runtime.pause(identity)).outcome).toBe('paused');
  expect(store.has(form.id, form.sessionID)).toBe(true);
});

it('blocks automatic replies on an unreadable shared store without an unhandled timer failure', async () => {
  const { runtime, emit, posts } = await setup();
  emit('form.created', { form });
  rmSync(pauseDirectory, { recursive: true });
  writeFileSync(pauseDirectory, 'blocked');
  await vi.advanceTimersByTimeAsync(30_000);
  expect(posts()).toHaveLength(0);
  expect(runtime.snapshot().requests[0].state).toBe('paused');
  expect(runtime.snapshot().coverage.state).toBe('partial');
});

it('observes a pause published by a separate Node host process', async () => {
  const { runtime, emit, posts } = await setup();
  emit('form.created', { form });
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { createQuestionPauseStore } from ${JSON.stringify(new URL('./pause-store.js', import.meta.url).href)};
    createQuestionPauseStore(process.argv[1]).pause(process.argv[2], process.argv[3]);
  `, pauseDirectory, form.id, form.sessionID]);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(posts()).toHaveLength(0);
  expect(runtime.snapshot().requests[0].state).toBe('paused');
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
