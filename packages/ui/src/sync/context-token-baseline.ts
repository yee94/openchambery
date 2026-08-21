/**
 * Shared backward token-baseline scan for context-usage surfaces.
 *
 * Context-usage rings read the last assistant token record because that
 * record's input total reflects the live context window. A compaction row
 * breaks that assumption: the transcript keeps the compacted history, so the
 * pre-compaction assistant would otherwise win every backward scan and the
 * ring would keep showing stale pre-compaction usage after `/compact`.
 */

export type ContextTokenRecord = {
  input?: unknown
  output?: unknown
  reasoning?: unknown
  cache?: { read?: unknown; write?: unknown }
}

export type ContextBaselineMessage = {
  id?: string
  role?: string
  tokens?: ContextTokenRecord
}

export type ContextTokenBaseline = {
  messageId: string
  totalTokens: number
  tokens: ContextTokenRecord
}

export type ContextTokenBaselineResult =
  | ContextTokenBaseline
  | { compacted: true }
  | null

export const readContextTokenCount = (value: unknown): number => (
  typeof value === "number" && Number.isFinite(value) ? value : 0
)

export const sumContextTokenRecord = (tokens: ContextTokenRecord): number => (
  readContextTokenCount(tokens.input)
  + readContextTokenCount(tokens.output)
  + readContextTokenCount(tokens.reasoning)
  + readContextTokenCount(tokens.cache?.read)
  + readContextTokenCount(tokens.cache?.write)
)

const isCompactionPart = (part: unknown): boolean => (
  (part as { type?: unknown } | null | undefined)?.type === "compaction"
)

export const hasCompactionPartType = (parts: readonly unknown[] | undefined): boolean => (
  Boolean(parts) && parts!.some(isCompactionPart)
)

/**
 * Scan messages newest→oldest for the token baseline:
 *
 * - The first token-bearing assistant wins; older records never matter.
 * - A compaction row newer than that assistant resets the baseline:
 *   pre-compaction counts no longer describe the live context window, so the
 *   result is `{ compacted: true }` and callers must treat usage as unknown
 *   until a post-compaction assistant publishes tokens.
 */
export const scanContextTokenBaseline = (
  messages: readonly ContextBaselineMessage[],
  getParts: (messageId: string) => readonly unknown[] | undefined,
): ContextTokenBaselineResult => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== "assistant") {
      if (message.id && hasCompactionPartType(getParts(message.id))) {
        return { compacted: true }
      }
      continue
    }
    const tokens = message.tokens
    if (!tokens) continue
    const totalTokens = sumContextTokenRecord(tokens)
    if (totalTokens > 0) {
      return { messageId: message.id ?? "", totalTokens, tokens }
    }
  }
  return null
}
