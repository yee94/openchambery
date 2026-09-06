import { describe, expect, it } from 'vitest';

import {
  collectConsecutiveProcessTools,
  formatProcessSummary,
  hasProcessSuccessor,
  isProcessGroupActive,
  isProcessGroupTool,
  isSkillGroupTool,
  isUsedGroupTool,
  summarizeProcessTools,
} from '@/lib/processToolGrouping';
import {
  collectConsecutiveSkillTools,
  formatSkillSummary,
  getSkillNameFromToolPart,
  summarizeSkillNames,
} from '@/lib/skillToolGrouping';

describe('process group predicates', () => {
  it('classifies explore + used as process, excludes skill/task/question', () => {
    expect(isProcessGroupTool('grep')).toBe(true);
    expect(isProcessGroupTool('bash')).toBe(true);
    expect(isProcessGroupTool('edit')).toBe(true);
    expect(isProcessGroupTool('skill')).toBe(false);
    expect(isProcessGroupTool('task')).toBe(false);
    expect(isProcessGroupTool('question')).toBe(false);
    expect(isUsedGroupTool('webfetch')).toBe(true);
    expect(isSkillGroupTool('runtime.skill:1')).toBe(true);
  });
});

describe('summarizeProcessTools / formatProcessSummary', () => {
  it('counts Cap order search/read/list/edit/command/other', () => {
    const counts = summarizeProcessTools(['grep', 'read', 'bash', 'edit', 'mcp_foo']);
    expect(counts).toEqual({
      search: 1,
      read: 1,
      list: 0,
      edit: 1,
      command: 1,
      other: 1,
    });
    expect(formatProcessSummary(['grep', 'grep', 'bash'])).toBe('2 searches, 1 command');
  });
});

describe('collect consecutive + successor / running', () => {
  it('collects adjacent process tools only', () => {
    const tools = ['grep', 'read', 'skill', 'bash'];
    const first = collectConsecutiveProcessTools(tools, 0, (name) => name);
    expect(first.items).toEqual(['grep', 'read']);
    expect(first.end).toBe(2);
    const afterSkill = collectConsecutiveProcessTools(tools, 3, (name) => name);
    expect(afterSkill.items).toEqual(['bash']);
  });

  it('keeps running while turn live without successor text', () => {
    const parts = [
      { type: 'tool', tool: 'grep', state: { status: 'completed', time: { start: 1, end: 2 } } },
    ];
    expect(
      isProcessGroupActive({
        parts,
        hasFollowingOtherType: false,
        isTurnLive: true,
      }),
    ).toBe(true);
    expect(
      isProcessGroupActive({
        parts,
        hasFollowingOtherType: true,
        isTurnLive: true,
      }),
    ).toBe(false);
  });

  it('treats text as successor, reasoning as not', () => {
    const items = [
      { type: 'tool', tool: 'grep' },
      { type: 'reasoning' },
      { type: 'text' },
    ];
    expect(
      hasProcessSuccessor(items, 1, (item) => ({
        type: item.type,
        toolName: 'tool' in item ? item.tool : undefined,
      })),
    ).toBe(true);
  });
});

describe('skill grouping', () => {
  it('collects consecutive skills and summarizes overflow', () => {
    const tools = ['skill', 'skill', 'bash'];
    const grouped = collectConsecutiveSkillTools(tools, 0, (name) => name);
    expect(grouped.items).toEqual(['skill', 'skill']);
    const names = ['a', 'b', 'c', 'd'];
    expect(summarizeSkillNames(names)).toMatchObject({
      visibleNames: ['a', 'b', 'c'],
      hiddenCount: 1,
      joinedVisible: 'a, b, c',
    });
    expect(formatSkillSummary(names, (joined, count) => `${joined} and ${count} more`)).toBe(
      'a, b, c and 1 more',
    );
  });

  it('reads skill name from Cap-shaped tool part', () => {
    expect(
      getSkillNameFromToolPart({
        state: { metadata: { name: 'expo-docs' }, input: { id: 'other' } },
      }),
    ).toBe('expo-docs');
  });
});
