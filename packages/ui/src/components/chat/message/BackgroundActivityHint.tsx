import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useRunningDescendantCount } from '@/sync/sync-context';

export const BackgroundActivityHint = React.memo(({ sessionId }: { sessionId: string }) => {
    const { t } = useI18n();
    const count = useRunningDescendantCount(sessionId);
    if (count === 0) return null;
    return (
        <span
            className="inline-flex h-3.5 shrink-0 items-center whitespace-nowrap text-[11px] leading-none font-normal text-muted-foreground"
            data-background-activity="true">
            <span className="animate-text-shimmer">{t('chat.sessionBackground.tasksRunning', { count })}</span>
        </span>
    );
});

BackgroundActivityHint.displayName = 'BackgroundActivityHint';
