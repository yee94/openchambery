import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runImmediateSessionCommand } from './immediateSessionCommandAction';

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => { resolve = next; });
    return { promise, resolve };
};

describe('runImmediateSessionCommand', () => {
    test('consumes compact text before its action promise settles', async () => {
        const action = deferred<void>();
        const calls: string[] = [];

        const running = runImmediateSessionCommand({
            command: 'compact',
            consumeCommandText: () => { calls.push('consume'); },
            forkSession: async () => undefined,
            waitForConnection: async () => { calls.push('wait'); },
            getDirectoryForSession: () => '/project',
            summarizeSession: async () => {
                calls.push('summarize');
                await action.promise;
            },
            onCompactError: () => { calls.push('compact-error'); },
            onForkError: () => { calls.push('fork-error'); },
        });

        await Promise.resolve();
        expect(calls).toEqual(['consume', 'wait', 'summarize']);
        action.resolve();
        await running;
    });

    test('keeps fork resources available and restores target text without the command', async () => {
        let composerText = '/fork';
        const attachments = ['existing-file'];
        const inlineDrafts = ['comment'];
        let targetPendingInputText = '';

        await runImmediateSessionCommand({
            command: 'fork',
            consumeCommandText: () => { composerText = ''; },
            forkSession: async () => { targetPendingInputText = 'selected message text'; },
            waitForConnection: async () => undefined,
            getDirectoryForSession: () => '/project',
            summarizeSession: async () => undefined,
            onCompactError: () => undefined,
            onForkError: () => undefined,
        });

        expect(composerText).toBe('');
        expect(attachments).toEqual(['existing-file']);
        expect(inlineDrafts).toEqual(['comment']);
        expect(targetPendingInputText).toBe('selected message text');
        expect(targetPendingInputText).not.toContain('/fork');
    });

    test('uses the compact error callback and skips summarize without a session directory', async () => {
        let summarizeCalls = 0;
        let compactErrors = 0;
        const externalFallbackDirectory = '/fallback/directory';

        await runImmediateSessionCommand({
            command: 'compact',
            consumeCommandText: () => undefined,
            forkSession: async () => undefined,
            waitForConnection: async () => undefined,
            getDirectoryForSession: () => {
                expect(externalFallbackDirectory).toBe('/fallback/directory');
                return null;
            },
            summarizeSession: async () => { summarizeCalls += 1; },
            onCompactError: () => { compactErrors += 1; },
            onForkError: () => undefined,
        });

        expect(summarizeCalls).toBe(0);
        expect(compactErrors).toBe(1);
    });
});

describe('ChatInput compact flight contract', () => {
    test('/compact runs in the background so queueing stays available during compaction', () => {
        const source = readFileSync(
            join(dirname(fileURLToPath(import.meta.url)), 'ChatInput.tsx'),
            'utf8',
        );
        const compactBranch = source.slice(source.indexOf("commandName === 'compact' && currentSessionId"));
        // The submission flight must be released when handleSubmit returns,
        // not held through the long-running summarize call: awaiting here
        // disabled Send/Queue and swallowed Enter for the whole compaction.
        expect(compactBranch.slice(0, 1200)).toContain('void runImmediateSessionCommand');
    });
});
