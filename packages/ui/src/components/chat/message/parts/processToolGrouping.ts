import {
    CONTEXT_TOOL_COUNT_ORDER,
    summarizeContextTools,
    type ContextToolCountKey,
    type ContextToolCounts,
} from './contextToolGrouping';
import { isProcessGroupTool, isToolPartActive } from './toolRenderUtils';
import {
    USED_TOOL_COUNT_ORDER,
    summarizeUsedToolDiffs,
    summarizeUsedTools,
    type UsedToolCountKey,
    type UsedToolCounts,
} from './usedToolGrouping';

export type ProcessToolCountKey = ContextToolCountKey | UsedToolCountKey;

export type ProcessToolCounts = ContextToolCounts & UsedToolCounts;

export const PROCESS_TOOL_COUNT_ORDER: readonly ProcessToolCountKey[] = [
    ...CONTEXT_TOOL_COUNT_ORDER,
    ...USED_TOOL_COUNT_ORDER,
];

export function summarizeProcessTools(toolNames: readonly unknown[]): ProcessToolCounts {
    return {
        ...summarizeContextTools(toolNames),
        ...summarizeUsedTools(toolNames),
    };
}

export { summarizeUsedToolDiffs };

export function isProcessToolActive(part: unknown): boolean {
    return isToolPartActive(part);
}

/**
 * Reasoning stays inside a live process run.
 * Body text / skill / task / question settle it. Explore and used tools do not.
 */
export function isProcessSuccessorPart(input: {
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
        return !isProcessGroupTool(input.toolName);
    }
    return input.kind != null || input.type != null;
}

export function hasProcessSuccessor<T>(
    items: readonly T[],
    start: number,
    read: (item: T) => { kind?: unknown; type?: unknown; toolName?: unknown },
): boolean {
    for (let index = start; index < items.length; index += 1) {
        if (isProcessSuccessorPart(read(items[index]))) {
            return true;
        }
    }
    return false;
}

/**
 * Stay running while a grouped call is active, or while the turn
 * is still live and no later body text / special tool has appeared.
 */
export function isProcessGroupActive(
    partsOrInput:
        | readonly unknown[]
        | {
            parts: readonly unknown[];
            hasFollowingOtherType: boolean;
            isTurnLive: boolean;
        },
): boolean {
    if (!('parts' in partsOrInput)) {
        return partsOrInput.some((part) => isProcessToolActive(part));
    }
    if (partsOrInput.parts.some((part) => isProcessToolActive(part))) {
        return true;
    }
    if (partsOrInput.hasFollowingOtherType) {
        return false;
    }
    return partsOrInput.isTurnLive;
}

export function collectConsecutiveProcessTools<T>(
    items: readonly T[],
    start: number,
    getToolName: (item: T) => unknown,
): { items: T[]; end: number } {
    const grouped: T[] = [];
    let index = start;
    while (index < items.length && isProcessGroupTool(getToolName(items[index]))) {
        grouped.push(items[index]);
        index += 1;
    }
    return { items: grouped, end: index };
};
