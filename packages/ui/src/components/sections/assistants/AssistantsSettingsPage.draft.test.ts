import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssistantDTO, AssistantDraft } from '@/queries/assistantQueries';

const directory = dirname(fileURLToPath(import.meta.url));
const pageSource = () => readFile(join(directory, 'AssistantsSettingsPage.tsx'), 'utf8');

/** Mirrors page `draftFromAssistant` — settings draft owns only editable fields. */
const draftFromAssistant = (assistant: AssistantDTO): AssistantDraft => ({
  enabled: assistant.enabled,
  name: assistant.name,
  defaultPrompt: assistant.defaultPrompt,
  workspacePath: assistant.workspacePath,
  providerID: assistant.providerID,
  modelID: assistant.modelID,
  variant: assistant.variant,
});

/** Mirrors page `toAssistantSettingsUpdateDraft`. */
const toAssistantSettingsUpdateDraft = (draft: AssistantDraft): AssistantDraft => ({
  enabled: draft.enabled,
  name: draft.name,
  defaultPrompt: draft.defaultPrompt,
  workspacePath: draft.workspacePath,
  providerID: draft.providerID,
  modelID: draft.modelID,
  variant: draft.variant ?? null,
});

const assistantFixture = (overrides: Partial<AssistantDTO> = {}): AssistantDTO => ({
  id: 'assistant-1',
  revision: 4,
  enabled: true,
  name: 'Contact',
  defaultPrompt: 'Be helpful',
  workspacePath: '/project',
  effectiveWorkspacePath: '/project',
  managedWorkspacePath: '/managed',
  providerID: 'provider-a',
  modelID: 'model-a',
  agent: 'general',
  variant: 'fast',
  mode: 'stateless',
  sessionID: 'ses-1',
  sessionGeneration: 2,
  historySessionIDs: [],
  historySessionCount: 0,
  assignedSessionIDs: [],
  working: false,
  activeContactTurn: null,
  createdAt: 1,
  updatedAt: 2,
  tombstoneAt: null,
  ...overrides,
});

let lastFetchInit: RequestInit | undefined;
let lastFetchPath: string | undefined;

vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => 'runtime-test',
  getRuntimeGeneration: () => 1,
  isRuntimeEndpointIdentityChange: () => false,
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));

vi.mock('@/lib/session-startup-barrier', () => ({
  waitForSessionStartupBarrier: async () => undefined,
}));

vi.mock('@/lib/queryRuntime', () => ({
  queryClient: {
    setQueryData: () => undefined,
    invalidateQueries: async () => undefined,
    getQueryData: () => undefined,
    fetchQuery: async () => undefined,
  },
}));

vi.mock('@/lib/openchamberEvents', () => ({
  subscribeOpenchamberEvents: () => () => undefined,
}));

vi.mock('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (path: string, init?: RequestInit) => {
    lastFetchPath = path;
    lastFetchInit = init;
    const body = {
      id: 'assistant-1',
      revision: 5,
      enabled: true,
      name: 'Contact',
      defaultPrompt: 'Be helpful',
      workspacePath: '/project',
      effectiveWorkspacePath: '/project',
      managedWorkspacePath: '/managed',
      providerID: 'provider-a',
      modelID: 'model-a',
      agent: 'general',
      variant: 'fast',
      mode: 'stateless',
      sessionID: 'ses-1',
      sessionGeneration: 2,
      historySessionIDs: [],
      historySessionCount: 0,
      assignedSessionIDs: [],
      working: false,
      activeContactTurn: null,
      createdAt: 1,
      updatedAt: 3,
      tombstoneAt: null,
    };
    return new Response(JSON.stringify(body), {
      status: init?.method === 'PATCH' ? 200 : 201,
    });
  },
}));

const { createAssistant, updateAssistant } = await import('@/queries/assistantQueries');

