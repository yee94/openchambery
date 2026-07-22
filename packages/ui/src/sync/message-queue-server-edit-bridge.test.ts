import { expect, test } from 'bun:test';
import type { MessageQueueAttachment } from '@/lib/message-queue-server';
import { sessionDraftKey } from './input-draft-types';
import type { DraftCommitInput } from './input-store';
import { createMessageQueueServerEditBridge } from './message-queue-server-edit-bridge';
import type { MessageQueueServerRuntimeCapture } from './message-queue-server-runtime';

const runtime = { transportIdentity: 'runtime', generation: 1 };
const item = {
  queueItemID: 'queue', operationID: 'operation', messageID: 'msg_a', content: '@file', status: 'queued', attemptCount: 0, position: 0, rowVersion: 3, createdAt: 1,
  composerDocument: { text: '@file', references: [] }, composerMentions: [{ kind: 'file', value: 'file', path: '/repo/file', label: 'file', range: { start: 0, end: 5 } }], attachmentIssues: [],
  attachments: [
    { attachmentID: 'one', occurrenceRefID: ['root', 'one'] as const, filename: 'one.bin', mimeType: 'application/octet-stream', size: 1, source: 'local' as const, locator: { kind: 'upload' as const, uploadID: 'upload-one' } },
    { attachmentID: 'two', occurrenceRefID: ['root', 'two'] as const, filename: 'two.bin', mimeType: 'application/octet-stream', size: 1, source: 'server' as const, locator: { kind: 'server-path' as const, path: '/repo/two' } },
  ],
};

test('downloads canonical mixed attachments, retains sidecars, commits then removes', async () => {
  let snapshot: DraftCommitInput['snapshot'] | undefined, removed = 0;
  const bridge = createMessageQueueServerEditBridge({
    queue: { captureRuntime: () => runtime, reserveEdit: async () => ({ revision: 4, scopeID: 'scope', queueItemID: 'queue', rowVersion: 3, token: 'token', expiresAt: 2, generation: 1 }), renewEdit: async () => ({ queueItemID: 'queue', token: 'token', generation: 1, expiresAt: Date.now() + 60_000 }), releaseEdit: async () => {}, removeReserved: async () => { removed++; return true; }, refresh: async () => {} },
    input: { captureDraftRuntime: () => runtime, commitDraftSnapshot: async (input: DraftCommitInput) => { snapshot = input.snapshot; return { status: 'committed', durable: true, current: true, errors: [], cleanupErrors: [] }; } },
    download: async (_queue: string, attachment: Pick<MessageQueueAttachment, 'attachmentID' | 'size' | 'mimeType'>) => new Blob(['x'], { type: attachment.mimeType }), current: () => true,
  } as never);
  const result = await bridge.editServerQueueItemIntoDraft({ scopeID: 'scope', scopeRevision: 4, item, targetKey: sessionDraftKey(runtime, 'session'), expectedRevision: 'absent' });
  expect(result.diagnostics).toEqual([]); expect(result.status).toBe('committed'); expect(removed).toBe(1);
  expect(snapshot?.attachments.map((attachment) => attachment.attachmentID)).toEqual(['one', 'two']);
  expect(snapshot?.composerReferences).toEqual([]); expect(snapshot?.mentions).toEqual(item.composerMentions);
});

test('releases reservation after download failure and retains the queue', async () => {
  let released = 0, committed = 0;
  const bridge = createMessageQueueServerEditBridge({
    queue: { captureRuntime: () => runtime, reserveEdit: async () => ({ revision: 4, scopeID: 'scope', queueItemID: 'queue', rowVersion: 3, token: 'token', expiresAt: 2, generation: 1 }), renewEdit: async () => ({ queueItemID: 'queue', token: 'token', generation: 1, expiresAt: Date.now() + 60_000 }), releaseEdit: async () => { released++; }, removeReserved: async () => true, refresh: async () => {} },
    input: { captureDraftRuntime: () => runtime, commitDraftSnapshot: async () => { committed++; throw new Error('unreachable'); } }, download: async () => { throw new Error('download'); }, current: () => true,
  } as never);
  const result = await bridge.editServerQueueItemIntoDraft({ scopeID: 'scope', scopeRevision: 4, item, targetKey: sessionDraftKey(runtime, 'session'), expectedRevision: 'absent' });
  expect(result.status).toBe('materialize-failed'); expect(released).toBe(1); expect(committed).toBe(0);
});

