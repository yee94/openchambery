import { describe, expect, test } from 'bun:test';
// @ts-expect-error The server contract fixture is JavaScript and shared across the package boundary.
import { assistantContractFixtures } from '../../../web/server/lib/assistants/contracts.js';
import { AssistantAPIError, parseAssistantCapabilityDTO, parseCompactResponse, parseMessageAdmission, parseSessionBinding, parseShareOperation, parseAssistantSnapshotDTO } from './assistantDTO';
describe('Assistant DTO parsing', () => {
  test('parses server contract fixtures across the web and UI boundary', () => {
    const serverBindingFixture = assistantContractFixtures.sessionBinding;
    const snapshot = parseAssistantSnapshotDTO({ revision: 1, enabled: true, assistants: [{ id: 'assistant-1', revision: 1, enabled: true, name: 'Assistant', defaultPrompt: '', workspacePath: '/project', effectiveWorkspacePath: '/project', managedWorkspacePath: '/managed', skillRoots: ['/legacy-skill'], providerID: 'provider', modelID: 'model', agent: null, mode: 'continuous', sessionID: 'ses-1', sessionGeneration: 2, historySessionIDs: ['ses-0'], createdAt: null, updatedAt: 2, tombstoneAt: null }] });
    const binding = parseSessionBinding(serverBindingFixture);
    const compact = parseCompactResponse(assistantContractFixtures.compactResponse);
    const admission = parseMessageAdmission(assistantContractFixtures.messageAdmission);
    const share = parseShareOperation(assistantContractFixtures.shareOperation);
    expect(snapshot.assistants[0]?.sessionID).toBe('ses-1');
    expect(snapshot.assistants[0]?.sessionGeneration).toBe(2);
    expect(snapshot.assistants[0]?.effectiveWorkspacePath).toBe('/project');
    expect(snapshot.assistants[0]?.managedWorkspacePath).toBe('/managed');
    expect(snapshot.assistants[0]?.mode).toBe('continuous');
    expect(snapshot.assistants[0]?.historySessionIDs).toEqual(['ses-0']);
    expect('skillRoots' in snapshot.assistants[0]).toBe(false);
    expect(binding.directory).toBe('/workspace');
    expect(compact.binding.sessionID).toBe('ses_fixture');
    expect(admission.messageID).toBe('msg_fixture');
    expect(share.sessionID).toBe('ses_fixture');
    expect(share.state).toBe('running');
    expect(parseAssistantCapabilityDTO({ supported: true, enabled: false, revision: 3, serverInstanceID: null }).serverInstanceID).toBeNull();
  });
  test('accepts every terminal and in-flight share state', () => {
    for (const state of ['submitting', 'running', 'completed', 'failed', 'unresolved'] as const) expect(parseShareOperation({ ...assistantContractFixtures.shareOperation, state }).state).toBe(state);
  });
  test('rejects incomplete DTOs', () => {
    expect(() => parseMessageAdmission({ messageID: 'msg' })).toThrow(AssistantAPIError);
    expect(() => parseCompactResponse({ binding: { sessionID: 'ses-1', directory: '/project', sessionGeneration: 2 }, admitted: true })).toThrow(AssistantAPIError);
    expect(() => parseShareOperation({ operationID: 'share-1', assistantID: 'assistant-1', phase: 'submitted', binding: { sessionID: 'ses-1' }, messageID: 'msg-1', state: 'completed', errorCode: null })).toThrow(AssistantAPIError);
    expect(() => parseAssistantSnapshotDTO({ revision: 1, enabled: true, assistants: [{ id: 'a' }] })).toThrow(AssistantAPIError);
  });
});
