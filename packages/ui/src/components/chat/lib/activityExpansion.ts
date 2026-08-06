import type { TurnRecord } from './turns/types';

/**
 * Default activity expansion when the user has not toggled this turn.
 * Live processing (`active`) always starts expanded so the latest in-progress
 * turn is watchable regardless of the activity setting. Settled turns follow
 * the configured render mode.
 *
 * The last turn is exempt from auto-collapse only while its final body is
 * unconfirmed. A multi-step turn reads settled for the gap between one step's
 * `finish` and the next assistant message, and collapsing in that gap unmounted
 * the nested tool rows and re-expanded them a frame later. Position plus
 * `hasConfirmedFinalBody` (confirmed terminal stop with zero continuation
 * tools, no error, plus a model-produced text — the runLoop exit rule) are
 * deterministic inputs, unlike session status, which flaps busy/idle between
 * tool steps: the turn you are watching stays open until the final answer is
 * confirmed, after which an untouched turn follows the render mode like any
 * settled turn.
 */
export const resolveDefaultActivityExpanded = (
  completionDisposition: TurnRecord['completionDisposition'] | undefined,
  activityRenderMode: 'collapsed' | 'summary',
  options?: {
    /** Newest turn in the transcript, settled or not. */
    isLastTurn?: boolean;
    /**
     * Turn-level confirmed final body (terminal stop with zero continuation
     * tools, no error, plus a model-produced text). When the option is omitted
     * the caller is not turn-aware; keep the historical last-turn exemption.
     */
    hasConfirmedFinalBody?: boolean;
  },
): boolean => {
  if (completionDisposition === 'active') {
    return true;
  }
  if (options?.isLastTurn && options.hasConfirmedFinalBody !== true) {
    return true;
  }
  return activityRenderMode === 'summary';
};

export const resolveToggledActivityExpanded = (currentExpanded: boolean): boolean => !currentExpanded;

/**
 * Header chrome disposition (Working vs Processed).
 * Demotes turn-level `active` to `abnormal` when the last turn is not live-working
 * so duration tickers stop on idle/historical rows.
 */
export const resolveTurnActivityPresentation = (input: {
  completionDisposition: TurnRecord['completionDisposition'];
  isLastTurn: boolean;
  sessionIsWorking: boolean;
  durationMs?: number;
}): {
  completionDisposition: TurnRecord['completionDisposition'];
  durationMs?: number;
} => {
  if (input.completionDisposition !== 'active') {
    return {
      completionDisposition: input.completionDisposition,
      durationMs: input.durationMs,
    };
  }
  if (input.isLastTurn && input.sessionIsWorking) {
    return {
      completionDisposition: 'active',
      durationMs: input.durationMs,
    };
  }
  return {
    completionDisposition: 'abnormal',
    durationMs: input.durationMs,
  };
};

/**
 * Whether turn-completion chrome may render: footer, turn duration, TPS, and the
 * changed-files preview.
 *
 * Two independent authorities must agree, because each is wrong on its own. The
 * turn projection settles as soon as its last assistant carries a terminal
 * signal, and a multi-step agent stamps `finish`/`time.completed` per step — so
 * during the gap before the next assistant arrives the projection reports a
 * finished turn while the loop is still running. Session status knows the loop is
 * still running, but flaps busy/idle between steps, so it cannot decide alone
 * either. Requiring both means the footer only appears when neither authority
 * claims work is in flight.
 *
 * Deliberately ignores `resolveTurnActivityPresentation`'s output: that demotes
 * `active` to `abnormal` on idle for header chrome, which would read as settled.
 */
export const resolveTurnSettledForPresentation = (input: {
  completionDisposition: TurnRecord['completionDisposition'] | undefined;
  isLastTurn: boolean;
  sessionIsWorking: boolean;
}): boolean => {
  if (input.completionDisposition === 'active') {
    return false;
  }
  return !(input.isLastTurn && input.sessionIsWorking);
};

/**
 * Disposition that drives Activity *expansion* (not header Working chrome).
 *
 * The last open turn stays `active` for expansion even when header presentation
 * demotes to `abnormal` because `sessionIsWorking` flapped idle between tools.
 * Collapse only after the turn itself settles (`normal` / `abnormal` on the
 * turn record).
 *
 * Regression: Trace-20260804T171706 — tool rows flashed when expansion followed
 * header demotion across busy/idle status flaps mid-turn.
 */
export const resolveActivityExpansionDisposition = (input: {
  isLastTurn: boolean;
  turnCompletionDisposition: TurnRecord['completionDisposition'];
  headerPresentationDisposition: TurnRecord['completionDisposition'];
}): TurnRecord['completionDisposition'] => {
  if (input.isLastTurn && input.turnCompletionDisposition === 'active') {
    return 'active';
  }
  return input.headerPresentationDisposition;
};