test('shares duplicate clicks and fences a stale runtime before draft commit', async () => {
  let reserves = 0, committed = 0;
  const bridge = createMessageQueueServerEditBridge({
    queue: { captureRuntime: () => runtime, reserveEdit: async () => { reserves++; return { revision: 4, scopeID: 'scope', queueItemID: 'queue', rowVersion: 3, token: 'token', expiresAt: 2, generation: 1 }; }, renewEdit: async () => ({ queueItemID: 'queue', token: 'token', generation: 1, expiresAt: Date.now() + 60_000 }), releaseEdit: async () => {}, removeReserved: async () => true, refresh: async () => {} },
    input: { captureDraftRuntime: () => runtime, commitDraftSnapshot: async () => { committed++; return { status: 'committed', durable: true, current: true, errors: [], cleanupErrors: [] }; } }, download: async (_queue: string, attachment: Pick<MessageQueueAttachment, 'attachmentID' | 'size' | 'mimeType'>) => new Blob(['x'], { type: attachment.mimeType }), current: () => false,
  } as never);
  const input = { scopeID: 'scope', scopeRevision: 4, item, targetKey: sessionDraftKey(runtime, 'session'), expectedRevision: 'absent' as const };
  const firstFlight = bridge.editServerQueueItemIntoDraft(input), secondFlight = bridge.editServerQueueItemIntoDraft(input);
  expect(firstFlight).toBe(secondFlight);
  const [first, second] = await Promise.all([firstFlight, secondFlight]);
  expect(first.status).toBe('materialize-failed'); expect(second).toEqual(first); expect(reserves).toBe(1); expect(committed).toBe(0);
});

