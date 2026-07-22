import { describe, expect, test } from 'bun:test';
import { applyPrimaryComposerSelectionChange } from './primaryComposerSelection';

const createConfig = (currentAgentName = 'build') => {
  const calls: string[] = [];
  return {
    calls,
    config: {
      currentAgentName,
      setAgent: (agentName: string | undefined) => {
        calls.push(`setAgent:${agentName ?? ''}`);
      },
      setProvider: (providerId: string) => {
        calls.push(`setProvider:${providerId}`);
      },
      setModel: (modelId: string) => {
        calls.push(`setModel:${modelId}`);
      },
      setCurrentVariant: (variant: string | undefined) => {
        calls.push(`setCurrentVariant:${variant ?? ''}`);
      },
      saveAgentModelSelection: (
        agentName: string,
        providerId: string,
        modelId: string,
        variant?: string,
      ) => {
        calls.push(`saveAgentModelSelection:${agentName}:${providerId}:${modelId}:${variant ?? ''}`);
      },
    },
  };
};

describe('applyPrimaryComposerSelectionChange', () => {
  test('keeps setAgent off the path when only the model changes', () => {
    const { calls, config } = createConfig('build');

    applyPrimaryComposerSelectionChange(
      { providerID: 'openai', modelID: 'gpt-5.5', agent: 'build', variant: 'high' },
      config,
    );

    expect(calls).toEqual([
      'setProvider:openai',
      'setModel:gpt-5.5',
      'setCurrentVariant:high',
      'saveAgentModelSelection:build:openai:gpt-5.5:high',
    ]);
  });

  test('runs setAgent before an explicit model override when the agent changes', () => {
    const { calls, config } = createConfig('build');

    applyPrimaryComposerSelectionChange(
      { providerID: 'anthropic', modelID: 'claude-sonnet', agent: 'plan' },
      config,
    );

    expect(calls).toEqual([
      'setAgent:plan',
      'setProvider:anthropic',
      'setModel:claude-sonnet',
      'setCurrentVariant:',
      'saveAgentModelSelection:plan:anthropic:claude-sonnet:',
    ]);
  });

  test('persists session-scoped model memory for later agent restores', () => {
    const { calls, config } = createConfig('build');
    const memoryCalls: string[] = [];

    applyPrimaryComposerSelectionChange(
      { providerID: 'openai', modelID: 'gpt-5.5', agent: 'build', variant: 'low' },
      config,
      {
        sessionId: 'ses_1',
        memory: {
          saveSessionModelSelection: (sessionId, providerId, modelId) => {
            memoryCalls.push(`session:${sessionId}:${providerId}:${modelId}`);
          },
          saveAgentModelForSession: (sessionId, agentName, providerId, modelId) => {
            memoryCalls.push(`agent:${sessionId}:${agentName}:${providerId}:${modelId}`);
          },
          saveAgentModelVariantForSession: (sessionId, agentName, providerId, modelId, variant) => {
            memoryCalls.push(`variant:${sessionId}:${agentName}:${providerId}:${modelId}:${variant ?? ''}`);
          },
        },
      },
    );

    expect(calls.at(-1)).toBe('saveAgentModelSelection:build:openai:gpt-5.5:low');
    expect(memoryCalls).toEqual([
      'session:ses_1:openai:gpt-5.5',
      'agent:ses_1:build:openai:gpt-5.5',
      'variant:ses_1:build:openai:gpt-5.5:low',
    ]);
  });
});
