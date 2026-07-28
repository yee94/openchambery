import type { CSSProperties } from 'react';

export const statusBarPopoverShadowClassName =
    'shadow-[inset_0_1px_0_0_rgba(255,255,255,0.8),inset_0_0_0_1px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.10),0_1px_2px_-0.5px_rgba(0,0,0,0.08),0_4px_8px_-2px_rgba(0,0,0,0.08),0_12px_20px_-4px_rgba(0,0,0,0.08)] dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_0_0_1px_rgba(255,255,255,0.08),0_0_0_1px_rgba(0,0,0,0.36),0_1px_1px_-0.5px_rgba(0,0,0,0.22),0_3px_3px_-1.5px_rgba(0,0,0,0.20),0_6px_6px_-3px_rgba(0,0,0,0.16)]';

export const statusBarPopoverClassName =
    `w-[min(30rem,calc(100cqw-1rem))] min-w-[280px] max-w-full overflow-hidden rounded-xl ${statusBarPopoverShadowClassName}`;

export const statusBarPopoverStyle: CSSProperties = {
    maxWidth: 'min(28rem, calc(100cqw - 4ch))',
    backgroundColor: 'var(--surface-elevated)',
    color: 'var(--surface-elevated-foreground)',
};

export const statusBarPopoverHeaderClassName =
    'flex items-center justify-between gap-3 border-b border-[var(--surface-subtle)] px-3 py-2.5';

export const statusBarPopoverHeaderTitleClassName =
    'text-xs font-medium leading-4 text-foreground md:text-[0.8125rem] md:leading-5';

export const statusBarPopoverHeaderMetaClassName =
    'text-xs tabular-nums leading-4 text-muted-foreground md:text-[0.8125rem] md:leading-5';

export const todoListClassName =
    'm-0 list-none divide-y divide-[var(--surface-subtle)] p-0';

export const statusBarPopoverListClassName =
    `${todoListClassName} max-h-[min(22rem,50vh)] overflow-y-auto`;

export const todoToolListClassName = `${todoListClassName} w-full`;

/** Todo 工具滚动卡片配置：直角边框且无内边距 */
export const todoToolScrollOptions = {
    className: 'p-0 rounded-none',
    maxHeightClass: 'max-h-[46vh]',
    disableHorizontal: true,
} as const;

export const statusBarPopoverRowClassName =
    'px-2.5 py-1.5 text-xs leading-4 md:py-2 md:text-[0.8125rem] md:leading-5';

export const statusBarTriggerClassName =
    'flex min-w-0 items-center gap-1 text-xs leading-4 text-muted-foreground md:gap-1.5 md:text-[0.8125rem] md:leading-5';

export const statusBarTriggerLabelClassName =
    'min-w-0 truncate text-xs leading-4 text-foreground md:text-[0.8125rem] md:leading-5';

export const statusBarTriggerMetaClassName =
    'inline-flex shrink-0 items-center gap-1 text-xs leading-4 tabular-nums text-muted-foreground md:text-[0.8125rem] md:leading-5';

export const statusBarTriggerIconClassName =
    'h-3 w-3 shrink-0 md:h-3.5 md:w-3.5';
