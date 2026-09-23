import { describe, expect, test } from 'vitest';
import {
  buildAgentSaveConfig,
  catalogModelSelection,
  hasPermissionChanged,
  readStoredSystem,
  splitModelSelection,
  type AgentEditorSnapshot,
} from './agentSaveConfig';

const baseSnapshot = (overrides: Partial<AgentEditorSnapshot> = {}): AgentEditorSnapshot => ({
  description: 'Helper',
  mode: 'subagent',
  model: 'openai/gpt-5#high',
  system: 'You are helpful.',
  steps: undefined,
  hidden: false,
  disabled: false,
  color: '',
  globalPermission: 'allow',
  permissionRules: [],
  ...overrides,
});

describe('hasPermissionChanged', () => {
  test('returns false when baseline is missing', () => {
    expect(hasPermissionChanged(baseSnapshot(), null)).toBe(false);
  });

  test('returns true when rules change', () => {
    expect(hasPermissionChanged(
      baseSnapshot({ permissionRules: [{ permission: 'shell', pattern: '*', action: 'ask' }] }),
      baseSnapshot(),
    )).toBe(true);
  });
});

describe('buildAgentSaveConfig', () => {
  test('update sends only the changed system prompt', () => {
    const initial = baseSnapshot();
    const current = baseSnapshot({ system: 'Only the prompt changed.' });

    expect(buildAgentSaveConfig({
      isNewAgent: false,
      agentName: 'build',
      draftHasExplicitPermission: false,
      current,
      initial,
    })).toEqual({
      name: 'build',
      system: 'Only the prompt changed.',
    });
  });

  test('update writes native permissions and renames legacy tool names', () => {
    const initial = baseSnapshot();
    const current = baseSnapshot({
      globalPermission: 'ask',
      permissionRules: [{ permission: 'bash', pattern: '*', action: 'deny' }],
    });

    expect(buildAgentSaveConfig({
      isNewAgent: false,
      agentName: 'build',
      draftHasExplicitPermission: false,
      current,
      initial,
    })).toEqual({
      name: 'build',
      permissions: [
        { action: '*', resource: '*', effect: 'ask' },
        { action: 'shell', resource: '*', effect: 'deny' },
      ],
    });
  });

  test('update clears model, steps, and color when they are removed', () => {
    const initial = baseSnapshot({ steps: 4, color: '#112233' });
    const current = baseSnapshot({ model: '', steps: undefined, color: '' });

    expect(buildAgentSaveConfig({
      isNewAgent: false,
      agentName: 'build',
      draftHasExplicitPermission: false,
      current,
      initial,
    })).toEqual({
      name: 'build',
      model: null,
      steps: null,
      color: null,
    });
  });

  test('create omits permission until the user edits it', () => {
    const current = baseSnapshot({
      description: '',
      model: '',
      system: 'New agent prompt',
    });

    expect(buildAgentSaveConfig({
      isNewAgent: true,
      agentName: 'custom',
      draftScope: 'user',
      draftHasExplicitPermission: false,
      current,
      initial: current,
    })).toEqual({
      name: 'custom',
      mode: 'subagent',
      system: 'New agent prompt',
      scope: 'user',
    });
  });

  test('create keeps an explicit permission draft', () => {
    const current = baseSnapshot({
      globalPermission: 'ask',
      permissionRules: [{ permission: 'task', pattern: 'review', action: 'deny' }],
    });

    expect(buildAgentSaveConfig({
      isNewAgent: true,
      agentName: 'custom-copy',
      draftScope: 'project',
      draftHasExplicitPermission: true,
      current,
      initial: current,
      confirmDrop: true,
    })).toEqual({
      name: 'custom-copy',
      mode: 'subagent',
      description: 'Helper',
      model: 'openai/gpt-5#high',
      system: 'You are helpful.',
      permissions: [
        { action: '*', resource: '*', effect: 'ask' },
        { action: 'subagent', resource: 'review', effect: 'deny' },
      ],
      scope: 'project',
      confirmDrop: true,
    });
  });
});

describe('stored agent readers', () => {
  test('joins catalog variant into the model selection', () => {
    expect(catalogModelSelection({
      model: { providerID: 'openai', modelID: 'gpt-5', variant: 'high' },
    })).toBe('openai/gpt-5#high');
  });

  test('splits a model selection for the picker', () => {
    expect(splitModelSelection('openai/gpt-5#high')).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5',
      variant: 'high',
    });
  });

  test('ignores a prompt file reference', () => {
    expect(readStoredSystem({ prompt: '{file:./prompts/review.txt}' })).toBeUndefined();
    expect(readStoredSystem({ prompt: 'Review carefully.' })).toBe('Review carefully.');
  });
});
