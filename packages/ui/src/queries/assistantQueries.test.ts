import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));

describe('Assistant current-instance query contract', () => {
  test('scopes every resource key by transport identity', async () => {
    const source = await readFile(join(directory, 'assistantQueries.ts'), 'utf8');
    expect(source).toContain("[transport, 'assistants', 'snapshot']");
    expect(source).toContain("[transport, 'assistants', assistantID, 'topics']");
    expect(source).toContain("[transport, 'assistants', 'topics', topicID, 'turns']");
  });

  test('uses the explicit Assistant routes and forwards query abort signals', async () => {
    const source = await readFile(join(directory, 'assistantQueries.ts'), 'utf8');
    expect(source).toContain("'/api/openchamber/assistants/snapshot', { signal }");
    expect(source).toContain('/api/openchamber/assistants/topics/${encodeURIComponent(topicID)}/messages');
    expect(source).toContain('/api/openchamber/assistants/operations/${encodeURIComponent(operationID)}');
  });

  test('preserves revision and operation idempotency fields on writes', async () => {
    const source = await readFile(join(directory, 'assistantQueries.ts'), 'utf8');
    expect(source).toContain('{ enabled, expectedRevision }');
    expect(source).toContain('{ ...draft, expectedRevision: assistant.revision }');
    expect(source).toContain('? { operationID, parts, source }');
    expect(source).toContain("source: AssistantSource = 'composer'");
  });

  test('reconciles explicit admitted and running operation DTOs, including transport exceptions', async () => {
    const source = await readFile(join(directory, 'assistantQueries.ts'), 'utf8');
    expect(source).toContain('parseAssistantOperationDTO(payload, response.status)');
    expect(source).toContain("result.state === 'admitted' || result.state === 'running'");
    expect(source).toContain('await reconcileAssistantOperation(operationID, { transport, generation })');
    expect(source).toContain('const operationFlights = new Map<string, Promise<AssistantOperationDTO>>()');
  });

});
