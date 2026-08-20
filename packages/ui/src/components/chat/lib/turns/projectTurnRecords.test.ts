import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { projectTurnRecords } from './projectTurnRecords';
import type { ChatMessageEntry } from './types';

function createMessageEntry({
    id,
    role,
    parentID,
    createdAt,
    completedAt,
    finish,
    error,
    parts,
}: {
    id: string;
    role: 'user' | 'assistant' | 'system';
    parentID?: string;
    createdAt: number;
    completedAt?: number;
    finish?: string;
    error?: unknown;
    parts?: Part[];
}): ChatMessageEntry {
    return {
        info: {
            id,
            role,
            ...(parentID ? { parentID } : {}),
            ...(finish !== undefined ? { finish } : {}),
            ...(error !== undefined ? { error } : {}),
            time: {
                created: createdAt,
                ...(typeof completedAt === 'number' ? { completed: completedAt } : {}),
            },
        } as Message,
        parts: parts ?? ([] as Part[]),
    };
}

describe('projectTurnRecords', () => {
    test('groups assistant replies under their parent user turn', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });

        const projection = projectTurnRecords([user, assistant]);

        expect(projection.turns).toHaveLength(1);
        expect(projection.turns[0]?.turnId).toBe('u1');
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1']);
        expect(projection.ungroupedMessageIds.size).toBe(0);
    });

    test('keeps out-of-order assistant replies attached to their parent user turn', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 });
        const user2 = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 });

        const projection = projectTurnRecords([user1, assistant1, assistant2, user2]);

        expect(projection.turns).toHaveLength(2);
        expect(projection.turns[0]?.turnId).toBe('u1');
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1']);
        expect(projection.turns[1]?.turnId).toBe('u2');
        expect(projection.turns[1]?.assistantMessageIds).toEqual(['a2']);
        expect(projection.ungroupedMessageIds.size).toBe(0);
    });

    test('does not render assistant replies while their parent user turn is missing', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 });

        const projection = projectTurnRecords([user1, assistant1, assistant2]);

        expect(projection.turns).toHaveLength(1);
        expect(projection.turns[0]?.turnId).toBe('u1');
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1']);
        expect(projection.ungroupedMessageIds.has('a2')).toBe(false);
        expect(projection.indexes.messageToTurnId.has('a2')).toBe(false);
    });

    test('does not render orphan assistant messages as standalone ungrouped entries', () => {
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'missing-user', createdAt: 1 });

        const projection = projectTurnRecords([assistant]);

        expect(projection.turns).toHaveLength(0);
        expect(projection.ungroupedMessageIds.has('a1')).toBe(false);
        expect(projection.indexes.messageToTurnId.has('a1')).toBe(false);
    });

    test('keeps non-assistant orphan messages available as ungrouped entries', () => {
        const system = createMessageEntry({ id: 's1', role: 'system', createdAt: 1 });

        const projection = projectTurnRecords([system]);

        expect(projection.turns).toHaveLength(0);
        expect(projection.ungroupedMessageIds.has('s1')).toBe(true);
    });

    test('reuses unchanged turn records from the previous projection', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const user2 = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 });
        const initial = projectTurnRecords([user1, assistant1, user2, assistant2]);
        const updatedAssistant2 = {
            ...assistant2,
            parts: [{ type: 'text', text: 'stream update' } as Part],
        };

        const next = projectTurnRecords([user1, assistant1, user2, updatedAssistant2], {
            previousProjection: initial,
        });

        expect(next.turns[0]).toBe(initial.turns[0]);
        expect(next.turns[1]).not.toBe(initial.turns[1]);
    });

    test('hydrates updated turns when a previous projection exists but no turn is reusable', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const initial = projectTurnRecords([user, assistant]);
        const updatedAssistant = {
            ...assistant,
            parts: [{ id: 'tool_1', type: 'tool', tool: 'bash', state: { status: 'completed' } } as Part],
        };

        const next = projectTurnRecords([user, updatedAssistant], {
            previousProjection: initial,
        });

        expect(next.turns).toHaveLength(1);
        expect(next.turns[0]).not.toBe(initial.turns[0]);
        expect(next.turns[0]?.hasTools).toBe(true);
        expect(next.turns[0]?.activityParts).toHaveLength(1);
        expect(next.turns[0]?.stream.isStreaming).toBe(true);
        expect(next.turns[0]?.stream.isRetrying).toBe(false);
    });

    test('reuses the whole turns array when every turn is unchanged', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const initial = projectTurnRecords([user, assistant]);

        const next = projectTurnRecords([user, assistant], {
            previousProjection: initial,
        });

        expect(next.turns).toBe(initial.turns);
        expect(next.turns[0]).toBe(initial.turns[0]);
    });

    test('completionDisposition is normal when last assistant finish is stop', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 3,
            finish: 'stop',
            parts: [{ id: 't1', type: 'text', text: 'done' } as Part],
        });

        const projection = projectTurnRecords([user, assistant]);

        expect(projection.turns[0]?.completionDisposition).toBe('normal');
    });

    test('completionDisposition is abnormal when settled without stop (user interrupt)', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 3,
            error: { message: 'aborted' },
            parts: [{ id: 't1', type: 'text', text: 'partial' } as Part],
        });

        const projection = projectTurnRecords([user, assistant]);

        // MessageBody: user interrupt often sets time.completed + error without finish === 'stop'
        expect(projection.turns[0]?.completionDisposition).toBe('abnormal');
    });

    test('completionDisposition is abnormal when finish is a non-stop terminal', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 3,
            finish: 'error',
            parts: [{ id: 't1', type: 'text', text: 'failed' } as Part],
        });

        const projection = projectTurnRecords([user, assistant]);

        expect(projection.turns[0]?.completionDisposition).toBe('abnormal');
    });

    test('completionDisposition stays active when only time.completed is stamped (multi-step gap)', () => {
        // Shell step ends → OpenCode may set time.completed before the next
        // assistant arrives. That must not collapse Activity mid-turn.
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 3,
            parts: [{
                id: 'tool_1',
                type: 'tool',
                tool: 'bash',
                state: { status: 'completed', output: 'ok', time: { start: 1, end: 2 } },
            } as Part],
        });

        const projection = projectTurnRecords([user, assistant]);

        expect(projection.turns[0]?.completionDisposition).toBe('active');
    });

    test('completionDisposition is active while last assistant has a running tool', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 3,
            parts: [{
                id: 'tool_1',
                type: 'tool',
                tool: 'bash',
                state: { status: 'running', input: { command: 'ls' }, time: { start: 1 } },
            } as unknown as Part],
        });

        expect(projectTurnRecords([user, assistant]).turns[0]?.completionDisposition).toBe('active');
    });

    test('completionDisposition is active while last assistant is streaming', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            parts: [{ id: 't1', type: 'text', text: 'streaming…' } as Part],
        });

        const projection = projectTurnRecords([user, assistant]);

        expect(projection.turns[0]?.completionDisposition).toBe('active');
    });

    test('historical incomplete turns settle to abnormal when a later user turn exists', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1_000 });
        const assistant1 = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 1_100,
            parts: [
                {
                    id: 'tool_1',
                    type: 'tool',
                    tool: 'bash',
                    state: { status: 'completed', time: { end: 1_500 } },
                } as Part,
            ],
        });
        const user2 = createMessageEntry({ id: 'u2', role: 'user', createdAt: 2_000 });
        const assistant2 = createMessageEntry({
            id: 'a2',
            role: 'assistant',
            parentID: 'u2',
            createdAt: 2_100,
            completedAt: 2_500,
            finish: 'stop',
            parts: [{ id: 't2', type: 'text', text: 'done' } as Part],
        });

        const projection = projectTurnRecords([user1, assistant1, user2, assistant2]);
        const historical = projection.turns[0];
        const latest = projection.turns[1];

        // Abnormal exit left no time.completed; a later user message proves the turn settled.
        expect(historical?.completionDisposition).toBe('abnormal');
        expect(historical?.durationMs).toBe(500);
        expect(historical?.stream.isStreaming).toBe(false);
        expect(latest?.completionDisposition).toBe('normal');
    });

    test('historical incomplete turns freeze duration to the next turn start when part ends are absent', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1_000 });
        const assistant1 = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 1_100,
            parts: [{ id: 't1', type: 'text', text: 'partial' } as Part],
        });
        const user2 = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3_000 });
        const assistant2 = createMessageEntry({
            id: 'a2',
            role: 'assistant',
            parentID: 'u2',
            createdAt: 3_100,
        });

        // A user row alone is not proof: it may be queued while this turn still
        // streams. The next turn must have an assistant response.
        const queued = projectTurnRecords([user1, assistant1, user2]);
        expect(queued.turns[0]?.completionDisposition).toBe('active');

        const projection = projectTurnRecords([user1, assistant1, user2, assistant2]);

        expect(projection.turns[0]?.completionDisposition).toBe('abnormal');
        expect(projection.turns[0]?.durationMs).toBe(2_000);
        expect(projection.turns[0]?.completedAt).toBe(3_000);
    });

    test('normal turn with multiple text keeps only last stop text as summary; others become justification activity', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 5,
            finish: 'stop',
            parts: [
                // Provider-executed: not a continuation tool, so this stop is a
                // confirmed terminal stop and its text is the canonical body.
                {
                    id: 'tool_1',
                    type: 'tool',
                    tool: 'websearch',
                    metadata: { providerExecuted: true },
                    state: { status: 'completed' },
                } as unknown as Part,
                { id: 'text_mid', type: 'text', text: 'working on it' } as Part,
                { id: 'text_final', type: 'text', text: 'all done' } as Part,
            ],
        });

        const projection = projectTurnRecords([user, assistant], {
            showTextJustificationActivity: true,
        });

        const turn = projection.turns[0];
        expect(turn?.completionDisposition).toBe('normal');
        expect(turn?.summary.text).toBe('all done');
        expect(turn?.summary.sourcePartId).toBe('text_final');

        const justificationTexts = turn?.activityParts
            .filter((part) => part.kind === 'justification')
            .map((part) => (part.part as { text?: string }).text);
        expect(justificationTexts).toContain('working on it');
        expect(justificationTexts).not.toContain('all done');
    });

    test('normal turn without tools still folds non-summary text into justification when canonical stop summary exists', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 5,
            finish: 'stop',
            parts: [
                { id: 'text_mid', type: 'text', text: 'thinking aloud' } as Part,
                { id: 'text_final', type: 'text', text: 'final answer' } as Part,
            ],
        });

        const projection = projectTurnRecords([user, assistant], {
            showTextJustificationActivity: true,
        });

        const turn = projection.turns[0];
        expect(turn?.completionDisposition).toBe('normal');
        expect(turn?.summary.text).toBe('final answer');
        const justificationTexts = turn?.activityParts
            .filter((part) => part.kind === 'justification')
            .map((part) => (part.part as { text?: string }).text) ?? [];
        expect(justificationTexts).toContain('thinking aloud');
        expect(justificationTexts).not.toContain('final answer');
    });

    test('abnormal interrupt text is not treated as normal stop summary for justification folding', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 4,
            error: { message: 'user aborted' },
            parts: [
                { id: 'tool_1', type: 'tool', tool: 'bash', state: { status: 'completed' } } as Part,
                { id: 'text_a', type: 'text', text: 'mid progress' } as Part,
                { id: 'text_b', type: 'text', text: 'interrupted fallback' } as Part,
            ],
        });

        const projection = projectTurnRecords([user, assistant], {
            showTextJustificationActivity: true,
        });

        const turn = projection.turns[0];
        expect(turn?.completionDisposition).toBe('abnormal');
        // Fallback text may still be projected as summary source for display, but without finish=stop
        // it must not fold other text solely as "normal summary" path — both texts stay as activity
        // when message has tools (existing non-collapse abnormal semantics).
        const justificationTexts = turn?.activityParts
            .filter((part) => part.kind === 'justification')
            .map((part) => (part.part as { text?: string }).text) ?? [];
        expect(justificationTexts).toContain('mid progress');
        expect(justificationTexts).toContain('interrupted fallback');
    });

    test('activityParts keep natural order across task; single segment equals full activityParts', () => {
        // Tools are provider-executed so the stop is a confirmed terminal stop
        // (no continuation tools) and the trailing text is the canonical body.
        const providerTool = (id: string, toolName: string): Part => ({
            id,
            type: 'tool',
            tool: toolName,
            metadata: { providerExecuted: true },
            state: { status: 'completed' },
        } as unknown as Part);
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 10,
            finish: 'stop',
            parts: [
                { id: 'r1', type: 'reasoning', text: 'plan before task' } as Part,
                providerTool('tool_bash', 'bash'),
                { id: 'j1', type: 'text', text: 'justify before task' } as Part,
                providerTool('task_1', 'task'),
                { id: 'r2', type: 'reasoning', text: 'plan after task' } as Part,
                providerTool('tool_read', 'read'),
                { id: 'j2', type: 'text', text: 'justify after task' } as Part,
                { id: 'summary', type: 'text', text: 'final answer' } as Part,
            ],
        });

        const projection = projectTurnRecords([user, assistant], {
            showTextJustificationActivity: true,
        });

        const turn = projection.turns[0];
        expect(turn?.activityParts.map((part) => part.id)).toEqual([
            'r1',
            'tool_bash',
            'j1',
            'task_1',
            'r2',
            'tool_read',
            'j2',
        ]);
        expect(turn?.activityParts.map((part) => part.kind)).toEqual([
            'reasoning',
            'tool',
            'justification',
            'tool',
            'reasoning',
            'tool',
            'justification',
        ]);
        expect(turn?.activitySegments).toHaveLength(1);
        expect(turn?.activitySegments[0]?.afterToolPartId).toBeNull();
        expect(turn?.activitySegments[0]?.anchorMessageId).toBe('a1');
        expect(turn?.activitySegments[0]?.parts).toBe(turn?.activityParts);
        expect(turn?.activitySegments[0]?.parts.map((part) => part.id)).toEqual([
            'r1',
            'tool_bash',
            'j1',
            'task_1',
            'r2',
            'tool_read',
            'j2',
        ]);
        expect(turn?.summary.text).toBe('final answer');
    });

    test('activitySegments is empty when turn has no activity parts', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 3,
            finish: 'stop',
            parts: [{ id: 't1', type: 'text', text: 'only summary' } as Part],
        });

        const projection = projectTurnRecords([user, assistant], {
            showTextJustificationActivity: true,
        });

        const turn = projection.turns[0];
        expect(turn?.activityParts).toHaveLength(0);
        expect(turn?.activitySegments).toHaveLength(0);
        expect(turn?.summary.text).toBe('only summary');
    });

    test('projects slim or empty reasoning into activity so collapsed body cannot pad a blank gap', () => {
        // First-packet slim reasoning has identity/timing and no body. Leaving it
        // out of activity lets MessageBody wrap a null ReasoningPart in py-1.5
        // for every slim trace — hundreds of empty shells between the Activity
        // header and the final answer. Fold them with the disclosure instead.
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 10,
            finish: 'stop',
            parts: [
                { id: 'r-slim', type: 'reasoning', slim: true, time: { start: 2 } } as unknown as Part,
                { id: 'r-empty', type: 'reasoning', text: '   ' } as unknown as Part,
                {
                    id: 'tool_read',
                    type: 'tool',
                    tool: 'read',
                    metadata: { providerExecuted: true },
                    state: { status: 'completed' },
                } as unknown as Part,
                { id: 'summary', type: 'text', text: 'final answer' } as Part,
            ],
        });

        const projection = projectTurnRecords([user, assistant], {
            showTextJustificationActivity: true,
        });

        const turn = projection.turns[0];
        expect(turn?.activityParts.map((part) => part.id)).toEqual([
            'r-slim',
            'r-empty',
            'tool_read',
        ]);
        expect(turn?.activityParts.map((part) => part.kind)).toEqual([
            'reasoning',
            'reasoning',
            'tool',
        ]);
        expect(turn?.summary.text).toBe('final answer');
    });

    test('single activity segment anchors to the earliest assistant message with activity', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant1 = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 3,
            finish: 'tool-calls',
            parts: [
                { id: 'r1', type: 'reasoning', text: 'first reasoning' } as Part,
                { id: 'task_1', type: 'tool', tool: 'task', state: { status: 'completed' } } as Part,
            ],
        });
        const assistant2 = createMessageEntry({
            id: 'a2',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 4,
            completedAt: 5,
            finish: 'stop',
            parts: [
                // Provider-executed: no continuation tools, so this stop is a
                // confirmed terminal stop and its text is the canonical body.
                {
                    id: 'tool_bash',
                    type: 'tool',
                    tool: 'bash',
                    metadata: { providerExecuted: true },
                    state: { status: 'completed' },
                } as unknown as Part,
                { id: 'summary', type: 'text', text: 'done' } as Part,
            ],
        });

        const projection = projectTurnRecords([user, assistant1, assistant2], {
            showTextJustificationActivity: true,
        });

        const turn = projection.turns[0];
        expect(turn?.activityParts.map((part) => part.id)).toEqual(['r1', 'task_1', 'tool_bash']);
        expect(turn?.activitySegments).toHaveLength(1);
        expect(turn?.activitySegments[0]?.anchorMessageId).toBe('a1');
        expect(turn?.activitySegments[0]?.afterToolPartId).toBeNull();
        expect(turn?.activitySegments[0]?.parts).toBe(turn?.activityParts);
    });

    test('marks turn as compaction when user message has raw compaction part', () => {
        const user = createMessageEntry({
            id: 'u1',
            role: 'user',
            createdAt: 10,
            parts: [{ id: 'c1', type: 'compaction' } as Part],
        });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 11,
            parts: [{ id: 't1', type: 'text', text: 'compacting…' } as Part],
        });

        const projection = projectTurnRecords([user, assistant]);
        const turn = projection.turns[0];

        expect(turn?.activityPresentationKind).toBe('compaction');
        expect(turn?.completionDisposition).toBe('active');
        expect(turn?.startedAt).toBe(10);
        expect(turn?.durationMs).toBeUndefined();
    });

    test('marks turn as compaction when display-normalized text is exactly /compact', () => {
        const user = createMessageEntry({
            id: 'u1',
            role: 'user',
            createdAt: 10,
            parts: [{ id: 't1', type: 'text', text: '/compact' } as Part],
        });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 11,
            completedAt: 25,
            finish: 'stop',
            parts: [{ id: 't2', type: 'text', text: 'done' } as Part],
        });

        const projection = projectTurnRecords([user, assistant]);
        const turn = projection.turns[0];

        expect(turn?.activityPresentationKind).toBe('compaction');
        expect(turn?.completionDisposition).toBe('normal');
        expect(turn?.startedAt).toBe(10);
        expect(turn?.completedAt).toBe(25);
        expect(turn?.durationMs).toBe(15);
    });

    test('marks ordinary user text turns as default activity presentation', () => {
        const user = createMessageEntry({
            id: 'u1',
            role: 'user',
            createdAt: 1,
            parts: [{ id: 't1', type: 'text', text: 'hello world' } as Part],
        });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 5,
            finish: 'stop',
            parts: [{ id: 't2', type: 'text', text: 'hi' } as Part],
        });

        const projection = projectTurnRecords([user, assistant]);
        const turn = projection.turns[0];

        expect(turn?.activityPresentationKind).toBe('default');
        expect(turn?.completionDisposition).toBe('normal');
        expect(turn?.durationMs).toBe(4);
    });

    test('detects compaction from sourceParts when display parts are already normalized', () => {
        const user: ChatMessageEntry = {
            ...createMessageEntry({
                id: 'u1',
                role: 'user',
                createdAt: 10,
                parts: [{ id: 't1', type: 'text', text: '/compact' } as Part],
            }),
            sourceParts: [{ id: 'c1', type: 'compaction' } as Part],
        };

        const projection = projectTurnRecords([user]);
        expect(projection.turns[0]?.activityPresentationKind).toBe('compaction');
    });

    test('pure stop with model text settles normal and confirms the final body', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 5,
            finish: 'stop',
            parts: [{ id: 't1', type: 'text', text: 'the answer' } as Part],
        });

        const turn = projectTurnRecords([user, assistant]).turns[0];
        expect(turn?.completionDisposition).toBe('normal');
        expect(turn?.hasConfirmedFinalBody).toBe(true);
    });

    test('stop with a completed ordinary tool stays active and keeps text in justification activity', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 5,
            finish: 'stop',
            parts: [
                { id: 'tool_1', type: 'tool', tool: 'bash', state: { status: 'completed', time: { start: 2, end: 3 } } } as unknown as Part,
                { id: 'text_1', type: 'text', text: 'ran the check' } as Part,
            ],
        });

        const turn = projectTurnRecords([user, assistant], {
            showTextJustificationActivity: true,
        }).turns[0];
        expect(turn?.completionDisposition).toBe('active');
        expect(turn?.hasConfirmedFinalBody).toBe(false);
        const justificationTexts = turn?.activityParts
            .filter((part) => part.kind === 'justification')
            .map((part) => (part.part as { text?: string }).text) ?? [];
        expect(justificationTexts).toContain('ran the check');
    });

    test('stop with a provider-executed tool settles normal and confirms the final body', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 5,
            finish: 'stop',
            parts: [
                {
                    id: 'tool_1',
                    type: 'tool',
                    tool: 'websearch',
                    metadata: { providerExecuted: true },
                    state: { status: 'completed', time: { start: 2, end: 3 } },
                } as unknown as Part,
                { id: 'text_1', type: 'text', text: 'looked it up' } as Part,
            ],
        });

        const turn = projectTurnRecords([user, assistant]).turns[0];
        expect(turn?.completionDisposition).toBe('normal');
        expect(turn?.hasConfirmedFinalBody).toBe(true);
    });

    test('stop with an interrupted orphan tool settles normal and confirms the final body', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 5,
            finish: 'stop',
            parts: [
                {
                    id: 'tool_1',
                    type: 'tool',
                    tool: 'bash',
                    state: { status: 'error', metadata: { interrupted: true }, time: { start: 2, end: 3 } },
                } as unknown as Part,
                { id: 'text_1', type: 'text', text: 'stopped early with a note' } as Part,
            ],
        });

        const turn = projectTurnRecords([user, assistant]).turns[0];
        expect(turn?.completionDisposition).toBe('normal');
        expect(turn?.hasConfirmedFinalBody).toBe(true);
    });

    test('stop with only synthetic or empty text settles normal without confirming a final body', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 5,
            finish: 'stop',
            parts: [
                { id: 't1', type: 'text', text: 'sidecar note', synthetic: true } as unknown as Part,
                { id: 't2', type: 'text', text: '   ' } as Part,
            ],
        });

        const turn = projectTurnRecords([user, assistant]).turns[0];
        expect(turn?.completionDisposition).toBe('normal');
        expect(turn?.hasConfirmedFinalBody).toBe(false);
    });

    test('error still settles abnormal even alongside stop finish metadata', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 5,
            finish: 'stop',
            error: { message: 'provider exploded' },
            parts: [{ id: 't1', type: 'text', text: 'partial' } as Part],
        });

        const turn = projectTurnRecords([user, assistant]).turns[0];
        expect(turn?.completionDisposition).toBe('abnormal');
        // Error vetoes the confirmed final body: the text is partial, so the
        // latest turn's Activity stays expanded. Display still shows the
        // partial text via the summary fallback.
        expect(turn?.hasConfirmedFinalBody).toBe(false);
    });

    test('time.completed alone stays active and never confirms a final body', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 5,
            parts: [{ id: 't1', type: 'text', text: 'step done' } as Part],
        });

        const turn = projectTurnRecords([user, assistant]).turns[0];
        expect(turn?.completionDisposition).toBe('active');
        expect(turn?.hasConfirmedFinalBody).toBe(false);
    });

    test('a fresh turn starts without a confirmed final body', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const turn = projectTurnRecords([user]).turns[0];
        expect(turn?.hasConfirmedFinalBody).toBe(false);
    });

    test('stop with a provider-executed running tool still settles normal and confirms the final body', () => {
        // The runLoop exit rule only excludes provider-executed tools from
        // continuation; their local status does not matter.
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 5,
            finish: 'stop',
            parts: [
                {
                    id: 'tool_1',
                    type: 'tool',
                    tool: 'websearch',
                    metadata: { providerExecuted: true },
                    state: { status: 'running', time: { start: 2 } },
                } as unknown as Part,
                { id: 'text_1', type: 'text', text: 'searched and answered' } as Part,
            ],
        });

        const turn = projectTurnRecords([user, assistant]).turns[0];
        expect(turn?.completionDisposition).toBe('normal');
        expect(turn?.hasConfirmedFinalBody).toBe(true);
    });

    test('canonical stop summary skips trailing synthetic text and picks the last real model text', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 5,
            finish: 'stop',
            parts: [
                { id: 'text_real', type: 'text', text: 'the real answer' } as Part,
                { id: 'text_synthetic', type: 'text', text: 'sidecar note', synthetic: true } as unknown as Part,
            ],
        });

        const turn = projectTurnRecords([user, assistant]).turns[0];
        expect(turn?.completionDisposition).toBe('normal');
        expect(turn?.hasConfirmedFinalBody).toBe(true);
        expect(turn?.summary.text).toBe('the real answer');
        expect(turn?.summary.sourcePartId).toBe('text_real');
    });

    test('reuses previous projection including activityPresentationKind', () => {
        const user = createMessageEntry({
            id: 'u1',
            role: 'user',
            createdAt: 10,
            parts: [{ id: 'c1', type: 'compaction' } as Part],
        });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 11,
            completedAt: 20,
            finish: 'stop',
            parts: [{ id: 't1', type: 'text', text: 'done' } as Part],
        });
        const initial = projectTurnRecords([user, assistant]);
        expect(initial.turns[0]?.activityPresentationKind).toBe('compaction');

        const next = projectTurnRecords([user, assistant], {
            previousProjection: initial,
        });

        expect(next.turns).toBe(initial.turns);
        expect(next.turns[0]).toBe(initial.turns[0]);
        expect(next.turns[0]?.activityPresentationKind).toBe('compaction');
        expect(next.turns[0]?.completionDisposition).toBe('normal');
        expect(next.turns[0]?.durationMs).toBe(10);
    });
});
