import React from 'react';
import { useEvent, useInterval } from '@reactuses/core';

const TARGET_TURNS = 12;
const WARMUP_PAGE_SIZE = 50;
const QUIET_MS = 800;

/** Bounded, post-paint history expansion; the repository remains the pagination owner. */
export function useDesktopHistoryWarmup(options: {
    scope: string;
    enabled: boolean;
    cursor: string | null;
    loadedTurns: number;
    messages: unknown;
    scrollRef: React.RefObject<HTMLDivElement | null>;
    loadPrevious: (pageSize: number) => Promise<void>;
}) {
    const { scope, enabled, cursor, loadedTurns, messages, scrollRef, loadPrevious } = options;
    const [attempt, setAttempt] = React.useState<string | null>(null);
    const attemptRef = React.useRef(attempt);
    const flight = React.useRef(false);
    const sample = React.useRef<{ height: number; top: number; since: number } | null>(null);
    const eligible = enabled && cursor !== null && loadedTurns < TARGET_TURNS
        && attempt !== scope;

    React.useEffect(() => {
        attemptRef.current = null;
        setAttempt(null);
    }, [scope]);

    React.useEffect(() => {
        sample.current = null;
    }, [scope, eligible, cursor, messages]);

    useInterval(useEvent(() => {
        const container = scrollRef.current;
        const lastAttempt = attemptRef.current;
        if (lastAttempt === scope) return;
        if (!eligible || !cursor || !container || flight.current || document.visibilityState === 'hidden') {
            sample.current = null;
            return;
        }
        const height = container.scrollHeight;
        const top = container.scrollTop;
        const previous = sample.current;
        if (!previous || previous.height !== height || previous.top !== top) {
            sample.current = { height, top, since: Date.now() };
            return;
        }
        if (Date.now() - previous.since < QUIET_MS) return;
        attemptRef.current = scope;
        setAttempt(scope);
        flight.current = true;
        void loadPrevious(WARMUP_PAGE_SIZE).catch((error: unknown) => {
            console.error('[chat-history] desktop history warmup failed', error);
        }).finally(() => {
            flight.current = false;
        });
    }), eligible ? 200 : null);
}
