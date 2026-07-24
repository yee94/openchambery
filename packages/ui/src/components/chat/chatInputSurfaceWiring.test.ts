import { describe, expect, test } from 'bun:test';
import { surfaceDraftKey } from '@/sync/input-draft-types';
import {
  assertDeliveryRequestRuntimeCurrent,
  createChatInputControllerWiring,
  primarySendOptionsFromDeliveryRequest,
  retainResourcesWhenCommandRejected,
} from './chatInputSurfaceWiring';
import type { ChatInputDeliveryRequest, ChatInputSurface } from './chatInputSurface';
import type { CommandInfo } from './CommandAutocomplete';

const calls: string[] = [];
let queuedRequest: (ChatInputDeliveryRequest & { queueItemID: string }) | null = null;
let lastSendRequest: ChatInputDeliveryRequest | null = null;
const resources = (owner: string) => ({
  attachments: [{ id: `${owner}-attachment` }] as never[], addAttachment: async () => { calls.push(`${owner}:attach`); }, removeAttachment: (id: string) => calls.push(`${owner}:remove:${id}`), clearAttachments: () => calls.push(`${owner}:clear`),
  pendingInput: { text: `${owner} draft`, mode: 'replace' as const }, consumePendingInput: () => { calls.push(`${owner}:pending`); return null; }, pendingPreset: `${owner} preset`, consumePendingPreset: () => { calls.push(`${owner}:preset`); return null; },
  consumeSyntheticParts: () => { calls.push(`${owner}:synthetic`); return null; }, restoreSyntheticParts: () => calls.push(`${owner}:restore-synthetic`), inlineDrafts: [], removeInlineDraft: (id: string) => calls.push(`${owner}:draft:${id}`), restoreInlineDrafts: () => calls.push(`${owner}:restore-drafts`), history: [`${owner} history`], captureRuntime: () => ({ transportIdentity: `runtime-${owner}`, generation: 1 }), getDraft: () => undefined, abortPrompt: { sessionID: null, clear: () => calls.push(`${owner}:clear-abort`) },
});
const surface = (id: string, active = true): ChatInputSurface => ({
  kind: id === 'A' ? 'primary' : 'secondary', surfaceID: id, active, sessionID: `session-${id}`, directory: `/dir/${id}`, draftKey: surfaceDraftKey({ transportIdentity: `runtime-${id}` }, id), transportIdentity: `runtime-${id}`, runtimeGeneration: id === 'A' ? 1 : 2, deliveryTarget: id === 'A' ? { kind: 'primary' } : { kind: 'assistant', assistantID: 'assistant-B' },
  selection: { value: {}, flush: async () => { calls.push(`${id}:selection`); } }, activity: { phase: 'busy', canAbort: true }, resources: resources(id), commands: { sessionID: `session-${id}`, hasMessages: false, hasNewDraft: false }, shortcuts: { cycle: (direction: 1 | -1) => { calls.push(`${id}:cycle:${direction}`); }, new: () => calls.push(`${id}:shortcut-new`), abort: () => calls.push(`${id}:shortcut-abort`), submit: () => calls.push(`${id}:shortcut-submit`) }, commandPolicy: (command: Pick<CommandInfo, 'name' | 'source' | 'isBuiltIn' | 'isSkill'>) => command.name !== 'blocked',
  backend: {
    send: async (request: ChatInputDeliveryRequest) => {
      lastSendRequest = request;
      calls.push(`${id}:send:${request.sessionID}`);
    },
    sendQueued: async (request: ChatInputDeliveryRequest & { queueItemID: string }) => {
      queuedRequest = request;
      calls.push(`${id}:queued:${request.queueItemID}:${request.queueScope?.deliveryTarget.kind}:${request.queueScope?.runtimeGeneration}`);
    },
    create: async (request: ChatInputDeliveryRequest) => { calls.push(`${id}:create:${request.sessionID}`); },
    compact: async (request: ChatInputDeliveryRequest) => { calls.push(`${id}:compact:${request.sessionID}`); },
    abort: async (request: ChatInputDeliveryRequest) => { calls.push(`${id}:abort:${request.sessionID}`); },
  },
} as unknown as ChatInputSurface);

