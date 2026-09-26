import type { FollowUpBehavior } from '@/stores/messageQueueStore';

export type FollowUpEnterAction =
    | { kind: 'submit'; delivery?: 'steer' | 'queue'; steerAfterAdmit?: boolean }
    | { kind: 'queue' };

/**
 * Enter / Send / Ctrl+Enter while the composer can address a session.
 * Plain Enter and the Send button use `ctrlEnter: false` and follow
 * `followUpBehavior` (default queue). Ctrl/Cmd+Enter during a running primary
 * turn admits through the queue and then steers that item, so the message
 * shows steering feedback until authoritative consumption removes the chip.
 */
export const resolveFollowUpEnterAction = (input: {
    followUpBehavior: FollowUpBehavior;
    ctrlEnter: boolean;
    canQueue: boolean;
    queueUsable: boolean;
    primary: boolean;
    sessionIsRunning: boolean;
    autoReviewRunning: boolean;
}): FollowUpEnterAction => {
    const steerIntoQueue = input.ctrlEnter
        && input.canQueue
        && input.primary
        && input.sessionIsRunning
        && !input.autoReviewRunning;
    if (input.followUpBehavior === 'queue') {
        if (steerIntoQueue) return { kind: 'submit', steerAfterAdmit: true };
        if (input.ctrlEnter || !input.canQueue) return { kind: 'submit' };
        if (input.primary) return { kind: 'submit', delivery: 'queue' };
        if (input.queueUsable) return { kind: 'queue' };
        return { kind: 'submit', delivery: 'steer' };
    }
    if (steerIntoQueue) return { kind: 'submit', steerAfterAdmit: true };
    if (input.ctrlEnter || !input.canQueue) return { kind: 'submit' };
    return { kind: 'submit', delivery: 'steer' };
};
