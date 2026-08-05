/**
 * Regression: a mid-turn "this message finished" verdict flipped the whole turn
 * to settled for a frame, and that verdict used to reach the data model.
 *
 * Evidence: Trace-20260805T17*, session 019fd075-def4-7081-b855-09a46de0ca4f.
 * Every shell step ended with the fold's content disappearing and returning
 * ~200ms later.
 *
 * Contracts locked here:
 * 1. `finish === 'stop'` does not settle a turn whose last assistant still has a
 *    running tool (SSE delivers message.updated and message.part.updated apart).
 * 2. An aborted turn still settles even with a dangling tool.
 * 3. Activity row membership does not change when the turn's disposition changes.
 * 4. A queued user row does not settle the turn that is still streaming.
 */

import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';

import { projectTurnActivity } from './projectTurnActivity';
import { projectTurnRecords } from './projectTurnRecords';
import { projectTurnSummary } from './projectTurnSummary';
import type { ChatMessageEntry } from './types';

const sessionID = 'ses_1';

const userMessage = (id: string, created: number): ChatMessageEntry => ({
    info: { id, sessionID, role: 'user', time: { created } } as Message,
    parts: [{ id: `${id}_p`, type: 'text', text: 'go' } as Part],
});

const assistantMessage = (input: {
    id: string;
    parentID: string;
    created: number;
    finish?: string;
    completed?: number;
    error?: unknown;
    parts?: Part[];
}): ChatMessageEntry => ({
    info: {
        id: input.id,
        sessionID,
        role: 'assistant',
        parentID: input.parentID,
        time: { created: input.created, ...(input.completed ? { completed: input.completed } : {}) },
        ...(input.finish ? { finish: input.finish } : {}),
        ...(input.error ? { error: input.error } : {}),
    } as Message,
    parts: input.parts ?? [],
});

const tool = (id: string, status: 'running' | 'completed'): Part => ({
    id,
    type: 'tool',
    tool: 'bash',
    state: status === 'running'
        ? { status, input: { command: 'ls' }, time: { start: 10 } }
        : { status, input: { command: 'ls' }, output: 'ok', time: { start: 10, end: 20 } },
} as unknown as Part);

const dispositionOf = (messages: ChatMessageEntry[]): string | undefined =>
    projectTurnRecords(messages).turns[0]?.completionDisposition;

describe('turn completion disposition', () => {
    test('a stop that lands before the tool state does not settle the turn', () => {
        const messages = [
            userMessage('u1', 1),
            assistantMessage({
                id: 'a1',
                parentID: 'u1',
                created: 2,
                finish: 'stop',
                completed: 30,
                parts: [tool('t1', 'running')],
            }),
        ];
        expect(dispositionOf(messages)).toBe('active');
    });

    test('the same turn settles once the tool reports completed', () => {
        const messages = [
            userMessage('u1', 1),
            assistantMessage({
                id: 'a1',
                parentID: 'u1',
                created: 2,
                finish: 'stop',
                completed: 30,
                parts: [tool('t1', 'completed')],
            }),
        ];
        expect(dispositionOf(messages)).toBe('normal');
    });

    test('an aborted turn settles even with a dangling running tool', () => {
        const messages = [
            userMessage('u1', 1),
            assistantMessage({
                id: 'a1',
                parentID: 'u1',
                created: 2,
                error: { name: 'AbortError' },
                parts: [tool('t1', 'running')],
            }),
        ];
        expect(dispositionOf(messages)).toBe('abnormal');
    });

    test('a later open step does not change the earlier message\'s Activity rows', () => {
        // `hasCanonicalStopSummary` used to require turn disposition === 'normal',
        // and disposition comes from the *last* assistant. Appending the next step
        // therefore re-classified a finished message's non-summary text, moving it
        // between an Activity justification row and the message body — a host change,
        // which unmounts the fold. Membership must be message-local.
        const finished = assistantMessage({
            id: 'a1',
            parentID: 'u1',
            created: 2,
            finish: 'stop',
            completed: 9,
            parts: [
                { id: 'p_aside', type: 'text', text: 'let me check the config' } as Part,
                { id: 'p_summary', type: 'text', text: 'the config is fine' } as Part,
            ],
        });
        const nextStepOpen = assistantMessage({ id: 'a2', parentID: 'u1', created: 3 });

        const rowsFor = (assistantMessages: ChatMessageEntry[]) => {
            const summary = projectTurnSummary(assistantMessages);
            return projectTurnActivity({
                turnId: 'u1',
                assistantMessages,
                summarySourceMessageId: summary.sourceMessageId,
                summarySourcePartId: summary.sourcePartId,
                showTextJustificationActivity: true,
            }).activityParts.map((activity) => activity.id);
        };

        expect(rowsFor([finished])).toEqual(['p_aside']);
        expect(rowsFor([finished, nextStepOpen])).toEqual(['p_aside']);
    });

    test('a queued user row does not settle the turn still streaming above it', () => {
        const messages = [
            userMessage('u1', 1),
            assistantMessage({ id: 'a1', parentID: 'u1', created: 2, parts: [tool('t1', 'running')] }),
            userMessage('u2', 3),
        ];
        const turns = projectTurnRecords(messages).turns;
        expect(turns[0]?.completionDisposition).toBe('active');

        // Once the server answers the queued message, the earlier turn is history.
        const answered = [
            ...messages,
            assistantMessage({ id: 'a2', parentID: 'u2', created: 4 }),
        ];
        expect(projectTurnRecords(answered).turns[0]?.completionDisposition).toBe('abnormal');
    });
});
