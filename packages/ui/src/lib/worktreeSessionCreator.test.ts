import { describe, expect, test } from 'bun:test';
import {
  readWorktreeSessionSelectionSnapshot,
  writeWorktreeSessionSelection,
} from './worktreeSessionCreator';

describe('worktreeSessionCreator selection helpers', () => {
  test('readWorktreeSessionSelectionSnapshot copies live config fields', () => {
    expect(readWorktreeSessionSelectionSnapshot({
      currentAgentName: 'build',
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentVariant: 'high',
    })).toEqual({
      agentName: 'build',
      providerId: 'openai',
      modelId: 'gpt-5.5',
      variant: 'high',
    });
  });

  test('writeWorktreeSessionSelection persists complete snapshot including undefined variant clear', () => {
    const calls: string[] = [];
    writeWorktreeSessionSelection(
      'ses_wt',
      {
        agentName: 'plan',
        providerId: 'anthropic',
        modelId: 'claude-sonnet',
        variant: undefined,
      },
      {
        saveSessionAgentSelection: (sessionId, agentName) => {
          calls.push(`agentName:${sessionId}:${agentName}`);
        },
        saveSessionModelSelection: (sessionId, providerId, modelId) => {
          calls.push(`model:${sessionId}:${providerId}:${modelId}`);
        },
        saveAgentModelForSession: (sessionId, agentName, providerId, modelId) => {
          calls.push(`agentModel:${sessionId}:${agentName}:${providerId}:${modelId}`);
        },
        saveAgentModelVariantForSession: (sessionId, agentName, providerId, modelId, variant) => {
          calls.push(`variant:${sessionId}:${agentName}:${providerId}:${modelId}:${variant ?? ''}`);
        },
      },
    );
    expect(calls).toEqual([
      'agentName:ses_wt:plan',
      'model:ses_wt:anthropic:claude-sonnet',
      'agentModel:ses_wt:plan:anthropic:claude-sonnet',
      'variant:ses_wt:plan:anthropic:claude-sonnet:',
    ]);
  });

  test('writeWorktreeSessionSelection no-ops when provider or model is missing', () => {
    const calls: string[] = [];
    writeWorktreeSessionSelection(
      'ses_wt',
      { agentName: 'build', providerId: '', modelId: 'gpt-5.5' },
      {
        saveSessionAgentSelection: () => { calls.push('agent'); },
        saveSessionModelSelection: () => { calls.push('model'); },
        saveAgentModelForSession: () => { calls.push('agentModel'); },
        saveAgentModelVariantForSession: () => { calls.push('variant'); },
      },
    );
    expect(calls).toEqual([]);
  });
});
