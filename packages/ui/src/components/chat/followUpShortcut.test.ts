import { describe, expect, test } from 'vitest';
import { resolveFollowUpEnterAction } from './followUpShortcut';

const runningPrimary = {
    canQueue: true,
    queueUsable: true,
    primary: true,
    sessionIsRunning: true,
    autoReviewRunning: false,
};

describe('resolveFollowUpEnterAction', () => {
    test('cmd+enter during a running primary turn queues then steers', () => {
        expect(resolveFollowUpEnterAction({
            ...runningPrimary,
            followUpBehavior: 'queue',
            ctrlEnter: true,
        })).toEqual({ kind: 'submit', steerAfterAdmit: true });
        expect(resolveFollowUpEnterAction({
            ...runningPrimary,
            followUpBehavior: 'steer',
            ctrlEnter: true,
        })).toEqual({ kind: 'submit', steerAfterAdmit: true });
    });

    test('enter keeps the selected follow-up while the turn is running', () => {
        expect(resolveFollowUpEnterAction({
            ...runningPrimary,
            followUpBehavior: 'queue',
            ctrlEnter: false,
        })).toEqual({ kind: 'submit', delivery: 'queue' });
        expect(resolveFollowUpEnterAction({
            ...runningPrimary,
            followUpBehavior: 'steer',
            ctrlEnter: false,
        })).toEqual({ kind: 'submit', delivery: 'steer' });
    });

    test('idle and auto-review cmd+enter stay a direct submit', () => {
        expect(resolveFollowUpEnterAction({
            ...runningPrimary,
            followUpBehavior: 'queue',
            ctrlEnter: true,
            canQueue: false,
            sessionIsRunning: false,
        })).toEqual({ kind: 'submit' });
        expect(resolveFollowUpEnterAction({
            ...runningPrimary,
            followUpBehavior: 'queue',
            ctrlEnter: true,
            autoReviewRunning: true,
        })).toEqual({ kind: 'submit' });
    });

    test('secondary queue follow-up still uses the queue event when the queue is usable', () => {
        expect(resolveFollowUpEnterAction({
            ...runningPrimary,
            followUpBehavior: 'queue',
            ctrlEnter: false,
            primary: false,
        })).toEqual({ kind: 'queue' });
        expect(resolveFollowUpEnterAction({
            ...runningPrimary,
            followUpBehavior: 'queue',
            ctrlEnter: false,
            primary: false,
            queueUsable: false,
        })).toEqual({ kind: 'submit', delivery: 'steer' });
    });
});
