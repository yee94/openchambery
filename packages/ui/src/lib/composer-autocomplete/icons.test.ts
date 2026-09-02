import { describe, expect, test } from 'vitest';

import {
  resolveFileMentionIconName,
  resolveSkillIconName,
  resolveSlashCommandIconName,
} from './icons';
import { spriteIconSvgMarkup } from './rasterize-icon';
import { buildMentionRows, buildSkillRows, buildSlashCommandRows } from './rows';

describe('composer autocomplete icons and rows', () => {
  test('maps slash command names to sprite icons', () => {
    expect(resolveSlashCommandIconName({ name: 'undo' })).toBe('arrow-go-back');
    expect(resolveSlashCommandIconName({ name: 'new' })).toBe('add');
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
      [{ id: 'openchamber:undo', name: 'undo', description: 'restore', isBuiltIn: true }],
      { skill: 'Skill', command: 'Command', system: 'System' },
    )).toEqual([{
      id: 'openchamber:undo',
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
      agents: [{ name: 'explore', description: 'look around' }],
      sessions: [{ id: 'ses_1', title: 'Fix login' }],
      recentFiles: [{ path: '/repo/a.ts', name: 'a.ts', relativePath: 'a.ts', extension: 'ts' }],
      pathHits: [{ path: '/repo/src', name: 'src', relativePath: 'src', isDirectory: true }],
      untitledSession: 'Untitled',
      sessionBadge: 'Session',
    });
    expect(mentionRows.map((row) => row.id)).toEqual([
      'agent:explore',
      'session:ses_1',
      'recent:/repo/a.ts',
      'file:/repo/src',
    ]);
    expect(mentionRows[0]?.title).toBe('@explore');
    expect(mentionRows[3]?.iconName).toBe('folder-3-fill');
  });

  test('builds standalone SVG markup from the sprite', () => {
    const markup = spriteIconSvgMarkup('command', '#111111');
    expect(markup).toContain('viewBox="0 0 24 24"');
    expect(markup).toContain('stroke="#111111"');
    expect(spriteIconSvgMarkup('not-a-real-icon', '#111111')).toBeNull();
  });
});
