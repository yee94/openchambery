import { beforeEach, describe, expect, test } from 'bun:test';
import { useSelectionStore } from './selection-store';

type PersistOptions = {
  partialize: (state: ReturnType<typeof useSelectionStore.getState>) => Record<string, unknown>;
  merge: (
    persistedState: unknown,
    currentState: ReturnType<typeof useSelectionStore.getState>,
  ) => ReturnType<typeof useSelectionStore.getState>;
};

const getPersistOptions = (): PersistOptions => (
  useSelectionStore as unknown as {
    persist: { getOptions: () => PersistOptions };
  }
).persist.getOptions();

beforeEach(() => {
  useSelectionStore.setState({
    sessionModelSelections: new Map(),
    sessionAgentSelections: new Map(),
    sessionAgentModelSelections: new Map(),
    sessionAgentModelVariantSelections: new Map(),
    lastUsedProvider: null,
  });
});

describe('selection-store variants', () => {
  test('persists variant in zustand state and returns it', () => {
    useSelectionStore.getState().saveAgentModelVariantForSession(
      'ses_1',
      'build',
      'openai',
      'gpt-5.5',
      'high',
    );

    expect(
      useSelectionStore.getState().getAgentModelVariantForSession(
        'ses_1',
        'build',
        'openai',
        'gpt-5.5',
      ),
    ).toBe('high');
    expect(useSelectionStore.getState().sessionAgentModelVariantSelections.get('ses_1')?.get('build')?.get('openai/gpt-5.5')).toBe('high');
  });

  test('undefined variant deletes the corresponding record', () => {
    useSelectionStore.getState().saveAgentModelVariantForSession(
      'ses_1',
      'build',
      'openai',
      'gpt-5.5',
      'high',
    );
    useSelectionStore.getState().saveAgentModelVariantForSession(
      'ses_1',
      'build',
      'openai',
      'gpt-5.5',
      undefined,
    );

    expect(
      useSelectionStore.getState().getAgentModelVariantForSession(
        'ses_1',
        'build',
        'openai',
        'gpt-5.5',
      ),
    ).toEqual(undefined);
    expect(useSelectionStore.getState().sessionAgentModelVariantSelections.size).toBe(0);
  });

  test('partialize includes variant map and trims to recent sessions', () => {
    for (let i = 0; i < 3; i += 1) {
      useSelectionStore.getState().saveAgentModelVariantForSession(
        `ses_${i}`,
        'build',
        'openai',
        'gpt-5.5',
        `v${i}`,
      );
    }

    const partial = getPersistOptions().partialize(useSelectionStore.getState());

    expect(Array.isArray(partial.sessionAgentModelVariantSelections)).toBe(true);
    const variants = partial.sessionAgentModelVariantSelections as [string, unknown][];
    expect(variants.map(([sessionId]) => sessionId)).toEqual(['ses_0', 'ses_1', 'ses_2']);
  });

  test('partialize keeps only the last 150 sessions when more are stored', () => {
    for (let i = 0; i < 160; i += 1) {
      useSelectionStore.getState().saveSessionModelSelection(`ses_${i}`, 'openai', `model-${i}`);
      useSelectionStore.getState().saveSessionAgentSelection(`ses_${i}`, 'build');
      useSelectionStore.getState().saveAgentModelForSession(`ses_${i}`, 'build', 'openai', `model-${i}`);
      useSelectionStore.getState().saveAgentModelVariantForSession(
        `ses_${i}`,
        'build',
        'openai',
        `model-${i}`,
        `v${i}`,
      );
    }

    const partial = getPersistOptions().partialize(useSelectionStore.getState());
    const models = partial.sessionModelSelections as [string, unknown][];
    const agents = partial.sessionAgentSelections as [string, unknown][];
    const agentModels = partial.sessionAgentModelSelections as [string, unknown][];
    const variants = partial.sessionAgentModelVariantSelections as [string, unknown][];

    expect(models).toHaveLength(150);
    expect(agents).toHaveLength(150);
    expect(agentModels).toHaveLength(150);
    expect(variants).toHaveLength(150);

    const expectedIds = Array.from({ length: 150 }, (_, index) => `ses_${index + 10}`);
    expect(models.map(([sessionId]) => sessionId)).toEqual(expectedIds);
    expect(agents.map(([sessionId]) => sessionId)).toEqual(expectedIds);
    expect(agentModels.map(([sessionId]) => sessionId)).toEqual(expectedIds);
    expect(variants.map(([sessionId]) => sessionId)).toEqual(expectedIds);
    expect(models[0]?.[0]).toBe('ses_10');
    expect(models[149]?.[0]).toBe('ses_159');
  });

  test('persist merge rehydrates model/agent/variant maps from partialize output', () => {
    useSelectionStore.getState().saveSessionModelSelection('ses_a', 'openai', 'gpt-5.5');
    useSelectionStore.getState().saveSessionAgentSelection('ses_a', 'plan');
    useSelectionStore.getState().saveAgentModelForSession('ses_a', 'plan', 'openai', 'gpt-5.5');
    useSelectionStore.getState().saveAgentModelVariantForSession(
      'ses_a',
      'plan',
      'openai',
      'gpt-5.5',
      'high',
    );
    useSelectionStore.getState().saveSessionModelSelection('ses_b', 'anthropic', 'claude-sonnet');
    useSelectionStore.getState().saveAgentModelVariantForSession(
      'ses_b',
      'build',
      'anthropic',
      'claude-sonnet',
      'low',
    );

    const { partialize, merge } = getPersistOptions();
    const persisted = partialize(useSelectionStore.getState());

    // Simulate a cold store, then rehydrate via the same merge used by zustand persist.
    const empty = {
      ...useSelectionStore.getState(),
      sessionModelSelections: new Map(),
      sessionAgentSelections: new Map(),
      sessionAgentModelSelections: new Map(),
      sessionAgentModelVariantSelections: new Map(),
      lastUsedProvider: null,
    };
    const rehydrated = merge(persisted, empty);

    expect(rehydrated.sessionModelSelections.get('ses_a')).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5.5',
    });
    expect(rehydrated.sessionAgentSelections.get('ses_a')).toBe('plan');
    expect(rehydrated.sessionAgentModelSelections.get('ses_a')?.get('plan')).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5.5',
    });
    expect(rehydrated.sessionAgentModelVariantSelections.get('ses_a')?.get('plan')?.get('openai/gpt-5.5')).toBe('high');
    expect(rehydrated.sessionModelSelections.get('ses_b')).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-sonnet',
    });
    expect(rehydrated.sessionAgentModelVariantSelections.get('ses_b')?.get('build')?.get('anthropic/claude-sonnet')).toBe('low');
    expect(rehydrated.lastUsedProvider).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet',
    });
  });
});
