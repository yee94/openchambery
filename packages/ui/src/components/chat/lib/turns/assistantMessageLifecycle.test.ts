/**
 * Assistant-message lifecycle contracts, mirroring the OpenCode runLoop exit
 * rule: the loop exits only when the last assistant carries a `finish` other
 * than `tool-calls` and no continuation tool part.
 *
 * Continuation tool = any `type='tool'` part with
 * `metadata.providerExecuted !== true`, excluding the interrupted orphan
 * (`state.status === 'error' && state.metadata.interrupted === true`). A
 * *completed* ordinary tool still counts as continuation work.
 */

import { describe, expect, test } from 'bun:test';
import type { Part } from '@opencode-ai/sdk/v2';

import {
    canRevealSortedFinalBody,
    countContinuationToolParts,
    hasConfirmedFinalBody,
    hasConfirmedTerminalStop,
    isContinuationToolPart,
    isModelTextPart,
    shouldStreamSortedFinalBody,
} from './assistantMessageLifecycle';

const toolPart = (input: {
    id: string;
    status?: string;
    providerExecuted?: boolean;
    interrupted?: boolean;
}): Part => ({
    id: input.id,
    type: 'tool',
    tool: 'bash',
    ...(input.providerExecuted !== undefined
        ? { metadata: { providerExecuted: input.providerExecuted } }
        : {}),
    state: {
        status: input.status ?? 'completed',
        input: { command: 'ls' },
        ...(input.interrupted !== undefined ? { metadata: { interrupted: input.interrupted } } : {}),
    },
} as unknown as Part);

const textPart = (id: string, text: string, synthetic?: boolean): Part => ({
    id,
    type: 'text',
    text,
    ...(synthetic !== undefined ? { synthetic } : {}),
} as unknown as Part);

describe('isContinuationToolPart', () => {
    test('completed ordinary tool still counts as continuation', () => {
        expect(isContinuationToolPart(toolPart({ id: 't1', status: 'completed' }))).toBe(true);
    });

    test('running ordinary tool counts as continuation', () => {
        expect(isContinuationToolPart(toolPart({ id: 't1', status: 'running' }))).toBe(true);
    });

    test('provider-executed tool does not count', () => {
        expect(isContinuationToolPart(toolPart({ id: 't1', providerExecuted: true }))).toBe(false);
    });

    test('interrupted orphan tool does not count', () => {
        expect(isContinuationToolPart(toolPart({ id: 't1', status: 'error', interrupted: true }))).toBe(false);
    });

    test('non-interrupted errored tool still counts', () => {
        expect(isContinuationToolPart(toolPart({ id: 't1', status: 'error' }))).toBe(true);
        expect(isContinuationToolPart(toolPart({ id: 't1', status: 'error', interrupted: false }))).toBe(true);
    });
});

describe('hasConfirmedTerminalStop', () => {
    test('pure stop with no tools is terminal', () => {
        expect(hasConfirmedTerminalStop('stop', [textPart('p1', 'done')])).toBe(true);
    });

    test('stop with a completed ordinary tool is not terminal', () => {
        expect(hasConfirmedTerminalStop('stop', [toolPart({ id: 't1', status: 'completed' })])).toBe(false);
    });

    test('stop with provider-executed tool is terminal', () => {
        expect(hasConfirmedTerminalStop('stop', [toolPart({ id: 't1', providerExecuted: true })])).toBe(true);
    });

    test('stop with interrupted orphan is terminal', () => {
        expect(hasConfirmedTerminalStop('stop', [toolPart({ id: 't1', status: 'error', interrupted: true })])).toBe(true);
    });

    test('non-stop finish is never a confirmed terminal stop', () => {
        expect(hasConfirmedTerminalStop('tool-calls', [])).toBe(false);
        expect(hasConfirmedTerminalStop('length', [])).toBe(false);
        expect(hasConfirmedTerminalStop(undefined, [])).toBe(false);
    });
});

describe('hasConfirmedFinalBody', () => {
    test('stop + model text confirms the final body', () => {
        expect(hasConfirmedFinalBody('stop', [textPart('p1', 'the answer')])).toBe(true);
    });

    test('stop + completed ordinary tool + text does not confirm', () => {
        expect(hasConfirmedFinalBody('stop', [
            toolPart({ id: 't1', status: 'completed' }),
            textPart('p1', 'the answer'),
        ])).toBe(false);
    });

    test('stop + provider-executed tool + text confirms', () => {
        expect(hasConfirmedFinalBody('stop', [
            toolPart({ id: 't1', providerExecuted: true }),
            textPart('p1', 'the answer'),
        ])).toBe(true);
    });

    test('stop + interrupted orphan + text confirms', () => {
        expect(hasConfirmedFinalBody('stop', [
            toolPart({ id: 't1', status: 'error', interrupted: true }),
            textPart('p1', 'the answer'),
        ])).toBe(true);
    });

    test('synthetic-only text does not confirm a final body', () => {
        expect(hasConfirmedFinalBody('stop', [textPart('p1', 'sidecar note', true)])).toBe(false);
    });

    test('empty text does not confirm a final body', () => {
        expect(hasConfirmedFinalBody('stop', [textPart('p1', '   ')])).toBe(false);
        expect(hasConfirmedFinalBody('stop', [])).toBe(false);
    });

    test('synthetic + real text confirms via the real text', () => {
        expect(hasConfirmedFinalBody('stop', [
            textPart('p1', 'sidecar note', true),
            textPart('p2', 'the answer'),
        ])).toBe(true);
    });

    test('an error vetoes the final body even with stop + model text', () => {
        // Aborted turns settle abnormal; the loop cannot continue after an
        // error, but the text is partial — keep the last turn's Activity open.
        expect(hasConfirmedFinalBody('stop', [textPart('p1', 'partial')], { message: 'boom' })).toBe(false);
        expect(hasConfirmedFinalBody('stop', [textPart('p1', 'partial')], undefined)).toBe(true);
    });
});

