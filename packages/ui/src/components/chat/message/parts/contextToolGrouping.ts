import { isContextGroupTool, isToolPartActive, normalizeContextToolName } from './toolRenderUtils';

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

export function isContextToolActive(part: unknown): boolean {
    return isToolPartActive(part);
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

export function isContextGroupExploring(parts: readonly unknown[]): boolean {
    return parts.some((part) => isContextToolActive(part));
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
