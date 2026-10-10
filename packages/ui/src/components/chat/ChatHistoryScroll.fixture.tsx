import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { useEvent, useEventListener } from '@reactuses/core';
import MessageList, { type MessageListHandle } from './MessageList';
import { useChatAutoFollow } from '@/hooks/useChatAutoFollow';
import { useChatTimelineController } from './hooks/useChatTimelineController';
import { SyncProvider } from '@/sync/sync-context';
import { opencodeClient } from '@/lib/opencode/client';
import { queryClient } from '@/lib/queryRuntime';
import { I18nProvider } from '@/lib/i18n';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { createWebAPIs } from '../../../../web/src/api';
import { useUIStore } from '@/stores/useUIStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import type { ChatMessageEntry } from './lib/turns/types';
import type { Message, Part } from '@/lib/opencode/v2-types';

const sessionID = 'history-scroll-fixture';
const isMobile = new URLSearchParams(location.search).get('scenario') !== 'desktop-short';
const makeRows = (start: number, count: number): ChatMessageEntry[] => Array.from({ length: count }, (_, index) => {
    const id = `message-${String(start + index).padStart(3, '0')}`;
    return {
        info: { id, sessionID, role: 'user', time: { created: start + index + 1 }, agent: 'build' } as Message,
        parts: [{ id: `${id}-text`, messageID: id, sessionID, type: 'text', text: `${id}\n${'History reading position. '.repeat(40)}` } as Part],
    };
});
const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export default function Fixture() {
    const scenario = new URLSearchParams(location.search).get('scenario');
    const delayedResize = scenario === 'delayed-resize';
    const [rows, setRows] = React.useState(() => scenario === 'desktop-short'
        ? makeRows(20, 1).map((message) => ({ ...message, parts: message.parts.map((part) => (
            part.type === 'text' ? { ...part, text: 'Short initial transcript' } : part
        )) }))
        : makeRows(20, scenario === 'virtualize-transition' ? 4 : 12));
    const [token, setToken] = React.useState(0);
    const listRef = React.useRef<MessageListHandle | null>(null);
    const upwardRef = React.useRef<() => void>(() => undefined);
    const loads = React.useRef(0);
    const prepared = React.useRef(false);
    const anchorID = React.useRef<string | null>(null);
    const anchorOffset = React.useRef<number | null>(null);
    const fingerY = React.useRef(0);
    const loadFingerY = React.useRef(0);
    const auto = useChatAutoFollow({
        currentSessionId: sessionID, sessionMessageCount: rows.length, sessionIsWorking: false, isMobile,
        onUpwardUserIntent: useEvent(() => upwardRef.current()),
    });
    const { releaseAutoFollow, scrollRef } = auto;
    useEventListener('touchmove', useEvent((event: TouchEvent) => {
        fingerY.current = event.touches.item(0)?.clientY ?? fingerY.current;
    }), scrollRef, { capture: true, passive: true });
    const sample = useEvent(() => {
        const el = auto.scrollRef.current!;
        const node = anchorID.current ? el.querySelector<HTMLElement>(`[data-message-id="${anchorID.current}"]`) : null;
        return {
            run: new URLSearchParams(location.search).get('run'),
            prepared: prepared.current,
            top: el.scrollTop, max: el.scrollHeight - el.clientHeight,
            anchor: anchorID.current,
            anchorOffset: anchorOffset.current,
            fingerDelta: fingerY.current - loadFingerY.current,
            anchorTop: node ? node.getBoundingClientRect().top - el.getBoundingClientRect().top : null,
            anchorBottom: node ? node.getBoundingClientRect().bottom - el.getBoundingClientRect().top : null,
            loads: loads.current, pinned: auto.isPinned,
            viewportHeight: el.clientHeight,
        };
    });
    const loadMore = useEvent(async () => {
        loads.current += 1;
        const anchor = listRef.current?.captureViewportAnchor();
        anchorID.current = anchor?.messageId ?? null;
        anchorOffset.current = anchor?.offsetTop ?? null;
        loadFingerY.current = fingerY.current;
        await wait(100);
        const older = makeRows(0, 12);
        setRows((current) => [...(delayedResize ? older.map((message) => ({
            ...message, parts: message.parts.map((part) => part.type === 'text' ? { ...part, text: 'Loading history body' } : part),
        })) : older), ...current]);
        if (delayedResize) {
            await wait(350);
            setRows((current) => [...older, ...current.slice(12)]);
        }
    });
    const timeline = useChatTimelineController({
        sessionId: sessionID, directory: '/fixture', messages: rows,
        historyMeta: { limit: rows.length, loading: false, complete: loads.current > 0, canLoadEarlier: loads.current === 0 },
        scrollRef: auto.scrollRef, messageListRef: listRef, loadMoreMessages: loadMore,
        goToBottom: auto.goToBottom, releaseAutoFollow: auto.releaseAutoFollow,
        beginHistoryViewportPreservation: auto.beginHistoryViewportPreservation,
        endHistoryViewportPreservation: auto.endHistoryViewportPreservation,
        isPinned: auto.isPinned, showScrollButton: auto.showScrollButton, isMobile,
        onWillLoadEarlier: useEvent(() => setToken((value) => value + 1)),
    });
    upwardRef.current = timeline.handleHistoryUpwardIntent;
    React.useEffect(() => {
        const api = {
            prepare: async () => {
                releaseAutoFollow();
                await wait(50);
                scrollRef.current!.scrollTop = scenario === 'virtualize-transition' ? 100 : 800;
                await wait(500);
                prepared.current = true;
            },
            sample,
        };
        Object.assign(window, { historyScrollFixture: api });
        if (!new URLSearchParams(location.search).has('native')) return;
        const timer = window.setInterval(() => {
            if (scrollRef.current) void fetch('/sample', { method: 'POST', body: JSON.stringify(sample()) });
        }, 200);
        const prepareTimer = window.setTimeout(() => void api.prepare(), 2000);
        return () => { window.clearInterval(timer); window.clearTimeout(prepareTimer); };
    }, [releaseAutoFollow, scrollRef, sample, scenario]);
    return <div ref={auto.scrollRef} data-history-scroller="true" onScroll={timeline.handleHistoryScroll}
        style={{ height: '100dvh', overflowY: 'auto', overflowAnchor: 'none' }}>
        <MessageList ref={listRef} sessionKey={sessionID} virtualizerKey={sessionID} directory="/fixture"
            messages={timeline.renderedMessages} scrollRef={auto.scrollRef} isLoadingOlder={timeline.isLoadingOlder}
            sessionIsWorking={false} onMessageContentChange={auto.notifyContentChange}
            getAnimationHandlers={auto.getAnimationHandlers} enableSendPark={false}
            timelineHistoryAnchorToken={token} />
    </div>;
}

useUIStore.setState({ isMobile, chatRenderMode: 'live', activityRenderMode: 'summary' });
useFeatureFlagsStore.setState({ legendTimelineEnabled: false });
createRoot(document.getElementById('root')!).render(
    <RuntimeAPIProvider apis={createWebAPIs()}><QueryClientProvider client={queryClient}><I18nProvider>
        <SyncProvider sdk={opencodeClient.getSdkClient()} directory="/fixture" bootstrapDirectory={false}>
            <Fixture />
        </SyncProvider>
    </I18nProvider></QueryClientProvider></RuntimeAPIProvider>,
);
