import { Icon } from '@/components/icon/Icon';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { SessionCompactionPart } from '@/sync/session-projection-api';
import { resolveAssistantErrorPresentation } from './assistantErrorPresentation';
import { ResponseStatusRow } from './ResponseStatusRow';
import {
    getToolRowBlockClass,
    TOOL_ROW_CHIP_GEOMETRY_CLASS,
    TOOL_ROW_INTERACTIVE_CHROME_CLASS,
} from './parts/toolRowChrome';

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
    const detail = isFailed ? undefined : part.summary?.trim();
    const canToggle = Boolean(detail);

    return (
        <Collapsible
            data-compaction-card=""
            data-compaction-status={part.status}
            className={getToolRowBlockClass(isMobile)}
            role="status"
            aria-live={isRunning ? 'polite' : undefined}
            aria-label={failure?.text ?? title}
        >
            {failure ? <ResponseStatusRow presentation={failure} /> : (
                <CollapsibleTrigger
                    disabled={!canToggle}
                    data-mobile-press-feedback={canToggle ? 'soft' : undefined}
                    className={cn(
                        'group flex w-full min-w-0 flex-nowrap items-center text-left',
                        isMobile ? 'gap-x-1' : 'gap-x-2',
                        canToggle ? TOOL_ROW_INTERACTIVE_CHROME_CLASS : `oc-tool-row -mx-2 ${TOOL_ROW_CHIP_GEOMETRY_CLASS} cursor-default`,
                        isMobile && 'pr-0',
                        'justify-start py-0.5',
                        !canToggle && 'hover:bg-transparent',
                    )}
                >
                    <span className={cn(
                        'inline-flex min-w-0 flex-1 items-center overflow-clip',
                        isMobile ? 'gap-x-1' : 'gap-x-1.5',
                    )}>
                        <span
                            className={cn(
                                'inline-flex flex-none items-center justify-center',
                                isMobile ? 'h-5 w-4' : 'h-6 w-3.5',
                            )}
                            style={{ color: 'var(--tools-icon)' }}
                        >
                            <Icon name="fold-vertical" className="h-3.5 w-3.5" aria-hidden="true" />
                        </span>
                        <span className={cn(
                            'inline-flex flex-shrink-0 items-center',
                            isMobile ? 'typography-meta h-5' : 'typography-ui-label h-5 font-semibold',
                            isRunning
                                ? 'animate-text-shimmer text-[var(--status-info)] [--oc-text-shimmer-base:var(--status-info)]'
                                : 'text-foreground/85',
                        )}>
                            {title}
                        </span>
                    </span>
                    {canToggle ? (
                        <Icon
                            name="arrow-right-s"
                            className={cn(
                                'ml-auto flex-shrink-0 text-muted-foreground opacity-70 transition-transform group-data-[open]:rotate-90',
                                isMobile && '-mr-0.5',
                                isMobile ? 'size-3' : 'size-3.5',
                            )}
                            aria-hidden="true"
                        />
                    ) : null}
                </CollapsibleTrigger>
            )}
            {detail ? (
                <CollapsibleContent>
                    <div className="markdown-content pt-1 leading-relaxed whitespace-pre-wrap break-words text-foreground">
                        {detail}
                    </div>
                </CollapsibleContent>
            ) : null}
        </Collapsible>
    );
}
