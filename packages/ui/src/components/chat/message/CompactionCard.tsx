import { Icon } from '@/components/icon/Icon';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { SessionCompactionPart } from '@/sync/session-projection-api';
import { resolveAssistantErrorPresentation } from './assistantErrorPresentation';
import { ResponseStatusRow } from './ResponseStatusRow';

export function CompactionCard({ part }: { part: SessionCompactionPart }) {
    const { t } = useI18n();
    const title = part.status === 'running'
        ? t('chat.activity.compacting')
        : part.status === 'failed'
            ? t('chat.activity.compactionFailed')
            : t('chat.activity.compactionCompleted');
    const failure = part.status === 'failed' ? resolveAssistantErrorPresentation(part.error, t) : undefined;
    const detail = part.status === 'failed' ? undefined : part.summary;
    const iconName = part.status === 'running'
        ? 'loader-4'
        : part.status === 'failed'
            ? 'close-circle'
            : 'fold-vertical';

    return (
        <Collapsible
            data-compaction-card=""
            data-compaction-status={part.status}
            className="flex w-full max-w-2xl flex-col gap-1 rounded-xl border border-border/60 bg-[var(--surface-subtle)] px-3 py-2 text-sm text-muted-foreground"
            role="status"
            aria-live={part.status === 'running' ? 'polite' : undefined}
            aria-label={failure?.text ?? title}
        >
            {failure ? <ResponseStatusRow presentation={failure} /> : <CollapsibleTrigger disabled={!detail} className="group justify-start gap-2">
                <Icon
                    name={iconName}
                    className={cn('size-3.5', part.status === 'running' && 'animate-spin')}
                    aria-hidden="true"
                />
                <span className="font-medium text-foreground">{title}</span>
                {detail ? <Icon name="arrow-right-s" className="ml-auto size-4 transition-transform group-data-[open]:rotate-90" aria-hidden="true" /> : null}
            </CollapsibleTrigger>}
            {detail ? (
                <CollapsibleContent>
                    <p className="whitespace-pre-wrap break-words text-muted-foreground">{detail}</p>
                </CollapsibleContent>
            ) : null}
        </Collapsible>
    );
}
