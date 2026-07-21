import { describe, expect, test } from 'bun:test';
import { AssistantAPIError, parseAssistantCapabilityDTO, parseAssistantOperationDTO, parseAssistantSnapshotDTO, parseAssistantTopicsDTO, parseAssistantTurnsDTO } from './assistantDTO';

describe('Assistant DTO parsing', () => {
  test('accepts a real 202 operation shape and nullable-instance capability DTO', () => {
    const operation = parseAssistantOperationDTO({
      operationID: 'op-202', topicID: 'topic-1', type: 'message', state: 'running',
      phase: 'submitted', sessionID: 'ses-1', messageID: 'msg-1', admission: { admitted: true, attempt: 1, leaseExpiresAt: 200 }, result: null,
      errorCode: null, payloadHash: 'hash', createdAt: 100, updatedAt: 101,
    }, 202);
    const capability = parseAssistantCapabilityDTO({ supported: true, enabled: false, revision: 3, serverInstanceID: null });

    expect(operation.state).toBe('running');
    expect(operation.admission.attempt).toBe(1);
    expect(operation.messageID).toBe('msg-1');
    expect(capability.serverInstanceID).toBeNull();
  });

  test('rejects malformed discriminated DTOs', () => {
    expect(() => parseAssistantOperationDTO({ operationID: 'op' }, 202)).toThrow(AssistantAPIError);
    expect(() => parseAssistantCapabilityDTO({ supported: true, enabled: true, revision: 1, serverInstanceID: 1 })).toThrow(AssistantAPIError);
  });

  test('validates real discriminated user and assistant turn shapes', () => {
    const snapshot = parseAssistantSnapshotDTO({ revision: 1, enabled: true, assistants: [{ id: 'assistant-1', revision: 1, enabled: true, name: 'Assistant', defaultPrompt: '', workspacePath: null, skillRoots: [], providerID: 'provider', modelID: 'model', agent: null, mode: 'continuous', inboxTopicID: 'topic-1', createdAt: null, updatedAt: 2, tombstoneAt: null }] });
    const topics = parseAssistantTopicsDTO([{ id: 'topic-1', assistantID: 'assistant-1', title: 'Inbox', sessionID: null, revision: 1, createdAt: 1, updatedAt: 2, tombstoneAt: null }]);
    const turns = parseAssistantTurnsDTO([
      { id: 'turn-1', topicID: 'topic-1', ordinal: 1, parentMessageID: null, phase: 'completed', role: 'user', kind: 'message', source: 'composer', parts: [], assistantRevision: 1, sessionID: 'ses-1', messageID: 'msg-1', operationID: 'op-1', createdAt: 1, completedAt: null, error: null },
      { id: 'message-2', topicID: 'topic-1', ordinal: 1, parentMessageID: 'msg-1', phase: 'completed', role: 'assistant', parts: [], sessionID: 'ses-1', messageID: 'message-2', operationID: 'op-1', createdAt: 2, completedAt: 3, error: null },
    ]);

    expect(snapshot.assistants[0]?.createdAt).toBeNull();
    expect(topics[0]?.assistantID).toBe('assistant-1');
    expect(turns[0]).toMatchObject({ role: 'user', parentMessageID: null, messageID: 'msg-1', completedAt: null, error: null });
    expect(turns[1]).toMatchObject({ role: 'assistant', parentMessageID: 'msg-1', messageID: 'message-2', createdAt: 2, completedAt: 3 });
    expect(() => parseAssistantTurnsDTO([{ id: 'turn-1', role: 'assistant' }])).toThrow(AssistantAPIError);
    expect(() => parseAssistantTurnsDTO([{ id: 'turn-1', topicID: 'topic-1', ordinal: 1, parentMessageID: null, phase: 'completed', role: 'user', parts: [], assistantRevision: 1, sessionID: null, messageID: null, operationID: 'op-1', createdAt: 1, completedAt: null, error: null }])).toThrow(AssistantAPIError);
  });
});
