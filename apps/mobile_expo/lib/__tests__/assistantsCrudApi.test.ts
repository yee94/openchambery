import { describe, expect, it } from 'vitest';

import { parseAssistantDTO } from '@/lib/assistantsApi';

describe('assistants CRUD draft parsing', () => {
  it('parses assistant DTO used by settings editors', () => {
    const dto = parseAssistantDTO({
      id: 'a1',
      revision: 2,
      enabled: true,
      name: 'Helper',
      defaultPrompt: 'hi',
      workspacePath: null,
      effectiveWorkspacePath: '/tmp',
      managedWorkspacePath: null,
      providerID: 'openai',
      modelID: 'gpt-4',
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
    });
    expect(dto.name).toBe('Helper');
    expect(dto.providerID).toBe('openai');
  });
});
