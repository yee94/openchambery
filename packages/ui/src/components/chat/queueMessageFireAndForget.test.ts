import { describe, expect, test } from 'bun:test';
import { runQueueMessageFireAndForget } from './queueMessageFireAndForget';

describe('runQueueMessageFireAndForget', () => {
    test('does not report when admission settles', async () => {
        let leaked = 0;
        await runQueueMessageFireAndForget(async () => {}, () => {
            leaked += 1;
        });
        expect(leaked).toBe(0);
    });

    test('reports once when admission rejects (restoreQueueComposer-style leak)', async () => {
        let leaked = 0;
        await runQueueMessageFireAndForget(async () => {
            throw new Error('restoreQueueComposer failed');
        }, () => {
            leaked += 1;
        });
        expect(leaked).toBe(1);
    });

    test('reports once when run throws before returning a promise', async () => {
        let leaked = 0;
        await runQueueMessageFireAndForget(() => {
            throw new Error('sync throw');
        }, () => {
            leaked += 1;
        });
        expect(leaked).toBe(1);
    });

    test('swallows the rejection so the host does not observe unhandledRejection', async () => {
        const observed: unknown[] = [];
        const onUnhandled = (reason: unknown) => {
            observed.push(reason);
        };
        process.on('unhandledRejection', onUnhandled);
        try {
            // Event callers void the settled promise; ensure that still stays handled.
            void runQueueMessageFireAndForget(async () => {
                throw new Error('must stay handled');
            }, () => {});
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            expect(observed).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });
});
