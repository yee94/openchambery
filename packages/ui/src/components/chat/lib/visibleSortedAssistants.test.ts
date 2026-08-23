import { describe, expect, test } from 'vitest';
import type { Part } from '@opencode-ai/sdk/v2';

import type { ChatMessageEntry, TurnActivityRecord } from './turns/types';
import { dropLiveRevealJustificationParts, isAssistantMessageCompleted, resolveLiveRevealBodyMessageId, resolveVisibleSortedAssistants } from './visibleSortedAssistants';

const toolPart = (id: string): Part => ({
    id,
    type: 'tool',
    tool: 'read',
    state: { status: 'completed', input: {} },
} as unknown as Part);

const textPart = (id: string, text: string): Part => ({ id, type: 'text', text } as unknown as Part);

const assistant = (input: {
    id: string;
    finish?: string;
    error?: unknown;
    completed?: number;
    parts: Part[];
}): ChatMessageEntry => ({
    info: {
        id: input.id,
        role: 'assistant',
        parentID: 'u1',
        ...(input.finish !== undefined ? { finish: input.finish } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        time: {
            created: 1,
            ...(input.completed !== undefined ? { completed: input.completed } : {}),
        },
    } as ChatMessageEntry['info'],
    parts: input.parts,
});

const activity = (kind: TurnActivityRecord['kind'], messageId: string): TurnActivityRecord => ({
    id: `${messageId}:${kind}`,
    turnId: 't',
    messageId,
    part: toolPart(`p_${messageId}_${kind}`),
    partIndex: 0,
    endedAt: undefined,
    kind,
});

describe('resolveLiveRevealBodyMessageId', () => {
    test('live render mode and missing streaming id never reveal', () => {
        const msgs = [assistant({ id: 'a1', parts: [textPart('p1', 'x')] })];
        expect(resolveLiveRevealBodyMessageId({
            chatRenderMode: 'live',
            assistants: msgs,
            streamingAssistantMessageId: 'a1',
            activeStreamingPhase: 'streaming',
        })).toBeNull();
        expect(resolveLiveRevealBodyMessageId({
            chatRenderMode: 'sorted',
            assistants: msgs,
            streamingAssistantMessageId: null,
            activeStreamingPhase: 'streaming',
        })).toBeNull();
        expect(resolveLiveRevealBodyMessageId({
            chatRenderMode: 'sorted',
            assistants: msgs,
            streamingAssistantMessageId: 'missing',
            activeStreamingPhase: 'streaming',
        })).toBeNull();
    });

    test('continuation tool arrival withdraws the reveal (folds back into Activity)', () => {
        // 原始消费语义：正文流式中一旦出现 continuation tool part，乐观
        // 揭示立即撤回，文本折回 Activity justification——正文不与正在
        // 运行的工具步骤同屏挂起。
        const streaming = assistant({
            id: 'a2',
            parts: [textPart('p1', 'partial'), toolPart('t1')],
        });
        expect(resolveLiveRevealBodyMessageId({
            chatRenderMode: 'sorted',
            assistants: [assistant({ id: 'a1', finish: 'tool-calls', completed: 3, parts: [toolPart('t0')] }), streaming],
            streamingAssistantMessageId: 'a2',
            activeStreamingPhase: 'streaming',
        })).toBeNull();
    });

    test('step boundary (finish=tool-calls) stops revealing so Activity shows justification again', () => {
        const streaming = assistant({
            id: 'a2',
            finish: 'tool-calls',
            parts: [textPart('p1', 'working'), toolPart('t1')],
        });
        expect(resolveLiveRevealBodyMessageId({
            chatRenderMode: 'sorted',
            assistants: [streaming],
            streamingAssistantMessageId: 'a2',
            activeStreamingPhase: 'streaming',
        })).toBeNull();
    });

    test('errors veto the live reveal', () => {
        const streaming = assistant({
            id: 'a2',
            error: { message: 'aborted' },
            parts: [textPart('p1', 'partial')],
        });
        expect(resolveLiveRevealBodyMessageId({
            chatRenderMode: 'sorted',
            assistants: [streaming],
            streamingAssistantMessageId: 'a2',
            activeStreamingPhase: 'streaming',
        })).toBeNull();
    });

    test('a completed streaming message mirrors the completed phase (no live reveal)', () => {
        const done = assistant({
            id: 'a2',
            completed: 42,
            parts: [textPart('p1', 'partial'), toolPart('t1')],
        });
        expect(resolveLiveRevealBodyMessageId({
            chatRenderMode: 'sorted',
            assistants: [done],
            streamingAssistantMessageId: 'a2',
            activeStreamingPhase: 'streaming',
        })).toBeNull();
    });

    test('null streaming phase falls back to streaming (steer gap keeps tool-less body)', () => {
        const streaming = assistant({ id: 'a2', parts: [textPart('p1', 'x')] });
        expect(resolveLiveRevealBodyMessageId({
            chatRenderMode: 'sorted',
            assistants: [streaming],
            streamingAssistantMessageId: 'a2',
            activeStreamingPhase: null,
        })).toBe('a2');
    });
});

describe('dropLiveRevealJustificationParts', () => {
    test('null reveal id keeps the same array reference', () => {
        const parts = [activity('justification', 'a1'), activity('tool', 'a2')];
        expect(dropLiveRevealJustificationParts(parts, null)).toBe(parts);
    });

    test('drops only the reveal message justification; keeps tools, reasoning, other messages', () => {
        const parts = [
            activity('tool', 'a1'),
            activity('justification', 'a1'),
            activity('justification', 'a2'),
            activity('tool', 'a2'),
            activity('reasoning', 'a2'),
        ];
        const filtered = dropLiveRevealJustificationParts(parts, 'a2');
        expect(filtered.map((p) => `${p.messageId}:${p.kind}`)).toEqual([
            'a1:tool',
            'a1:justification',
            'a2:tool',
            'a2:reasoning',
        ]);
    });

    test('keeps the same reference when nothing matches', () => {
        const parts = [activity('tool', 'a1')];
        expect(dropLiveRevealJustificationParts(parts, 'a2')).toBe(parts);
    });
});

describe('regression: live reveal renders text exactly once', () => {
    test('multi-step turn — body streams, tool arrival folds it back into Activity exactly once', () => {
        const anchor = assistant({ id: 'a1', finish: 'tool-calls', completed: 3, parts: [toolPart('t0')] });

        // Phase 1: text streaming, no tools yet — the body reveals and the
        // Activity viewport withholds its justification row (renders once).
        const streaming = assistant({
            id: 'a2',
            parts: [textPart('p_stream', 'REPLY TEXT')],
        });
        const assistants = [anchor, streaming];
        const revealId = resolveLiveRevealBodyMessageId({
            chatRenderMode: 'sorted',
            assistants,
            streamingAssistantMessageId: 'a2',
            activeStreamingPhase: 'streaming',
        });
        expect(revealId).toBe('a2');
        const turnJustificationRows: TurnActivityRecord[] = [activity('justification', 'a2')];
        expect(dropLiveRevealJustificationParts(turnJustificationRows, revealId)).toHaveLength(0);

        // Phase 2: a continuation tool arrives — the optimistic reveal is
        // withdrawn, the text folds back into Activity (visible there).
        const withTool = assistant({
            id: 'a2',
            parts: [textPart('p_stream', 'REPLY TEXT'), toolPart('t1')],
        });
        const withdrawnReveal = resolveLiveRevealBodyMessageId({
            chatRenderMode: 'sorted',
            assistants: [anchor, withTool],
            streamingAssistantMessageId: 'a2',
            activeStreamingPhase: 'streaming',
        });
        expect(withdrawnReveal).toBeNull();
        expect(dropLiveRevealJustificationParts(turnJustificationRows, withdrawnReveal)).toBe(turnJustificationRows);

        // Phase 3: at the step boundary (finish=tool-calls) Activity keeps
        // showing the justification.
        const settled = assistant({
            id: 'a2',
            finish: 'tool-calls',
            parts: withTool.parts,
        });
        const settledReveal = resolveLiveRevealBodyMessageId({
            chatRenderMode: 'sorted',
            assistants: [anchor, settled],
            streamingAssistantMessageId: 'a2',
            activeStreamingPhase: 'streaming',
        });
        expect(settledReveal).toBeNull();
        expect(dropLiveRevealJustificationParts(turnJustificationRows, settledReveal)).toBe(turnJustificationRows);
    });
});

// ---- restored pre-existing contracts (do not lose on merge) ----
const legacyAssistant = (id: string, completed?: number): ChatMessageEntry => ({
    info: {
        id,
        role: 'assistant',
        sessionID: 'ses_1',
        time: completed !== undefined ? { created: 1, completed } : { created: 1 },
    } as ChatMessageEntry['info'],
    parts: [] as Part[],
});

describe('resolveVisibleSortedAssistants (restored)', () => {
    test('keeps earlier incomplete assistants while a later sibling is streaming', () => {
        const a1 = legacyAssistant('a1'); // tools already ran; completion metadata lagging
        const a2 = legacyAssistant('a2'); // currently streaming
        const visible = resolveVisibleSortedAssistants([a1, a2], 'a2');
        expect(visible.map((entry) => entry.info.id)).toEqual(['a1', 'a2']);
    });

    test('shows the full turn once every assistant is completed', () => {
        const a1 = legacyAssistant('a1', 10);
        const a2 = legacyAssistant('a2', 20);
        expect(resolveVisibleSortedAssistants([a1, a2], null).map((entry) => entry.info.id)).toEqual([
            'a1',
            'a2',
        ]);
    });

    test('keeps incomplete assistants when stream id is unknown mid-turn', () => {
        // Between shell steps stream id / session_status often clear for a frame.
        // completed-only filtering dropped a2 and its Activity tools → fold flash.
        const a1 = legacyAssistant('a1', 10);
        const a2 = legacyAssistant('a2');
        expect(resolveVisibleSortedAssistants([a1, a2], null).map((entry) => entry.info.id)).toEqual([
            'a1',
            'a2',
        ]);
    });
});

describe('isAssistantMessageCompleted (restored)', () => {
    test('requires positive completed time', () => {
        expect(isAssistantMessageCompleted(legacyAssistant('a1'))).toBe(false);
        expect(isAssistantMessageCompleted(legacyAssistant('a1', 0))).toBe(false);
        expect(isAssistantMessageCompleted(legacyAssistant('a1', 5))).toBe(true);
    });
});
