import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';

import { buildLiveStreamingEntry, type StreamingTailEntry } from './streamingTailEntry';
import type { ChatMessageEntry, TurnRecord } from './types';

const message = (id: string, role: 'user' | 'assistant', parentID?: string, parts: Part[] = []): ChatMessageEntry => ({
    info: {
        id,
        role,
        sessionID: 'ses_1',
        ...(parentID ? { parentID } : {}),
        time: { created: 1 },
    } as Message,
    parts,
});

const textPart = (id: string, text: string): Part => ({
    id,
    type: 'text',
    text,
} as Part);

const syntheticTextPart = (id: string, text: string): Part => ({
    id,
    type: 'text',
    text,
    synthetic: true,
} as Part);

const reasoningPart = (id: string, text: string): Part => ({
    id,
    type: 'reasoning',
    text,
} as Part);

const turnEntry = (assistant: ChatMessageEntry): StreamingTailEntry => {
    const user = message('user_1', 'user');
    return {
        kind: 'turn',
        key: 'turn:user_1',
        isLastTurn: true,
        turn: {
            turnId: 'user_1',
            userMessageId: 'user_1',
            userMessage: user,
            headerMessageId: assistant.info.id,
            messages: [],
            assistantMessageIds: [assistant.info.id],
            assistantMessages: [assistant],
            activityParts: [],
            activitySegments: [],
            summary: {},
            hasTools: false,
            hasReasoning: false,
            stream: { isStreaming: true, isRetrying: false },
            completionDisposition: 'active',
            activityPresentationKind: 'default',
        } satisfies TurnRecord,
    };
};

describe('buildLiveStreamingEntry', () => {
    test('returns the same entry when the active message is not in the tail', () => {
        const assistant = message('assistant_1', 'assistant', 'user_1', [textPart('part_1', 'old')]);
        const entry = turnEntry(assistant);

        const next = buildLiveStreamingEntry(entry, {
            activeStreamingMessageId: 'assistant_other',
            liveParts: [textPart('part_live', 'live')],
            showTextJustificationActivity: true,
            showTurnChangedFiles: false,
        });

        expect(next).toBe(entry);
    });

    test('rebuilds only the streaming turn with live parts', () => {
        const assistant = message('assistant_1', 'assistant', 'user_1', [textPart('part_1', 'hel')]);
        const entry = turnEntry(assistant);
        // A live frame for an open message carries the ids it already had; the store
        // grows `state.part[messageID]` and only shrinks on an authoritative removal.
        const liveParts = [textPart('part_1', 'hello'), reasoningPart('part_1_live', 'thinking')];

        const next = buildLiveStreamingEntry(entry, {
            activeStreamingMessageId: 'assistant_1',
            liveParts,
            showTextJustificationActivity: true,
            showTurnChangedFiles: false,
        });

        expect(next).not.toBe(entry);
        expect(next.kind).toBe('turn');
        if (next.kind !== 'turn') return;
        // mergePartsForDisplay may copy; content is the live overlay.
        expect(next.turn.assistantMessages[0]?.parts).toEqual(liveParts);
        expect(next.turn.activityParts.length).toBeGreaterThan(0);
    });

    test('updates an ungrouped streaming message with live parts', () => {
        const stale = message('assistant_1', 'assistant', undefined, [textPart('part_1', 'old')]);
        const entry: StreamingTailEntry = {
            kind: 'ungrouped',
            key: 'msg:assistant_1',
            message: stale,
        };
        const liveParts = [textPart('part_1', 'old'), textPart('part_1_live', 'live')];

        const next = buildLiveStreamingEntry(entry, {
            activeStreamingMessageId: 'assistant_1',
            liveParts,
            showTextJustificationActivity: false,
            showTurnChangedFiles: false,
        });

        expect(next).not.toBe(entry);
        expect(next.kind).toBe('ungrouped');
        if (next.kind !== 'ungrouped') return;
        expect(next.message.parts).toEqual(liveParts);
    });

    test('does not wipe tools when live snapshot regresses tool count', () => {
        const toolA = {
            id: 't1',
            type: 'tool',
            tool: 'bash',
            state: { status: 'completed', output: 'a', time: { start: 1, end: 2 } },
        } as unknown as Part;
        const toolB = {
            id: 't2',
            type: 'tool',
            tool: 'bash',
            state: { status: 'running', input: { command: 'ls' }, time: { start: 3 } },
        } as unknown as Part;
        const assistant = message('assistant_1', 'assistant', 'user_1', [toolA, toolB]);
        const entry = turnEntry(assistant);
        // Lagging materialize: only t1, drops t2.
        const liveParts = [{ ...toolA, state: { status: 'completed', output: 'a2', time: { start: 1, end: 2 } } } as Part];

        const next = buildLiveStreamingEntry(entry, {
            activeStreamingMessageId: 'assistant_1',
            liveParts,
            showTextJustificationActivity: true,
            showTurnChangedFiles: false,
        });

        expect(next.kind).toBe('turn');
        if (next.kind !== 'turn') return;
        const parts = next.turn.assistantMessages[0]?.parts ?? [];
        expect(parts.map((part) => part.id)).toEqual(['t1', 't2']);
    });

    test('normalizes live tail parts with the display filtering path', () => {
        const stale = message('assistant_1', 'assistant', 'user_1', [textPart('part_1', 'old')]);
        const entry = turnEntry(stale);
        const stalePart = stale.parts[0] as Part;
        const visible = textPart('part_visible', 'visible');
        const synthetic = syntheticTextPart('part_synthetic', 'hidden while streaming');

        const next = buildLiveStreamingEntry(entry, {
            activeStreamingMessageId: 'assistant_1',
            liveParts: [stalePart, synthetic, visible],
            showTextJustificationActivity: true,
            showTurnChangedFiles: false,
        });

        expect(next.kind).toBe('turn');
        if (next.kind !== 'turn') return;
        expect(next.turn.assistantMessages[0]?.parts).toEqual([stalePart, visible]);
    });

});

