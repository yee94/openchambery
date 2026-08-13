import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import type { State } from '@/sync/types';

import { EMPTY_REVERTED_MESSAGE_DOCK_STATE, buildRevertedMessageDockState } from './revertedMessageDockState';

const message = (id: string, role: 'user' | 'assistant'): Message => ({
    id,
    role,
    sessionID: 'ses_1',
    time: { created: 1 },
} as Message);

const textPart = (id: string, text: string): Part => ({
    id,
    type: 'text',
    text,
} as Part);

type LegacyDock = {
    session: State['session'];
    message: Record<string, Message[]>;
    part: Record<string, Part[]>;
};

const legacy = (partial: Partial<LegacyDock>): LegacyDock => ({
    session: [],
    message: {},
    part: {},
    ...partial,
});

describe('buildRevertedMessageDockState', () => {
    test('returns a shared empty state when the session is not reverted', () => {
        const first = buildRevertedMessageDockState(legacy({}), 'ses_1');
        const second = buildRevertedMessageDockState(
            legacy({ part: { assistant_1: [textPart('part_1', 'streaming')] } }),
            'ses_1',
            first,
        );

        expect(first).toBe(EMPTY_REVERTED_MESSAGE_DOCK_STATE);
        expect(second).toBe(EMPTY_REVERTED_MESSAGE_DOCK_STATE);
    });

    test('reuses the previous state when unrelated assistant parts change', () => {
        const user = message('user_1', 'user');
        const userParts = [textPart('part_user', 'hello')];
        const first = buildRevertedMessageDockState(
            legacy({
                session: [{ id: 'ses_1', revert: { messageID: 'user_1' } } as State['session'][number]],
                message: { ses_1: [user, message('assistant_1', 'assistant')] },
                part: { user_1: userParts, assistant_1: [textPart('part_a', 'a')] },
            }),
            'ses_1',
        );

        const second = buildRevertedMessageDockState(
            legacy({
                session: [{ id: 'ses_1', revert: { messageID: 'user_1' } } as State['session'][number]],
                message: { ses_1: [user, message('assistant_1', 'assistant')] },
                part: { user_1: userParts, assistant_1: [textPart('part_a2', 'updated')] },
            }),
            'ses_1',
            first,
        );

        expect(second).toBe(first);
    });

    test('updates when a reverted user message part changes', () => {
        const user = message('user_1', 'user');
        const first = buildRevertedMessageDockState(
            legacy({
                session: [{ id: 'ses_1', revert: { messageID: 'user_1' } } as State['session'][number]],
                message: { ses_1: [user] },
                part: { user_1: [textPart('part_user', 'hello')] },
            }),
            'ses_1',
        );

        const second = buildRevertedMessageDockState(
            legacy({
                session: [{ id: 'ses_1', revert: { messageID: 'user_1' } } as State['session'][number]],
                message: { ses_1: [user] },
                part: { user_1: [textPart('part_user_updated', 'updated')] },
            }),
            'ses_1',
            first,
        );

        expect(second).not.toBe(first);
        expect(second.records).toHaveLength(1);
    });

    test('accepts repository-shaped messages/parts without child-store maps', () => {
        const user = message('user_1', 'user');
        const snapshot = buildRevertedMessageDockState(
            {
                session: [{ id: 'ses_1', revert: { messageID: 'user_1' } } as State['session'][number]],
                messages: [user],
                partsByMessageID: { user_1: [textPart('part_user', 'hello')] },
            },
            'ses_1',
        );
        expect(snapshot.records).toHaveLength(1);
        expect(snapshot.records[0]?.message.id).toBe('user_1');
    });

    test('lists reverted user rows by conversation order when ids are not monotonic', () => {
        const olderHighId = message('msg_9', 'user');
        const laterLowId = message('msg_2', 'user');
        const snapshot = buildRevertedMessageDockState(
            {
                session: [{ id: 'ses_1', revert: { messageID: 'msg_2' } } as State['session'][number]],
                messages: [olderHighId, laterLowId],
                partsByMessageID: {
                    msg_9: [textPart('part_9', 'older')],
                    msg_2: [textPart('part_2', 'later')],
                },
            },
            'ses_1',
        );
        expect(snapshot.records.map((record) => record.message.id)).toEqual(['msg_2']);
    });
});
