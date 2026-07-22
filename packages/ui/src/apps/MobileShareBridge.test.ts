import { describe, expect, test } from 'bun:test';
import { drainMobileShareItems, retryMobileShareCleanupStage } from './mobileShareDrain';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));

describe('MobileShareBridge contract', () => {
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
});
