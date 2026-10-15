import { expect, test } from 'vitest';
import type { TranscriptData } from '@/sync/transcript-repository';
import { projectBackgroundTasks } from './backgroundTaskProjection';

test('deduplicates dispatches, keeps latest Agent details, and retires shells using synthetic completion metadata', () => {
    const part = (id: string, tool: string, identity: object, input: object, status = 'completed') => ({
        id, type: 'tool', tool, state: { status, metadata: { status: 'running', ...identity }, input },
    });
    const data = {
        messageOrder: ['dispatch', 'again', 'notice'],
        messagesByID: { notice: { metadata: { source: 'shell', shellID: 'finished-shell', state: 'completed' } } },
        partsByMessageID: {
            dispatch: [
                part('first', 'subagent', { sessionID: 'child' }, { agent: 'explore', description: 'Old task' }),
                part('foreground', 'subagent', { sessionID: 'foreground' }, {}, 'running'),
                part('shell-call', 'shell', { shellID: 'finished-shell' }, { command: 'build' }),
                part('running-shell', 'shell', { shellID: 'live-shell' }, { command: 'test' }),
            ],
            again: [part('second', 'task', { sessionID: 'child' }, { subagent_type: 'reviewer', description: 'Review changes' })],
            notice: [],
        },
    } as unknown as TranscriptData;
    const tasks = projectBackgroundTasks(data);
    expect(tasks.map(({ id }) => id)).toEqual(['child', 'live-shell']);
    expect(tasks[0]).toMatchObject({ agent: 'reviewer', label: 'Review changes', part: { id: 'second' } });
});
