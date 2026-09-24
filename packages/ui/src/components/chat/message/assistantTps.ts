/** One OpenCode assistant step's authoritative timing and generated-token usage. */
export type AssistantTpsInput = {
  createdAt?: number | null;
  streamedAt?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
};

const toNonNegativeFinite = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
};

/**
 * Match OpenCode TUI's average turn throughput: aggregate output + reasoning
 * tokens across assistant steps, divided by summed provider-response intervals
 * (`time.streamed - time.created`). A turn is unmeasurable if any step lacks
 * that upstream interval.
 */
export const computeAssistantTpsByStep = (steps: readonly AssistantTpsInput[]): Array<number | null> => {
  let generatedTokens = 0;
  let providerDurationMs = 0;
  let hasCompleteTiming = true;

  return steps.map((step) => {
    if (
      typeof step.createdAt === 'number'
      && Number.isFinite(step.createdAt)
      && typeof step.streamedAt === 'number'
      && Number.isFinite(step.streamedAt)
    ) {
      providerDurationMs += Math.max(0, step.streamedAt - step.createdAt);
    } else {
      hasCompleteTiming = false;
    }

    generatedTokens += toNonNegativeFinite(step.outputTokens) + toNonNegativeFinite(step.reasoningTokens);

    if (!hasCompleteTiming || generatedTokens <= 0 || providerDurationMs <= 0) return null;

    const tps = generatedTokens / (providerDurationMs / 1000);
    return Number.isFinite(tps) && tps > 0 ? tps : null;
  });
};

/** Return the turn's aggregate rate (the final cumulative assistant step). */
export const computeAssistantTps = (steps: readonly AssistantTpsInput[]): number | null => {
  const rates = computeAssistantTpsByStep(steps);
  return rates[rates.length - 1] ?? null;
};

export type AssistantTurnDisposition = 'active' | 'normal' | 'abnormal';

/**
 * Publish a calculated rate for finished, interrupted, aborted, and failed turns.
 * An in-flight continuation stays hidden: the next assistant step would replace it.
 * Missing `time.completed` does not hide a rate the streamed clocks can already produce.
 */
export const canPresentAssistantTps = (input: {
  completionDisposition?: AssistantTurnDisposition;
  tps: number | null | undefined;
}): boolean => {
  if (input.completionDisposition === 'active') return false;
  return typeof input.tps === 'number' && Number.isFinite(input.tps) && input.tps > 0;
};

/** OpenCode TUI renders assistant throughput with one decimal place. */
export const formatAssistantTps = (tps: number): string => {
  if (!Number.isFinite(tps) || tps <= 0) {
    return '';
  }
  return `${tps.toFixed(1)} tok/s`;
};
