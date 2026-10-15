import type { ToolPart } from '@/lib/opencode/v2-types';
import type { TranscriptData } from '@/sync/transcript-repository';
import { collectBackgroundCompletions, hasSettledBackgroundRunningHint, readBackgroundWorkIdentity, resolveBackgroundToolActivity } from './message/parts/sessionBackgroundModel';

export type BackgroundTask = {
    id: string;
    type: 'subagent' | 'shell';
    label: string;
    agent?: string;
    part: ToolPart;
};

export function projectBackgroundTasks(data: TranscriptData): readonly BackgroundTask[] {
    const messages = data.messageOrder.map((id) => ({
        parts: data.partsByMessageID[id] ?? [],
        metadata: data.messagesByID?.[id]?.metadata,
    }));
    const completions = collectBackgroundCompletions(messages);
    const tasks = new Map<string, BackgroundTask>();
    for (const message of messages) {
        for (const part of message.parts) {
            if (part.type !== 'tool' || !hasSettledBackgroundRunningHint(part)) continue;
            const identity = readBackgroundWorkIdentity(part);
            if (!identity?.id) continue;
            if (identity.type === 'shell' && resolveBackgroundToolActivity({ part, completions }).kind !== 'background-running') continue;
            tasks.set(`${identity.type}:${identity.id}`, { ...identity, id: identity.id, label: identity.label ?? identity.id, part });
        }
    }
    return [...tasks.values()];
}

export const sameBackgroundTasks = (left: readonly BackgroundTask[], right: readonly BackgroundTask[]) =>
    left.length === right.length && left.every((task, index) => {
        const other = right[index];
        return task.id === other.id && task.type === other.type && task.label === other.label
            && task.agent === other.agent && task.part === other.part;
    });
