export const TOOL_EXPANDED_TIMELINE_CLASS_NAME = 'relative ml-2 pl-3';

/** Todo 工具展开容器样式：无论 PC 或移动端均使用紧凑外层间距 */
export const getToolExpandedContentClassName = (
    isMobile: boolean,
    variant: 'default' | 'todo' | 'todo-error' = 'default',
    compactGap = false,
): string => {
    if (variant === 'todo') {
        return 'relative flex min-w-0 flex-col gap-1 py-0.5';
    }

    if (isMobile) {
        return `relative flex min-w-0 flex-col ${compactGap ? 'gap-1' : 'gap-2'} py-2`;
    }

    return 'relative flex flex-col gap-2 pr-2 pb-2 pt-2 pl-4';
};

export const getToolScrollableSectionPaddingClassName = (isMobile: boolean): string =>
    isMobile ? 'p-0' : 'p-2';

export const MOBILE_SHELL_CODE_LINE_HEIGHT = '1.25rem';
