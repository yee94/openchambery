import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActiveRuntime } from '@/lib/connectionController';
import * as client from '@/lib/openchamberClient';
import {
  AssistantsApiError,
  deleteAssistant,
  fetchAssistantCapability,
  fetchAssistantSnapshot,
  newAssistantSession,
  parseAssistantCapability,
  parseAssistantDTO,
  parseAssistantSnapshot,
  parseSessionBinding,
  setAssistantsEnabled,
} from '@/lib/assistantsApi';
import { getAssistantPresentation } from '@/lib/assistantPresentation';

const active = {
  clientToken: 'tok',
  transport: { kind: 'direct', url: 'http://127.0.0.1:2606' },
} as ActiveRuntime;

afterEach(() => {
  vi.restoreAllMocks();
});

const mockJson = (status: number, body: unknown) => {
  vi.spyOn(client, 'openchamberFetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
};

const fixtureAssistant = {
  id: 'assistant_fixture',
  revision: 4,
  enabled: true,
  name: '🤖 Fixture',
  defaultPrompt: 'hello',
  workspacePath: null,
  managedWorkspacePath: '/data/assistant-workspaces/assistant_fixture',
  effectiveWorkspacePath: '/workspace',
  providerID: 'provider_fixture',
  modelID: 'model_fixture',
  agent: null,
  variant: null,
  mode: 'continuous',
  sessionID: 'ses_fixture',
  sessionGeneration: 4,
  historySessionIDs: [],
  historySessionCount: 0,
  createdAt: 1234,
  updatedAt: 1234,
  tombstoneAt: null,
};

describe('assistant DTO parse', () => {
  it('parses capability / snapshot / binding', () => {
    expect(
      parseAssistantCapability({
        supported: true,
        enabled: false,
        revision: 3,
        serverInstanceID: null,
      }),
    ).toEqual({
      supported: true,
      enabled: false,
      revision: 3,
      serverInstanceID: null,
    });

    const snapshot = parseAssistantSnapshot({
      revision: 1,
      enabled: true,
      assistants: [fixtureAssistant],
    });
    expect(snapshot.assistants[0]?.sessionID).toBe('ses_fixture');
    expect(snapshot.assistants[0]?.mode).toBe('continuous');

    expect(
      parseSessionBinding({
        sessionID: 'ses_fixture',
        directory: '/workspace',
        sessionGeneration: 4,
      }),
    ).toEqual({
      sessionID: 'ses_fixture',
      directory: '/workspace',
      sessionGeneration: 4,
    });
  });

  it('rejects incomplete assistants', () => {
    expect(() => parseAssistantDTO({ id: 'a' })).toThrow(AssistantsApiError);
    expect(() =>
      parseAssistantSnapshot({ revision: 1, enabled: true, assistants: [{ id: 'a' }] }),
    ).toThrow(AssistantsApiError);
  });
});

describe('getAssistantPresentation', () => {
  it('splits leading emoji from display name', () => {
    expect(getAssistantPresentation('🤖 Fixture')).toEqual({
      avatarEmoji: '🤖',
      displayName: 'Fixture',
    });
    expect(getAssistantPresentation('Plain')).toEqual({ displayName: 'Plain' });
  });
});

describe('assistants official APIs', () => {
  it('GETs live snapshot', async () => {
    mockJson(200, { revision: 2, enabled: true, assistants: [fixtureAssistant] });
    const snapshot = await fetchAssistantSnapshot(active);
    expect(client.openchamberFetch).toHaveBeenCalledWith(
      active,
      '/api/openchamber/assistants/snapshot',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(snapshot.assistants).toHaveLength(1);
  });

  it('does not coerce snapshot HTTP failure to empty success', async () => {
    mockJson(500, { error: 'internal_error' });
    await expect(fetchAssistantSnapshot(active)).rejects.toBeInstanceOf(AssistantsApiError);
  });

  it('treats capability 404/501 as unsupported', async () => {
    mockJson(404, { error: 'not_found' });
    await expect(fetchAssistantCapability(active)).resolves.toMatchObject({
      supported: false,
      enabled: false,
    });
  });

  it('PUTs assistants/settings to enable', async () => {
    mockJson(200, { enabled: true, revision: 5 });
    const result = await setAssistantsEnabled(active, true, 4);
    expect(client.openchamberFetch).toHaveBeenCalledWith(
      active,
      '/api/openchamber/assistants/settings',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ enabled: true, expectedRevision: 4 }),
      }),
    );
    expect(result).toEqual({ enabled: true, revision: 5 });
  });

  it('POSTs session/new when opening unbound assistant', async () => {
    mockJson(200, {
      sessionID: 'ses_new',
      directory: '/workspace',
      sessionGeneration: 1,
    });
    const binding = await newAssistantSession(active, 'assistant_fixture');
    expect(client.openchamberFetch).toHaveBeenCalledWith(
      active,
      '/api/openchamber/assistants/assistant_fixture/session/new',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(binding.sessionID).toBe('ses_new');
  });

  it('DELETEs assistant with expectedRevision', async () => {
    mockJson(200, { assistantID: 'assistant_fixture', tombstoneAt: 1 });
    await deleteAssistant(active, { id: 'assistant_fixture', revision: 4 });
    expect(client.openchamberFetch).toHaveBeenCalledWith(
      active,
      '/api/openchamber/assistants/assistant_fixture',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ expectedRevision: 4 }),
      }),
    );
  });
});
