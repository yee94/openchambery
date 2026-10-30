import React from 'react';
import { useEvent, useResizeObserver } from '@reactuses/core';
import { ContextPanel } from './ContextPanel';

const PRIMARY_CHAT_MIN_WIDTH = 350;

export const ChatWorkspace: React.FC<React.PropsWithChildren> = ({ children }) => {
    const workspaceRef = React.useRef<HTMLDivElement>(null);
    const availableWidthRef = React.useRef(0);
    const reservedWidthRef = React.useRef(0);
    const hiddenRef = React.useRef(false);
    const [hidden, setHidden] = React.useState(false);

    const updateVisibility = useEvent(() => {
        if (availableWidthRef.current <= 0) return;
        const next = reservedWidthRef.current > 0
            && availableWidthRef.current - reservedWidthRef.current < PRIMARY_CHAT_MIN_WIDTH;
        if (next === hiddenRef.current) return;
        hiddenRef.current = next;
        setHidden(next);
    });
    const handleReservedWidthChange = useEvent((width: number) => {
        reservedWidthRef.current = width;
        updateVisibility();
    });

    React.useLayoutEffect(() => {
        availableWidthRef.current = workspaceRef.current?.clientWidth ?? 0;
        updateVisibility();
    }, [updateVisibility]);
    useResizeObserver(workspaceRef, ([entry]) => {
        if (!entry) return;
        availableWidthRef.current = entry.contentRect.width;
        updateVisibility();
    });

    return (
        <div ref={workspaceRef} className="relative flex flex-1 min-h-0 min-w-0 overflow-hidden" data-page-scroll-lock="true" data-chat-area>
            <main
                className="flex-1 min-w-0 overflow-hidden bg-background relative"
                style={hidden ? { display: 'none' } : { minWidth: `min(${PRIMARY_CHAT_MIN_WIDTH}px, 100%)` }}
                inert={hidden || undefined}
                data-page-scroll-lock="true"
                data-primary-chat
            >
                {children}
            </main>
            <ContextPanel onReservedWidthChange={handleReservedWidthChange} fillAvailableSpace={hidden} />
        </div>
    );
};
