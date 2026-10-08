import { useId } from 'react';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { SessionCompactionPart } from '@/sync/session-projection-api';
import { resolveAssistantErrorPresentation } from './assistantErrorPresentation';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { TOOL_ROW_CHIP_HOVER_CLASS } from './parts/toolRowChrome';
import { useCompactionDisclosure } from './compactionDisclosureState';

export function CompactionCard({
    part,
    isMobile = false,
}: {
    part: SessionCompactionPart;
    isMobile?: boolean;
}) {
    const { t } = useI18n();
    const disclosureId = JSON.stringify([part.sessionID, part.messageID, part.id]);
    const { expanded, toggle: toggleDisclosure } = useCompactionDisclosure(disclosureId);
    const contentId = useId();
    const toggle = useEvent(() => toggleDisclosure(disclosureId));
    const isRunning = part.status === 'running';
    const isFailed = part.status === 'failed';
    const title = isRunning
        ? t('chat.activity.compacting')
        : isFailed
            ? t('chat.activity.compactionFailed')
            : t('chat.activity.compactionCompleted');
    const failure = isFailed ? resolveAssistantErrorPresentation(part.error, t) : undefined;
    const summary = isFailed ? '' : part.summary?.trim() ?? '';
    const labelClassName = cn(
        'shrink-0 typography-meta',
        isRunning
            ? 'animate-text-shimmer text-[var(--status-info)] [--oc-text-shimmer-base:var(--status-info)]'
            : isFailed
                ? 'text-[var(--status-error)]/85'
                : 'text-muted-foreground',
    );

    return (
        <div className="w-full min-w-0">
            <div
                data-compaction-card=""
                data-compaction-status={part.status}
                className={cn('flex w-full items-center gap-3', isMobile ? 'min-h-7' : 'min-h-8')}
                role="separator"
                aria-live={isRunning ? 'polite' : undefined}
                aria-label={failure?.text ?? title}
            >
                <span className="min-w-0 flex-1 border-t" aria-hidden="true" />
                {summary ? (
                    <Button
                        variant="ghost"
                        size="sm"
                        className={cn(labelClassName, TOOL_ROW_CHIP_HOVER_CLASS)}
                        aria-expanded={expanded}
                        aria-controls={contentId}
                        onClick={toggle}
                    >
                        {title}
                        <Icon name="arrow-down-s" className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
                    </Button>
                ) : <span className={labelClassName}>{title}</span>}
                <span className="min-w-0 flex-1 border-t" aria-hidden="true" />
            </div>
            {summary && expanded ? (
                <div id={contentId} className="py-2">
                    <MarkdownRenderer content={summary} messageId={part.messageID} isStreaming={isRunning} />
                </div>
            ) : null}
        </div>
    );
}
