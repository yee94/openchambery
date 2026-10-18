import { describe, expect, test } from 'vitest';
import type { Part } from '@/lib/opencode/v2-types';
import { filterVisibleParts, isEmptyTextPart } from './partUtils';
import { projectTurnActivity } from '../lib/turns/projectTurnActivity';
import { hasConfirmedFinalBody } from '../lib/turns/assistantMessageLifecycle';
import type { ChatMessageEntry } from '../lib/turns/types';

const textPart = (text: string): Part => ({ id: 'text', type: 'text', text } as Part);

describe('invisible provider text', () => {
    test.each(['\u200b', ' \n\u200b\u200c\u200d\u2060\ufeff\t'])('does not paint or split process activity: %j', (text) => {
        const placeholder = textPart(text);
        const parts = [
            { id: 'before', type: 'tool', tool: 'grep', state: { status: 'completed' } } as Part,
            placeholder,
            { id: 'after', type: 'tool', tool: 'read', state: { status: 'running' } } as Part,
        ];
        expect(isEmptyTextPart(placeholder)).toBe(true);
        expect(filterVisibleParts(parts)).toEqual([parts[0], parts[2]]);
        const activity = projectTurnActivity({
            turnId: 'turn',
            assistantMessages: [{ info: { id: 'assistant' }, parts } as ChatMessageEntry],
            showTextJustificationActivity: true,
        });
        expect(activity.activityParts.map((part) => part.kind)).toEqual(['tool', 'tool']);
        expect(hasConfirmedFinalBody('stop', [placeholder])).toBe(false);
    });

    test.each(['正常正文', 'a\u200bb', '👩\u200d💻', 'می\u200cروم'])('preserves visible text and embedded format characters: %s', (text) => {
        const part = textPart(text);
        expect(isEmptyTextPart(part)).toBe(false);
        expect(filterVisibleParts([part])).toEqual([part]);
        expect(hasConfirmedFinalBody('stop', [part])).toBe(true);
    });
});
