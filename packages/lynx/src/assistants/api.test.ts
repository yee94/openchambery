import { describe, expect, test } from 'vitest';

import type { LynxHttpResponse } from '../connection/types';
import {
  createLynxAssistant,
  deleteLynxAssistant,
  ensureAssistantSession,
  loadAssistantSnapshot,
  resolveLynxAssistantCreateDefaults,
  setLynxAssistantsEnabled,
} from './api';
import { parseLynxAssistantSnapshot } from './parse';

const jsonResponse = (status: number, body: unknown): LynxHttpResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const assistant = {
  id: 'asst_1',
  revision: 1,
  enabled: true,
  name: 'Helper',
  defaultPrompt: 'hi',
  workspacePath: '/repo',
  effectiveWorkspacePath: '/repo',
  managedWorkspacePath: null,
  providerID: 'anthropic',
  modelID: 'claude',
  agent: null,
  variant: null,
  mode: 'continuous',
  sessionID: 'ses_1',
  sessionGeneration: 2,
  historySessionIDs: ['ses_0'],
  historySessionCount: 1,
  createdAt: null,
  updatedAt: 2,
  tombstoneAt: null,
};

const draft = {
  enabled: true,
  name: 'Helper',
  defaultPrompt: '',
  workspacePath: null as string | null,
  providerID: 'anthropic',
  modelID: 'claude',
  agent: null as string | null,
  mode: 'continuous' as const,
};

describe('assistants snapshot API', () => {
  test('parses Cap snapshot contract', () => {
    const snapshot = parseLynxAssistantSnapshot({
      revision: 3,
      enabled: true,
      assistants: [assistant],
    });
    expect(snapshot.assistants[0]?.id).toBe('asst_1');
    expect(snapshot.assistants[0]?.mode).toBe('continuous');
  });

  test('loads GET /api/openchamber/assistants/snapshot', async () => {
    const result = await loadAssistantSnapshot(async (path) => {
      expect(path).toBe('/api/openchamber/assistants/snapshot');
      return jsonResponse(200, { revision: 1, enabled: true, assistants: [assistant] });
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.snapshot.assistants).toHaveLength(1);
  });

  test('null runtime is no-runtime, not empty success', async () => {
    expect(await loadAssistantSnapshot(null)).toEqual({ status: 'no-runtime' });
  });

  test('failed GET is failed, not empty catalog', async () => {
    const result = await loadAssistantSnapshot(async () => jsonResponse(500, { error: 'boom' }));
    expect(result.status).toBe('failed');
  });

  test('501 is unsupported', async () => {
    expect(await loadAssistantSnapshot(async () => jsonResponse(501, {}))).toEqual({
      status: 'unsupported',
    });
  });

  test('ensure session hits Cap route', async () => {
    const binding = await ensureAssistantSession(async (path, init) => {
      expect(path).toBe('/api/openchamber/assistants/asst_1/session/ensure');
      expect(init?.method).toBe('POST');
      return jsonResponse(200, { sessionID: 'ses_9', directory: '/repo', sessionGeneration: 4 });
    }, 'asst_1');
    expect(binding).toEqual({ sessionID: 'ses_9', directory: '/repo', sessionGeneration: 4 });
  });

  test('ensure with null sessionID does not invent an id', async () => {
    const binding = await ensureAssistantSession(async () => (
      jsonResponse(200, { sessionID: null, directory: '/repo', sessionGeneration: 1 })
    ), 'asst_1');
    expect(binding.sessionID).toBeNull();
  });
});

describe('assistants create / enable / delete', () => {
  test('createLynxAssistant POSTs Cap draft and parses DTO', async () => {
    const result = await createLynxAssistant(async (path, init) => {
      expect(path).toBe('/api/openchamber/assistants');
      expect(init?.method).toBe('POST');
      expect(init?.headers?.['Content-Type']).toBe('application/json');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        name: 'Helper',
        providerID: 'anthropic',
        modelID: 'claude',
        mode: 'continuous',
      });
      return jsonResponse(201, assistant);
    }, draft);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.assistant.id).toBe('asst_1');
  });

  test('createLynxAssistant null runtime is no-runtime (never fake-success)', async () => {
    expect(await createLynxAssistant(null, draft)).toEqual({ status: 'no-runtime' });
  });

  test('createLynxAssistant HTTP failure stays failed', async () => {
    const result = await createLynxAssistant(async () => (
      jsonResponse(400, { error: 'validation_error' })
    ), draft);
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error.message).toBe('validation_error');
    expect(result.httpStatus).toBe(400);
  });

  test('setLynxAssistantsEnabled PUTs settings with expectedRevision', async () => {
    const result = await setLynxAssistantsEnabled(async (path, init) => {
      expect(path).toBe('/api/openchamber/assistants/settings');
      expect(init?.method).toBe('PUT');
      expect(JSON.parse(String(init?.body))).toEqual({ enabled: true, expectedRevision: 7 });
      return jsonResponse(200, { enabled: true, revision: 8 });
    }, { enabled: true, expectedRevision: 7 });
    expect(result).toEqual({ status: 'ok' });
  });

  test('setLynxAssistantsEnabled no-runtime / failure honest', async () => {
    expect(await setLynxAssistantsEnabled(null, { enabled: true, expectedRevision: 1 })).toEqual({
      status: 'no-runtime',
    });
    const failed = await setLynxAssistantsEnabled(async () => (
      jsonResponse(409, { error: 'revision_conflict' })
    ), { enabled: false, expectedRevision: 1 });
    expect(failed.status).toBe('failed');
    if (failed.status !== 'failed') return;
    expect(failed.error.message).toBe('revision_conflict');
  });

  test('deleteLynxAssistant DELETEs with expectedRevision', async () => {
    const result = await deleteLynxAssistant(async (path, init) => {
      expect(path).toBe('/api/openchamber/assistants/asst_1');
      expect(init?.method).toBe('DELETE');
      expect(JSON.parse(String(init?.body))).toEqual({ expectedRevision: 3 });
      return jsonResponse(200, {});
    }, { id: 'asst_1', expectedRevision: 3 });
    expect(result).toEqual({ status: 'ok' });
  });

  test('deleteLynxAssistant no-runtime / failure honest', async () => {
    expect(await deleteLynxAssistant(null, { id: 'asst_1', expectedRevision: 1 })).toEqual({
      status: 'no-runtime',
    });
    const failed = await deleteLynxAssistant(async () => (
      jsonResponse(409, { error: 'revision_conflict' })
    ), { id: 'asst_1', expectedRevision: 1 });
    expect(failed.status).toBe('failed');
  });

  test('resolveLynxAssistantCreateDefaults picks first provider/model', async () => {
    const result = await resolveLynxAssistantCreateDefaults(async (path) => {
      expect(path).toBe('/api/config/providers');
      return jsonResponse(200, {
        providers: [
          { id: 'anthropic', models: [{ id: 'claude-sonnet' }] },
        ],
      });
    });
    expect(result).toEqual({
      status: 'ok',
      providerID: 'anthropic',
      modelID: 'claude-sonnet',
    });
  });

  test('resolveLynxAssistantCreateDefaults empty providers is failed (not invented)', async () => {
    const result = await resolveLynxAssistantCreateDefaults(async () => (
      jsonResponse(200, { providers: [] })
    ));
    expect(result.status).toBe('failed');
  });
});
