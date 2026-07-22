import { describe, expect, test } from 'bun:test';
import { draftKeyString, sessionDraftKey, surfaceDraftKey } from '@/sync/input-draft-types';
import { assertChatInputSurfaceReady, isChatInputCommandAllowed, resolveChatInputDraftBusy, resolveChatInputSurface, type ChatInputBackend, type ChatInputPrimarySurface, type ChatInputSelection, type ChatInputSurface } from './chatInputSurface';

const backend: ChatInputBackend = { send: async () => undefined, sendQueued: async () => undefined, create: async () => undefined, compact: async () => undefined, abort: async () => undefined };
const selection = { value: { providerID: 'provider', modelID: 'model', agent: 'agent', variant: 'variant' }, flush: async () => {} };

const surface = (surfaceID: string, sessionID: string): ChatInputSurface => ({
  kind: surfaceID === 'primary' ? 'primary' : 'secondary',
  surfaceID,
  active: true,
  sessionID,
  directory: `/work/${surfaceID}`,
  draftKey: surfaceDraftKey({ transportIdentity: 'runtime' }, surfaceID),
  transportIdentity: 'runtime',
  runtimeGeneration: 1,
  selection,
  backend,
  activity: { phase: 'idle' },
  resources: {
    busy: false,
    attachments: [], addAttachment: async () => {}, removeAttachment: () => {}, clearAttachments: () => {}, setAttachments: () => {}, pendingInput: null, consumePendingInput: () => null, pendingPreset: null, consumePendingPreset: () => null,
    consumeSyntheticParts: () => null, restoreSyntheticParts: () => {}, inlineDrafts: [], removeInlineDraft: () => {}, restoreInlineDrafts: () => {}, history: [], captureRuntime: () => ({ transportIdentity: 'runtime', generation: 1 }), getDraft: () => undefined,
    abortPrompt: { sessionID: null, clear: () => {} },
  },
  commands: { sessionID, hasMessages: false, hasNewDraft: false },
  shortcuts: { cycle: () => {}, new: () => {}, abort: () => {}, submit: () => {} },
  deliveryTarget: surfaceID === 'primary' ? { kind: 'primary' } : { kind: 'assistant', assistantID: 'assistant-test' },
});

