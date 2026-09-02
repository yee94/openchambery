import { beforeEach, describe, expect, test } from 'vitest';

import {
    clearConsumedUserSendAnimation,
    hasPendingUserSendAnimation,
    markPendingUserSendAnimation,
    peekConsumedUserSendAnimation,
    resetUserSendAnimationForTests,
    resolveConsumedSendMessageId,
} from './userSendAnimation';

describe('resolveConsumedSendMessageId', () => {
    beforeEach(() => {
        resetUserSendAnimationForTests();
    });

    test('consumes a pending send on append and remembers it', () => {
        markPendingUserSendAnimation('ses');
        const animatedIds = new Set<string>();
        expect(resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: false,
            previousUserOrder: ['a'],
            currentUserOrder: ['a', 'b'],
            animatedIds,
        })).toBe('b');
        expect(hasPendingUserSendAnimation('ses')).toBe(false);
        expect(peekConsumedUserSendAnimation('ses')).toBe('b');
        expect(animatedIds.has('b')).toBe(true);
    });

    test('re-latches the remembered send after a remount that already consumed pending', () => {
        markPendingUserSendAnimation('ses');
        resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: false,
            previousUserOrder: ['a'],
            currentUserOrder: ['a', 'b'],
            animatedIds: new Set(),
        });

        expect(resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: true,
            previousUserOrder: [],
            currentUserOrder: ['a', 'b'],
            animatedIds: new Set(),
        })).toBe('b');
    });

    test('does not re-latch after the park is released', () => {
        markPendingUserSendAnimation('ses');
        resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: false,
            previousUserOrder: ['a'],
            currentUserOrder: ['a', 'b'],
            animatedIds: new Set(),
        });
        clearConsumedUserSendAnimation('ses');

        expect(resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: true,
            previousUserOrder: [],
            currentUserOrder: ['a', 'b'],
            animatedIds: new Set(),
        })).toBeNull();
    });

    test('does not treat historical first paint as a send', () => {
        expect(resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: true,
            previousUserOrder: [],
            currentUserOrder: ['a', 'b'],
            animatedIds: new Set(),
        })).toBeNull();
    });

    test('a remount still sees the append against the module-scoped previous order', () => {
        resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: true,
            previousUserOrder: [],
            currentUserOrder: ['a'],
            animatedIds: new Set(),
        });
        markPendingUserSendAnimation('ses');
        expect(resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: true,
            previousUserOrder: [],
            currentUserOrder: ['a', 'b'],
            animatedIds: new Set(),
        })).toBe('b');
    });

    test('pending still parks the last user row when the module order already includes it', () => {
        resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: false,
            previousUserOrder: ['a'],
            currentUserOrder: ['a', 'b'],
            animatedIds: new Set(),
        });
        markPendingUserSendAnimation('ses');
        expect(resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: false,
            previousUserOrder: ['a', 'b'],
            currentUserOrder: ['a', 'b'],
            animatedIds: new Set(),
        })).toBe('b');
    });

    test('a shorter sibling transcript does not erase the live user order', () => {
        resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: false,
            previousUserOrder: [],
            currentUserOrder: ['a', 'b'],
            animatedIds: new Set(),
        });
        resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: false,
            previousUserOrder: ['a', 'b'],
            currentUserOrder: [],
            animatedIds: new Set(),
        });
        markPendingUserSendAnimation('ses');
        expect(resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: false,
            previousUserOrder: [],
            currentUserOrder: ['a', 'b', 'c'],
            animatedIds: new Set(),
        })).toBe('c');
    });

    test('a prepend that lands with the send still parks the new last user row', () => {
        resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: true,
            previousUserOrder: [],
            currentUserOrder: ['b'],
            animatedIds: new Set(),
        });
        markPendingUserSendAnimation('ses');
        expect(resolveConsumedSendMessageId({
            sessionId: 'ses',
            sessionChanged: false,
            previousUserOrder: ['b'],
            currentUserOrder: ['older', 'b', 'c'],
            animatedIds: new Set(),
        })).toBe('c');
    });
});
