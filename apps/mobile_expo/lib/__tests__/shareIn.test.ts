import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActiveRuntime } from '@/lib/connectionController';
import * as assistantsApi from '@/lib/assistantsApi';
import * as client from '@/lib/openchamberClient';
import {
  buildShareCatalogEntries,
} from '@/lib/shareIn/catalog';
import {
  assignShareDraftRecipient,
  isAssignedShareDraft,
  sortShareRecipientEntries,
} from '@/lib/shareIn/drafts';
import { drainShareItems, retryShareCleanupStage } from '@/lib/shareIn/drain';
import { deliverShareEnvelope } from '@/lib/shareIn/deliver';
import { ascendingId } from '@/lib/shareIn/messageId';
import { buildShareParts } from '@/lib/shareIn/parts';
import {
  MemoryMetaStore,
  setMetaStoreBackend,
} from '@/lib/metaStore';
import {
  parseShareDraft,
  parseShareEnvelope,
  resolveShareTarget,
} from '@/lib/systemShell/share';
import {
  parseShareOperation,
  waitForAssistantShare,
  type ShareOperation,
} from '@/lib/assistantsApi';

const active = {
  connectionId: 'conn-1',
  label: 'Home',
  clientToken: 'tok',
  candidates: [],
  transport: { kind: 'direct', url: 'http://127.0.0.1:2606' },
} as ActiveRuntime;

afterEach(() => {
  vi.restoreAllMocks();
  setMetaStoreBackend(null);
});

describe('share message id', () => {
  it('matches OpenCode ascending shape', () => {
    expect(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(ascendingId('msg'))).toBe(true);
  });
});

describe('share drain queue', () => {
  it('continues after cleanup permanently fails', async () => {
    const delivered: string[] = [];
    let cleanupAttempts = 0;
    await drainShareItems(
      [
        { operationID: 'first', cleanupPhase: 'server-completed' },
        { operationID: 'second' },
      ],
      {
        cleanup: async () =>
          retryShareCleanupStage(async () => {
            cleanupAttempts += 1;
            throw new Error('ack_failed');
          }),
        deliver: async (operationID) => {
          delivered.push(operationID);
        },
      },
      1,
    );
    expect(cleanupAttempts).toBe(3);
    expect(delivered).toEqual(['second']);
  });

  it('serializes multi-server deliver without crossover', async () => {
    const envelopes = [
      { operationID: 'server-a-operation', serverInstanceID: 'server-a' },
      { operationID: 'server-b-operation', serverInstanceID: 'server-b' },
    ];
    const activeServer = { value: '' };
    const events: string[] = [];
    await drainShareItems(
      envelopes.map(({ operationID }) => ({ operationID })),
      {
        cleanup: async () => undefined,
        deliver: async (operationID) => {
          const serverInstanceID = envelopes.find((e) => e.operationID === operationID)
            ?.serverInstanceID;
          if (!serverInstanceID) throw new Error('missing');
          activeServer.value = serverInstanceID;
          events.push(`switch:${serverInstanceID}`);
          await Promise.resolve();
          if (activeServer.value !== serverInstanceID) return;
          events.push(`dispatch:${serverInstanceID}`);
        },
      },
      1,
    );
    expect(events).toEqual([
      'switch:server-a',
      'dispatch:server-a',
      'switch:server-b',
      'dispatch:server-b',
    ]);
  });
});

describe('share parts + catalog', () => {
  it('builds text+file parts and rejects empty', async () => {
    const parts = await buildShareParts(
      {
        text: 'hello',
        attachments: [
          {
            stagedPath: 'data:image/png;base64,aaa',
            originalName: 'a.png',
            mime: 'image/png',
            byteSize: 3,
          },
        ],
      },
      async (a) => a.stagedPath,
    );
    expect(parts).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'file', mime: 'image/png', url: 'data:image/png;base64,aaa' },
    ]);
    await expect(buildShareParts({ text: '  ', attachments: [] })).rejects.toThrow('empty_share');
  });

  it('builds catalog without inventing a default share target', () => {
    const entries = buildShareCatalogEntries({
      serverInstanceID: 'srv',
      connectionKey: 'conn-1',
      serverLabel: 'Home',
      assistantsEnabled: true,
      assistants: [
        {
          id: 'a1',
          revision: 1,
          enabled: true,
          name: '🤖 Bot',
          defaultPrompt: '',
          workspacePath: null,
          effectiveWorkspacePath: '/',
          managedWorkspacePath: null,
          providerID: 'p',
          modelID: 'm',
          agent: null,
          variant: null,
          mode: 'continuous',
          sessionID: null,
          sessionGeneration: 0,
          historySessionIDs: [],
          historySessionCount: 0,
          createdAt: null,
          updatedAt: 1,
          tombstoneAt: null,
        },
      ],
      defaultAssistantID: null,
    });
    expect(entries[0]?.isDefaultShareTarget).toBe(false);
    expect(entries[0]?.name).toBe('Bot');
  });
});

