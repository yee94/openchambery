import { describe, expect, test } from 'bun:test';
import {
  applyPrimaryComposerSelectionChange,
  applyPrimaryComposerSessionRestore,
  capturePrimaryComposerSendConfig,
  resolvePrimaryComposerSendConfig,
  resolvePrimaryComposerSessionSelection,
  shouldHoldPrimaryComposerUserPick,
} from './primaryComposerSelection';

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

const catalog = {
  providers: [
    { id: 'openai', models: [{ id: 'gpt-5.5', variants: { low: {}, high: {} } }] },
    { id: 'anthropic', models: [{ id: 'claude-sonnet' }] },
  ],
  agents: [{ name: 'build' }, { name: 'plan' }],
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

  test('clears the persisted session variant when the explicit selection uses the default effort', () => {
    const { config } = createConfig('build');
    const variants: Array<string | undefined> = [];

    applyPrimaryComposerSelectionChange(
      { providerID: 'openai', modelID: 'gpt-5.5', agent: 'build', variant: undefined },
      config,
      {
        sessionId: 'ses_1',
        memory: {
          saveSessionModelSelection: () => undefined,
          saveAgentModelForSession: () => undefined,
          saveAgentModelVariantForSession: (_sessionId, _agentName, _providerId, _modelId, variant) => {
            variants.push(variant);
          },
        },
      },
    );

    expect(variants).toEqual([undefined]);
  });
});

describe('resolvePrimaryComposerSessionSelection', () => {
  test('prefers history when catalog validates the latest user choice', () => {
    const resolved = resolvePrimaryComposerSessionSelection({
      sessionId: 'ses_1',
      latestUserChoice: {
        id: 'msg_1',
        agent: 'plan',
        providerID: 'anthropic',
        modelID: 'claude-sonnet',
        variant: undefined,
      },
      catalog,
      memory: {
        getSessionModelSelection: () => ({ providerId: 'openai', modelId: 'gpt-5.5' }),
        getSessionAgentSelection: () => 'build',
      },
    });

    expect(resolved).toEqual({
      agent: 'plan',
      providerID: 'anthropic',
      modelID: 'claude-sonnet',
      variant: undefined,
      source: 'history',
      messageId: 'msg_1',
    });
  });

  test('falls back to session memory when history model is missing from catalog', () => {
    const resolved = resolvePrimaryComposerSessionSelection({
      sessionId: 'ses_1',
      latestUserChoice: {
        id: 'msg_1',
        agent: 'plan',
        providerID: 'missing',
        modelID: 'gone',
      },
      catalog,
      memory: {
        getSessionAgentSelection: () => 'build',
        getAgentModelForSession: () => ({ providerId: 'openai', modelId: 'gpt-5.5' }),
        getAgentModelVariantForSession: () => 'high',
      },
    });

    expect(resolved).toEqual({
      agent: 'build',
      providerID: 'openai',
      modelID: 'gpt-5.5',
      variant: 'high',
      source: 'session-memory',
    });
  });

  test('clears invalid history variant while keeping model', () => {
    const resolved = resolvePrimaryComposerSessionSelection({
      sessionId: 'ses_1',
      latestUserChoice: {
        id: 'msg_2',
        agent: 'build',
        providerID: 'openai',
        modelID: 'gpt-5.5',
        variant: 'ultra',
      },
      catalog,
      memory: {
        getAgentModelVariantForSession: () => 'high',
      },
    });

    expect(resolved?.variant).toEqual(undefined);
    expect(resolved?.providerID).toBe('openai');
    expect(resolved?.source).toBe('history');
  });

  test('omitted history variant falls back to session memory', () => {
    const resolved = resolvePrimaryComposerSessionSelection({
      sessionId: 'ses_1',
      latestUserChoice: {
        id: 'msg_4',
        agent: 'build',
        providerID: 'openai',
        modelID: 'gpt-5.5',
      },
      catalog,
      memory: {
        getAgentModelVariantForSession: () => 'high',
      },
    });

    expect(resolved?.variant).toBe('high');
    expect(resolved?.providerID).toBe('openai');
    expect(resolved?.source).toBe('history');
  });

  test('falls back agent from session memory when history agent is missing from catalog', () => {
    const resolved = resolvePrimaryComposerSessionSelection({
      sessionId: 'ses_1',
      latestUserChoice: {
        id: 'msg_3',
        agent: 'ghost',
        providerID: 'openai',
        modelID: 'gpt-5.5',
        variant: 'low',
      },
      catalog,
      memory: {
        getSessionAgentSelection: () => 'plan',
      },
      fallbackAgentName: 'build',
    });

    expect(resolved?.agent).toBe('plan');
    expect(resolved?.variant).toBe('low');
  });

  test('falls back to session-entity when history and memory cannot restore', () => {
    const resolved = resolvePrimaryComposerSessionSelection({
      sessionId: 'ses_1',
      latestUserChoice: null,
      catalog,
      memory: {},
      sessionEntity: {
        agent: 'plan',
        model: {
          id: 'claude-sonnet',
          providerID: 'anthropic',
          variant: undefined,
        },
      },
      fallbackAgentName: 'build',
    });

    expect(resolved).toEqual({
      agent: 'plan',
      providerID: 'anthropic',
      modelID: 'claude-sonnet',
      variant: undefined,
      source: 'session-entity',
    });
  });

  test('returns null when session-entity model is missing from catalog', () => {
    const resolved = resolvePrimaryComposerSessionSelection({
      sessionId: 'ses_1',
      latestUserChoice: null,
      catalog,
      memory: {},
      sessionEntity: {
        agent: 'plan',
        model: {
          id: 'gone',
          providerID: 'missing',
        },
      },
    });

    expect(resolved).toBeNull();
  });

  test('falls back agent from fallbackAgentName when session-entity agent is invalid', () => {
    const resolved = resolvePrimaryComposerSessionSelection({
      sessionId: 'ses_1',
      latestUserChoice: null,
      catalog,
      memory: {},
      sessionEntity: {
        agent: 'ghost',
        model: {
          id: 'gpt-5.5',
          providerID: 'openai',
          variant: 'high',
        },
      },
      fallbackAgentName: 'build',
    });

    expect(resolved).toEqual({
      agent: 'build',
      providerID: 'openai',
      modelID: 'gpt-5.5',
      variant: 'high',
      source: 'session-entity',
    });
  });

  test('skips history and memory while the transcript is still loading', () => {
    const resolved = resolvePrimaryComposerSessionSelection({
      sessionId: 'ses_1',
      latestUserChoice: {
        id: 'msg_partial',
        agent: 'plan',
        providerID: 'anthropic',
        modelID: 'claude-sonnet',
      },
      catalog,
      memory: {
        getSessionAgentSelection: () => 'build',
        getAgentModelForSession: () => ({ providerId: 'openai', modelId: 'gpt-5.5' }),
      },
      sessionEntity: {
        agent: 'plan',
        model: {
          id: 'claude-sonnet',
          providerID: 'anthropic',
        },
      },
      transcriptReady: false,
    });

    expect(resolved).toEqual({
      agent: 'plan',
      providerID: 'anthropic',
      modelID: 'claude-sonnet',
      variant: undefined,
      source: 'session-entity',
    });
  });

  test('returns null while loading when session-entity is also unavailable', () => {
    const resolved = resolvePrimaryComposerSessionSelection({
      sessionId: 'ses_1',
      latestUserChoice: {
        id: 'msg_partial',
        providerID: 'openai',
        modelID: 'gpt-5.5',
      },
      catalog,
      memory: {
        getSessionAgentSelection: () => 'build',
        getAgentModelForSession: () => ({ providerId: 'openai', modelId: 'gpt-5.5' }),
      },
      transcriptReady: false,
    });

    expect(resolved).toBeNull();
  });

  test('prefers history over session-entity when history validates', () => {
    const resolved = resolvePrimaryComposerSessionSelection({
      sessionId: 'ses_1',
      latestUserChoice: {
        id: 'msg_1',
        agent: 'plan',
        providerID: 'anthropic',
        modelID: 'claude-sonnet',
      },
      catalog,
      memory: {},
      sessionEntity: {
        agent: 'build',
        model: {
          id: 'gpt-5.5',
          providerID: 'openai',
          variant: 'low',
        },
      },
    });

    expect(resolved).toEqual({
      agent: 'plan',
      providerID: 'anthropic',
      modelID: 'claude-sonnet',
      variant: undefined,
      source: 'history',
      messageId: 'msg_1',
    });
  });
});

