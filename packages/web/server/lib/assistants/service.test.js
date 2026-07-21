import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAssistantsService } from './service.js';

describe('assistants service', () => {
  it('persists inbox, revisions, and idempotent operations', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistants-'));
    const service = createAssistantsService({ dbPath: path.join(root, 'assistants.sqlite'), dataDir: root, buildOpenCodeUrl: () => 'http://127.0.0.1:1', getOpenCodeAuthHeaders: () => ({}) });
    const assistant = service.createAssistant({ name: 'A', providerID: 'p', modelID: 'm', mode: 'continuous', skillRoots: [] });
    expect(service.listTopics(assistant.id)).toHaveLength(1);
    const updated = service.updateAssistant(assistant.id, { expectedRevision: 1, name: 'B' });
    expect(updated.revision).toBe(2);
    expect(service.snapshot().revision).toBe(2);
    expect(await service.operation('missing')).toBeUndefined();
    service.close();
  });

  it('limits workspaces and preserves CAS conflicts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistants-'));
    const service = createAssistantsService({ dbPath: path.join(root, 'assistants.sqlite'), dataDir: root, buildOpenCodeUrl: () => 'http://127.0.0.1:1', getOpenCodeAuthHeaders: () => ({}) });
    expect(() => service.createAssistant({ name: 'A', providerID: 'p', modelID: 'm', mode: 'continuous', workspacePath: os.tmpdir(), skillRoots: [] })).toThrow(expect.objectContaining({ code: 'workspace_forbidden' }));
    const assistant = service.createAssistant({ name: 'A', providerID: 'p', modelID: 'm', mode: 'continuous', skillRoots: [] });
    expect(() => service.updateAssistant(assistant.id, { expectedRevision: 9, name: 'stale' })).toThrow(expect.objectContaining({ code: 'revision_conflict' }));
    expect(() => service.removeAssistant(assistant.id, 9)).toThrow(expect.objectContaining({ code: 'revision_conflict' }));
    service.close();
  });

  it('keeps an admitted message operation inspectable and rejects body reuse', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistants-'));
    const service = createAssistantsService({ dbPath: path.join(root, 'assistants.sqlite'), dataDir: root, buildOpenCodeUrl: () => 'http://127.0.0.1:1', getOpenCodeAuthHeaders: () => ({}) });
    const assistant = service.createAssistant({ name: 'A', providerID: 'p', modelID: 'm', mode: 'continuous', skillRoots: [] });
    const admitted = service.submit('op-1', assistant.inboxTopicID, [{ type: 'text', text: 'one' }]);
    expect(admitted).toMatchObject({ state: 'running', admission: { admitted: true }, result: null, type: 'message' });
    expect(() => service.submit('op-1', assistant.inboxTopicID, [{ type: 'text', text: 'two' }])).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    service.close();
  });

  it('projects parent-linked transcript from one paginated fetch per distinct session', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistants-'));
    const calls = [];
    const pages = {
      first: [{ info: { id: 'user-1', role: 'user' } }, { info: { id: 'assistant-1', role: 'assistant', parentID: 'user-1', time: { created: 2, completed: 3 } }, parts: [{ type: 'text', text: 'answer' }] }],
      next: [{ info: { id: 'other', role: 'assistant', parentID: 'other-user' } }],
    };
    const service = createAssistantsService({ dbPath: path.join(root, 'assistants.sqlite'), dataDir: root, buildOpenCodeUrl: () => 'http://127.0.0.1:1', getOpenCodeAuthHeaders: () => ({}), clientFactory: () => ({ session: { create: async () => ({ data: { id: 'session-1' } }), promptAsync: async () => ({ data: { info: { id: 'user-1' } } }), messages: async (input) => { calls.push(input); return { data: input.cursor ? pages.next : pages.first, next: input.cursor ? null : 'page-2' }; } } }) });
    const assistant = service.createAssistant({ name: 'A', providerID: 'p', modelID: 'm', mode: 'stateless', skillRoots: [] });
    service.submit('op-1', assistant.inboxTopicID, [{ type: 'text', text: 'one' }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const turns = await service.getTurns(assistant.inboxTopicID);
    expect(calls).toHaveLength(4);
    expect(turns).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.any(String), topicID: assistant.inboxTopicID, ordinal: 1, parentMessageID: null, phase: 'completed', role: 'user', kind: 'message', source: 'composer', parts: [{ type: 'text', text: 'one' }], assistantRevision: 1, sessionID: 'session-1', messageID: 'user-1', operationID: 'op-1', createdAt: expect.any(Number), completedAt: null, error: null }),
      expect.objectContaining({ id: 'assistant-1', topicID: assistant.inboxTopicID, ordinal: 1, parentMessageID: 'user-1', phase: 'completed', role: 'assistant', parts: [{ type: 'text', text: 'answer' }], sessionID: 'session-1', messageID: 'assistant-1', operationID: 'op-1', createdAt: 2, completedAt: 3, error: null }),
    ]));
    service.close();
  });

  it('reconciles submitted work without a client request and closes its scheduler', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistants-')); let tick; let cleared = false;
    const service = createAssistantsService({ dbPath: path.join(root, 'assistants.sqlite'), dataDir: root, buildOpenCodeUrl: () => 'http://127.0.0.1:1', getOpenCodeAuthHeaders: () => ({}), setIntervalFn: (fn) => { tick = fn; return 'timer'; }, clearIntervalFn: () => { cleared = true; }, clientFactory: () => ({ session: { create: async () => ({ data: { id: 'session-1' } }), promptAsync: async () => ({ data: { info: { id: 'user-1' } } }), messages: async () => ({ data: [{ info: { id: 'assistant-1', role: 'assistant', parentID: 'user-1', time: { completed: 4 } } }] }) } }) });
    const assistant = service.createAssistant({ name: 'A', providerID: 'p', modelID: 'm', mode: 'continuous', skillRoots: [] });
    service.submit('op-1', assistant.inboxTopicID, [{ type: 'text', text: 'one' }]);
    await new Promise((resolve) => setTimeout(resolve, 20)); tick(); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await service.operation('op-1')).toMatchObject({ state: 'completed', messageID: 'user-1' });
    service.close(); expect(cleared).toBe(true);
  });

  it('serializes message, new, and compact admission per topic', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistants-'));
    const service = createAssistantsService({ dbPath: path.join(root, 'assistants.sqlite'), dataDir: root, buildOpenCodeUrl: () => 'http://127.0.0.1:1', getOpenCodeAuthHeaders: () => ({}) });
    const assistant = service.createAssistant({ name: 'A', providerID: 'p', modelID: 'm', mode: 'continuous', skillRoots: [] });
    service.submit('message', assistant.inboxTopicID, [{ type: 'text', text: 'one' }]);
    expect(() => service.newTopic('new', assistant.inboxTopicID)).toThrow(expect.objectContaining({ code: 'topic_busy' }));
    expect(() => service.compact('compact', assistant.inboxTopicID)).toThrow(expect.objectContaining({ code: 'topic_busy' }));
    service.close();
  });

  it('rejects disabled and tombstoned topic ownership for direct topic work', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistants-'));
    const service = createAssistantsService({ dbPath: path.join(root, 'assistants.sqlite'), dataDir: root, buildOpenCodeUrl: () => 'http://127.0.0.1:1', getOpenCodeAuthHeaders: () => ({}) });
    const assistant = service.createAssistant({ name: 'A', providerID: 'p', modelID: 'm', mode: 'continuous', skillRoots: [] });
    service.updateAssistant(assistant.id, { expectedRevision: assistant.revision, enabled: false });
    expect(() => service.submit('disabled', assistant.inboxTopicID, [{ type: 'text', text: 'one' }])).toThrow(expect.objectContaining({ code: 'assistant_disabled' }));
    service.updateAssistant(assistant.id, { expectedRevision: 2, enabled: true });
    const topic = service.createTopic(assistant.id);
    service.removeTopic(topic.id, topic.revision);
    expect(() => service.submit('deleted', topic.id, [{ type: 'text', text: 'one' }])).toThrow(expect.objectContaining({ code: 'not_found' }));
    service.close();
  });

  it('accepts native HEIC data URLs and enforces decoded per-image and submission image limits', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistants-'));
    const service = createAssistantsService({ dbPath: path.join(root, 'assistants.sqlite'), dataDir: root, buildOpenCodeUrl: () => 'http://127.0.0.1:1', getOpenCodeAuthHeaders: () => ({}) });
    const assistant = service.createAssistant({ name: 'A', providerID: 'p', modelID: 'm', mode: 'continuous', skillRoots: [] });
    expect(() => service.submit('remote-image', assistant.inboxTopicID, [{ type: 'file', mime: 'image/png', url: 'https://example.test/image.png' }])).toThrow(expect.objectContaining({ code: 'validation_error' }));
    expect(service.submit('image', assistant.inboxTopicID, [{ type: 'file', mime: 'image/heic', url: 'data:image/heic;base64,aGVsbG8=' }])).toMatchObject({ state: 'running' });
    const image = (bytes) => ({ type: 'file', mime: 'image/png', url: `data:image/png;base64,${Buffer.alloc(bytes).toString('base64')}` });
    expect(() => service.submit('too-large-image', assistant.inboxTopicID, [image(8 * 1024 * 1024 + 1)])).toThrow(expect.objectContaining({ code: 'image_too_large' }));
    expect(() => service.submit('too-many-images', assistant.inboxTopicID, [image(6 * 1024 * 1024), image(6 * 1024 * 1024), image(6 * 1024 * 1024)])).toThrow(expect.objectContaining({ code: 'images_too_large' }));
    service.close();
  });
});
