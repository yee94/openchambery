import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';

import { projectTurnActivity } from './projectTurnActivity';
import { projectTurnSummary } from './projectTurnSummary';
import { resolveActivityPartId } from './resolveActivityPartId';
import type { ChatMessageEntry } from './types';

const toolPart = (id: string | undefined, tool = 'bash'): Part => ({
    id,
    type: 'tool',
    tool,
    state: { status: 'completed', output: 'ok', time: { start: 1, end: 2 } },
} as Part);

const assistant = (id: string, parts: Part[], finish?: string): ChatMessageEntry => ({
    info: {
        id,
        role: 'assistant',
        sessionID: 'ses_1',
        parentID: 'user_1',
        time: { created: 1 },
        ...(finish ? { finish } : {}),
    } as Message,
    parts,
});

describe('resolveActivityPartId', () => {
    test('prefers the server part id', () => {
        expect(resolveActivityPartId('msg_1', toolPart('prt_real'), 3)).toBe('prt_real');
    });

    test('falls back to a message-scoped index id for synthesized parts', () => {
        expect(resolveActivityPartId('msg_1', toolPart(undefined), 2)).toBe('msg_1-part-2-tool');
    });

    test('activity rows and the summary source agree on the same part id', () => {
        // The summary source id is matched against activity row ids to decide
        // whether a text part renders as a justification row or as the message
        // body. Divergent ids moved that text between two hosts mid-turn.
        const text = { id: 'prt_text', type: 'text', text: 'final answer' } as Part;
        const messages = [assistant('msg_1', [toolPart('prt_tool'), text], 'stop')];

        const summary = projectTurnSummary(messages);
        const activity = projectTurnActivity({
            turnId: 'user_1',
            assistantMessages: messages,
            summarySourceMessageId: summary.sourceMessageId,
            summarySourcePartId: summary.sourcePartId,
            showTextJustificationActivity: true,
        });

        expect(summary.sourcePartId).toBe('prt_text');
        expect(activity.activityParts.map((part) => part.id)).toEqual(['prt_tool']);
    });
});
