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
    countContinuationToolParts,
    hasConfirmedFinalBody,
    hasConfirmedTerminalStop,
    isContinuationToolPart,
    isModelTextPart,
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
