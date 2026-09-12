import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const model = vi.hoisted(() => ({ complete: null }));
vi.mock('../llm/completions.js', () => ({ createChatCompletion: (input) => model.complete(input) }));
import { registerAssistantRoutes } from './routes.js';

const closers = [];
afterEach(async () => {
  while (closers.length) await closers.pop()();
  model.complete = null;
});
const listen = async (app) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
};
const final = (text) => ({ text: '```openchamber-final\n' + JSON.stringify({ status: 'complete', text }) + '\n```' });
const call = (name, args) => ({ text: '```openchamber-tool\n' + JSON.stringify({ name, arguments: args }) + '\n```' });
const resultFor = (body, name) => {
  const row = body.messages.findLast((m) => m.content?.startsWith(`OpenChamber tool result name=${name} `));
  if (!row) return null;
  return JSON.parse(row.content.slice(row.content.indexOf(': ') + 2));
};
const setup = async (existingDirectory = null) => {
  const directory = existingDirectory || fs.mkdtempSync(path.join(os.tmpdir(), 'oc-memory-http-'));
  if (!existingDirectory) closers.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const upstream = express();
  const catalog = [{ id: 'p', name: 'Provider', models: { m: { id: 'm', name: 'Model' } } }];
  upstream.get('/provider', (_req, res) => res.json({ all: catalog, connected: ['p'], default: {} }));
  upstream.get('/config/providers', (_req, res) => res.json({ providers: catalog, default: {} }));
  const upstreamBase = await listen(upstream);
  const app = express();
  app.use(express.json());
  const runtime = registerAssistantRoutes(app, {
    dbPath: path.join(directory, 'assistants.sqlite'), openchamberDataDir: directory,
    getAllowedRoots: () => [directory], listProjects: () => [{ id: 'project', path: directory }],
    buildOpenCodeUrl: (pathname) => `${upstreamBase}${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
  });
  closers.push(() => runtime.close());
  const base = await listen(app);
  const request = async (url, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(`${base}/api/openchamber/assistants${url}`, {
      method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(response.ok).toBe(true);
    return response.json();
  };
  await request('/settings', { enabled: true, expectedRevision: runtime.service.snapshot().revision }, 'PUT');
  const create = (name) => request('', { name, providerID: 'p', modelID: 'm', workspacePath: directory });
  const send = async (assistantID, messageID, text) => {
    const response = await fetch(`${base}/api/openchamber/assistants/${assistantID}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID, language: 'zh-CN', parts: [{ type: 'text', text }] }),
    });
    expect(response.status).toBe(202);
    await runtime.service.whenContactTurnSettled(messageID);
    return request(`/${assistantID}/contact/messages?limit=100`);
  };
  return { request, create, send, directory, service: runtime.service };
};

