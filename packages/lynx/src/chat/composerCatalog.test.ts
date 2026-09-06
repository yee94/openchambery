import { describe, expect, test } from 'vitest';

import {
  applyLynxComposerSuggestion,
  detectLynxComposerTrigger,
  filterLynxComposerSuggestions,
  suggestionsForTrigger,
  type LynxComposerCatalogBundle,
} from './composerCatalog';

const ok = (items: { id: string; title: string }[]) => ({ status: 'ok' as const, items });

describe('composer / @ catalogs', () => {
  test('detects slash and mention triggers', () => {
    expect(detectLynxComposerTrigger('hello /mo')).toEqual({ trigger: 'slash', query: 'mo' });
    expect(detectLynxComposerTrigger('@ag')).toEqual({ trigger: 'mention', query: 'ag' });
    expect(detectLynxComposerTrigger('plain')).toEqual({ trigger: 'none', query: '' });
  });

  test('filters suggestions and applies insert', () => {
    const bundle: LynxComposerCatalogBundle = {
      commands: ok([{ id: 'model', title: 'model' }]),
      agents: ok([{ id: 'build', title: 'build' }]),
      magicPrompts: ok([]),
      models: ok([{ id: 'anthropic/claude', title: 'claude', subtitle: 'anthropic' } as never]),
    };
    const slash = suggestionsForTrigger(bundle, 'slash', 'mo');
    expect(slash[0]?.insertText).toBe('/model');
    const mention = suggestionsForTrigger(bundle, 'mention', 'bu');
    expect(mention[0]?.insertText).toBe('@build');
    expect(applyLynxComposerSuggestion('hi /mo', slash[0]!)).toContain('/model');
    expect(filterLynxComposerSuggestions(slash, 'zzz')).toEqual([]);
  });
});
