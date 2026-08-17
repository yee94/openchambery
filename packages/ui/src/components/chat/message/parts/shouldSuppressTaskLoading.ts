import type { SessionStatus } from '@/lib/opencode/v2-types';

type TaskLoadingState = {
    isTaskTool: boolean;
    isFinalized: boolean;
    taskSessionId: string | undefined;
    childSessionStatus: SessionStatus | undefined;
    parentSessionStatus: SessionStatus | undefined;
    statusObservedAt: number | undefined;
    taskStartedAt: number | undefined;
    statusSnapshotAt: number | undefined;
};

export function shouldSuppressTaskLoading(state: TaskLoadingState): boolean {
    if (!state.isTaskTool || state.isFinalized) return false;
    const liveStatus = state.taskSessionId ? state.childSessionStatus : state.parentSessionStatus;
    if (liveStatus) {
        if (liveStatus.type !== 'idle') return false;
        if (
            typeof state.taskStartedAt === 'number'
            && typeof state.statusObservedAt === 'number'
            && state.taskStartedAt <= state.statusObservedAt
        ) {
            return true;
        }
    }
    return typeof state.taskStartedAt === 'number'
        && typeof state.statusSnapshotAt === 'number'
        && state.taskStartedAt <= state.statusSnapshotAt;
}
