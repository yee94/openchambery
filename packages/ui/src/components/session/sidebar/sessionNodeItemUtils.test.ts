import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import { resolvedSessionRenderKey } from './sessionNodeItemUtils';

const session = (overrides: Partial<Session> = {}): Session => ({
    id: 'ses_1',
    title: 'Fix the sidebar',
    time: { created: 1_000_000, updated: 1_000_000 },
    ...overrides,
} as Session);

describe('resolvedSessionRenderKey', () => {
    test('ignores activity churn inside one date-label bucket', () => {
        const before = session({ time: { created: 1_000_000, updated: 1_700_000_000_000 } } as Partial<Session>);
        const after = session({ time: { created: 1_000_000, updated: 1_700_000_000_900 } } as Partial<Session>);

        expect(resolvedSessionRenderKey(before)).toBe(resolvedSessionRenderKey(after));
    });

    test('reacts once activity crosses into the next bucket', () => {
        const before = session({ time: { created: 1_000_000, updated: 1_700_000_000_000 } } as Partial<Session>);
        const after = session({ time: { created: 1_000_000, updated: 1_700_000_060_000 } } as Partial<Session>);

        expect(resolvedSessionRenderKey(before)).not.toBe(resolvedSessionRenderKey(after));
    });

    test('reacts to a renamed session', () => {
        expect(resolvedSessionRenderKey(session())).not.toBe(
            resolvedSessionRenderKey(session({ title: 'Renamed' })),
        );
    });

    test('reacts to a session becoming shared', () => {
        expect(resolvedSessionRenderKey(session())).not.toBe(
            resolvedSessionRenderKey(session({ share: { url: 'https://example.test/s/1' } } as Partial<Session>)),
        );
    });

    test('reacts to title-refresh state the row renders', () => {
        const generating = session({
            metadata: { openchamber: { titleRefresh: { isGenerating: true } } },
        } as unknown as Partial<Session>);

        expect(resolvedSessionRenderKey(session())).not.toBe(resolvedSessionRenderKey(generating));
    });
});
