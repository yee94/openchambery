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
 * Exception: when the last assistant is authoritatively settled
 * (`hasConfirmedSettledAssistant`, typically `turn.hasConfirmedFinalBody` —
 * confirmed terminal stop + model text, no error), prefer that over a lagging
 * `sessionIsWorking`. Live SSE settle reaches the message before pending-user /
 * status-observedAt gates flip working off; without this override TPS and
 * duration stay hidden until a later HTTP reconcile (often 7s–90s).
 *
 * Deliberately ignores `resolveTurnActivityPresentation`'s output: that demotes
 * `active` to `abnormal` on idle for header chrome, which would read as settled.
 * Never overrides `completionDisposition === 'active'` (step-gap flicker guard).
 */
export const resolveTurnSettledForPresentation = (input: {
  completionDisposition: TurnRecord['completionDisposition'] | undefined;
  isLastTurn: boolean;
  sessionIsWorking: boolean;
  /**
   * Authoritative last-assistant settle (prefer `turn.hasConfirmedFinalBody`).
   * When true, a lagging sessionIsWorking no longer suppresses completion chrome.
   */
  hasConfirmedSettledAssistant?: boolean;
}): boolean => {
  if (input.completionDisposition === 'active') {
    return false;
  }
  if (input.isLastTurn && input.sessionIsWorking && !input.hasConfirmedSettledAssistant) {
    return false;
  }
  return true;
};

/**
 * Last-assistant bottom padding: live work uses `pb-1` so StatusRow sits
 * under the last tool; idle Processed rows keep the between-turns `pb-8`.
 * `isInActiveTurn` stays true
 * after an abnormal settle whenever `time.completed` never lands (the
 * incomplete-assistant fallback in MessageList), so it cannot own the
 * tighten by itself once header chrome has already demoted to Processed.
 */
export const shouldTightenWorkingBottomGap = (input: {
  isWorking: boolean;
  isInActiveTurn: boolean;
  headerCompletionDisposition?: TurnRecord['completionDisposition'];
}): boolean => {
  if (input.isWorking) {
    return true;
  }
  if (!input.isInActiveTurn) {
    return false;
  }
  return input.headerCompletionDisposition !== 'normal'
    && input.headerCompletionDisposition !== 'abnormal';
};

/**
 * Disposition that drives Activity *expansion* (not header Working chrome).
 *
 * A turn still running its own loop (`turnCompletionDisposition === 'active'`)
 * stays `active` for expansion regardless of turn position: a queued/steered
 * user message makes the running turn non-last while its tools are still
 * executing (the queue gap before the next run's first assistant can be
 * minutes), and folding then hid the in-progress steps inside a collapsed
 * disclosure — "the newest reasoning steps disappeared". An active turn
 * without assistant messages (an empty queue placeholder) does not expand on
 * its own; only the last-turn exemption keeps empty placeholders open.
 *
 * Otherwise expansion follows the header presentation demotion.
 *
 * Regression: Trace-20260804T171706 — tool rows flashed when expansion followed
 * header demotion across busy/idle status flaps mid-turn.
 */
export const resolveActivityExpansionDisposition = (input: {
    isLastTurn: boolean;
    turnCompletionDisposition: TurnRecord['completionDisposition'];
    headerPresentationDisposition: TurnRecord['completionDisposition'];
    hasAssistantMessages: boolean;
}): TurnRecord['completionDisposition'] => {
    if (
        input.turnCompletionDisposition === 'active'
        && (input.isLastTurn || input.hasAssistantMessages)
    ) {
        return 'active';
    }
    return input.headerPresentationDisposition;
};
