import { describe, expect, test } from 'vitest';

import {
  resolveFileMentionIconName,
  resolveSkillIconName,
  resolveSlashCommandIconName,
} from './icons';
import { spriteIconSvgMarkup } from './rasterize-icon';
import { buildMentionRows, buildSkillRows, buildSlashCommandRows } from './rows';

describe('composer autocomplete icons and rows', () => {
  test.each(['ge', 'gene'])('ranks @%s names before description-only matches', (searchQuery) => {
    const rows = buildMentionRows({
      searchQuery,
      agents: [{ name: 'general' }],
      skills: [
        { name: 'gpt-image-generator', scope: 'user' },
        { name: 'poe-image-generator', scope: 'user' },
        { name: 'wxa-skills-generate', scope: 'user' },
        { name: 'agent-tracker-api', scope: 'user' },
        { name: 'comic-illustration', scope: 'user', description: 'generate images' },
      ],
      sessions: [], recentFiles: [],
      pathHits: [{ path: '/repo/generate.ts', name: 'generate.ts' }],
      untitledSession: 'Untitled',
    });
    expect(rows[0]).toMatchObject({ title: '@general', agentName: 'general' });
    const skillNames = rows.filter((row) => row.id.startsWith('skill:')).map((row) => row.title);
    // These two names tie in fuzzysort; their order depends on the complete catalog.
    expect(skillNames.slice(0, 2).sort()).toEqual(['@gpt-image-generator', '@poe-image-generator']);
    expect(skillNames.slice(2)).toEqual(searchQuery === 'ge'
      ? ['@wxa-skills-generate', '@agent-tracker-api', '@comic-illustration']
      : ['@wxa-skills-generate', '@comic-illustration']);
    expect(rows.at(-1)?.title).toBe('generate.ts');
  });

  test.each(['Runmark', 'runmark', 'RUNMARK'])('recalls a skill by its description with @%s', (searchQuery) => {
    const rows = buildMentionRows({
      searchQuery,
      agents: [{ name: 'general', description: 'Runmark' }],
      skills: [
        { name: 'agent-tracker-api', scope: 'user', description: '通过 curl 查询 Runmark API，拉取会话上下文与统计。' },
        { name: 'runmark-tools', scope: 'project', description: 'Usage reports' },
        { name: 'drawing', scope: 'user', description: 'Generate pictures' },
      ],
      sessions: [], recentFiles: [], pathHits: [], untitledSession: 'Untitled',
    });
    expect(rows.map((row) => row.title)).toEqual(['@runmark-tools', '@agent-tracker-api']);
  });

  test('lets an exact skill outrank a partial agent and bounds a 300-entry catalog', () => {
    const rows = buildMentionRows({
      searchQuery: 'general',
      agents: [{ name: 'general-helper' }],
      skills: [{ name: 'general', scope: 'user' }, ...Array.from({ length: 300 }, (_, i) => ({
        name: `general-${i}`, scope: 'project',
      }))],
      sessions: [], recentFiles: [], pathHits: [], untitledSession: 'Untitled',
    });
    expect(rows).toHaveLength(10);
    expect(rows[0]?.id).toBe('skill:general-user');
  });

  test('maps slash command names to sprite icons', () => {
    expect(resolveSlashCommandIconName({ name: 'undo' })).toBe('arrow-go-back');
    expect(resolveSlashCommandIconName({ name: 'new' })).toBe('add');
    expect(resolveSlashCommandIconName({ name: 'reload', isBuiltIn: true })).toBe('refresh');
    expect(resolveSlashCommandIconName({ name: 'mystery', isBuiltIn: true })).toBe('flashlight');
    expect(resolveSlashCommandIconName({ name: 'loop' })).toBe('command');
    expect(resolveSkillIconName()).toBe('book-open');
  });

  test('maps mention paths to sprite icons', () => {
    expect(resolveFileMentionIconName({ isDirectory: true })).toBe('folder-3-fill');
    expect(resolveFileMentionIconName({ extension: 'ts' })).toBe('code');
    expect(resolveFileMentionIconName({ extension: 'png' })).toBe('file-image');
    expect(resolveFileMentionIconName({ extension: 'bin' })).toBe('file-pdf');
  });

  test('builds slash, skill, and mention rows in keyboard order', () => {
    expect(buildSlashCommandRows(
      [{ id: 'yuri:undo', name: 'undo', description: 'restore', isBuiltIn: true }],
      { skill: 'Skill', command: 'Command', system: 'System' },
    )).toEqual([{
      id: 'yuri:undo',
      title: '/undo',
      subtitle: 'restore',
      badge: 'System',
      iconName: 'arrow-go-back',
    }]);

    expect(buildSkillRows([
      { name: 'review', scope: 'project', description: 'look at the diff' },
    ])).toEqual([{
      id: 'review-project',
      title: 'review',
      subtitle: 'look at the diff',
      badge: 'project',
      iconName: 'book-open',
    }]);

    const mentionRows = buildMentionRows({
      skills: [{ name: 'review', scope: 'project', description: 'look at the diff' }],
      agents: [{ name: 'explore', description: 'look around' }],
      sessions: [{ id: 'ses_1', title: 'Fix login' }],
      recentFiles: [{ path: '/repo/a.ts', name: 'a.ts', relativePath: 'a.ts', extension: 'ts' }],
      pathHits: [{ path: '/repo/src', name: 'src', relativePath: 'src', isDirectory: true }],
      untitledSession: 'Untitled',
      sessionBadge: 'Session',
    });
    expect(mentionRows.map((row) => row.id)).toEqual([
      'skill:review-project',
      'agent:explore',
      'recent:/repo/a.ts',
      'file:/repo/src',
      'session:ses_1',
    ]);
    expect(mentionRows[0]?.title).toBe('@review');
    expect(mentionRows[0]?.iconName).toBe('book-open');
    expect(mentionRows[1]?.title).toBe('@explore');
    expect(mentionRows[3]?.iconName).toBe('folder-3-fill');
  });

  test('builds standalone SVG markup from the sprite', () => {
    const markup = spriteIconSvgMarkup('command', '#111111');
    expect(markup).toContain('viewBox="0 0 24 24"');
    expect(markup).toContain('stroke="#111111"');
    expect(spriteIconSvgMarkup('not-a-real-icon', '#111111')).toBeNull();
  });
});
