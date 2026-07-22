import { describe, expect, test } from 'bun:test';
import type { Agent } from '@opencode-ai/sdk/v2';
import { resolveComposerPrimaryAgents, resolveComposerVisibleAgents } from './chatComposerCatalog';

const agent = (
  name: string,
  options?: { hidden?: boolean; mode?: Agent['mode']; optionsHidden?: boolean },
): Agent => ({
  name,
  mode: options?.mode,
  ...(options?.hidden ? { hidden: true } : {}),
  ...(options?.optionsHidden ? { options: { hidden: true } } : {}),
} as unknown as Agent);

describe('chatComposerCatalog', () => {
  test('drops hidden internals before primary-mode filtering', () => {
    const agents = [
      agent('build', { mode: 'primary' }),
      agent('title', { mode: 'primary', hidden: true }),
      agent('summary', { mode: 'all', optionsHidden: true }),
      agent('compaction', { mode: 'subagent', hidden: true }),
      agent('explore', { mode: 'subagent' }),
      agent('plan', { mode: 'all' }),
    ];

    expect(resolveComposerVisibleAgents(agents).map((entry) => entry.name)).toEqual([
      'build',
      'explore',
      'plan',
    ]);
    expect(resolveComposerPrimaryAgents(agents).map((entry) => entry.name)).toEqual([
      'build',
      'plan',
    ]);
  });

  test('treats missing catalogs as empty', () => {
    expect(resolveComposerVisibleAgents(undefined)).toEqual([]);
    expect(resolveComposerPrimaryAgents(null)).toEqual([]);
  });
});
