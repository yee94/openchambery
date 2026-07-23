export const assistantContractFixtures = Object.freeze({
  assistant: Object.freeze({ id: 'assistant_fixture', revision: 4, enabled: true, name: 'Fixture', defaultPrompt: '', workspacePath: null, managedWorkspacePath: '/data/assistant-workspaces/assistant_fixture', effectiveWorkspacePath: '/workspace', providerID: 'provider_fixture', modelID: 'model_fixture', agent: null, variant: null, mode: 'continuous', sessionID: 'ses_fixture', sessionGeneration: 4, historySessionIDs: Object.freeze([]), historySessionCount: 0, createdAt: 1234, updatedAt: 1234, tombstoneAt: null }),
  sessionBinding: Object.freeze({ sessionID: 'ses_fixture', directory: '/workspace', sessionGeneration: 4 }),
  compactResponse: Object.freeze({ binding: Object.freeze({ sessionID: 'ses_fixture', directory: '/workspace', sessionGeneration: 4 }), summarized: true }),
  messageAdmission: Object.freeze({ binding: Object.freeze({ sessionID: 'ses_fixture', directory: '/workspace', sessionGeneration: 4 }), messageID: 'msg_fixture', admitted: true }),
  abortResponse: Object.freeze({ binding: Object.freeze({ sessionID: 'ses_fixture', directory: '/workspace', sessionGeneration: 4 }), aborted: true }),
  shareOperation: Object.freeze({ operationID: 'share_fixture', assistantID: 'assistant_fixture', sessionID: 'ses_fixture', messageID: 'msg_fixture', state: 'running', phase: 'submitted', attempt: 1, leaseExpiresAt: 1234, errorCode: null }),
  historicalMessages: Object.freeze({ entries: Object.freeze([Object.freeze({ sessionID: 'ses_fixture', directory: null, info: Object.freeze({ id: 'msg_fixture', sessionID: 'ses_fixture', role: 'assistant', time: Object.freeze({ created: 1234 }) }), parts: Object.freeze([]) })]), nextCursor: null, complete: true }),
});
