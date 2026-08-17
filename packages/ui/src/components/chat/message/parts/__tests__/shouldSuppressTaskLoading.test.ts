import { describe, expect, test } from 'bun:test';
import type { SessionStatus } from '@/lib/opencode/v2-types';
import { shouldSuppressTaskLoading } from '../shouldSuppressTaskLoading';

const IDLE = { type: 'idle' } as SessionStatus;
const BUSY = { type: 'busy' } as SessionStatus;

const baseState = {
    isTaskTool: true,
    isFinalized: false,
    taskSessionId: undefined,
    childSessionStatus: undefined,
    parentSessionStatus: undefined,
    statusObservedAt: undefined,
    taskStartedAt: undefined,
    statusSnapshotAt: undefined,
};

describe('shouldSuppressTaskLoading', () => {
    test('keeps a non-task tool unchanged', () => {
        expect(shouldSuppressTaskLoading({ ...baseState, isTaskTool: false, parentSessionStatus: IDLE })).toBe(false);
    });

    test('keeps a finalized task unchanged', () => {
        expect(shouldSuppressTaskLoading({ ...baseState, isFinalized: true, parentSessionStatus: IDLE })).toBe(false);
    });

    test('suppresses loading when the resolved child session is idle', () => {
        expect(shouldSuppressTaskLoading({
            ...baseState,
            taskSessionId: 'child-session',
            childSessionStatus: IDLE,
            parentSessionStatus: BUSY,
            statusObservedAt: 200,
            taskStartedAt: 100,
        })).toBe(true);
    });

    test('keeps loading while the resolved child session is busy', () => {
        expect(shouldSuppressTaskLoading({
            ...baseState,
            taskSessionId: 'child-session',
            childSessionStatus: BUSY,
            parentSessionStatus: IDLE,
        })).toBe(false);
    });

    test('suppresses loading from parent idle while the child id is unresolved', () => {
        expect(shouldSuppressTaskLoading({
            ...baseState,
            parentSessionStatus: IDLE,
            statusObservedAt: 200,
            taskStartedAt: 100,
        })).toBe(true);
    });

    test('keeps loading while status remains unresolved', () => {
        expect(shouldSuppressTaskLoading(baseState)).toBe(false);
    });

    test('suppresses stale loading when a successful snapshot covers the task start', () => {
        expect(shouldSuppressTaskLoading({
            ...baseState,
            taskSessionId: 'child-session',
            taskStartedAt: 100,
            statusSnapshotAt: 200,
        })).toBe(true);
    });

    test('keeps a task started after the snapshot active while live status is pending', () => {
        expect(shouldSuppressTaskLoading({
            ...baseState,
            taskSessionId: 'child-session',
            taskStartedAt: 300,
            statusSnapshotAt: 200,
        })).toBe(false);
    });

    test('keeps a task started after an older idle observation active', () => {
        expect(shouldSuppressTaskLoading({
            ...baseState,
            taskSessionId: 'child-session',
            childSessionStatus: IDLE,
            statusObservedAt: 200,
            taskStartedAt: 300,
            statusSnapshotAt: 100,
        })).toBe(false);
    });
});
