import { describe, expect, test } from 'bun:test';

import {
    collectConsecutiveSkillTools,
    getSkillNameFromToolPart,
    SKILL_GROUP_VISIBLE_LIMIT,
    summarizeSkillNames,
} from './skillToolGrouping';

describe('skill tool grouping', () => {
    test('merges consecutive skill names and splits on other tools', () => {
        const tools = ['skill', 'skill', 'bash', 'skill', 'read'];
        const first = collectConsecutiveSkillTools(tools, 0, (name) => name);
        expect(first.items).toEqual(['skill', 'skill']);
        expect(first.end).toBe(2);

        const afterBash = collectConsecutiveSkillTools(tools, 3, (name) => name);
        expect(afterBash.items).toEqual(['skill']);
        expect(afterBash.end).toBe(4);
    });

    test('reads the original skill name from metadata, input name, input id, or output', () => {
        expect(getSkillNameFromToolPart({
            state: { input: { name: 'sync-state-invariants' } },
        })).toBe('sync-state-invariants');
        expect(getSkillNameFromToolPart({
            state: { input: { name: '  diagnosing-bugs  ' } },
        })).toBe('diagnosing-bugs');
        expect(getSkillNameFromToolPart({
            state: { input: { id: 'openchamber-change-discipline' } },
        })).toBe('openchamber-change-discipline');
        expect(getSkillNameFromToolPart({
            state: {
                input: { id: 'skill-id' },
                metadata: { name: 'locale-ui-patterns' },
            },
        })).toBe('locale-ui-patterns');
        expect(getSkillNameFromToolPart({
            state: { output: { name: 'theme-system' } },
        })).toBe('theme-system');
        expect(getSkillNameFromToolPart({ state: { input: { name: '' } } })).toBeNull();
        expect(getSkillNameFromToolPart({ state: {} })).toBeNull();
        expect(getSkillNameFromToolPart(null)).toBeNull();
    });

    test('keeps two or three names on one line and overflows past three', () => {
        expect(SKILL_GROUP_VISIBLE_LIMIT).toBe(3);

        expect(summarizeSkillNames(['sync-state-invariants', 'diagnosing-bugs'])).toEqual({
            visibleNames: ['sync-state-invariants', 'diagnosing-bugs'],
            hiddenCount: 0,
            joinedVisible: 'sync-state-invariants, diagnosing-bugs',
        });

        expect(summarizeSkillNames(['one', 'two', 'three'])).toEqual({
            visibleNames: ['one', 'two', 'three'],
            hiddenCount: 0,
            joinedVisible: 'one, two, three',
        });

        expect(summarizeSkillNames(['one', 'two', 'three', 'four', 'five', 'six'])).toEqual({
            visibleNames: ['one', 'two', 'three'],
            hiddenCount: 3,
            joinedVisible: 'one, two, three',
        });
    });

    test('skips blank names before applying the visible limit', () => {
        expect(summarizeSkillNames(['one', '  ', null, 'two', undefined, 'three', 'four'])).toEqual({
            visibleNames: ['one', 'two', 'three'],
            hiddenCount: 1,
            joinedVisible: 'one, two, three',
        });
    });
});
