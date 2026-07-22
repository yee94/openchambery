import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = dirname(fileURLToPath(import.meta.url));
describe('Assistant query contract', () => {
  test('uses runtime-scoped snapshots and assistant session routes', async () => {
    const source = await readFile(join(directory, 'assistantQueries.ts'), 'utf8');
    expect(source).toContain("[transport, 'assistants', 'snapshot']");
    expect(source).toContain('/session/ensure');
    expect(source).toContain('/session/new');
    expect(source).toContain('/session/compact');
    expect(source).toContain('/messages');
    expect(source).toContain('/share');
    expect(source).toContain("share-operations");
    expect(source).toContain('payload: { messageID, parts, source }');
    expect(source).toContain('{ sessionID: binding.sessionID, sessionGeneration: binding.sessionGeneration, messageID, parts, source }');
  });

  test('settles share delivery only from a completed operation in its captured runtime', async () => {
    const source = await readFile(join(directory, 'assistantQueries.ts'), 'utf8');
    expect(source).toContain("current.state === 'running' || current.state === 'submitting'");
    expect(source).toContain("if (current.state === 'completed') return current");
    expect(source).toContain("new AssistantShareOperationError('share_unresolved', 408, current)");
    expect(source).toContain('fetchAssistantShareOperation(current.operationID, transport, generation)');
  });

  test('updates the captured Assistant snapshot immediately after PATCH success', async () => {
    const source = await readFile(join(directory, 'assistantQueries.ts'), 'utf8');
    const update = source.slice(source.indexOf('export const updateAssistant'), source.indexOf('export const deleteAssistant'));
    expect(update).toContain("jsonInit('PATCH'");
    expect(update).toContain('expectedRevision: assistant.revision');
    expect(update).toContain('applyAssistant(result, transport)');
  });

  test('provides an abortable direct snapshot fetch without Query cache operations or retries', async () => {
    const source = await readFile(join(directory, 'assistantQueries.ts'), 'utf8');
    const directFetch = source.slice(source.indexOf('export const fetchAssistantSnapshot'), source.indexOf('export const assistantCapabilityQueryOptions'));
    expect(directFetch).toContain('signal: AbortSignal');
    expect(directFetch).toContain("requestJSON<unknown>('/api/openchamber/assistants/snapshot', { signal })");
    expect(directFetch).toContain('parseAssistantSnapshotDTO');
    expect(directFetch).not.toContain('queryClient');
    expect(directFetch).not.toContain('retry');
  });
});
