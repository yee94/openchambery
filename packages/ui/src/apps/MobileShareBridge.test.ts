import { describe, expect, test } from 'bun:test';
import { drainMobileShareItems, retryMobileShareCleanupStage } from './mobileShareDrain';
import { ascendingId } from '@/sync/message-id';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));

describe('MobileShareBridge contract', () => {
  test('generates an OpenCode-compatible message ID', () => {
    expect(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(ascendingId('msg'))).toBe(true);
  });

  test('continues a fair drain after the first cleanup permanently fails', async () => {
    const delivered: string[] = [];
    let cleanupAttempts = 0;
    await drainMobileShareItems([{ operationID: 'first', cleanupPhase: 'server-completed' }, { operationID: 'second' }], {
      cleanup: async () => retryMobileShareCleanupStage(async () => { cleanupAttempts += 1; throw new Error('ack_failed'); }),
      deliver: async (operationID) => { delivered.push(operationID); },
    }, 1);
    expect(cleanupAttempts).toBe(3);
    expect(delivered).toEqual(['second']);
  });

  test('serializes envelopes for different servers without runtime crossover or stale aborts', async () => {
    const envelopes = [
      { operationID: 'server-a-operation', serverInstanceID: 'server-a' },
      { operationID: 'server-b-operation', serverInstanceID: 'server-b' },
    ];
    const activeServer = { value: '' };
    const events: string[] = [];
    let staleAborts = 0;

    await drainMobileShareItems(envelopes.map(({ operationID }) => ({ operationID })), {
      cleanup: async () => undefined,
      deliver: async (operationID) => {
        const serverInstanceID = envelopes.find((envelope) => envelope.operationID === operationID)?.serverInstanceID;
        if (!serverInstanceID) throw new Error('missing_envelope');
        activeServer.value = serverInstanceID;
        events.push(`switch:${serverInstanceID}`);
        await Promise.resolve();
        if (activeServer.value !== serverInstanceID) { staleAborts += 1; return; }
        events.push(`dispatch:${serverInstanceID}`);
      },
    }, 1);

    expect(events).toEqual(['switch:server-a', 'dispatch:server-a', 'switch:server-b', 'dispatch:server-b']);
    expect(staleAborts).toBe(0);
  });

  test('keeps unresolved share operations reconciling without native acknowledgement', async () => {
    const source = await readFile(join(directory, 'MobileShareBridge.tsx'), 'utf8');
    expect(source).toContain("error.code === 'share_unresolved'");
    expect(source).toContain("state: 'reconciling'");
    expect(source.indexOf("error.code === 'share_unresolved'")).toBeLessThan(source.indexOf("state: 'delivered', cleanupPhase: 'server-completed'"));
    expect(source).not.toContain('operation.binding');
  });

  test('refreshes the authoritative snapshot after completion before opening the assistant', async () => {
    const source = await readFile(join(directory, 'MobileShareBridge.tsx'), 'utf8');
    const completed = source.indexOf('const completedOperation = await waitForAssistantShare');
    const refresh = source.indexOf('refreshedSnapshot = await forceRefreshAssistantSnapshot()');
    const binding = source.indexOf('refreshedAssistant.sessionID !== completedOperation.sessionID');
    const open = source.indexOf('openAssistant(deliveredAssistantID)');
    expect(completed).toBeGreaterThan(-1);
    expect(refresh).toBeGreaterThan(completed);
    expect(binding).toBeGreaterThan(refresh);
    expect(open).toBeGreaterThan(binding);
  });

  test('retains reconciliation for authoritative binding and runtime-current failures', async () => {
    const source = await readFile(join(directory, 'MobileShareBridge.tsx'), 'utf8');
    const refresh = source.indexOf('refreshedSnapshot = await forceRefreshAssistantSnapshot()');
    const delivered = source.indexOf("state: 'delivered', cleanupPhase: 'server-completed'");
    expect(source).toContain("error: 'assistant_binding_mismatch'");
    expect(source).toContain("error: 'runtime_stale'");
    expect(source).toContain("state: 'reconciling'");
    expect(refresh).toBeLessThan(delivered);
  });

  test('durably admits each operation with an OpenCode message ID before connecting', async () => {
    const source = await readFile(join(directory, 'MobileShareBridge.tsx'), 'utf8');
    const admission = source.indexOf("messageID: ascendingId('msg')");
    const save = source.indexOf('save(item); // Durable admission precedes every native share mutation.');
    const connect = source.indexOf('await connectMobileShareConnection');
    expect(source).toContain("import { ascendingId } from '@/sync/message-id';");
    expect(source).toContain('type OutboxItem = { envelope: NativeShareEnvelope; messageID: string;');
    expect(admission).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(admission);
    expect(connect).toBeGreaterThan(save);
  });

  test('restores legacy outbox entries with one persisted message ID reused by share retries', async () => {
    const source = await readFile(join(directory, 'MobileShareBridge.tsx'), 'utf8');
    expect(source).toContain('existing?.messageID');
    expect(source).toContain("messageID: ascendingId('msg')");
    expect(source).toContain('sendAssistantShare(assistant.id, envelope.operationID, item.messageID, parts, envelope.source)');
  });
});
