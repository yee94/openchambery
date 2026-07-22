import { describe, expect, test } from 'bun:test';
import { createMessageQueueShadowImporter, type MessageQueueShadowImportState } from './message-queue-shadow-import';
import type { MessageQueueRuntime } from './message-queue-runtime';
import type { QueueItemDTO } from '@/stores/message-queue-ledger';
import type { MessageQueueAdmissionItem } from '@/lib/message-queue-server';

const capture = { transportIdentity: 'transport', generation: 1 };
const item = (status: QueueItemDTO['status'] = 'queued', attachments: QueueItemDTO['attachments'] = []): QueueItemDTO => ({ version: 1, queueItemID: `queue-${status}`, operationID: `operation-${status}`, messageID: `message-${status}`, owner: { state: 'bound', transportIdentity: 'transport', directory: '/repo', sessionID: 'session' }, content: status, attachments, attachmentIssues: [], createdAt: 1, status, attemptCount: 2, ...(status === 'retrying' ? { nextAttemptAt: 3, failureKind: 'pre-dispatch' as const } : {}), ...(status === 'reconciling' ? { reconciliationStartedAt: 1, reconciliationDeadlineAt: 4, reconciliationChecks: 1, reconciliationNextCheckAt: 2, failureKind: 'ambiguous-dispatch' as const } : {}), ...(status === 'unresolved' ? { reconciliationStartedAt: 1, reconciliationDeadlineAt: 4, reconciliationChecks: 1, reconciliationNextCheckAt: 2, failureKind: 'ambiguous-dispatch' as const } : {}), ...(status === 'failed' ? { failureKind: 'definitive' as const } : {}) });
const attachment = (id: string, occurrence: string, source: 'local' | 'server' = 'local'): QueueItemDTO['attachments'][number] => ({ version: 1, attachmentID: id, occurrenceRefID: occurrence, filename: `${id}.txt`, mimeType: 'text/plain', size: 1, source, ...(source === 'server' ? { serverPath: `/repo/${id}.txt` } : {}), locator: { kind: 'blob', blobID: id } });
const queue = (items: QueueItemDTO[], values = new Map<string, Blob | string>()): MessageQueueRuntime => ({ captureRuntime: () => ({ transportIdentity: 'transport', generation: 1, isCurrent: () => true }), hydrate: async () => ({ status: 'committed', errors: [], cleanupErrors: [] }), getState: () => ({ hydration: 'ready', enabled: true, issues: [], snapshot: { version: 4, queues: { scope: items }, migration: { v3State: 'complete' } } }), acquireSendPayload: async (identity: { queueItemID: string }) => ({ status: 'committed', errors: [], cleanupErrors: [], token: `token-${identity.queueItemID}` as never, values: items.find((entry) => entry.queueItemID === identity.queueItemID)?.attachments.map((entry) => ({ attachment: entry, value: values.get(entry.occurrenceRefID)! })) }), releaseSend: async () => ({ status: 'committed', errors: [], cleanupErrors: [] }) } as unknown as MessageQueueRuntime);
const create = (items: QueueItemDTO[], options: { values?: Map<string, Blob | string>; existing?: Array<{ queueItemID: string; operationID: string; messageID: string }>; admit?: (input: unknown) => Promise<unknown>; refresh?: () => Promise<void>; current?: () => boolean; hydration?: 'ready' | 'recovery-required'; degraded?: boolean } = {}) => {
  const releases: string[] = [];
  const admissions: Array<{ item: MessageQueueAdmissionItem }> = [];
  const states: MessageQueueShadowImportState[] = [];
  const runtime = queue(items, options.values);
  runtime.getState = () => ({ hydration: options.hydration ?? 'ready', enabled: true, issues: [], snapshot: { version: 4, queues: { scope: items }, migration: { v3State: options.degraded ? 'degraded' : 'complete' } } });
  runtime.releaseSend = async (identity) => { releases.push(identity.queueItemID); return { status: 'committed', errors: [], cleanupErrors: [] }; };
  return { releases, admissions, states, importer: createMessageQueueShadowImporter({ queue: runtime, capture: () => capture, current: options.current ?? (() => true), admit: async (input) => { admissions.push(input); await options.admit?.(input); return { revision: 1 }; }, upload: async (candidates) => { const local = candidates[0]; if (!local || local.source !== 'local') throw new Error('local candidate expected'); return { totalBytes: local.value.size, attachments: candidates.map((candidate) => { if (candidate.source !== 'local') throw new Error('local candidate expected'); return { attachmentID: candidate.attachmentID, occurrenceRefID: candidate.occurrenceRefID!, filename: candidate.filename, mimeType: candidate.mimeType, size: candidate.value.size, source: 'local' as const, locator: { kind: 'upload' as const, uploadID: `upload-${candidate.attachmentID}` } }; }) }; }, existing: () => options.existing ?? admissions.map((input) => input.item), refresh: options.refresh ?? (async () => {}), publish: (state) => states.push(state) }) };
};

