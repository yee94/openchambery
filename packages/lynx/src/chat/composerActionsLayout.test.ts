import { describe, expect, test } from 'vitest';

import { LYNX_COMPOSER_AUTOCOMPLETE_LAYOUT } from './composerAutocompleteLayout';
import {
  LYNX_COMPOSER_ACTIONS_IN_GLASS,
  resolveLynxComposerInGlassActionOrder,
} from './composerActionsLayout';

describe('Lynx composer actions inside glass (Cap order)', () => {
  test('collapsed pill is + · input · Send/Stop (no agent/model/queue)', () => {
    expect(resolveLynxComposerInGlassActionOrder('pill')).toEqual([
      'attach',
      'input',
      'sendOrStop',
    ]);
    expect(LYNX_COMPOSER_ACTIONS_IN_GLASS.collapsedOrder).toEqual([
      'attach',
      'input',
      'sendOrStop',
    ]);
  });

  test('expanded card footer is + · spacer · Agent · model · Send/Stop (± Queue)', () => {
    expect(resolveLynxComposerInGlassActionOrder('card')).toEqual([
      'attach',
      'spacer',
      'agent',
      'model',
      'sendOrStop',
    ]);
    expect(resolveLynxComposerInGlassActionOrder('card', { showQueue: true })).toEqual([
      'attach',
      'spacer',
      'agent',
      'model',
      'sendOrStop',
      'queue',
    ]);
    expect(LYNX_COMPOSER_ACTIONS_IN_GLASS.expandedFooterOrder).toEqual([
      'attach',
      'spacer',
      'agent',
      'model',
      'sendOrStop',
      'queue',
    ]);
  });

  test('actions may live in glass contentView; autocomplete must not', () => {
    expect(LYNX_COMPOSER_ACTIONS_IN_GLASS.actionsInsideGlassContentView).toBe(true);
    expect(LYNX_COMPOSER_ACTIONS_IN_GLASS.autocompleteInsideGlassContentView).toBe(false);
    expect(LYNX_COMPOSER_AUTOCOMPLETE_LAYOUT.forbidInsideGlassContentView).toBe(true);
    expect(LYNX_COMPOSER_AUTOCOMPLETE_LAYOUT.placement).toBe('above-glass-composer');
    expect(LYNX_COMPOSER_ACTIONS_IN_GLASS.expandedCountsAsOccupancy).toBe(false);
  });
});
