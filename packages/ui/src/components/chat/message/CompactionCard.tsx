import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { SessionCompactionPart } from '@/sync/session-projection-api';

export function CompactionCard({ part }: { part: SessionCompactionPart }) {
    const { t } = useI18n();
    const title = part.status === 'running'
        ? t('chat.activity.compacting')
        : part.status === 'failed'
            ? t('chat.activity.compactionFailed')
            : t('chat.activity.compactionCompleted');
    const detail = part.status === 'failed' ? part.error?.message : part.summary;
    const iconName = part.status === 'running'
        ? 'loader-4'
        : part.status === 'failed'
            ? 'close-circle'
            : 'fold-vertical';

    return (
        <div
            data-compaction-card=""
            data-compaction-status={part.status}
            className="flex w-full max-w-2xl flex-col gap-1 rounded-xl border border-border/60 bg-[var(--surface-subtle)] px-3 py-2 text-sm text-muted-foreground"
            role="status"
            aria-live={part.status === 'running' ? 'polite' : undefined}
            aria-label={title}
        >
            <div className="flex items-center gap-2">
                <Icon
                    name={iconName}
                    className={cn('size-3.5', part.status === 'running' && 'animate-spin')}
                    aria-hidden="true"
                />
                <span className="font-medium text-foreground">{title}</span>
            </div>
            {detail ? (
                <p className="whitespace-pre-wrap text-muted-foreground">{detail}</p>
            ) : null}
        </div>
    );
}
