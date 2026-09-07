/**
 * Hook-level contract: ordinary-session history auto-load follows the same
 * mounted `isMobile` flag as the ChatContainer load-older button — not
 * `isMobileSurfaceRuntime()` width/pointer probes that can disagree.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Message, Part } from '@opencode-ai/sdk/v2';

import type { ChatMessageEntry } from '../lib/turns/types';
import type { SessionHistoryMeta } from '@/stores/types/sessionTypes';
import type { UseChatTimelineControllerResult } from './useChatTimelineController';

const runtimeSurface = vi.hoisted(() => ({
    mobileProbe: false,
}));

vi.mock('@/lib/runtimeSurface', () => ({
    isMobileSurfaceRuntime: () => runtimeSurface.mobileProbe,
}));

vi.mock('@/lib/desktop', () => ({
    isVSCodeRuntime: () => false,
}));

vi.mock('@/lib/runtime-switch', () => ({
    getRuntimeKey: () => 'test-runtime',
}));

vi.mock('@/lib/i18n', () => ({
    useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui', () => ({
    toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock('@/sync/transcript-repository-runtime', () => ({
    getTranscriptRepository: () => null,
    transcriptScope: (directory: string | null, sessionId: string) => ({
        directory,
        sessionId,
    }),
}));

import { useChatTimelineController } from './useChatTimelineController';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION_ID = 'ses_history_boundary';

const historyMetaReady = (): SessionHistoryMeta => ({
    limit: 6,
    loading: false,
    complete: false,
    canLoadEarlier: true,
});

const message = (id: string): ChatMessageEntry => ({
    info: {
        id,
        role: 'user',
        sessionID: SESSION_ID,
        time: { created: 1 },
    } as Message,
    parts: [] as Part[],
});

const applyScrollerGeometry = (
    el: HTMLDivElement,
    input: { scrollHeight: number; clientHeight: number; scrollTop: number },
) => {
    el.style.height = `${input.clientHeight}px`;
    el.style.overflow = 'auto';
    const inner = el.firstElementChild as HTMLDivElement | null;
    if (inner) {
        inner.style.height = `${input.scrollHeight}px`;
    }
    // happy-dom often reports 0 for unlaid-out boxes; pin the metrics the
    // controller reads for auto-fill / near-top gates.
    Object.defineProperties(el, {
        scrollHeight: { configurable: true, get: () => input.scrollHeight },
        clientHeight: { configurable: true, get: () => input.clientHeight },
        scrollTop: {
            configurable: true,
            get: () => input.scrollTop,
            set: (value: number) => {
                input.scrollTop = value;
            },
        },
    });
};

const flushMicrotasks = async () => {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
};

const waitMs = async (ms: number) => {
    await act(async () => {
        await new Promise<void>((resolve) => {
            window.setTimeout(resolve, ms);
        });
    });
};

type HarnessState = {
    isMobile: boolean;
    autoFillEnabled: boolean;
    isPinned: boolean;
    historyMeta: SessionHistoryMeta;
    messages: ChatMessageEntry[];
    loadMoreMessages: (sessionId: string, direction: 'up' | 'down') => Promise<void>;
};

type TimelineHarnessProps = HarnessState & {
    scrollRef: React.MutableRefObject<HTMLDivElement | null>;
    geometry: { scrollHeight: number; clientHeight: number; scrollTop: number };
    onApi: (api: UseChatTimelineControllerResult) => void;
};

const TimelineHarness: React.FC<TimelineHarnessProps> = ({
    isMobile,
    autoFillEnabled,
    isPinned,
    historyMeta,
    messages,
    loadMoreMessages,
    scrollRef,
    geometry,
    onApi,
}) => {
    const messageListRef = React.useRef(null);
    // Apply geometry before the controller's layout-phase metrics publish so
    // short-viewport auto-fill can arm on the first commit.
    const bindScrollNode = (node: HTMLDivElement | null) => {
        scrollRef.current = node;
        if (node) applyScrollerGeometry(node, geometry);
    };
    const api = useChatTimelineController({
        sessionId: SESSION_ID,
        directory: '/workspace',
        messages,
        historyMeta,
        scrollRef,
        messageListRef,
        loadMoreMessages,
        goToBottom: () => undefined,
        releaseAutoFollow: () => undefined,
        beginHistoryViewportPreservation: () => undefined,
        endHistoryViewportPreservation: () => undefined,
        isPinned,
        showScrollButton: false,
        autoFillEnabled,
        isMobile,
    });
    onApi(api);
    return (
        <div data-testid="timeline-scroll" ref={bindScrollNode}>
            <div data-testid="timeline-scroll-inner" />
        </div>
    );
};

type Mounted = {
    root: Root;
    host: HTMLDivElement;
    client: QueryClient;
    scrollRef: React.MutableRefObject<HTMLDivElement | null>;
    state: HarnessState;
    geometry: { scrollHeight: number; clientHeight: number; scrollTop: number };
    api: UseChatTimelineControllerResult | null;
    render: () => Promise<void>;
    setState: (patch: Partial<HarnessState>) => Promise<void>;
};

const mounted: Mounted[] = [];

const mountController = async (input: {
    isMobile: boolean;
    autoFillEnabled?: boolean;
    isPinned?: boolean;
    historyMeta?: SessionHistoryMeta;
    messages?: ChatMessageEntry[];
    loadMoreMessages: (sessionId: string, direction: 'up' | 'down') => Promise<void>;
    geometry?: { scrollHeight: number; clientHeight: number; scrollTop: number };
}): Promise<Mounted> => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const client = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    });
    const scrollRef: React.MutableRefObject<HTMLDivElement | null> = { current: null };

    const handle: Mounted = {
        root: createRoot(host),
        host,
        client,
        scrollRef,
        state: {
            isMobile: input.isMobile,
            autoFillEnabled: input.autoFillEnabled ?? true,
            isPinned: input.isPinned ?? true,
            historyMeta: input.historyMeta ?? historyMetaReady(),
            messages: input.messages ?? [message('msg_1'), message('msg_2')],
            loadMoreMessages: input.loadMoreMessages,
        },
        geometry: input.geometry ?? {
            scrollHeight: 400,
            clientHeight: 400,
            scrollTop: 0,
        },
        api: null,
        render: async () => undefined,
        setState: async () => undefined,
    };

    handle.render = async () => {
        await act(async () => {
            handle.root.render(
                <QueryClientProvider client={handle.client}>
                    <TimelineHarness
                        {...handle.state}
                        scrollRef={handle.scrollRef}
                        geometry={handle.geometry}
                        onApi={(api) => {
                            handle.api = api;
                        }}
                    />
                </QueryClientProvider>,
            );
        });
    };

    handle.setState = async (patch) => {
        handle.state = { ...handle.state, ...patch };
        await handle.render();
        await flushMicrotasks();
    };

    await handle.render();
    await flushMicrotasks();
    // Metrics publish + Query auto-fill scheduling.
    await flushMicrotasks();
    await waitMs(0);

    if (!handle.api) throw new Error('timeline controller failed to publish api');

    mounted.push(handle);
    return handle;
};

afterEach(async () => {
    for (const entry of mounted.splice(0)) {
        await act(async () => {
            entry.root.unmount();
        });
        entry.client.clear();
        entry.host.remove();
    }
    runtimeSurface.mobileProbe = false;
    document.body.innerHTML = '';
    vi.clearAllMocks();
});

beforeEach(() => {
    runtimeSurface.mobileProbe = false;
});

describe('useChatTimelineController mobile history boundary', () => {
    // isPinned false: scroll/upward only blocked by isMobile (auto-fill also
    // fails the pin gate). isPinned true: short-viewport auto-fill is armed on
    // every non-mobile gate — so zero fetches proves the mobile autofill guard.
    test.each([
        { isPinned: false as const, label: 'unpinned' },
        { isPinned: true as const, label: 'pinned short-viewport auto-fill' },
    ])(
        'UI mobile=true ($label) blocks scroll / upward-intent / short-viewport auto-fill even when runtime probe is desktop',
        async ({ isPinned }) => {
            runtimeSurface.mobileProbe = false;
            const loadMoreMessages = vi.fn(async () => undefined);

            const handle = await mountController({
                isMobile: true,
                autoFillEnabled: true,
                isPinned,
                loadMoreMessages,
                geometry: { scrollHeight: 400, clientHeight: 400, scrollTop: 0 },
            });

            // Extra commit so short-viewport metrics + Query enablement settle
            // when pin would otherwise arm desktop auto-fill.
            await handle.render();
            await flushMicrotasks();
            await waitMs(250);

            await act(async () => {
                handle.api!.handleHistoryScroll();
                handle.api!.handleHistoryUpwardIntent();
            });
            await flushMicrotasks();
            await waitMs(200);

            expect(loadMoreMessages).not.toHaveBeenCalled();
        },
    );

    test('manual loadEarlier remains available once; concurrent scroll cannot double-fetch', async () => {
        runtimeSurface.mobileProbe = false;
        let resolveLoad: (() => void) | null = null;
        const loadMoreMessages = vi.fn(
            () => new Promise<void>((resolve) => {
                resolveLoad = resolve;
            }),
        );

        const handle = await mountController({
            isMobile: true,
            autoFillEnabled: true,
            isPinned: false,
            loadMoreMessages,
            geometry: { scrollHeight: 8000, clientHeight: 400, scrollTop: 0 },
        });

        await act(async () => {
            void handle.api!.loadEarlier({ userInitiated: true });
        });
        await flushMicrotasks();

        await act(async () => {
            handle.api!.handleHistoryScroll();
            handle.api!.handleHistoryUpwardIntent();
            void handle.api!.loadEarlier({ userInitiated: true });
        });
        await flushMicrotasks();

        expect(loadMoreMessages).toHaveBeenCalledTimes(1);

        await act(async () => {
            resolveLoad?.();
        });
        await flushMicrotasks();
    });

    test('UI mobile=false keeps scroll auto-load when runtime probe reports mobile', async () => {
        runtimeSurface.mobileProbe = true;
        const loadMoreMessages = vi.fn(async () => undefined);

        const handle = await mountController({
            isMobile: false,
            autoFillEnabled: false,
            isPinned: false,
            loadMoreMessages,
            geometry: { scrollHeight: 8000, clientHeight: 400, scrollTop: 0 },
        });

        await act(async () => {
            handle.api!.handleHistoryScroll();
        });
        await flushMicrotasks();
        await waitMs(50);

        expect(loadMoreMessages).toHaveBeenCalledTimes(1);
        expect(loadMoreMessages).toHaveBeenCalledWith(SESSION_ID, 'up');
    });

    test('UI mobile=false keeps short-viewport auto-fill when runtime probe reports mobile', async () => {
        runtimeSurface.mobileProbe = true;
        const loadMoreMessages = vi.fn(async () => undefined);

        const handle = await mountController({
            isMobile: false,
            autoFillEnabled: true,
            isPinned: true,
            loadMoreMessages,
            geometry: { scrollHeight: 400, clientHeight: 400, scrollTop: 0 },
        });

        // Metrics publish is async setState; give Query one more commit + tick.
        await handle.render();
        await flushMicrotasks();
        await waitMs(250);

        expect(loadMoreMessages).toHaveBeenCalled();
        expect(loadMoreMessages).toHaveBeenCalledWith(SESSION_ID, 'up');
    });

    const autoFillQuerySnapshots = (client: QueryClient) => (
        client.getQueryCache().getAll().filter((query) => (
            Array.isArray(query.queryKey) && query.queryKey[0] === 'chat-timeline-auto-fill'
        ))
    );

    const isAutoFillBusyRetryState = (client: QueryClient): boolean => {
        return autoFillQuerySnapshots(client).some((query) => {
            const error = query.state.error as { code?: string; message?: string } | null;
            return (
                query.state.fetchFailureCount > 0
                || error?.code === 'auto-fill-busy'
                || error?.message === 'auto-fill-busy'
            );
        });
    };

    // Mount autoFill off → real manual pending → enable autoFill so queryFn
    // hits auto-fill-busy retries (not the initial autofill owning the mutex).
    // Stop via mobile flip or autoFill disable; resolve manual with real growth
    // so canLoadEarlier stays true (no-growth would clear it and vacate the assert).
    test.each([
        { stopHow: 'mobile' as const, label: 'flipping to mobile' },
        { stopHow: 'disable-autofill' as const, label: 'disabling autoFillEnabled' },
    ])(
        '$label stops an already-scheduled auto-fill busy retry before real fetch',
        async ({ stopHow }) => {
            runtimeSurface.mobileProbe = false;
            let resolveUserLoad: (() => void) | null = null;
            const loadMoreMessages = vi.fn(
                () => new Promise<void>((resolve) => {
                    resolveUserLoad = resolve;
                }),
            );

            const handle = await mountController({
                isMobile: false,
                autoFillEnabled: false,
                isPinned: true,
                loadMoreMessages,
                geometry: { scrollHeight: 400, clientHeight: 400, scrollTop: 0 },
            });

            // Real manual flight owns isLoadingOlder / mutex first.
            await act(async () => {
                void handle.api!.loadEarlier({ userInitiated: true });
            });
            await flushMicrotasks();
            expect(loadMoreMessages).toHaveBeenCalledTimes(1);

            // Arm short-viewport auto-fill while manual is still pending.
            // isLoadingOlder is excluded from Query `enabled`, so queryFn must
            // enter the busy-retry path instead of a second real fetch.
            await handle.setState({ autoFillEnabled: true });
            await handle.render();
            await flushMicrotasks();

            // Let busy retries schedule (retryDelay 50).
            await waitMs(200);
            expect(isAutoFillBusyRetryState(handle.client)).toBe(true);
            // Still only the manual real fetch.
            expect(loadMoreMessages).toHaveBeenCalledTimes(1);

            if (stopHow === 'mobile') {
                await handle.setState({ isMobile: true });
            } else {
                await handle.setState({ autoFillEnabled: false });
            }

            // Submit actual growth so stop-no-growth cannot clear canLoadEarlier
            // and make "no second fetch" vacuously true.
            const grownMessages = [
                message('msg_0'),
                message('msg_1'),
                message('msg_2'),
            ];
            const grownMeta: SessionHistoryMeta = {
                limit: 12,
                loading: false,
                complete: false,
                canLoadEarlier: true,
            };

            await act(async () => {
                resolveUserLoad?.();
            });
            // Grow on the next commit so fetchOlderHistory's render wait sees it.
            await handle.setState({
                messages: grownMessages,
                historyMeta: grownMeta,
            });
            await flushMicrotasks();
            await waitMs(300);

            expect(loadMoreMessages).toHaveBeenCalledTimes(1);
            // Gate must still claim more history — otherwise the assert is vacuous.
            expect(handle.state.historyMeta.canLoadEarlier).toBe(true);
        },
    );
});