describe('ChatInput surface controller wiring', () => {
  test('routes global A plus secondary B events and resources exclusively to B', async () => {
    const primary = createChatInputControllerWiring(surface('A'))!;
    const secondary = createChatInputControllerWiring(surface('B'))!;
    await secondary.send({ text: 'B' }); await secondary.sendQueued('queued-B'); await secondary.abort(); await secondary.create(); await secondary.compact({}); await secondary.shortcut('cycle', -1); await secondary.shortcut('new'); await secondary.shortcut('abort'); await secondary.shortcut('submit');
    secondary.resources!.consumePendingInput(); secondary.resources!.consumeSyntheticParts(); secondary.resources!.removeAttachment('B-attachment'); secondary.resources!.removeInlineDraft('draft');
    expect(secondary.queueScope).toEqual({ deliveryTarget: { kind: 'assistant', assistantID: 'assistant-B' }, sessionID: 'session-B', directory: '/dir/B', transportIdentity: 'runtime-B', runtimeGeneration: 2 });
    expect(queuedRequest?.queueScope).toEqual({ deliveryTarget: { kind: 'assistant', assistantID: 'assistant-B' }, sessionID: 'session-B', directory: '/dir/B', transportIdentity: 'runtime-B', runtimeGeneration: 2 });
    expect(secondary.canAbort).toBe(true); expect(secondary.canQueue).toBe(true); expect(secondary.resources!.history).toEqual(['B history']); expect(secondary.allowsCommand('blocked')).toBe(false);
    expect(retainResourcesWhenCommandRejected(secondary, 'blocked')).toBe(true); expect(secondary.resources!.attachments.map((attachment) => attachment.id)).toEqual(['B-attachment']);
    expect(calls).toEqual(['B:selection', 'B:shortcut-submit', 'B:send:session-B', 'B:selection', 'B:queued:queued-B:assistant:2', 'B:selection', 'B:abort:session-B', 'B:selection', 'B:create:session-B', 'B:selection', 'B:compact:session-B', 'B:cycle:-1', 'B:shortcut-new', 'B:shortcut-abort', 'B:shortcut-submit', 'B:pending', 'B:synthetic', 'B:remove:B-attachment', 'B:draft:draft']);
    expect(primary.resources!.attachments[0]!.id).toBe('A-attachment');
  });

  test('keeps inactive surfaces out of controller and shortcut registration', () => {
    expect(createChatInputControllerWiring(surface('B', false))).toBeNull();
  });

  test('pins request session and directory identity before selection flush', async () => {
    lastSendRequest = null;
    const mutable: ChatInputSurface = surface('A');
    const wiring = createChatInputControllerWiring(mutable)!;
    (mutable as { selection: { flush: () => Promise<void> } }).selection = {
      ...mutable.selection,
      flush: async () => {
        calls.push('A:selection');
        // Simulate a same-Project session switch after first-submit capture.
        (mutable as { sessionID: string | null }).sessionID = 'session-switched';
        (mutable as { directory: string }).directory = '/dir/switched';
      },
    };
    await wiring.send({ text: 'hello', providerID: 'openai', modelID: 'gpt-5.5' });
    const pinned = lastSendRequest as ChatInputDeliveryRequest | null;
    expect(pinned?.sessionID).toBe('session-A');
    expect(pinned?.directory).toBe('/dir/A');
    expect(pinned?.transportIdentity).toBe('runtime-A');
    expect(pinned?.runtimeGeneration).toBe(1);
  });
});

describe('primary delivery request helpers', () => {
  test('primarySendOptionsFromDeliveryRequest pins existing session and directory', () => {
    expect(primarySendOptionsFromDeliveryRequest({
      sessionID: 'ses_a',
      directory: '/project/a',
      options: { delivery: 'steer', commitStagedMessageEdit: true, messageID: 'msg_draft_first' },
    })).toEqual({
      sessionId: 'ses_a',
      directoryHint: '/project/a',
      delivery: 'steer',
      commitStagedMessageEdit: true,
      messageID: 'msg_draft_first',
    });
  });

  test('primarySendOptionsFromDeliveryRequest prefers first-submit options over surface session', () => {
    expect(primarySendOptionsFromDeliveryRequest({
      sessionID: 'ses_live',
      directory: '/live',
      options: {
        sessionId: 'ses_captured',
        directoryHint: '/captured',
        commitStagedMessageEdit: false,
      },
    })).toEqual({
      sessionId: 'ses_captured',
      directoryHint: '/captured',
      commitStagedMessageEdit: false,
    });
  });

  test('primarySendOptionsFromDeliveryRequest keeps draft materialization without session pin', () => {
    expect(primarySendOptionsFromDeliveryRequest({
      sessionID: null,
      directory: '/project/draft',
      options: { commitStagedMessageEdit: true },
    })).toEqual({
      commitStagedMessageEdit: true,
    });
  });

  test('assertDeliveryRequestRuntimeCurrent rejects stale generation or transport', () => {
    assertDeliveryRequestRuntimeCurrent(
      { transportIdentity: 'runtime-a', runtimeGeneration: 1 },
      { transportIdentity: 'runtime-a', runtimeGeneration: 1 },
    );
    let staleGeneration: unknown;
    try {
      assertDeliveryRequestRuntimeCurrent(
        { transportIdentity: 'runtime-a', runtimeGeneration: 1 },
        { transportIdentity: 'runtime-a', runtimeGeneration: 2 },
      );
    } catch (error) {
      staleGeneration = error;
    }
    expect(staleGeneration instanceof Error ? staleGeneration.message : '').toBe('chat-input-delivery-runtime-stale');
    let staleTransport: unknown;
    try {
      assertDeliveryRequestRuntimeCurrent(
        { transportIdentity: 'runtime-a', runtimeGeneration: 1 },
        { transportIdentity: 'runtime-b', runtimeGeneration: 1 },
      );
    } catch (error) {
      staleTransport = error;
    }
    expect(staleTransport instanceof Error ? staleTransport.message : '').toBe('chat-input-delivery-runtime-stale');
  });
});
