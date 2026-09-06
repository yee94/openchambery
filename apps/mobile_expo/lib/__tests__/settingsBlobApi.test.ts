import { describe, expect, it } from 'vitest';

import {
  parseSettingsBlob,
  themeModeFromBlob,
  themeModeToPatch,
} from '@/lib/settings/settingsBlobApi';
import { parseProviderCatalog } from '@/lib/settings/providersApi';
import { parseAgentList } from '@/lib/settings/agentsApi';
import { parseMcpServerList } from '@/lib/settings/mcpApi';
import { parseCommandsCatalog } from '@/lib/settings/commandsApi';
import { parsePluginsList } from '@/lib/settings/pluginsApi';
import { parseSkillsSummary } from '@/lib/settings/skillsApi';
import { parseSnippetsList } from '@/lib/settings/snippetsApi';
import { parseMagicPrompts } from '@/lib/settings/magicPromptsApi';
import { parseGitIdentities } from '@/lib/settings/gitIdentitiesApi';
import { parseAgentsMd } from '@/lib/settings/behaviorApi';

describe('settings blob parsers', () => {
  it('parses theme mode and strips summary tokens', () => {
    const blob = parseSettingsBlob({
      useSystemTheme: false,
      themeVariant: 'dark',
      showReasoningTraces: true,
      summaryCustomAPIToken: 'secret-token-should-not-linger',
      hasSummaryCustomAPIToken: true,
    });
    expect(themeModeFromBlob(blob)).toBe('dark');
    expect(blob.hasSummaryCustomAPIToken).toBe(true);
    expect('summaryCustomAPIToken' in blob).toBe(false);
    expect(themeModeToPatch('system')).toEqual({ useSystemTheme: true });
  });

  it('rejects invalid blob', () => {
    expect(() => parseSettingsBlob(null)).toThrow();
  });
});

describe('settings catalog parsers', () => {
  it('parses provider catalog', () => {
    const catalog = parseProviderCatalog({
      providers: [{ id: 'openai', name: 'OpenAI', models: { 'gpt-4': { id: 'gpt-4', name: 'GPT-4' } } }],
      default: { openai: 'gpt-4' },
      partial: false,
    });
    expect(catalog.providers[0]?.models[0]?.id).toBe('gpt-4');
  });

  it('parses agents/mcp/commands/plugins/skills/snippets/magic/git/behavior', () => {
    expect(parseAgentList([{ name: 'build', description: 'x' }])[0]?.name).toBe('build');
    expect(parseMcpServerList([{ name: 'fs' }])[0]?.name).toBe('fs');
    expect(parseCommandsCatalog({ commands: [{ name: 'test' }] })[0]?.name).toBe('test');
    expect(parsePluginsList({ entries: [{ id: 'a', spec: 'pkg' }], files: [] }).entries[0]?.id).toBe('a');
    expect(parseSkillsSummary([{ name: 'skill-a' }])[0]?.name).toBe('skill-a');
    expect(parseSnippetsList([{ name: 'snip' }])[0]?.name).toBe('snip');
    expect(parseMagicPrompts([{ id: 'review' }])[0]?.id).toBe('review');
    expect(parseGitIdentities([{ id: 'me', email: 'a@b.c' }])[0]?.email).toBe('a@b.c');
    expect(parseAgentsMd({ content: '# hi' })).toBe('# hi');
  });

  it('failure shapes reject empty success', () => {
    expect(() => parseProviderCatalog({})).toThrow();
    expect(() => parseAgentList({})).toThrow();
    expect(() => parseMcpServerList({})).toThrow();
    expect(() => parseCommandsCatalog({})).toThrow();
  });
});
