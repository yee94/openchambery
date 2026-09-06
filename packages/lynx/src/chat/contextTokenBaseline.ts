/**
 * Shared backward token-baseline scan for context-usage surfaces.
 * Port of packages/ui/src/sync/context-token-baseline.ts (Cap).
 *
 * A compaction row newer than the last token-bearing assistant resets the
 * baseline: pre-compaction counts no longer describe the live context window.
 */

export type LynxContextTokenRecord = {
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  cache?: { read?: unknown; write?: unknown };
};

export type LynxContextBaselineMessage = {
  id?: string;
  role?: string;
  tokens?: LynxContextTokenRecord;
};

export type LynxContextTokenBaseline = {
  messageId: string;
  totalTokens: number;
  tokens: LynxContextTokenRecord;
};

export type LynxContextTokenBaselineResult =
  | LynxContextTokenBaseline
  | { compacted: true }
  | null;

export const readLynxContextTokenCount = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : 0
);

export const sumLynxContextTokenRecord = (tokens: LynxContextTokenRecord): number => (
  readLynxContextTokenCount(tokens.input)
  + readLynxContextTokenCount(tokens.output)
  + readLynxContextTokenCount(tokens.reasoning)
  + readLynxContextTokenCount(tokens.cache?.read)
  + readLynxContextTokenCount(tokens.cache?.write)
);

const isCompactionPart = (part: unknown): boolean => (
  (part as { type?: unknown } | null | undefined)?.type === 'compaction'
);

export const hasLynxCompactionPartType = (
  parts: readonly unknown[] | undefined,
): boolean => Boolean(parts) && parts!.some(isCompactionPart);

/**
 * Scan messages newest→oldest:
 * - First token-bearing assistant wins.
 * - A compaction row newer than that assistant → `{ compacted: true }`.
 */
export const scanLynxContextTokenBaseline = (
  messages: readonly LynxContextBaselineMessage[],
  getParts: (messageId: string) => readonly unknown[] | undefined,
): LynxContextTokenBaselineResult => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== 'assistant') {
      if (message.id && hasLynxCompactionPartType(getParts(message.id))) {
        return { compacted: true };
      }
      continue;
    }
    const tokens = message.tokens;
    if (!tokens) continue;
    const totalTokens = sumLynxContextTokenRecord(tokens);
    if (totalTokens > 0) {
      return { messageId: message.id ?? '', totalTokens, tokens };
    }
  }
  return null;
};
