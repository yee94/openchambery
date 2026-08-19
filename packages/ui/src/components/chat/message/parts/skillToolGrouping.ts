import { isSkillGroupTool } from './toolRenderUtils';

export const SKILL_GROUP_VISIBLE_LIMIT = 3;

export function collectConsecutiveSkillTools<T>(
    items: readonly T[],
    start: number,
    getToolName: (item: T) => unknown,
): { items: T[]; end: number } {
    const grouped: T[] = [];
    let index = start;
    while (index < items.length && isSkillGroupTool(getToolName(items[index]))) {
        grouped.push(items[index]);
        index += 1;
    }
    return { items: grouped, end: index };
}

const readTrimmedString = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};

export function getSkillNameFromToolPart(part: unknown): string | null {
    if (!part || typeof part !== 'object') return null;
    const state = (part as { state?: unknown }).state;
    if (!state || typeof state !== 'object') return null;
    const record = state as { input?: unknown; metadata?: unknown; output?: unknown };

    if (record.metadata && typeof record.metadata === 'object') {
        const fromMetadata = readTrimmedString((record.metadata as { name?: unknown }).name);
        if (fromMetadata) return fromMetadata;
    }

    if (record.input && typeof record.input === 'object') {
        const input = record.input as { name?: unknown; id?: unknown };
        const fromName = readTrimmedString(input.name);
        if (fromName) return fromName;
        const fromId = readTrimmedString(input.id);
        if (fromId) return fromId;
    }

    if (record.output && typeof record.output === 'object') {
        const fromOutput = readTrimmedString((record.output as { name?: unknown }).name);
        if (fromOutput) return fromOutput;
    }

    return null;
}

export function summarizeSkillNames(names: readonly (string | null | undefined)[]): {
    visibleNames: string[];
    hiddenCount: number;
    joinedVisible: string;
} {
    const cleaned: string[] = [];
    for (const name of names) {
        if (typeof name !== 'string') continue;
        const trimmed = name.trim();
        if (trimmed) cleaned.push(trimmed);
    }
    const visibleNames = cleaned.slice(0, SKILL_GROUP_VISIBLE_LIMIT);
    return {
        visibleNames,
        hiddenCount: Math.max(0, cleaned.length - visibleNames.length),
        joinedVisible: visibleNames.join(', '),
    };
}