describe('isModelTextPart', () => {
    test('accepts only non-empty, non-synthetic text parts', () => {
        expect(isModelTextPart(textPart('p1', 'the answer'))).toBe(true);
        expect(isModelTextPart(textPart('p1', 'sidecar', true))).toBe(false);
        expect(isModelTextPart(textPart('p1', '   '))).toBe(false);
        expect(isModelTextPart(toolPart({ id: 't1' }))).toBe(false);
    });
});

describe('canRevealSortedFinalBody / shouldStreamSortedFinalBody', () => {
    test('confirmed terminal stop reveals without needing a live stream phase', () => {
        expect(canRevealSortedFinalBody({
            finish: 'stop',
            parts: [textPart('p1', 'done')],
            streamPhase: 'completed',
        })).toBe(true);
        expect(shouldStreamSortedFinalBody({
            finish: 'stop',
            parts: [textPart('p1', 'done')],
            streamPhase: 'completed',
        })).toBe(false);
    });

    test('live tool-less stream reveals and streams as the final conclusion', () => {
        const input = {
            finish: undefined,
            parts: [textPart('p1', 'partial answer')],
            streamPhase: 'streaming' as const,
            isLastAssistantInTurn: true,
        };
        expect(canRevealSortedFinalBody(input)).toBe(true);
        expect(shouldStreamSortedFinalBody(input)).toBe(true);
    });

    test('continuation tools arriving withdraw the optimistic reveal', () => {
        // 正文流式中一旦出现 continuation tool part，乐观揭示立即撤回：文本
        // 折回 Activity justification（原始消费语义）。撤回跟随工具到达而
        // 非步骤边界——正文不得与正在运行的工具步骤同屏挂起。
        const input = {
            finish: undefined,
            parts: [
                textPart('p1', 'partial answer before tools'),
                toolPart({ id: 't1', status: 'completed' }),
            ],
            streamPhase: 'streaming' as const,
            isLastAssistantInTurn: true,
        };
        expect(canRevealSortedFinalBody(input)).toBe(false);
        expect(shouldStreamSortedFinalBody(input)).toBe(false);
    });

    test('step boundary folds intermediate text back into Activity', () => {
        // finish 打上 tool-calls（步骤结束、下一 assistant 未到）即整理进
        // Activity，正文不再揭示。
        const input = {
            finish: 'tool-calls',
            parts: [
                textPart('p1', 'working...'),
                toolPart({ id: 't1', status: 'completed' }),
            ],
            streamPhase: 'streaming' as const,
            isLastAssistantInTurn: true,
        };
        expect(canRevealSortedFinalBody(input)).toBe(false);
        expect(shouldStreamSortedFinalBody(input)).toBe(false);
    });

    test('non-live messages with continuation tools stay deferred', () => {
        // 非 live 阶段只认 confirmed terminal stop：工具未清偿的已完成消息
        // 的文本保持在 Activity。
        expect(canRevealSortedFinalBody({
            finish: undefined,
            parts: [
                toolPart({ id: 't1', status: 'completed' }),
                textPart('p1', 'working...'),
            ],
            streamPhase: 'completed',
            isLastAssistantInTurn: true,
        })).toBe(false);
    });

    test('non-stop finish and non-last assistants never reveal as final body', () => {
        expect(canRevealSortedFinalBody({
            finish: 'tool-calls',
            parts: [textPart('p1', 'step')],
            streamPhase: 'streaming',
            isLastAssistantInTurn: true,
        })).toBe(false);
        expect(canRevealSortedFinalBody({
            finish: undefined,
            parts: [textPart('p1', 'step')],
            streamPhase: 'streaming',
            isLastAssistantInTurn: false,
        })).toBe(false);
    });

    test('errors veto reveal even while streaming', () => {
        expect(canRevealSortedFinalBody({
            finish: undefined,
            parts: [textPart('p1', 'partial')],
            streamPhase: 'streaming',
            error: { message: 'aborted' },
            isLastAssistantInTurn: true,
        })).toBe(false);
    });
});

describe('countContinuationToolParts', () => {
    test('counts only continuation tools', () => {
        expect(countContinuationToolParts([
            toolPart({ id: 't1', status: 'completed' }),
            toolPart({ id: 't2', providerExecuted: true }),
            toolPart({ id: 't3', status: 'error', interrupted: true }),
            textPart('p1', 'hi'),
        ])).toBe(1);
    });
});