describe('message queue shadow importer', () => {
  test('maps every durable status and preserves query-only sending states', async () => {
    const items = ['queued', 'retrying', 'sending', 'reconciling', 'failed', 'unresolved'].map((status) => item(status as QueueItemDTO['status']));
    const setup = create(items); const result = await setup.importer.run();
    expect(result.status).toBe('complete'); expect(result.imported).toBe(6); expect(result.canActivate).toBe(true);
    expect(setup.admissions.map((entry) => entry.item.migrationState?.status)).toEqual(['queued', 'retrying', 'reconciling', 'reconciling', 'failed', 'unresolved']);
    expect(setup.releases).toEqual(items.map((entry) => entry.queueItemID));
  });

  test('preserves root/part order, server paths, and releases after admission failure', async () => {
    const root = attachment('root', '["root","root"]', 'server'), part = attachment('part', '["part","p","part"]', 'server'), server = attachment('server', '["root","server"]', 'server');
    const setup = create([item('queued', [root, part, server])], { admit: async () => { throw new Error('admit'); } });
    const result = await setup.importer.run(); expect(result.status).toBe('error');
    expect(setup.releases).toEqual(['queue-queued']);
    expect(setup.admissions[0]?.item.attachments.map((entry) => entry.locator.kind)).toEqual(['server-path', 'server-path', 'server-path']);
  });

  test('keeps bound imports while reporting unbound pending and rejects vscode', async () => {
    const bound = item(), unbound = { ...item(), queueItemID: 'unbound', owner: { state: 'unbound-legacy' as const, sessionID: 'legacy' } };
    const mixed = create([bound, unbound]); const result = await mixed.importer.run(); expect(result.status).toBe('pending'); expect(result.imported).toBe(1); expect(result.canActivate).toBe(false);
    const vscode = attachment('vscode', '["root","vscode"]');
    const malformedVscode = vscode as unknown as Record<string, unknown>;
    malformedVscode.source = 'vscode'; malformedVscode.vscodePath = '/v'; malformedVscode.vscodeSource = 'file';
    expect((await create([item('queued', [vscode])]).importer.run()).status).toBe('degraded');
  });

  test('uses fetch for durable URLs and releases tokens for URL failure', async () => {
    const original = globalThis.fetch; let signal: AbortSignal | undefined;
    globalThis.fetch = (async (_url, init) => { signal = init?.signal ?? undefined; return new Response(new Blob(['x'], { type: 'text/plain' }), { status: 200 }); }) as typeof fetch;
    try {
      const url = attachment('url', '["root","url"]'); url.locator = { kind: 'url', url: 'https://example.test/file' };
      const setup = create([item('queued', [url])]); const imported = await setup.importer.run(); expect(imported.status).toBe('degraded'); expect(signal).toBeDefined(); expect(setup.releases).toEqual(['queue-queued']);
      const failed = create([item('queued', [url])]); globalThis.fetch = (async () => { throw new Error('network'); }) as typeof fetch; expect((await failed.importer.run()).status).toBe('error'); expect(failed.releases).toEqual(['queue-queued']);
    } finally { globalThis.fetch = original; }
  });

  test('fails closed for cross IDs and incomplete catalogs', async () => {
    const current = item(); expect((await create([current], { existing: [{ queueItemID: current.queueItemID, operationID: 'other', messageID: 'other' }] }).importer.run()).status).toBe('degraded');
    expect((await create([current], { existing: [], refresh: async () => {} }).importer.run()).status).toBe('error');
  });

  test('fails closed for production recovery and degraded runtime gates', async () => {
    expect((await create([item()], { hydration: 'recovery-required' }).importer.run()).status).toBe('degraded');
    expect((await create([item()], { degraded: true }).importer.run()).status).toBe('degraded');
  });

  test('releases payload when refresh fails and stale completion stays pending', async () => {
    const refreshed = create([item()], { refresh: async () => { throw new Error('refresh'); } });
    expect((await refreshed.importer.run()).status).toBe('error'); expect(refreshed.releases).toEqual(['queue-queued']);
    let current = true; const stale = create([item()], { current: () => current }); current = false;
    expect((await stale.importer.run()).status).toBe('pending');
  });
});