describe('ChatInput surface contract', () => {
  test('keeps primary session draft keys compatible', () => {
    expect(draftKeyString(sessionDraftKey({ transportIdentity: 'runtime' }, 'ses_1'))).toBe('["runtime","session","ses_1"]');
  });

  test('isolates two surface draft and shortcut identities', () => {
    const first = surface('assistant-1', 'ses_a');
    const second = surface('assistant-2', 'ses_b');
    expect(draftKeyString(first.draftKey!)).not.toBe(draftKeyString(second.draftKey!));
    expect(first.surfaceID).not.toBe(second.surfaceID);
  });

  test('uses the supplied surface and applies its command policy', () => {
    const primary = surface('primary', 'ses_primary') as ChatInputPrimarySurface;
    const assistant = { ...surface('assistant', 'ses_assistant'), commandPolicy: (command: { name: string }) => command.name !== 'fork' };
    expect(resolveChatInputSurface(primary, assistant)).toBe(assistant);
    expect(isChatInputCommandAllowed(assistant, { name: 'fork', source: 'openchamber' })).toBe(false);
    expect(isChatInputCommandAllowed(assistant, { name: 'compact', source: 'openchamber' })).toBe(true);
  });

  test('keeps a secondary selection catalog scoped to its surface', () => {
    const workspaceCatalog: NonNullable<ChatInputSelection['catalog']> = {
      providers: [{ id: 'workspace-provider', models: [{ id: 'workspace-model' }] }],
      agents: [{ name: 'workspace-agent', mode: 'primary' } as NonNullable<ChatInputSelection['catalog']>['agents'][number]],
      variants: ['low', 'high'],
      variantsReady: true,
      ready: true,
      error: false,
    };
    const globalCatalog: NonNullable<ChatInputSelection['catalog']> = {
      providers: [{ id: 'global-provider', models: [{ id: 'global-model' }] }],
      agents: [{ name: 'global-agent', mode: 'primary' } as NonNullable<ChatInputSelection['catalog']>['agents'][number]],
      variants: [],
      variantsReady: true,
      ready: true,
      error: false,
    };
    const workspaceSurface = { ...surface('assistant-workspace', 'ses_workspace'), selection: { ...selection, catalog: workspaceCatalog } };
    const globalSurface = { ...surface('assistant-global', 'ses_global'), selection: { ...selection, catalog: globalCatalog } };

    expect(resolveChatInputSurface(surface('primary', 'ses_primary') as ChatInputPrimarySurface, workspaceSurface).selection.catalog).toBe(workspaceCatalog);
    expect(resolveChatInputSurface(surface('primary', 'ses_primary') as ChatInputPrimarySurface, globalSurface).selection.catalog).toBe(globalCatalog);
    expect(workspaceSurface.selection.catalog?.agents[0]?.name).toBe('workspace-agent');
    expect(globalSurface.selection.catalog?.agents[0]?.name).toBe('global-agent');
    expect(workspaceSurface.selection.catalog?.variants).toEqual(['low', 'high']);
    expect(globalSurface.selection.catalog?.variants).toEqual([]);
  });

  test('preserves the primary session, directory, selection, and backend mapping', async () => {
    const primary = surface('primary', 'ses_primary') as ChatInputPrimarySurface;
    let flushed = false;
    let aborted = '';
    primary.selection.flush = async () => { flushed = true; };
    primary.backend.abort = async (request) => { aborted = request.sessionID ?? ''; };
    const resolved = resolveChatInputSurface(primary);

    await resolved.selection.flush();
    await resolved.backend.abort({ operation: 'abort', surfaceID: resolved.surfaceID, transportIdentity: resolved.transportIdentity, runtimeGeneration: resolved.runtimeGeneration, sessionID: resolved.sessionID, directory: resolved.directory!, draftKey: resolved.draftKey!, deliveryTarget: resolved.deliveryTarget });

    expect(resolved.directory).toBe('/work/primary');
    expect(resolved.selection.value).toEqual({ providerID: 'provider', modelID: 'model', agent: 'agent', variant: 'variant' });
    expect(flushed).toBe(true);
    expect(aborted).toBe('ses_primary');
  });

  test('fails closed for an incomplete secondary surface', () => {
    const incomplete = { ...surface('assistant', 'ses_assistant'), directory: '' } as ChatInputSurface;
    expect(() => assertChatInputSurfaceReady(incomplete)).toThrow('chat-input-secondary-surface-incomplete');
  });

  test('requires commands and every secondary shortcut handler', () => {
    const incomplete = surface('assistant', 'ses_assistant') as Extract<ChatInputSurface, { kind: 'secondary' }>;
    expect(() => assertChatInputSurfaceReady({ ...incomplete, commands: undefined })).toThrow('chat-input-secondary-surface-incomplete');
    expect(() => assertChatInputSurfaceReady({ ...incomplete, shortcuts: undefined })).toThrow('chat-input-secondary-surface-incomplete');
    expect(() => assertChatInputSurfaceReady({ ...incomplete, resources: { ...incomplete.resources!, busy: undefined } })).toThrow('chat-input-secondary-surface-incomplete');
  });

  test('resolves secondary draft busy state from its own resources', () => {
    const secondary = { ...surface('assistant', 'ses_assistant'), resources: { ...surface('assistant', 'ses_assistant').resources!, busy: true } };
    const primary = surface('primary', 'ses_primary') as ChatInputPrimarySurface;

    expect(resolveChatInputDraftBusy(secondary, false)).toBe(true);
    expect(resolveChatInputDraftBusy(primary, true)).toBe(true);
  });
});
