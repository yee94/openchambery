import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { SessionCompactionPart } from '@/sync/session-projection-api';
import { resolveAssistantErrorPresentation } from './assistantErrorPresentation';

export function CompactionCard({
    part,
    isMobile = false,
}: {
    part: SessionCompactionPart;
    isMobile?: boolean;
}) {
    const { t } = useI18n();
    const isRunning = part.status === 'running';
    const isFailed = part.status === 'failed';
    const title = isRunning
        ? t('chat.activity.compacting')
        : isFailed
            ? t('chat.activity.compactionFailed')
            : t('chat.activity.compactionCompleted');
    const failure = isFailed ? resolveAssistantErrorPresentation(part.error, t) : undefined;

    return (
        <div
            data-compaction-card=""
            data-compaction-status={part.status}
            className={cn('flex w-full items-center gap-3', isMobile ? 'h-7' : 'h-8')}
            role="separator"
            aria-live={isRunning ? 'polite' : undefined}
            aria-label={failure?.text ?? title}
        >
            <span className="min-w-0 flex-1 border-t" aria-hidden="true" />
            <span
                className={cn(
                    'shrink-0 typography-meta',
                    isRunning
                        ? 'animate-text-shimmer text-[var(--status-info)] [--oc-text-shimmer-base:var(--status-info)]'
                        : isFailed
                            ? 'text-[var(--status-error)]/85'
                            : 'text-muted-foreground',
                )}
            >
                {title}
            </span>
            <span className="min-w-0 flex-1 border-t" aria-hidden="true" />
        </div>
    );
}