describe('applyPrimaryComposerSessionRestore', () => {
  test('writes session memory but never project agent preferences', () => {
    const { calls, config } = createConfig('build');
    const memoryCalls: string[] = [];
    const restoreConfig = {
      currentAgentName: config.currentAgentName,
      setAgent: config.setAgent,
      setProvider: config.setProvider,
      setModel: config.setModel,
      setCurrentVariant: config.setCurrentVariant,
    };

    applyPrimaryComposerSessionRestore(
      {
        agent: 'plan',
        providerID: 'openai',
        modelID: 'gpt-5.5',
        variant: 'high',
        source: 'history',
        messageId: 'msg_1',
      },
      restoreConfig,
      {
        sessionId: 'ses_1',
        memory: {
          saveSessionModelSelection: (sessionId, providerId, modelId) => {
            memoryCalls.push(`session:${sessionId}:${providerId}:${modelId}`);
          },
          saveSessionAgentSelection: (sessionId, agentName) => {
            memoryCalls.push(`agentName:${sessionId}:${agentName}`);
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

    expect(calls).toEqual([
      'setAgent:plan',
      'setProvider:openai',
      'setModel:gpt-5.5',
      'setCurrentVariant:high',
    ]);
    expect(calls.some((call) => call.startsWith('saveAgentModelSelection:'))).toBe(false);
    expect(memoryCalls).toEqual([
      'session:ses_1:openai:gpt-5.5',
      'agentName:ses_1:plan',
      'agent:ses_1:plan:openai:gpt-5.5',
      'variant:ses_1:plan:openai:gpt-5.5:high',
    ]);
  });

  test('clears previous variant when restore has no variant', () => {
    const { calls, config } = createConfig('build');
    const restoreConfig = {
      currentAgentName: config.currentAgentName,
      setAgent: config.setAgent,
      setProvider: config.setProvider,
      setModel: config.setModel,
      setCurrentVariant: config.setCurrentVariant,
    };
    const memoryCalls: string[] = [];

    applyPrimaryComposerSessionRestore(
      {
        providerID: 'anthropic',
        modelID: 'claude-sonnet',
        variant: undefined,
        source: 'history',
      },
      restoreConfig,
      {
        sessionId: 'ses_1',
        memory: {
          saveSessionModelSelection: () => undefined,
          saveAgentModelForSession: () => undefined,
          saveAgentModelVariantForSession: (_s, _a, _p, _m, variant) => {
            memoryCalls.push(`variant:${variant ?? ''}`);
          },
        },
      },
    );

    expect(calls).toContain('setCurrentVariant:');
    expect(memoryCalls).toEqual(['variant:']);
  });
});

describe('capturePrimaryComposerSendConfig', () => {
  test('captures live primary config snapshot after flush', () => {
    expect(capturePrimaryComposerSendConfig({
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentAgentName: 'build',
      currentVariant: 'high',
    })).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.5',
      agent: 'build',
      variant: 'high',
    });
  });

  test('returns undefined when provider or model is missing', () => {
    expect(capturePrimaryComposerSendConfig({
      currentProviderId: '',
      currentModelId: 'gpt-5.5',
    })).toEqual(undefined);
  });

  test('returns undefined when activeDirectoryKey does not match expected session Project key', () => {
    expect(capturePrimaryComposerSendConfig({
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentAgentName: 'build',
    }, {
      expectedConfigKey: '/project-a',
      activeDirectoryKey: '/project-b',
    })).toEqual(undefined);
  });

  test('captures when activeDirectoryKey matches expected session Project key', () => {
    expect(capturePrimaryComposerSendConfig({
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentAgentName: 'build',
      currentVariant: 'high',
    }, {
      expectedConfigKey: '/project-a',
      activeDirectoryKey: '/project-a',
    })).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.5',
      agent: 'build',
      variant: 'high',
    });
  });

  test('skips scope check when expectedConfigKey is omitted (new-session draft)', () => {
    expect(capturePrimaryComposerSendConfig({
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
    }, {
      activeDirectoryKey: '/other',
    })).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.5',
      agent: undefined,
      variant: undefined,
    });
  });
});