describe('recipient picker assignment', () => {
  it('requires exact catalog pick — no silent default', () => {
    const draft = parseShareDraft({
      version: 1,
      draftID: 'd1',
      text: 'hi',
      attachments: [],
      source: 'android-share',
      createdAt: 1,
      expiresAt: 2,
    });
    expect(draft).not.toBeNull();
    expect(isAssignedShareDraft(draft!)).toBe(false);
    const entry = {
      serverInstanceID: 'srv',
      assistantID: 'asst',
      name: 'Bot',
      avatarSeed: 'asst',
      serverLabel: 'Home',
      connectionKey: 'k',
      enabled: true,
      isDefaultShareTarget: false,
    };
    const assigned = assignShareDraftRecipient(draft!, entry);
    expect(isAssignedShareDraft(assigned)).toBe(true);
    expect(assigned.assistantID).toBe('asst');
    expect(sortShareRecipientEntries([entry, { ...entry, assistantID: 'b', name: 'A', isDefaultShareTarget: true }])[0]
      ?.assistantID).toBe('b');
  });

  it('resolveShareTarget still prefers exact over default', () => {
    const a = {
      serverInstanceID: 'srv',
      assistantID: 'asst',
      name: 'Bot',
      avatarSeed: 'asst',
      serverLabel: 'Home',
      connectionKey: 'k',
      enabled: true,
      isDefaultShareTarget: false,
    };
    const b = { ...a, assistantID: 'def', name: 'Default', isDefaultShareTarget: true };
    expect(resolveShareTarget([a, b], 'srv', 'asst')?.assistantID).toBe('asst');
  });
});

describe('share operation API parsers', () => {
  it('parses share operation and waits until completed', async () => {
    const running: ShareOperation = {
      operationID: 'op1',
      assistantID: 'asst',
      sessionID: null,
      messageID: 'msg_1',
      state: 'running',
      phase: 'dispatch',
      attempt: 1,
      leaseExpiresAt: null,
      errorCode: null,
    };
    const completed: ShareOperation = { ...running, state: 'completed', sessionID: 'ses_1' };
    expect(parseShareOperation(running).state).toBe('running');

    vi.spyOn(client, 'openchamberFetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => completed,
      text: async () => JSON.stringify(completed),
    } as Response);

    const result = await waitForAssistantShare(active, running, {
      maxAttempts: 3,
      delayMs: 0,
      sleep: async () => undefined,
    });
    expect(result.sessionID).toBe('ses_1');
  });
});

describe('deliverShareEnvelope', () => {
  it('POSTs share, reconciles snapshot binding, then acks', async () => {
    setMetaStoreBackend(new MemoryMetaStore());

    const envelope = parseShareEnvelope({
      version: 1,
      operationID: 'op-deliver',
      serverInstanceID: 'srv',
      assistantID: 'asst',
      text: 'hello share',
      attachments: [],
      source: 'ios-share',
      createdAt: 1,
      expiresAt: 99,
    })!;

    const assistant = {
      id: 'asst',
      revision: 1,
      enabled: true,
      name: 'Bot',
      defaultPrompt: '',
      workspacePath: null,
      effectiveWorkspacePath: '/',
      managedWorkspacePath: null,
      providerID: 'p',
      modelID: 'm',
      agent: null,
      variant: null,
      mode: 'continuous' as const,
      sessionID: 'ses_bound',
      sessionGeneration: 1,
      historySessionIDs: [],
      historySessionCount: 0,
      createdAt: null,
      updatedAt: 1,
      tombstoneAt: null,
    };

    vi.spyOn(assistantsApi, 'fetchAssistantCapability').mockResolvedValue({
      supported: true,
      enabled: true,
      revision: 1,
      serverInstanceID: 'srv',
    });
    vi.spyOn(assistantsApi, 'fetchAssistantSnapshot').mockResolvedValue({
      revision: 1,
      enabled: true,
      assistants: [assistant],
    });
    vi.spyOn(assistantsApi, 'sendAssistantShare').mockResolvedValue({
      operationID: 'op-deliver',
      assistantID: 'asst',
      sessionID: 'ses_bound',
      messageID: 'msg_x',
      state: 'completed',
      phase: 'done',
      attempt: 1,
      leaseExpiresAt: null,
      errorCode: null,
    });
    vi.spyOn(assistantsApi, 'waitForAssistantShare').mockResolvedValue({
      operationID: 'op-deliver',
      assistantID: 'asst',
      sessionID: 'ses_bound',
      messageID: 'msg_x',
      state: 'completed',
      phase: 'done',
      attempt: 1,
      leaseExpiresAt: null,
      errorCode: null,
    });

    const opened: string[] = [];
    const shareMod = await import('@/lib/systemShell/share');
    const ack = vi.spyOn(shareMod, 'ackShare').mockResolvedValue(undefined);
    const release = vi.spyOn(shareMod, 'releaseShareFiles').mockResolvedValue(undefined);

    await deliverShareEnvelope(envelope, {
      active,
      connectionKey: 'conn-1',
      onDelivered: (sessionID) => opened.push(sessionID),
    });

    expect(assistantsApi.sendAssistantShare).toHaveBeenCalledWith(
      active,
      'asst',
      'op-deliver',
      expect.stringMatching(/^msg_/),
      [{ type: 'text', text: 'hello share' }],
      'ios-share',
    );
    expect(opened).toEqual(['ses_bound']);
    expect(ack).toHaveBeenCalledWith('op-deliver');
    expect(release).toHaveBeenCalledWith('op-deliver');
  });
});
