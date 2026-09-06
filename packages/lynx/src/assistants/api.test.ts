import { describe, expect, test } from 'vitest';

import type { LynxHttpResponse } from '../connection/types';
import { loadAssistantSnapshot, ensureAssistantSession } from './api';
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