describe('shouldHoldPrimaryComposerUserPick', () => {
  test('does not hold when the user has not edited this session', () => {
    expect(shouldHoldPrimaryComposerUserPick({
      editRevision: 0,
      pinnedHistoryMessageId: null,
      latestHistoryMessageId: 'msg_1',
    })).toBe(false);
  });

  test('holds a pick made while the transcript was still loading', () => {
    expect(shouldHoldPrimaryComposerUserPick({
      editRevision: 1,
      pinnedHistoryMessageId: null,
      latestHistoryMessageId: 'msg_1',
    })).toBe(true);
  });

  test('holds a pick against the same latest history message', () => {
    expect(shouldHoldPrimaryComposerUserPick({
      editRevision: 1,
      pinnedHistoryMessageId: 'msg_1',
      latestHistoryMessageId: 'msg_1',
    })).toBe(true);
  });

  test('releases when a newer history message arrives after the pick', () => {
    expect(shouldHoldPrimaryComposerUserPick({
      editRevision: 1,
      pinnedHistoryMessageId: 'msg_1',
      latestHistoryMessageId: 'msg_2',
    })).toBe(false);
  });
});

describe('resolvePrimaryComposerSendConfig', () => {
  test('prefers a successful live capture', () => {
    expect(resolvePrimaryComposerSendConfig({
      captured: {
        providerID: 'openai',
        modelID: 'gpt-5.5',
        agent: 'build',
      },
      surfaceSelection: {
        providerID: 'anthropic',
        modelID: 'claude-sonnet',
      },
    })).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.5',
      agent: 'build',
    });
  });

  test('falls back to the composer UI selection when capture is empty', () => {
    // Worktree→project lag can make capture refuse a scope mismatch even though
    // ModelControls already show a complete selection the user expects to send.
    expect(resolvePrimaryComposerSendConfig({
      captured: undefined,
      surfaceSelection: {
        providerID: 'anthropic',
        modelID: 'claude-sonnet',
        agent: 'plan',
        variant: 'high',
      },
    })).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet',
      agent: 'plan',
      variant: 'high',
    });
  });

  test('returns undefined when neither capture nor surface has a model', () => {
    expect(resolvePrimaryComposerSendConfig({
      captured: undefined,
      surfaceSelection: { agent: 'build' },
    })).toBeUndefined();
  });
});
