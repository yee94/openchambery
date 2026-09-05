import React from 'react';
import { useEvent } from '@reactuses/core';
import type { ToolPart as ToolPartType } from '@opencode-ai/sdk/v2';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { TurnActivityRecord as TurnActivityPart } from '../../lib/turns/types';
import { LatticeOrb } from './LatticeOrb';
import { FlipUpText } from './FlipUpText';
import {
    USED_TOOL_COUNT_ORDER,
    isUsedGroupRunning,
    summarizeUsedToolDiffs,
    summarizeUsedTools,
} from './usedToolGrouping';
import { getToolRowBlockClass, TOOL_ROW_INTERACTIVE_CHROME_CLASS } from './toolRowChrome';

const TOOL_ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';

const UsedDiffTotals: React.FC<{ added: number; removed: number }> = ({ added, removed }) => {
    if (added <= 0 && removed <= 0) {
        return null;
    }

    return (
        <span className={cn('inline-flex flex-none items-center gap-0.5 tabular-nums', TOOL_ROW_TEXT_CLASS)}>
            {added > 0 ? <span style={{ color: 'var(--status-success)' }}>+{added}</span> : null}
            {added > 0 && removed > 0 ? <span style={{ color: 'var(--tools-description)' }}>/</span> : null}
            {removed > 0 ? <span style={{ color: 'var(--status-error)' }}>-{removed}</span> : null}
        </span>
    );
};

export const UsedToolGroup: React.FC<{
    activities: TurnActivityPart[];
    isMobile: boolean;
    /** 本轮仍在进行时，后面没出现其他类型内容也保持运行中。 */
    isTurnLive?: boolean;
    /** 本组之后是否已出现正文 / 非 used 工具。 */
    hasFollowingOtherType?: boolean;
    running?: boolean;
    children?: React.ReactNode;
}> = ({ activities, isMobile, isTurnLive = false, hasFollowingOtherType = false, running, children }) => {
    const { t } = useI18n();
    const [isExpanded, setIsExpanded] = React.useState(false);
    const contentId = React.useId();
    const toolParts = activities.map((activity) => activity.part as ToolPartType);
    const isActive = running ?? isUsedGroupRunning({
        parts: toolParts,
        hasFollowingOtherType,
        isTurnLive,
    });
    const counts = summarizeUsedTools(toolParts.map((part) => part.tool));
    const diffs = summarizeUsedToolDiffs(toolParts);
    const summary = USED_TOOL_COUNT_ORDER
        .filter((key) => counts[key] > 0)
        .map((key) => {
            const count = counts[key];
            if (key === 'edit') {
                return t(count === 1 ? 'chat.usedGroup.editSingle' : 'chat.usedGroup.editPlural', { count });
            }
            if (key === 'command') {
                return t(count === 1 ? 'chat.usedGroup.commandSingle' : 'chat.usedGroup.commandPlural', { count });
            }
            return t(count === 1 ? 'chat.usedGroup.otherSingle' : 'chat.usedGroup.otherPlural', { count });
        })
        .join(', ');

    const handleToggle = useEvent(() => {
        setIsExpanded((expanded) => !expanded);
    });

    const handleKeyDown = useEvent((event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleToggle();
        }
    });

    const ariaLabel = isExpanded
        ? t('chat.usedGroup.collapseAria')
        : t('chat.usedGroup.expandAria');
    const title = isActive
        ? t('chat.usedGroup.running')
        : t('chat.usedGroup.used');
    const rowLineClass = isMobile ? 'h-5' : 'h-6';

    return (
        <div data-component="used-tool-group" className={getToolRowBlockClass(isMobile)}>
            <div
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                aria-controls={contentId}
                aria-label={ariaLabel}
                data-mobile-press-feedback="soft"
                className={cn('flex min-h-0 min-w-0 items-center gap-1.5 overflow-clip', TOOL_ROW_INTERACTIVE_CHROME_CLASS)}
                onClick={handleToggle}
                onKeyDown={handleKeyDown}
            >
                <span
                    className={cn(
                        'inline-flex flex-none items-center justify-center self-center',
                        rowLineClass,
                        isMobile ? 'w-4' : 'w-3.5',
                    )}
                    style={{ color: 'var(--tools-icon)' }}
                >
                    {isActive ? (
                        <LatticeOrb
                            isMobile={isMobile}
                            label={t('chat.usedGroup.running')}
                            className="block"
                        />
                    ) : (
                        <Icon name="terminal-box" className="block h-[13px] w-[13px]" />
                    )}
                </span>
                <span
                    className={cn(
                        'typography-meta inline-flex flex-none items-center self-center font-medium',
                        rowLineClass,
                        TOOL_ROW_TEXT_CLASS,
                        isActive && 'animate-text-shimmer',
                    )}
                    style={{
                        color: 'var(--tools-title)',
                        ...(isActive ? { ['--oc-text-shimmer-base' as string]: 'var(--tools-title)' } : {}),
                    }}
                >
                    {title}
                </span>
                {summary ? (
                    <span
                        className={cn(
                            'typography-meta inline-flex min-h-0 w-0 min-w-0 max-w-full flex-1 items-center self-center overflow-clip',
                            rowLineClass,
                            TOOL_ROW_TEXT_CLASS,
                        )}
                        style={{ color: 'var(--tools-description)' }}
                    >
                        <FlipUpText
                            text={summary}
                            active={isActive}
                            className={isMobile ? '!h-5 sm:!h-5' : '!h-6 sm:!h-6'}
                        />
                    </span>
                ) : null}
                <UsedDiffTotals added={diffs.added} removed={diffs.removed} />
                <Icon
                    name={isExpanded ? 'arrow-down-s' : 'arrow-right-s'}
                    className="ml-auto size-3.5 flex-none self-center text-muted-foreground opacity-70"
                />
            </div>

            {isExpanded && children ? (
                <div id={contentId} className="relative ml-2 pl-3 pt-0.5">
                    <span
                        aria-hidden="true"
                        className="pointer-events-none absolute bottom-0 left-0 top-0 w-px opacity-40"
                        style={{ backgroundColor: 'var(--tools-border)' }}
                    />
                    {children}
                </div>
            ) : null}
        </div>
    );
};
