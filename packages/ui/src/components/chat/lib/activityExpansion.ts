import type { TurnRecord } from './turns/types';

/**
 * Default activity expansion when the user has not toggled this turn.
 * Live processing (`active`) always starts expanded so the latest in-progress
 * turn is watchable regardless of the activity setting. Settled turns follow
 * the configured render mode.
 */
export const resolveDefaultActivityExpanded = (
  completionDisposition: TurnRecord['completionDisposition'] | undefined,
  activityRenderMode: 'collapsed' | 'summary',
): boolean => {
  if (completionDisposition === 'active') {
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
