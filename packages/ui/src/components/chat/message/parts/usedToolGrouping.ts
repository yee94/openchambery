import { aggregateToolPartLineDiffTotals, type LineDiffTotals } from './toolDiffUtils';
import { isToolPartActive, isUsedGroupTool, normalizeContextToolName } from './toolRenderUtils';

export type UsedToolCountKey = 'edit' | 'command' | 'other';

export type UsedToolCounts = Record<UsedToolCountKey, number>;

export const USED_TOOL_COUNT_ORDER: readonly UsedToolCountKey[] = ['edit', 'command', 'other'];

const EDIT_TOOL_NAMES = new Set<string>([
    'edit',
    'multiedit',
    'write',
    'create',
    'file_write',
    'apply_patch',
    'patch',
]);

const COMMAND_TOOL_NAMES = new Set<string>([
    'bash',
    'shell',
    'cmd',
    'command',
    'exec',
    'terminal',
]);

export function usedToolCountKey(toolName: unknown): UsedToolCountKey | null {
    if (!isUsedGroupTool(toolName)) return null;
    const name = normalizeContextToolName(toolName);
    if (EDIT_TOOL_NAMES.has(name)) return 'edit';
    if (COMMAND_TOOL_NAMES.has(name)) return 'command';
    return 'other';
}

export function summarizeUsedTools(toolNames: readonly unknown[]): UsedToolCounts {
    const counts: UsedToolCounts = { edit: 0, command: 0, other: 0 };
    for (const toolName of toolNames) {
        const key = usedToolCountKey(toolName);
        if (key) counts[key] += 1;
    }
    return counts;
}

export function summarizeUsedToolDiffs(parts: readonly unknown[]): LineDiffTotals {
    return aggregateToolPartLineDiffTotals(parts);
}

export function isUsedToolActive(part: unknown): boolean {
    return isToolPartActive(part);
}

/** Reasoning stays inside a live Used run. Text / explore / skill / task / question settle it. */
export function isUsedRunSuccessorPart(input: {
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
        return !isUsedGroupTool(input.toolName);
    }
    return input.kind != null || input.type != null;
}

export function hasUsedRunSuccessor<T>(
    items: readonly T[],
    start: number,
    read: (item: T) => { kind?: unknown; type?: unknown; toolName?: unknown },
): boolean {
    for (let index = start; index < items.length; index += 1) {
        if (isUsedRunSuccessorPart(read(items[index]))) {
            return true;
        }
    }
    return false;
}

/**
 * Stay 「运行中」 while a grouped call is active, or while the turn is still
 * live and no later non-used part has appeared. Reasoning between used calls
 * does not settle the group.
 */
export function isUsedGroupRunning(
    partsOrInput:
        | readonly unknown[]
        | {
            parts: readonly unknown[];
            hasFollowingOtherType: boolean;
            isTurnLive: boolean;
        },
): boolean {
    if (!('parts' in partsOrInput)) {
        return partsOrInput.some((part) => isUsedToolActive(part));
    }
    if (partsOrInput.parts.some((part) => isUsedToolActive(part))) {
        return true;
    }
    if (partsOrInput.hasFollowingOtherType) {
        return false;
    }
    return partsOrInput.isTurnLive;
}

export function collectConsecutiveUsedTools<T>(
    items: readonly T[],
    start: number,
    getToolName: (item: T) => unknown,
): { items: T[]; end: number } {
    const grouped: T[] = [];
    let index = start;
    while (index < items.length && isUsedGroupTool(getToolName(items[index]))) {
        grouped.push(items[index]);
        index += 1;
    }
    return { items: grouped, end: index };
}
