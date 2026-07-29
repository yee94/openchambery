import { describe, expect, test } from 'bun:test';
import {
  buildAgentSaveConfig,
  hasPermissionChanged,
  type AgentEditorSnapshot,
} from './agentSaveConfig';

const baseSnapshot = (overrides: Partial<AgentEditorSnapshot> = {}): AgentEditorSnapshot => ({
  description: 'Helper',
  mode: 'subagent',
  model: 'openai/gpt-5',
  variant: 'high',
  temperature: 0.2,
  topP: 0.9,
  prompt: 'You are helpful.',
  globalPermission: 'allow',
  permissionRules: [],
  ...overrides,
});

describe('hasPermissionChanged', () => {
  test('returns false when baseline is missing', () => {
    expect(hasPermissionChanged(baseSnapshot(), null)).toBe(false);
  });

  test('returns true when global permission changes', () => {
    expect(hasPermissionChanged(
      baseSnapshot({ globalPermission: 'ask' }),
      baseSnapshot({ globalPermission: 'allow' }),
    )).toBe(true);
  });

  test('returns true when rules change', () => {
    expect(hasPermissionChanged(
      baseSnapshot({
        permissionRules: [{ permission: 'bash', pattern: '*', action: 'ask' }],
      }),
      baseSnapshot(),
    )).toBe(true);
  });
});

describe('buildAgentSaveConfig', () => {
  test('update sends only changed prompt and leaves permission out', () => {
    const initial = baseSnapshot();
    const current = baseSnapshot({ prompt: 'Only prompt changed.' });

    expect(buildAgentSaveConfig({
      isNewAgent: false,
      agentName: 'build',
      draftHasExplicitPermission: false,
      current,
      initial,
      permissionConfig: { bash: 'ask' },
    })).toEqual({
      name: 'build',
      prompt: 'Only prompt changed.',
    });
  });

  test('update includes permission only when permission fields change', () => {
    const initial = baseSnapshot();
    const current = baseSnapshot({
      globalPermission: 'ask',
      permissionRules: [{ permission: 'bash', pattern: '*', action: 'deny' }],
    });
    const permissionConfig = { '*': 'ask', bash: 'deny' };

    expect(buildAgentSaveConfig({
      isNewAgent: false,
      agentName: 'build',
      draftHasExplicitPermission: false,
      current,
      initial,
      permissionConfig,
    })).toEqual({
      name: 'build',
      permission: permissionConfig,
    });
  });

  test('update includes each changed field independently', () => {
    const initial = baseSnapshot();
    const current = baseSnapshot({
      description: 'New description',
      mode: 'primary',
      model: '',
      variant: '',
      temperature: undefined,
      topP: 0.5,
    });

    expect(buildAgentSaveConfig({
      isNewAgent: false,
      agentName: 'build',
      draftHasExplicitPermission: false,
      current,
      initial,
      permissionConfig: 'allow',
    })).toEqual({
      name: 'build',
      description: 'New description',
      mode: 'primary',
      model: null,
      variant: null,
      temperature: null,
      top_p: 0.5,
    });
  });

  test('create omits default permission for blank agent', () => {
    const current = baseSnapshot({
      description: '',
      model: '',
      variant: '',
      temperature: undefined,
      topP: undefined,
      prompt: 'New agent prompt',
      permissionRules: [],
    });

    expect(buildAgentSaveConfig({
      isNewAgent: true,
      agentName: 'custom',
      draftScope: 'user',
      draftHasExplicitPermission: false,
      current,
      initial: current,
      permissionConfig: 'allow',
    })).toEqual({
      name: 'custom',
      mode: 'subagent',
      prompt: 'New agent prompt',
      scope: 'user',
    });
  });

  test('create keeps draft permission for duplicate even when unchanged', () => {
    const current = baseSnapshot({
      globalPermission: 'ask',
      permissionRules: [{ permission: 'bash', pattern: '*', action: 'ask' }],
    });
    const permissionConfig = { '*': 'ask', bash: 'ask' };

    expect(buildAgentSaveConfig({
      isNewAgent: true,
      agentName: 'custom-copy',
      draftScope: 'project',
      draftHasExplicitPermission: true,
      current,
      initial: current,
      permissionConfig,
    })).toEqual({
      name: 'custom-copy',
      mode: 'subagent',
      description: 'Helper',
      model: 'openai/gpt-5',
      variant: 'high',
      temperature: 0.2,
      top_p: 0.9,
      prompt: 'You are helpful.',
      permission: permissionConfig,
      scope: 'project',
    });
  });

  test('create includes permission when user customizes it', () => {
    const initial = baseSnapshot({
      description: '',
      model: '',
      variant: '',
      temperature: undefined,
      topP: undefined,
      prompt: '',
      globalPermission: 'allow',
      permissionRules: [],
    });
    const current = {
      ...initial,
      globalPermission: 'deny' as const,
    };

    expect(buildAgentSaveConfig({
      isNewAgent: true,
      agentName: 'custom',
      draftScope: 'user',
      draftHasExplicitPermission: false,
      current,
      initial,
      permissionConfig: 'deny',
    })).toEqual({
      name: 'custom',
      mode: 'subagent',
      permission: 'deny',
      scope: 'user',
    });
  });
});
