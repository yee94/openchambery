import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionDirectoryRuntime } from './session-directory-runtime.js';
import { createSessionIndexService } from '../session-index/service.js';
import { createSessionIndexSyncRuntime } from '../session-index/sync-runtime.js';
import { applySessionIndexEvent } from '../session-index/event-ingest.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const fixture = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-directory-')));
  roots.push(root);
  const real = path.join(root, 'repo');
  const alias = path.join(root, 'link');
  const other = path.join(root, 'worktree');
  fs.mkdirSync(real);
  fs.mkdirSync(other);
  fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  return { real, alias, other };
};
const session = (id, directory, updated = 1) => ({ id, title: id, location: { directory }, time: { created: 1, updated } });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('physical session directory identity', () => {
  it('recovers unindexed alias history across pages without admitting another worktree', async () => {
    const { real, alias, other } = fixture();
    const requests = [];
    const controller = new AbortController();
    const fetchFn = vi.fn(async (input, init) => {
      const url = new URL(input);
      requests.push(url);
      expect(init.signal).toBe(controller.signal);
      expect(init.headers).toEqual({ Authorization: 'test-only' });
      if (url.pathname === '/api/location') return json({ project: { id: 'project-repo' } });
      expect(url.searchParams.has('directory')).toBe(false);
      if (!url.searchParams.has('cursor')) {
        expect(url.searchParams.get('project')).toBe('project-repo');
        return json({ data: [session('other', other, 30)], cursor: { next: 'page-2' } });
      }
      return json({ data: [session('old-alias', alias, 20), session('real', real, 10)], cursor: { next: 'page-3' } });
    });
    const runtime = createSessionDirectoryRuntime({ fetchFn });
    const url = new URL('http://localhost/api/session');
    url.searchParams.set('directory', real);
    url.searchParams.set('limit', '2');
    const init = { signal: controller.signal, headers: { Authorization: 'test-only' } };
    const first = await (await runtime.fetchSessionList(url, init)).json();
    expect(first.data).toEqual([]);
    expect(first.cursor.next).toBe('page-2');
    url.searchParams.set('cursor', first.cursor.next);
    const response = await runtime.fetchSessionList(url, init);
    const payload = await response.json();
    expect(payload.data.map((row) => row.id)).toEqual(['old-alias', 'real']);
    expect(payload.data.every((row) => row.directory === real && row.location.directory === real)).toBe(true);
    expect(payload.cursor.next).toBe('page-3');
    expect(requests).toHaveLength(3);
    expect(requests[0].searchParams.get('location[directory]')).toBe(real);
  });

  it('uses the same physical directory for cold sync and later native live events', async () => {
    const { real, alias } = fixture();
    const directories = createSessionDirectoryRuntime({ fetchFn: async (input) => {
      const url = new URL(input);
      if (url.pathname === '/api/location') return json({ project: { id: 'project-repo' } });
      if (url.searchParams.has('parentID')) return json({ data: [], cursor: {} });
      return json({ data: [session('old-alias', alias)], cursor: {} });
    } });
    const service = createSessionIndexService({ dbPath: ':memory:', resolveDirectory: directories.resolveDirectory });
    const sync = createSessionIndexSyncRuntime({
      sessionIndexService: service,
      buildOpenCodeUrl: (route) => `http://localhost/api${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => true,
      fetchFn: directories.fetchSessionList,
      resolveDirectory: directories.resolveDirectory,
    });
    try {
      sync.enqueue([real, alias]);
      await vi.waitFor(() => expect(sync.snapshot().sync.active || sync.snapshot().sync.enriching).toBe(false));
      expect(sync.snapshot().sync.total).toBe(1);
      expect(service.snapshot().directories).toHaveLength(1);
      expect(service.snapshot().directories[0]).toMatchObject({ directory: real, sessions: [{ id: 'old-alias', directory: real }] });
      const event = directories.projectEvent({ payload: { type: 'session.updated', data: { info: session('old-alias', alias, 5) } }, directory: alias });
      expect(event.directory).toBe(real);
      expect(event.payload.data.info.location.directory).toBe(real);
      applySessionIndexEvent(service, event);
      expect(service.snapshot().directories).toHaveLength(1);
      expect(service.findBySessionId('old-alias').directory).toBe(real);
    } finally { sync.stop(); service.close(); }
  });

  it('preserves cached rows on a failed alias-history page and recovers on retry', async () => {
    const { real, alias } = fixture();
    let fail = true;
    const directories = createSessionDirectoryRuntime({ fetchFn: async (input) => {
      const url = new URL(input);
      if (url.pathname === '/api/location') return json({ project: { id: 'project-repo' } });
      if (url.searchParams.has('parentID')) return json({ data: [], cursor: {} });
      if (fail) return json({ error: 'unavailable' }, 503);
      return json({ data: [session('recovered', alias)], cursor: {} });
    } });
    const service = createSessionIndexService({ dbPath: ':memory:', resolveDirectory: directories.resolveDirectory });
    service.upsert({ ...session('cached', real), directory: real });
    const sync = createSessionIndexSyncRuntime({ sessionIndexService: service,
      buildOpenCodeUrl: (route) => `http://localhost/api${route}`, getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => true, fetchFn: directories.fetchSessionList,
    });
    try {
      sync.enqueue([real]);
      await vi.waitFor(() => expect(sync.snapshot().sync.active).toBe(false));
      expect(sync.snapshot().sync.failedDirectories).toEqual([real]);
      expect(service.findBySessionId('cached')).not.toBeNull();
      fail = false;
      sync.enqueue([real]);
      await vi.waitFor(() => expect(sync.snapshot().sync.active || sync.snapshot().sync.enriching).toBe(false));
      expect(service.findBySessionId('recovered').directory).toBe(real);
      expect(service.findBySessionId('cached')).toBeNull();
    } finally { sync.stop(); service.close(); }
  });

  it('does not resolve remote paths against the local machine, even when that path exists locally', async () => {
    const { alias } = fixture();
    let endpoint = 'http://localhost:4096';
    const realpath = vi.fn(fs.realpathSync.native);
    const fetchFn = vi.fn(async () => json({ data: [], cursor: {} }));
    const runtime = createSessionDirectoryRuntime({ getRuntimeUrl: () => endpoint, realpath, fetchFn });
    expect(runtime.resolveDirectory(alias)).not.toBe(alias);
    endpoint = 'https://remote.example.com';
    expect(runtime.resolveDirectory(alias)).toBe(alias);
    const url = new URL(`${endpoint}/api/session`);
    url.searchParams.set('directory', alias);
    await runtime.fetchSessionList(url, {});
    expect(realpath).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe(url);
  });

  it('bounds physical path lookups across 245 legacy sessions and repeated live updates; retries failures and retargets', () => {
    let clock = 0;
    let target = '/physical/repo';
    const realpath = vi.fn(() => { if (!target) throw new Error('unmounted'); return target; });
    const runtime = createSessionDirectoryRuntime({ realpath, now: () => clock });
    for (let i = 0; i < 2450; i++) expect(runtime.projectSession(session(`session-${i % 245}`, '/alias')).directory).toBe(target);
    expect(realpath).toHaveBeenCalledTimes(1);
    clock = 60_001;
    target = '';
    expect(runtime.resolveDirectory('/alias')).toBe('/alias');
    target = '/retargeted/repo';
    clock += 5_001;
    expect(runtime.resolveDirectory('/alias')).toBe(target);
    expect(realpath).toHaveBeenCalledTimes(3);
    const message = { type: 'message.part.updated', data: {} };
    expect(runtime.projectEvent(message)).toBe(message);
    expect(realpath).toHaveBeenCalledTimes(3);
  });
});