test('isolates same queue item edit flights across runtime generations', async () => {
  let activeRuntime = runtime, reserves = 0, commits = 0, releaseFirstDownload!: () => void;
  const bridge = createMessageQueueServerEditBridge({
    queue: { captureRuntime: () => activeRuntime, reserveEdit: async () => { reserves++; return { revision: 4, scopeID: 'scope', queueItemID: 'queue', rowVersion: 3, token: `token-${activeRuntime.generation}`, expiresAt: Date.now() + 60_000, generation: activeRuntime.generation }; }, renewEdit: async (request: { generation: number }) => ({ queueItemID: 'queue', token: `token-${request.generation}`, generation: request.generation, expiresAt: Date.now() + 60_000 }), releaseEdit: async () => {}, removeReserved: async () => true, refresh: async () => {} },
    input: { captureDraftRuntime: () => activeRuntime, commitDraftSnapshot: async () => { commits++; return { status: 'committed', durable: true, current: true, errors: [], cleanupErrors: [] }; } },
    download: async (_queue: string, attachment: Pick<MessageQueueAttachment, 'attachmentID' | 'size' | 'mimeType'>) => { if (reserves === 1) await new Promise<void>((resolve) => { releaseFirstDownload = resolve; }); return new Blob(['x'], { type: attachment.mimeType }); },
    current: (capture: MessageQueueServerRuntimeCapture) => capture.transportIdentity === activeRuntime.transportIdentity && capture.generation === activeRuntime.generation,
  } as never);
  const first = bridge.editServerQueueItemIntoDraft({ scopeID: 'scope', scopeRevision: 4, item: { ...item, attachments: [item.attachments[0]!] }, targetKey: sessionDraftKey(runtime, 'session'), expectedRevision: 'absent' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  activeRuntime = { transportIdentity: 'runtime', generation: 2 };
  const second = bridge.editServerQueueItemIntoDraft({ scopeID: 'scope', scopeRevision: 4, item, targetKey: sessionDraftKey(activeRuntime, 'session'), expectedRevision: 'absent' });
  expect(second).not.toBe(first); expect(reserves).toBe(2);
  const secondResult = await second;
  releaseFirstDownload();
  const firstResult = await first;
  expect(firstResult.diagnostics).toEqual([{ stage: 'identity', code: 'runtime-stale' }]); expect(secondResult.status).toBe('committed'); expect(commits).toBe(1);
});

test('returns a materialize diagnostic when runtime capture throws', async () => {
  const bridge = createMessageQueueServerEditBridge({ queue: { captureRuntime: () => { throw new Error('runtime'); } } } as never);
  const result = await bridge.editServerQueueItemIntoDraft({ scopeID: 'scope', scopeRevision: 4, item, targetKey: sessionDraftKey(runtime, 'session'), expectedRevision: 'absent' });
  expect(result.status).toBe('materialize-failed'); expect(result.diagnostics).toEqual([{ stage: 'identity', code: 'runtime-capture-failed' }]);
});

test('treats a mismatched renew acknowledgement as a lost lease', async () => {
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((callback: TimerHandler) => { void (callback as () => void)(); return 0 as unknown as ReturnType<typeof setInterval>; }) as unknown as typeof setInterval;
  try {
    const bridge = createMessageQueueServerEditBridge({
      queue: { captureRuntime: () => runtime, reserveEdit: async () => ({ revision: 4, scopeID: 'scope', queueItemID: 'queue', rowVersion: 3, token: 'token', expiresAt: 2, generation: 1 }), renewEdit: async () => ({ queueItemID: 'other', token: 'token', expiresAt: 3, generation: 1 }), releaseEdit: async () => {}, removeReserved: async () => true, refresh: async () => {} },
      input: { captureDraftRuntime: () => runtime, commitDraftSnapshot: async () => ({ status: 'committed', durable: true, current: true, errors: [], cleanupErrors: [] }) },
      download: async (_queue: string, attachment: Pick<MessageQueueAttachment, 'attachmentID' | 'size' | 'mimeType'>) => new Blob(['x'], { type: attachment.mimeType }), current: () => true,
    } as never);
    const result = await bridge.editServerQueueItemIntoDraft({ scopeID: 'scope', scopeRevision: 4, item, targetKey: sessionDraftKey(runtime, 'session'), expectedRevision: 'absent' });
    expect(result.status).toBe('materialize-failed'); expect(result.diagnostics).toEqual([{ stage: 'identity', code: 'lease-lost' }]);
  } finally { globalThis.setInterval = originalSetInterval; }
});

test('shares heartbeat renew flight and fences a delayed expired acknowledgement before draft commit', async () => {
  const originalSetInterval = globalThis.setInterval, originalClearInterval = globalThis.clearInterval;
  let heartbeat!: () => void, cleared = 0, releaseDownload!: () => void, resolveRenew!: (value: { queueItemID: string; token: string; generation: number; expiresAt: number }) => void, renews = 0, commits = 0;
  globalThis.setInterval = ((callback: TimerHandler) => { heartbeat = callback as () => void; return 1 as unknown as ReturnType<typeof setInterval>; }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => { cleared++; }) as typeof clearInterval;
  try {
    const bridge = createMessageQueueServerEditBridge({
      queue: { captureRuntime: () => runtime, reserveEdit: async () => ({ revision: 4, scopeID: 'scope', queueItemID: 'queue', rowVersion: 3, token: 'token', expiresAt: Date.now() + 60_000, generation: 1 }), renewEdit: async () => { renews++; return new Promise<{ queueItemID: string; token: string; generation: number; expiresAt: number }>((resolve) => { resolveRenew = resolve; }); }, releaseEdit: async () => {}, removeReserved: async () => true, refresh: async () => {} },
      input: { captureDraftRuntime: () => runtime, commitDraftSnapshot: async () => { commits++; return { status: 'committed', durable: true, current: true, errors: [], cleanupErrors: [] }; } },
      download: async (_queue: string, attachment: Pick<MessageQueueAttachment, 'attachmentID' | 'size' | 'mimeType'>) => { await new Promise<void>((resolve) => { releaseDownload = resolve; }); return new Blob(['x'], { type: attachment.mimeType }); }, current: () => true,
    } as never);
    const editing = bridge.editServerQueueItemIntoDraft({ scopeID: 'scope', scopeRevision: 4, item: { ...item, attachments: [item.attachments[0]!] }, targetKey: sessionDraftKey(runtime, 'session'), expectedRevision: 'absent' });
    await new Promise((resolve) => setTimeout(resolve, 0)); heartbeat(); heartbeat(); await Promise.resolve(); expect(renews).toBe(1);
    releaseDownload(); resolveRenew({ queueItemID: 'queue', token: 'token', generation: 1, expiresAt: Date.now() });
    const result = await editing; expect(result.status).toBe('materialize-failed'); expect(result.diagnostics).toEqual([{ stage: 'identity', code: 'lease-lost' }]); expect(commits).toBe(0); expect(cleared).toBe(1);
  } finally { globalThis.setInterval = originalSetInterval; globalThis.clearInterval = originalClearInterval; }
});

test('rejects oversized metadata before downloads and bounds 64 downloads to four concurrent requests', async () => {
  let downloads = 0;
  const oversized = { ...item, attachments: [{ ...item.attachments[0]!, size: 50 * 1024 * 1024 + 1 }] };
  const oversizedBridge = createMessageQueueServerEditBridge({
    queue: { captureRuntime: () => runtime, reserveEdit: async () => ({ revision: 4, scopeID: 'scope', queueItemID: 'queue', rowVersion: 3, token: 'token', expiresAt: Date.now() + 60_000, generation: 1 }), renewEdit: async () => ({ queueItemID: 'queue', token: 'token', generation: 1, expiresAt: Date.now() + 60_000 }), releaseEdit: async () => {}, removeReserved: async () => true, refresh: async () => {} },
    input: { captureDraftRuntime: () => runtime, commitDraftSnapshot: async () => ({ status: 'committed', durable: true, current: true, errors: [], cleanupErrors: [] }) }, download: async () => { downloads++; return new Blob(); }, current: () => true,
  } as never);
  const oversizedResult = await oversizedBridge.editServerQueueItemIntoDraft({ scopeID: 'scope', scopeRevision: 4, item: oversized, targetKey: sessionDraftKey(runtime, 'session'), expectedRevision: 'absent' }); expect(oversizedResult.diagnostics).toEqual([{ stage: 'attachments', code: 'attachments-too-large' }]); expect(downloads).toBe(0);

  let active = 0, maximum = 0;
  const attachments = Array.from({ length: 64 }, (_, index) => ({ ...item.attachments[index % 2]!, attachmentID: `attachment-${index}`, occurrenceRefID: ['root', `attachment-${index}`] as const }));
  const bridge = createMessageQueueServerEditBridge({
    queue: { captureRuntime: () => runtime, reserveEdit: async () => ({ revision: 4, scopeID: 'scope', queueItemID: 'queue', rowVersion: 3, token: 'token', expiresAt: Date.now() + 60_000, generation: 1 }), renewEdit: async () => ({ queueItemID: 'queue', token: 'token', generation: 1, expiresAt: Date.now() + 60_000 }), releaseEdit: async () => {}, removeReserved: async () => true, refresh: async () => {} },
    input: { captureDraftRuntime: () => runtime, commitDraftSnapshot: async () => ({ status: 'committed', durable: true, current: true, errors: [], cleanupErrors: [] }) },
    download: async (_queue: string, attachment: Pick<MessageQueueAttachment, 'attachmentID' | 'size' | 'mimeType'>) => { active++; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 1)); active--; return new Blob(['x'], { type: attachment.mimeType }); }, current: () => true,
  } as never);
  const boundedResult = await bridge.editServerQueueItemIntoDraft({ scopeID: 'scope', scopeRevision: 4, item: { ...item, attachments }, targetKey: sessionDraftKey(runtime, 'session'), expectedRevision: 'absent' }); expect(boundedResult.status).toBe('committed'); expect(maximum <= 4).toBe(true);
});