describe('contact memory HTTP → real Agent/tools → SQLite → model reply', () => {
  it('clears late replies from an earlier running turn while preserving queued user requests', async () => {
    let release;
    let started = false;
    const gate = new Promise((resolve) => { release = resolve; });
    model.complete = async ({ body }) => {
      if (resultFor(body, 'new_conversation')) return final('记忆已清除。');
      const search = resultFor(body, 'search_memory');
      if (search) {
        expect(search.isError).toBe(false);
        expect(JSON.parse(search.content).matches).toEqual([]);
        return final('新请求保留，旧记忆已隔离。');
      }
      const text = body.messages.at(-1)?.content;
      if (text === 'Previous work') { started = true; await gate; return final('late-private old result'); }
      if (text === '清除记忆') return call('new_conversation', {});
      expect(text).toBe('New queued request');
      expect(JSON.stringify(body)).not.toContain('late-private');
      return call('search_memory', { query: 'late-private' });
    };
    const app = await setup();
    const a = await app.create('Queued memory');
    const prior = app.send(a.id, 'previous-work', 'Previous work');
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      const clearing = app.send(a.id, 'queued-clear', '清除记忆');
      await vi.waitFor(() => expect(app.service.contactMessages(a.id).messages.some((m) => m.messageID === 'queued-clear')).toBe(true));
      const queued = app.send(a.id, 'queued-new', 'New queued request');
      await vi.waitFor(() => expect(app.service.contactMessages(a.id).messages.some((m) => m.messageID === 'queued-new')).toBe(true));
      release();
      await Promise.all([prior, clearing]);
      expect((await queued).messages.at(-1).text).toBe('新请求保留，旧记忆已隔离。');
    } finally { release(); await prior; }
  });

  it('recalls text outside the automatic history window and summarizes the retrieved source', async () => {
    const seen = [];
    model.complete = async ({ body }) => {
      const read = resultFor(body, 'read_memory');
      if (read) {
        expect(read.isError).toBe(false);
        const data = JSON.parse(read.content);
        expect(data.text).toContain('migration target: quartz-v4.1');
        expect(data.messageID).toBe('old-preference');
        return final('查到了，你之前确定的迁移目标是 quartz-v4.1。');
      }
      const search = resultFor(body, 'search_memory');
      if (search) {
        expect(search.isError).toBe(false);
        const data = JSON.parse(search.content);
        expect(data.matches).toHaveLength(1);
        expect(data.matches[0].createdAt).toBeGreaterThan(0);
        return call('read_memory', { messageID: data.matches[0].messageID });
      }
      const user = body.messages.at(-1)?.content;
      if (user === 'Recall the migration decision') {
        expect(JSON.stringify(body)).not.toContain('quartz-v4.1');
        expect(body.messages[0].content).toContain('search_memory');
        seen.push('outside-window');
        return call('search_memory', { query: 'migration target' });
      }
      return final('收到。');
    };
    const app = await setup();
    const assistant = await app.create('Memory');
    await app.send(assistant.id, 'old-preference', 'migration target: quartz-v4.1');
    for (let index = 0; index < 36; index++) await app.send(assistant.id, `filler-${index}`, `Small talk ${index}`);
    const page = await app.send(assistant.id, 'recall', 'Recall the migration decision');
    expect(seen).toEqual(['outside-window']);
    expect(page.messages.at(-1).text).toBe('查到了，你之前确定的迁移目标是 quartz-v4.1。');
    expect(page.messages.at(-1).status).toBe('complete');
  });

  it('enforces clear-memory across restart, isolates contacts and makes wiped history inaccessible', async () => {
    let mode = 'seed';
    let target = 'a-original';
    let recallChecks = 0;
    model.complete = async ({ body }) => {
      if (mode === 'seed') return final('收到。');
      if (mode === 'clear') {
        if (resultFor(body, 'new_conversation')) return final('记忆已清除。');
        return call('new_conversation', {});
      }
      const read = resultFor(body, 'read_memory');
      if (read) {
        recallChecks += 1;
        if (mode === 'read-b') {
          expect(read.isError).toBe(false);
          expect(JSON.parse(read.content).text).toBe('shared keyword B-private');
          return final('查到了当前助理的记录。');
        }
        expect(read.isError).toBe(true);
        expect(read.content).toContain('memory_not_found');
        return final('当前可回查的记忆中没有这条记录。');
      }
      const search = resultFor(body, 'search_memory');
      if (search) {
        expect(search.isError).toBe(false);
        const data = JSON.parse(search.content);
        if (mode === 'search-a') {
          expect(data.matches.map((m) => m.messageID)).toEqual(['a-original']);
          recallChecks += 1;
          return final('查到了当前助理的记录。');
        }
        expect(data.matches).toEqual([]);
        return call('read_memory', { messageID: target });
      }
      if (mode !== 'read-b' && mode !== 'search-a' && mode !== 'foreign') expect(JSON.stringify(body)).not.toMatch(/A-private|B-private/);
      if (mode === 'read-b' || mode === 'foreign') return call('read_memory', { messageID: target });
      return call('search_memory', { query: 'shared keyword' });
    };
    let app = await setup();
    const a = await app.create('Contact A');
    const b = await app.create('Contact B');
    await app.send(a.id, 'a-original', 'shared keyword A-private');
    await app.send(b.id, 'b-original', 'shared keyword B-private');
    mode = 'search-a';
    expect((await app.send(a.id, 'search-a', 'Recall previous record')).messages.at(-1).status).toBe('complete');
    mode = 'foreign'; target = 'b-original';
    expect((await app.send(a.id, 'foreign', 'Read source')).messages.at(-1).text).toBe('当前可回查的记忆中没有这条记录。');
    mode = 'clear';
    await app.send(a.id, 'clear-a', '清除记忆');
    expect((await app.request(`/${a.id}/contact/messages`)).messages.some((m) => m.messageID === 'a-original')).toBe(true);
    app.service.close();
    app = await setup(app.directory);
    mode = 'after-clear'; target = 'a-original';
    expect((await app.send(a.id, 'after-clear', 'Recall previous record')).messages.at(-1).text).toBe('当前可回查的记忆中没有这条记录。');
    mode = 'read-b'; target = 'b-original';
    expect((await app.send(b.id, 'read-b', 'Read source')).messages.at(-1).text).toBe('查到了当前助理的记录。');
    await app.request(`/${a.id}/contact/reset`, {});
    expect((await app.request(`/${a.id}/contact/messages`)).messages).toEqual([]);
    mode = 'after-wipe'; target = 'a-original';
    expect((await app.send(a.id, 'after-wipe', 'Recall previous record')).messages.at(-1).text).toBe('当前可回查的记忆中没有这条记录。');
    expect(recallChecks).toBe(5);
  });
});