describe('AssistantsSettingsPage draft → save payload', () => {
  beforeEach(() => {
    lastFetchInit = undefined;
    lastFetchPath = undefined;
  });

  afterEach(() => {
    lastFetchInit = undefined;
    lastFetchPath = undefined;
  });

  test('edit save round-trips variant and retains server-owned agent/mode', async () => {
    const assistant = assistantFixture({
      variant: 'fast',
      agent: 'general',
      mode: 'stateless',
    });
    const draft = draftFromAssistant(assistant);
    const updateDraft = toAssistantSettingsUpdateDraft(draft);

    expect(Object.hasOwn(draft, 'agent')).toBe(false);
    expect(draft.variant).toBe('fast');
    expect(Object.hasOwn(draft, 'mode')).toBe(false);
    expect(Object.hasOwn(updateDraft, 'agent')).toBe(false);
    expect(updateDraft.variant).toBe('fast');
    expect(Object.hasOwn(updateDraft, 'mode')).toBe(false);

    await updateAssistant(assistant, updateDraft);

    expect(lastFetchPath).toContain(`/api/openchamber/assistants/${encodeURIComponent(assistant.id)}`);
    expect(lastFetchInit?.method).toBe('PATCH');
    const payload = JSON.parse(String(lastFetchInit?.body)) as Record<string, unknown>;
    expect(Object.hasOwn(payload, 'agent')).toBe(false);
    expect(payload.variant).toBe('fast');
    expect(Object.hasOwn(payload, 'mode')).toBe(false);
    expect(payload).toMatchObject({
      enabled: true,
      name: 'Contact',
      defaultPrompt: 'Be helpful',
      workspacePath: '/project',
      providerID: 'provider-a',
      modelID: 'model-a',
      expectedRevision: 4,
    });
  });

  test('create payload includes variant and omits agent/mode', async () => {
    const createDraft: AssistantDraft = {
      enabled: true,
      name: 'New contact',
      defaultPrompt: 'Hello',
      workspacePath: null,
      providerID: 'provider-b',
      modelID: 'model-b',
      variant: 'high',
    };

    await createAssistant(createDraft);

    expect(lastFetchPath).toBe('/api/openchamber/assistants');
    expect(lastFetchInit?.method).toBe('POST');
    const payload = JSON.parse(String(lastFetchInit?.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      name: 'New contact',
      providerID: 'provider-b',
      modelID: 'model-b',
      defaultPrompt: 'Hello',
      workspacePath: null,
    });
    expect(Object.hasOwn(payload, 'agent')).toBe(false);
    expect(payload.variant).toBe('high');
    expect(Object.hasOwn(payload, 'mode')).toBe(false);
  });

  test('default selection clears a stored variant in the PATCH payload', async () => {
    const assistant = assistantFixture();
    await updateAssistant(assistant, toAssistantSettingsUpdateDraft({ ...draftFromAssistant(assistant), variant: null }));
    expect(JSON.parse(String(lastFetchInit?.body)).variant).toBeNull();
  });

  test('page wires the shared model and variant picker through its draft and save helper', async () => {
    const source = await pageSource();
    const emptyDraft = source.slice(source.indexOf('const emptyDraft'), source.indexOf('const draftFromAssistant'));
    const draftFrom = source.slice(source.indexOf('const draftFromAssistant'), source.indexOf('const toAssistantSettingsUpdateDraft'));
    const updateHelper = source.slice(source.indexOf('const toAssistantSettingsUpdateDraft'), source.indexOf('const projectName'));
    const save = source.slice(source.indexOf('const save = useEvent'), source.indexOf('const remove = useEvent'));

    expect(emptyDraft).not.toMatch(/\bagent\s*:/);
    expect(emptyDraft).toContain('variant: null');
    expect(emptyDraft).not.toMatch(/\bmode\s*:/);
    expect(draftFrom).not.toMatch(/\bagent\s*:/);
    expect(draftFrom).toContain('variant: assistant.variant');
    expect(draftFrom).not.toMatch(/assistant\.mode\b/);
    expect(updateHelper).toContain('providerID: draft.providerID');
    expect(updateHelper).toContain('modelID: draft.modelID');
    expect(updateHelper).not.toMatch(/draft\.agent\b/);
    expect(updateHelper).toContain('variant: draft.variant ?? null');
    expect(source).toContain("variant={draft.variant ?? ''}");
    expect(source).toContain('variant: variant || null');
    expect(updateHelper).not.toMatch(/draft\.mode\b/);
    expect(save).toContain('toAssistantSettingsUpdateDraft(draft)');
    expect(save).toContain('createAssistant(draft)');
  });
});
