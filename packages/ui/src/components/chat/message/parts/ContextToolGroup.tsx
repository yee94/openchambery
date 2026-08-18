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
    CONTEXT_TOOL_COUNT_ORDER,
    isContextGroupExploring,
    summarizeContextTools,
} from './contextToolGrouping';
import { getToolRowBlockClass, TOOL_ROW_INTERACTIVE_CHROME_CLASS } from './toolRowChrome';

const TOOL_ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';

export const ContextToolGroup: React.FC<{
    activities: TurnActivityPart[];
    isMobile: boolean;
    /** 本轮仍在进行时，后面没出现其他类型内容也保持探索中。 */
    isTurnLive?: boolean;
    /** 本组之后是否已出现正文 / 非 context 工具。 */
    hasFollowingOtherType?: boolean;
    /**
     * 可选：由完整 parts 时间线计算的明确 exploring 状态。
     * 传入时优先使用；未传入时按 isTurnLive + hasFollowingOtherType 计算。
     */
    exploring?: boolean;
    children?: React.ReactNode;
}> = ({ activities, isMobile, isTurnLive = false, hasFollowingOtherType = false, exploring, children }) => {
    const { t } = useI18n();
    const [isExpanded, setIsExpanded] = React.useState(false);
    const contentId = React.useId();
    const toolParts = activities.map((activity) => activity.part as ToolPartType);
    const isActive = exploring ?? isContextGroupExploring({
        parts: toolParts,
        hasFollowingOtherType,
        isTurnLive,
    });
    const counts = summarizeContextTools(toolParts.map((part) => part.tool));
    const summary = CONTEXT_TOOL_COUNT_ORDER
        .filter((key) => counts[key] > 0)
        .map((key) => {
            const count = counts[key];
            if (key === 'search') {
                return t(count === 1 ? 'chat.contextGroup.searchSingle' : 'chat.contextGroup.searchPlural', { count });
            }
            if (key === 'read') {
                return t(count === 1 ? 'chat.contextGroup.readSingle' : 'chat.contextGroup.readPlural', { count });
            }
            return t(count === 1 ? 'chat.contextGroup.listSingle' : 'chat.contextGroup.listPlural', { count });
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
        ? t('chat.contextGroup.collapseAria')
        : t('chat.contextGroup.expandAria');
    const title = isActive
        ? t('chat.contextGroup.exploring')
        : t('chat.contextGroup.explored');

    return (
        <div data-component="context-tool-group" className={getToolRowBlockClass(isMobile)}>
            <div
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                aria-controls={contentId}
                aria-label={ariaLabel}
                data-mobile-press-feedback="soft"
                className={cn('flex w-full min-h-0 min-w-0 items-center gap-1.5 overflow-clip', TOOL_ROW_INTERACTIVE_CHROME_CLASS)}
                onClick={handleToggle}
                onKeyDown={handleKeyDown}
            >
                <span
                    className={cn('flex flex-none items-center justify-center', isMobile ? 'size-4' : 'size-3.5')}
                    style={{ color: 'var(--tools-icon)' }}
                >
                    {isActive ? (
                        <LatticeOrb isMobile={isMobile} label={t('chat.contextGroup.exploring')} />
                    ) : (
                        <Icon name="search" className="h-[13px] w-[13px]" />
                    )}
                </span>
                <span
                    className={cn(
                        'typography-meta flex-none font-medium',
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
                        className={cn('typography-meta h-5 min-h-0 w-0 min-w-0 max-w-full flex-1 overflow-clip sm:h-6', TOOL_ROW_TEXT_CLASS)}
                        style={{ color: 'var(--tools-description)' }}
                    >
                        <FlipUpText text={summary} active={isActive} />
                    </span>
                ) : null}
                <Icon
                    name={isExpanded ? 'arrow-down-s' : 'arrow-right-s'}
                    className="ml-auto size-3.5 flex-none text-muted-foreground opacity-70"
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
