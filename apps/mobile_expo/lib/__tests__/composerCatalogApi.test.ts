import { describe, expect, it } from 'vitest';

import { buildAutocompleteRows } from '@/lib/composerCatalogApi';

describe('buildAutocompleteRows', () => {
  it('builds slash command and mention rows', () => {
    const slash = buildAutocompleteRows('slash-command', 'un', {
      commands: [{ id: '1', name: 'undo', description: 'Undo last', isBuiltIn: true }],
      skills: [],
      snippets: [],
      agents: [],
      files: [],
    });
    expect(slash[0]?.insertText).toBe('/undo');

    const mention = buildAutocompleteRows('mention', 'bot', {
      commands: [],
      skills: [],
      snippets: [],
      agents: [{ name: 'bot', description: 'Helper' }],
      files: [{ path: '/repo/src/a.ts', relativePath: 'src/a.ts' }],
    });
    expect(mention.some((row) => row.insertText === '@bot')).toBe(true);
  });
});
