import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { useEvent } from '@reactuses/core';
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
const makeRows = (start: number, count: number): ChatMessageEntry[] => Array.from({ length: count }, (_, index) => {
    const id = `message-${String(start + index).padStart(3, '0')}`;
    return {
        info: { id, sessionID, role: 'user', time: { created: start + index + 1 }, agent: 'build' } as Message,
        parts: [{ id: `${id}-text`, messageID: id, sessionID, type: 'text', text: `${id}\n${'History reading position. '.repeat(40)}` } as Part],
    };
});
const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export default function Fixture() {
    const [rows, setRows] = React.useState(() => makeRows(20, 12));
    const [token, setToken] = React.useState(0);
    const listRef = React.useRef<MessageListHandle | null>(null);
    const upwardRef = React.useRef<() => void>(() => undefined);
    const loads = React.useRef(0);
    const anchorID = React.useRef<string | null>(null);
    const auto = useChatAutoFollow({
        currentSessionId: sessionID, sessionMessageCount: rows.length, sessionIsWorking: false, isMobile: true,
        onUpwardUserIntent: useEvent(() => upwardRef.current()),
    });
    const { releaseAutoFollow, scrollRef } = auto;
    const sample = useEvent(() => {
        const el = auto.scrollRef.current!;
        const node = anchorID.current ? el.querySelector<HTMLElement>(`[data-message-id="${anchorID.current}"]`) : null;
        return {
            run: new URLSearchParams(location.search).get('run'),
            top: el.scrollTop, max: el.scrollHeight - el.clientHeight,
            anchor: anchorID.current,
            anchorTop: node ? node.getBoundingClientRect().top - el.getBoundingClientRect().top : null,
            anchorBottom: node ? node.getBoundingClientRect().bottom - el.getBoundingClientRect().top : null,
            loads: loads.current, pinned: auto.isPinned,
            viewportHeight: el.clientHeight,
        };
    });
    const loadMore = useEvent(async () => {
        loads.current += 1;
        anchorID.current = listRef.current?.captureViewportAnchor()?.messageId ?? null;
        await wait(100);
        setRows((current) => [...makeRows(0, 12), ...current]);
    });
    const timeline = useChatTimelineController({
        sessionId: sessionID, directory: '/fixture', messages: rows,
        historyMeta: { limit: rows.length, loading: false, complete: loads.current > 0, canLoadEarlier: loads.current === 0 },
        scrollRef: auto.scrollRef, messageListRef: listRef, loadMoreMessages: loadMore,
        goToBottom: auto.goToBottom, releaseAutoFollow: auto.releaseAutoFollow,
        beginHistoryViewportPreservation: auto.beginHistoryViewportPreservation,
        endHistoryViewportPreservation: auto.endHistoryViewportPreservation,
        isPinned: auto.isPinned, showScrollButton: auto.showScrollButton, isMobile: true, autoFillEnabled: false,
        onWillLoadEarlier: useEvent(() => setToken((value) => value + 1)),
    });
    upwardRef.current = timeline.handleHistoryUpwardIntent;
    React.useEffect(() => {
        const api = {
            prepare: async () => {
                releaseAutoFollow();
                await wait(50);
                scrollRef.current!.scrollTop = 800;
                await wait(500);
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
    }, [releaseAutoFollow, scrollRef, sample]);
    return <div ref={auto.scrollRef} data-history-scroller="true" onScroll={timeline.handleHistoryScroll}
        style={{ height: '100dvh', overflowY: 'auto', overflowAnchor: 'none' }}>
        <MessageList ref={listRef} sessionKey={sessionID} virtualizerKey={sessionID} directory="/fixture"
            messages={timeline.renderedMessages} scrollRef={auto.scrollRef} isLoadingOlder={timeline.isLoadingOlder}
            sessionIsWorking={false} onMessageContentChange={auto.notifyContentChange}
            getAnimationHandlers={auto.getAnimationHandlers} enableSendPark={false}
            timelineHistoryAnchorToken={token} />
    </div>;
}

useUIStore.setState({ isMobile: true, chatRenderMode: 'live', activityRenderMode: 'summary' });
useFeatureFlagsStore.setState({ legendTimelineEnabled: false });
createRoot(document.getElementById('root')!).render(
    <RuntimeAPIProvider apis={createWebAPIs()}><QueryClientProvider client={queryClient}><I18nProvider>
        <SyncProvider sdk={opencodeClient.getSdkClient()} directory="/fixture" bootstrapDirectory={false}>
            <Fixture />
        </SyncProvider>
    </I18nProvider></QueryClientProvider></RuntimeAPIProvider>,
);
