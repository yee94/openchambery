import { describe, expect, test } from 'vitest';

import {
    canMoveSessionToBackground,
    collectBackgroundCompletions,
    hasSettledBackgroundRunningHint,
    isBackgroundRunningToolPart,
    isBlockingForegroundToolPart,
    moveSessionBlockingWorkToBackground,
    projectSessionBackgroundFromMessages,
    readBackgroundWorkIdentity,
    resolveBackgroundToolActivity,
} from './sessionBackgroundModel';
import {
    isBackgroundableToolName,
    isShellToolName,
    isTaskToolName,
    parseShellNotification,
} from './taskToolModel';

/** Upstream shell background tool result shape (core tool/plugin/shell.ts). */
const officialShellBackgroundPart = {
    type: 'tool' as const,
    tool: 'shell',
    id: 'prt_shell_bg',
    state: {
        status: 'completed',
        metadata: {
            status: 'running',
            shellID: 'sh_official_1',
            truncated: false,
        },
        output: 'Command moved to the background (shell ID: sh_official_1).\nOutput is streaming to: /tmp/out',
        input: { command: 'npm run build', background: true },
    },
};

/** Upstream native subagent background result shape. */
const officialSubagentBackgroundPart = {
    type: 'tool' as const,
    tool: 'subagent',
    id: 'prt_sub_bg',
    state: {
        status: 'completed',
        metadata: {
            sessionID: 'ses_child_bg',
            status: 'running',
        },
        output: 'The subagent is working in the background (sessionID: ses_child_bg).',
        input: { description: 'Explore sync', agent: 'explore', background: true },
    },
};

describe('task / subagent tool identity', () => {
    test('treats plugin task and native subagent as the same task-row family', () => {
        expect(isTaskToolName('task')).toBe(true);
        expect(isTaskToolName('subagent')).toBe(true);
        expect(isTaskToolName('runtime.subagent:2')).toBe(true);
        expect(isTaskToolName('bash')).toBe(false);
        expect(isTaskToolName('shell')).toBe(false);
    });

    test('recognizes upstream shell names for backgroundable shell work', () => {
        expect(isShellToolName('shell')).toBe(true);
        expect(isShellToolName('bash')).toBe(true);
        expect(isShellToolName('cmd')).toBe(true);
        expect(isBackgroundableToolName('subagent')).toBe(true);
        expect(isBackgroundableToolName('shell')).toBe(true);
        expect(isBackgroundableToolName('read')).toBe(false);
    });
});

describe('blocking vs background-running tool parts', () => {
    test('foreground running subagent / shell block the parent session', () => {
        expect(isBlockingForegroundToolPart({
            type: 'tool',
            tool: 'subagent',
            id: 'prt_1',
            state: {
                status: 'running',
                metadata: { sessionID: 'ses_child' },
                input: { description: 'Explore sync', agent: 'explore' },
            },
        })).toBe(true);

        expect(isBlockingForegroundToolPart({
            type: 'tool',
            tool: 'shell',
            id: 'prt_shell',
            state: {
                status: 'running',
                metadata: { shellID: 'sh_1' },
                input: { command: 'npm test' },
            },
        })).toBe(true);

        expect(isBlockingForegroundToolPart({
            type: 'tool',
            tool: 'read',
            id: 'prt_read',
            state: { status: 'running' },
        })).toBe(false);
    });

    test('official shell background fixture is a settled running hint, not permanent live alone', () => {
        expect(isBlockingForegroundToolPart(officialShellBackgroundPart)).toBe(false);
        expect(hasSettledBackgroundRunningHint(officialShellBackgroundPart)).toBe(true);
        expect(isBackgroundRunningToolPart(officialShellBackgroundPart)).toBe(true);
        expect(resolveBackgroundToolActivity({ part: officialShellBackgroundPart }).kind).toBe('background-running');
        expect(readBackgroundWorkIdentity(officialShellBackgroundPart)).toEqual({
            type: 'shell',
            id: 'sh_official_1',
            label: 'npm run build',
            agent: undefined,
        });
    });

    test('shell completion notice ends background-running despite historical metadata.running', () => {
        const noticeText = '<shell id="sh_official_1" state="completed" command="npm run build">\nbuild ok\n</shell>';
        expect(parseShellNotification(noticeText)).toEqual({
            id: 'sh_official_1',
            state: 'completed',
            command: 'npm run build',
            body: 'build ok',
        });
        const completions = collectBackgroundCompletions([
            {
                role: 'user',
                metadata: { source: 'shell', shellID: 'sh_official_1', state: 'completed' },
                parts: [{ type: 'text', text: noticeText }],
            },
        ]);
        expect(completions.byShellOrJobID.get('sh_official_1')).toBe('completed');
        expect(resolveBackgroundToolActivity({
            part: officialShellBackgroundPart,
            completions,
        })).toEqual({ kind: 'terminal', state: 'completed' });
        // Historical hint remains true — must not drive live alone.
        expect(hasSettledBackgroundRunningHint(officialShellBackgroundPart)).toBe(true);
    });

    test('native subagent background fixture settles on child idle or completion notice', () => {
        expect(hasSettledBackgroundRunningHint(officialSubagentBackgroundPart)).toBe(true);
        expect(resolveBackgroundToolActivity({
            part: officialSubagentBackgroundPart,
            childSessionStatusType: 'busy',
        }).kind).toBe('background-running');
        expect(resolveBackgroundToolActivity({
            part: officialSubagentBackgroundPart,
            childSessionStatusType: 'idle',
        }).kind).toBe('settled');

        const completions = collectBackgroundCompletions([
            {
                role: 'user',
                parts: [{
                    type: 'text',
                    text: '<subagent sessionID="ses_child_bg" state="completed" description="Explore sync">done</subagent>',
                }],
            },
        ]);
        expect(resolveBackgroundToolActivity({
            part: officialSubagentBackgroundPart,
            completions,
            childSessionStatusType: 'busy',
        })).toEqual({ kind: 'terminal', state: 'completed' });
    });

    test('settled tool success with metadata.status=running is background work, not blocking', () => {
        const part = {
            type: 'tool',
            tool: 'subagent',
            id: 'prt_bg',
            state: {
                status: 'completed',
                metadata: { sessionID: 'ses_child', status: 'running' },
                input: { description: 'Long explore', agent: 'explore' },
            },
        };
        expect(isBlockingForegroundToolPart(part)).toBe(false);
        expect(isBackgroundRunningToolPart(part)).toBe(true);
        expect(readBackgroundWorkIdentity(part)).toEqual({
            type: 'subagent',
            id: 'ses_child',
            label: 'Long explore',
            agent: 'explore',
        });
    });

    test('background shell identity prefers shellID and command label', () => {
        expect(readBackgroundWorkIdentity({
            type: 'tool',
            tool: 'bash',
            id: 'prt_sh',
            state: {
                status: 'completed',
                metadata: { shellID: 'sh_9', status: 'running' },
                input: { command: 'sleep 30' },
            },
        })).toEqual({
            type: 'shell',
            id: 'sh_9',
            label: 'sleep 30',
            agent: undefined,
        });
    });
});

