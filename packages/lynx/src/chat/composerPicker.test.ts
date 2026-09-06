import { describe, expect, test } from 'vitest';

import type { LynxComposerModel } from './composerActions';
import {
  LYNX_COMPOSER_PICKER_SHEETS,
  applyLynxAgentPickerSelection,
  applyLynxModelPickerSelection,
  filterLynxComposerPickerItems,
  loadLynxAgentPickerItems,
  loadLynxModelPickerItems,
  parseLynxModelPickerId,
} from './composerPicker';

const base: LynxComposerModel = {
  providerID: 'anthropic',
  modelID: 'claude-sonnet',
  agent: 'build',
  variant: 'high',
};

describe('composer agent/model picker selection', () => {
  test('parses Cap provider/model ids', () => {
    expect(parseLynxModelPickerId('openai/gpt-5.5')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.5',
    });
    expect(parseLynxModelPickerId('bad')).toBeNull();
    expect(parseLynxModelPickerId('/only-model')).toBeNull();
  });

  test('applies agent selection and clear (Cap not-selected)', () => {
    expect(applyLynxAgentPickerSelection(base, 'plan').agent).toBe('plan');
    expect(applyLynxAgentPickerSelection(base, '').agent).toBeUndefined();
    expect(applyLynxAgentPickerSelection(base, null).agent).toBeUndefined();
  });

  test('applies model selection and clears previous variant', () => {
    const next = applyLynxModelPickerSelection(base, {
      providerID: 'openai',
      modelID: 'gpt-5.5',
    });
    expect(next).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.5',
      agent: 'build',
    });
    expect(next.variant).toBeUndefined();
  });

  test('filters picker rows by query', () => {
    const items = [
      { id: 'build', title: 'build', subtitle: 'primary' },
      { id: 'plan', title: 'plan' },
    ];
    expect(filterLynxComposerPickerItems(items, 'bu').map((i) => i.id)).toEqual(['build']);
    expect(filterLynxComposerPickerItems(items, '').length).toBe(2);
  });

  test('sheet contract keeps triggers in glass and sheets outside', () => {
    expect(LYNX_COMPOSER_PICKER_SHEETS.triggersInsideGlass).toBe(true);
    expect(LYNX_COMPOSER_PICKER_SHEETS.sheetsInsideGlassContentView).toBe(false);
    expect(LYNX_COMPOSER_PICKER_SHEETS.fullScreenOpaque).toBe(false);
    expect(LYNX_COMPOSER_PICKER_SHEETS.halfHeight).toBe(true);
    expect(LYNX_COMPOSER_PICKER_SHEETS.grabber).toBe(true);
    expect(LYNX_COMPOSER_PICKER_SHEETS.dismissVertical).toBe(true);
    expect(LYNX_COMPOSER_PICKER_SHEETS.agentCatalogPath).toBe('/api/agent');
    expect(LYNX_COMPOSER_PICKER_SHEETS.modelCatalogPath).toBe('/api/config/providers');
    expect(LYNX_COMPOSER_PICKER_SHEETS.appliesViaPromptAsync).toBe(true);
  });
});

describe('composer picker catalog loads', () => {
  test('no-runtime is honest (never empty-ok)', async () => {
    await expect(loadLynxAgentPickerItems(null)).resolves.toEqual({ status: 'no-runtime' });
    await expect(loadLynxModelPickerItems(undefined)).resolves.toEqual({ status: 'no-runtime' });
  });

  test('loads agents from /api/agent and models from providers', async () => {
    const calls: string[] = [];
    const runtimeFetch = async (path: string) => {
      calls.push(path);
      if (path.includes('/api/agent')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ name: 'build', description: 'Build agent' }],
        };
      }
      if (path.includes('/api/config/providers')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            providers: [
              {
                id: 'anthropic',
                models: [{ id: 'claude-sonnet' }],
              },
            ],
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const agents = await loadLynxAgentPickerItems(runtimeFetch as never);
    const models = await loadLynxModelPickerItems(runtimeFetch as never);
    expect(agents).toEqual({
      status: 'ok',
      items: [{ id: 'build', title: 'build', subtitle: 'Build agent' }],
    });
    expect(models).toEqual({
      status: 'ok',
      items: [{ id: 'anthropic/claude-sonnet', title: 'claude-sonnet', subtitle: 'anthropic' }],
    });
    expect(calls.some((c) => c.includes('/api/agent'))).toBe(true);
    expect(calls.some((c) => c.includes('/api/config/providers'))).toBe(true);
  });

  test('HTTP failure ≠ empty success', async () => {
    const runtimeFetch = async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    const agents = await loadLynxAgentPickerItems(runtimeFetch as never);
    expect(agents.status).toBe('failed');
  });
});
