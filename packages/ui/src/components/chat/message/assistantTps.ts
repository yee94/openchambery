import type { Part } from '@opencode-ai/sdk/v2';

/**
 * Assistant TPS (tokens per second) from generation time only.
 *
 * Wall-clock message duration includes tool execution. TPS should measure
 * model generation rate, so tool intervals are subtracted from the span
 * between message `created` and `completed`.
 *
 * Token numerator uses output + reasoning (generated tokens), not input/cache.
 */

export type AssistantTpsInput = {
  createdAt?: number | null;
  completedAt?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  parts?: Part[] | null;
};

const toNonNegativeFinite = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
};

const partRecord = (part: Part): Record<string, unknown> => part as unknown as Record<string, unknown>;

/**
 * Sum completed tool wall time for a message. Incomplete tools contribute 0
 * so partial streams do not invent duration.
 */
export const sumToolDurationMs = (parts: Part[] | null | undefined): number => {
  if (!Array.isArray(parts) || parts.length === 0) {
    return 0;
  }

  let total = 0;
  for (const part of parts) {
    const record = partRecord(part);
    if (record.type !== 'tool') {
      continue;
    }
    const state = record.state as { time?: { start?: unknown; end?: unknown } } | undefined;
    const start = state?.time?.start;
    const end = state?.time?.end;
    if (typeof start !== 'number' || !Number.isFinite(start)) {
      continue;
    }
    if (typeof end !== 'number' || !Number.isFinite(end) || end < start) {
      continue;
    }
    total += end - start;
  }
  return total;
};

/**
 * Generation-only duration in ms, or null when the message is not complete
 * enough to measure.
 */
export const computeGenerationDurationMs = (
  createdAt: number | null | undefined,
  completedAt: number | null | undefined,
  parts: Part[] | null | undefined,
): number | null => {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) {
    return null;
  }
  if (typeof completedAt !== 'number' || !Number.isFinite(completedAt) || completedAt <= 0) {
    return null;
  }
  if (completedAt <= createdAt) {
    return null;
  }

  const wallMs = completedAt - createdAt;
  const toolMs = sumToolDurationMs(parts);
  const generationMs = wallMs - toolMs;
  if (!Number.isFinite(generationMs) || generationMs <= 0) {
    return null;
  }
  return generationMs;
};

/**
 * Compute assistant tokens/sec excluding tool call wall time.
 * Returns null when TPS cannot be measured.
 */
export const computeAssistantTps = (input: AssistantTpsInput): number | null => {
  const generationMs = computeGenerationDurationMs(input.createdAt, input.completedAt, input.parts);
  if (generationMs === null) {
    return null;
  }

  const generatedTokens =
    toNonNegativeFinite(input.outputTokens) + toNonNegativeFinite(input.reasoningTokens);
  if (generatedTokens <= 0) {
    return null;
  }

  const seconds = generationMs / 1000;
  if (seconds <= 0) {
    return null;
  }

  const tps = generatedTokens / seconds;
  if (!Number.isFinite(tps) || tps <= 0) {
    return null;
  }
  return tps;
};

/**
 * Compact display for footer / raw-message rows.
 * Examples: `12.4 tok/s`, `128 tok/s`, `1.2k tok/s`
 */
export const formatAssistantTps = (tps: number): string => {
  if (!Number.isFinite(tps) || tps <= 0) {
    return '';
  }
  if (tps >= 1000) {
    const thousands = tps / 1000;
    const rounded = thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1);
    return `${rounded}k tok/s`;
  }
  if (tps >= 100) {
    return `${Math.round(tps)} tok/s`;
  }
  if (tps >= 10) {
    return `${tps.toFixed(1)} tok/s`;
  }
  return `${tps.toFixed(2)} tok/s`;
};
