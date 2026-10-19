import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { createNativeNotificationStream } from './native-stream.js';
import { registerNotificationRoutes } from './routes.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';

const responses = [];
const response = () => {
  const res = Object.assign(new EventEmitter(), {
    chunks: [], destroyed: false, writableEnded: false, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    write(chunk) { this.chunks.push(chunk); return true; },
    destroy() { this.destroyed = true; this.emit('close'); },
  });
  responses.push(res);
  return res;
};
const events = (res) => res.chunks.filter((chunk) => chunk.startsWith('id:')).map((chunk) => ({
  id: chunk.split('\n')[0].slice(4), data: JSON.parse(chunk.split('\n')[1].slice(6)),
}));
it('localizes standard titles per subscriber and replay while preserving session names and custom titles', () => {
  const stream = createNativeNotificationStream();
  const zh = response();
  const en = response();
  stream.connect({ headers: { 'accept-language': 'zh-CN' } }, zh);
  stream.connect({ headers: { 'accept-language': 'en' } }, en);
  const cursor = events(zh)[0].id;
  stream.publish({ title: 'Needs your answer', body: 'messagelist库', kind: 'question' });
  expect(events(zh).at(-1).data).toMatchObject({ title: '需要你回答', body: 'messagelist库' });
  expect(events(en).at(-1).data.title).toBe('Needs your answer');
  const replay = response();
  stream.connect({ headers: { 'accept-language': 'zh-CN', 'last-event-id': cursor } }, replay);
  expect(events(replay)[0].data.title).toBe('需要你回答');
  stream.publish({ title: '自定义标题', body: '原始正文', kind: 'question' });
  expect(events(zh).at(-1).data.title).toBe('自定义标题');
  stream.publish({ title: 'Needs your answer', kind: 'contact' });
  expect(events(zh).at(-1).data.title).toBe('Needs your answer');
  for (const [kind, title, translated] of [
    ['ready', 'Task completed', '任务已完成'],
    ['permission', 'Needs permission', '需要你授权'],
    ['error', 'Task failed', '出现错误'],
    ['goal_complete', 'Goal completed', '目标已完成'],
    ['task_complete', 'Scheduled task completed', '定时任务已完成'],
    ['task_error', 'Scheduled task failed', '定时任务失败'],
  ]) {
    stream.publish({ kind, title });
    expect(events(zh).at(-1).data.title).toBe(translated);
  }
});
afterEach(() => { responses.splice(0).forEach((res) => res.destroy()); vi.useRealTimers(); });

it('replays a missed first notification from the initial ready cursor and does not replay acknowledged events', () => {
  const stream = createNativeNotificationStream();
  const first = response();
  stream.connect({ headers: {} }, first);
  const initialCursor = events(first)[0].id;
  first.destroy();
  stream.publish({ title: 'Completed', sessionId: 'session-a' });
  const second = response();
  stream.connect({ headers: { 'last-event-id': initialCursor } }, second);
  expect(events(second).map((entry) => entry.data.type)).toEqual(['notification', 'ready']);
  expect(events(second).at(-1).data.gap).toBe(false);
  const third = response();
  stream.connect({ headers: { 'last-event-id': events(second).at(-1).id } }, third);
  expect(events(third).map((entry) => entry.data.type)).toEqual(['ready']);
});

it('bounds replay by count and age, flags gaps and never replays history to a new subscriber', () => {
  let clock = 0;
  const stream = createNativeNotificationStream({ now: () => clock, maxEntries: 2, ttlMs: 100 });
  const first = response();
  stream.connect({ headers: {} }, first);
  const cursor = events(first)[0].id;
  for (let i = 0; i < 1000; i++) stream.publish({ title: `Event ${i}`, body: 'x'.repeat(20_000) });
  const replay = response();
  stream.connect({ headers: { 'last-event-id': cursor } }, replay);
  expect(events(replay)).toHaveLength(3);
  expect(events(replay)[0].data.body).toHaveLength(1024);
  expect(events(replay).at(-1).data.gap).toBe(true);
  clock = 101;
  const expired = response();
  stream.connect({ headers: { 'last-event-id': cursor } }, expired);
  expect(events(expired)).toHaveLength(1);
  expect(events(expired)[0].data.gap).toBe(true);
  const fresh = response();
  stream.connect({ headers: {} }, fresh);
  expect(events(fresh)).toHaveLength(1);
  expect(events(fresh)[0].data.gap).toBe(false);
});

it('sends one idle heartbeat per minute, tears down timers, and disconnects backpressured consumers', () => {
  vi.useFakeTimers();
  const stream = createNativeNotificationStream();
  const res = response();
  stream.connect({ headers: {} }, res);
  vi.advanceTimersByTime(59_999);
  expect(res.chunks).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(res.chunks.at(-1)).toBe(': heartbeat\n\n');
  res.write = () => false;
  stream.publish({ title: 'Done' });
  expect(res.destroyed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('closes an established subscription when its bearer is revoked without overlapping auth checks', async () => {
  vi.useFakeTimers();
  const stream = createNativeNotificationStream();
  const res = response();
  let settle;
  const authorize = vi.fn(() => new Promise((resolve) => { settle = resolve; }));
  stream.connect({ headers: {} }, res, authorize);
  vi.advanceTimersByTime(120_000);
  expect(authorize).toHaveBeenCalledOnce();
  settle(false);
  await Promise.resolve();
  expect(res.destroyed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('authenticates the real route before opening the stream and starts the watcher for authorized clients', async () => {
  const stream = createNativeNotificationStream();
  const watcher = vi.fn(async () => {});
  const auth = createUiAuth({ requireClientAuth: true, clientAuthController: {
    authenticateBearerToken: async (token) => token === 'fixture-token'
      ? { ok: true, clientId: 'fixture', sessionToken: 'client:fixture' } : { ok: false },
  } });
  const app = express();
  app.use('/api', auth.requireAuth);
  registerNotificationRoutes(app, { uiAuthController: auth, connectNativeNotifications: stream.connect, ensureGlobalWatcherStarted: watcher });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/notifications/native-stream`;
  const abort = new AbortController();
  try {
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect(watcher).not.toHaveBeenCalled();
    const result = await fetch(url, { headers: { Authorization: 'Bearer fixture-token' }, signal: abort.signal });
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toContain('text/event-stream');
    const reader = result.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"ready"');
    stream.publish({ title: 'Scheduled complete' });
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('Scheduled complete');
    expect(watcher).toHaveBeenCalledOnce();
    await reader.cancel();
  } finally {
    abort.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
