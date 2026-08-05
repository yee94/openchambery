import type { Part } from '@opencode-ai/sdk/v2';

/**
 * Stable identity for a projected turn part: React row key, expand-state id, and
 * `TurnSummaryRecord.sourcePartId`.
 *
 * `projectTurnActivity` and `projectTurnSummary` must agree on this id or the
 * summary source stops matching its Activity row and the text flips between a
 * justification row and the message body. Server parts always carry `id`; the
 * index fallback only covers UI-synthesized display parts, which have no
 * server identity to preserve.
 */
export const resolveActivityPartId = (
    messageId: string,
    part: Part,
    partIndex: number,
): string => part.id ?? `${messageId}-part-${partIndex}-${part.type}`;
