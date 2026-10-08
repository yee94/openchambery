import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useDirectoryStore, useRunningSessionCount } from '@/sync/sync-context';
import { useTranscriptProjection } from '@/sync/transcript-repository-observers';
import type { TranscriptData } from '@/sync/transcript-repository';
import { hasSettledBackgroundRunningHint, readBackgroundWorkIdentity } from './message/parts/sessionBackgroundModel';

const projectBackgroundChildren = (data: TranscriptData): readonly string[] => {
    const ids = new Set<string>();
    for (const messageID of data.messageOrder) {
        for (const part of data.partsByMessageID[messageID] ?? []) {
            if (!hasSettledBackgroundRunningHint(part)) continue;
            const identity = readBackgroundWorkIdentity(part);
            if (identity?.type === 'subagent' && identity.id) ids.add(identity.id);
        }
    }
    return [...ids];
};

const sameIDs = (left: readonly string[], right: readonly string[]) => (
    left.length === right.length && left.every((id, index) => id === right[index])
);

export const BackgroundWorkHint = React.memo(({ sessionID, directory }: {
    sessionID: string;
    directory: string;
}) => {
    const { t } = useI18n();
    const store = useDirectoryStore(directory, { bootstrap: false });
    const children = useTranscriptProjection(
        sessionID, directory, store, projectBackgroundChildren, sameIDs,
        { enabled: Boolean(sessionID && directory) },
    );
    const count = useRunningSessionCount(children);
    if (count === 0) return null;
    return (
        <div className="chat-column py-1 typography-meta text-muted-foreground" role="status" aria-live="polite">
            {t('chat.sessionBackground.tasksRunning', { count })}
        </div>
    );
});

BackgroundWorkHint.displayName = 'BackgroundWorkHint';