describe('projectSessionBackgroundFromMessages', () => {
    test('projects blocking and background tasks; completion notices clear background entries', () => {
        const messages = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool',
                        tool: 'subagent',
                        id: 'prt_block',
                        state: {
                            status: 'running',
                            metadata: { sessionID: 'ses_live' },
                            input: { description: 'Live child', agent: 'explore' },
                        },
                    },
                    {
                        type: 'tool',
                        tool: 'shell',
                        id: 'prt_bg_shell',
                        state: {
                            status: 'completed',
                            metadata: { shellID: 'sh_done', status: 'running' },
                            input: { command: 'npm run build' },
                        },
                    },
                    {
                        type: 'tool',
                        tool: 'subagent',
                        id: 'prt_bg_sub',
                        state: {
                            status: 'completed',
                            metadata: { sessionID: 'ses_bg', status: 'running' },
                            input: { description: 'Bg explore', agent: 'explore' },
                        },
                    },
                ],
            },
            {
                role: 'synthetic',
                metadata: { source: 'shell', shellID: 'sh_done', state: 'completed' },
                parts: [{
                    type: 'text',
                    text: '<shell id="sh_done" state="completed" command="npm run build">ok</shell>',
                }],
            },
        ];

        const projection = projectSessionBackgroundFromMessages(messages);
        expect(projection.blocking).toEqual([{
            type: 'subagent',
            partID: 'prt_block',
            id: 'ses_live',
            label: 'Live child',
        }]);
        expect(projection.backgroundTasks).toEqual([{
            id: 'ses_bg',
            type: 'subagent',
            label: 'Bg explore',
            agent: 'explore',
        }]);
        expect(canMoveSessionToBackground(projection)).toBe(true);
    });

    test('official shell fixture stays background until synthetic notice; then drops', () => {
        const live = projectSessionBackgroundFromMessages([
            { role: 'assistant', parts: [officialShellBackgroundPart] },
        ]);
        expect(live.backgroundTasks).toEqual([{
            id: 'sh_official_1',
            type: 'shell',
            label: 'npm run build',
            agent: undefined,
        }]);

        const done = projectSessionBackgroundFromMessages([
            { role: 'assistant', parts: [officialShellBackgroundPart] },
            {
                role: 'user',
                metadata: { source: 'shell', shellID: 'sh_official_1', state: 'completed' },
                parts: [{
                    type: 'text',
                    text: '<shell id="sh_official_1" state="completed" command="npm run build">exit 0</shell>',
                }],
            },
        ]);
        expect(done.backgroundTasks).toEqual([]);
        expect(done.blocking).toEqual([]);
    });

    test('empty blocking set cannot move to background', () => {
        expect(canMoveSessionToBackground({ blocking: [] })).toBe(false);
    });
});

describe('moveSessionBlockingWorkToBackground', () => {
    test('calls official session.background with the parent session id', async () => {
        const calls: Array<{ sessionID: string }> = [];
        const result = await moveSessionBlockingWorkToBackground('ses_parent', {
            session: {
                background: async (input) => {
                    calls.push(input);
                },
            },
        });
        expect(result).toEqual({ ok: true });
        expect(calls).toEqual([{ sessionID: 'ses_parent' }]);
    });

    test('preserves failure without inventing success', async () => {
        const result = await moveSessionBlockingWorkToBackground('ses_parent', {
            session: {
                background: async () => {
                    throw new Error('not supported');
                },
            },
        });
        expect(result).toEqual({ ok: false, error: 'not supported' });
    });

    test('rejects empty session id before calling the client', async () => {
        let called = false;
        const result = await moveSessionBlockingWorkToBackground('  ', {
            session: {
                background: async () => {
                    called = true;
                },
            },
        });
        expect(result.ok).toBe(false);
        expect(called).toBe(false);
    });
});
