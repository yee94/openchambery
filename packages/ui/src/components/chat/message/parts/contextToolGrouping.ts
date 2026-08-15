import { isContextGroupTool, normalizeContextToolName } from './toolRenderUtils';

export type ContextToolCountKey = 'read' | 'search' | 'list';

export type ContextToolCounts = Record<ContextToolCountKey, number>;

export const CONTEXT_TOOL_COUNT_ORDER: readonly ContextToolCountKey[] = ['search', 'read', 'list'];

export function contextToolCountKey(toolName: unknown): ContextToolCountKey | null {
    const name = normalizeContextToolName(toolName);
    if (name === 'read') return 'read';
    if (name === 'glob' || name === 'grep') return 'search';
    if (name === 'list') return 'list';
    return null;
}

export function summarizeContextTools(toolNames: readonly unknown[]): ContextToolCounts {
    const counts: ContextToolCounts = { read: 0, search: 0, list: 0 };
    for (const toolName of toolNames) {
        const key = contextToolCountKey(toolName);
        if (key) counts[key] += 1;
    }
    return counts;
}

export function isContextToolActive(status: unknown): boolean {
    return status === 'pending' || status === 'running' || status === 'started';
}

/** 思考轨迹仍算探索过程；正文 / 非 context 工具才结束「探索中」。 */
export function isContextExploreSuccessorPart(input: {
    kind?: unknown;
    type?: unknown;
    toolName?: unknown;
}): boolean {
    if (input.kind === 'reasoning' || input.type === 'reasoning') {
        return false;
    }
    if (input.kind === 'justification' || input.type === 'text') {
        return true;
    }
    if (input.kind === 'tool' || input.type === 'tool') {
        return !isContextGroupTool(input.toolName);
    }
    return input.kind != null || input.type != null;
}

export function hasContextExploreSuccessor<T>(
    items: readonly T[],
    start: number,
    read: (item: T) => { kind?: unknown; type?: unknown; toolName?: unknown },
): boolean {
    for (let index = start; index < items.length; index += 1) {
        if (isContextExploreSuccessorPart(read(items[index]))) {
            return true;
        }
    }
    return false;
}

/**
 * 组内仍有 running，或本轮还在进行且后面还没出现其他类型内容，都保持探索中。
 * 只看 tool status 会在批次空档误判成「探索」。
 */
export function isContextGroupExploring(input: {
    statuses: readonly unknown[];
    hasFollowingOtherType: boolean;
    isTurnLive: boolean;
}): boolean {
    if (input.statuses.some((status) => isContextToolActive(status))) {
        return true;
    }
    if (input.hasFollowingOtherType) {
        return false;
    }
    return input.isTurnLive;
}

export function collectConsecutiveContextTools<T>(
    items: readonly T[],
    start: number,
    getToolName: (item: T) => unknown,
): { items: T[]; end: number } {
    const grouped: T[] = [];
    let index = start;
    while (index < items.length && isContextGroupTool(getToolName(items[index]))) {
        grouped.push(items[index]);
        index += 1;
    }
    return { items: grouped, end: index };
}
