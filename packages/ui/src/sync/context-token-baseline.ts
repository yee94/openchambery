import type { SessionContextUsage } from '@/stores/types/sessionTypes';

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
  clientRole?: string
  type?: string
  status?: string
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
 * V2 compaction projects as `role: "assistant"` + `clientRole: "compaction"`.
 * OpenCode also puts compaction-request tokens on that row; those measure the
 * compact call, not the resulting window, so they must never win the scan.
 */
export const isCompactionBaselineRow = (
  message: ContextBaselineMessage,
  parts: readonly unknown[] | undefined,
): boolean => (
  message.clientRole === "compaction"
  || message.type === "compaction"
  || hasCompactionPartType(parts)
)

/**
 * Scan messages newest→oldest for the token baseline:
 *
 * - The first token-bearing assistant wins; older records never matter.
 * - A completed compaction row newer than that assistant resets the baseline:
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
    const parts = message.id ? getParts(message.id) : undefined
    if (isCompactionBaselineRow(message, parts)) {
      const part = parts?.find(isCompactionPart) as { status?: string } | undefined
      const status = part?.status ?? message.status
      // Running/failed compactions leave the old window valid. Missing status
      // is incomplete data: never report a potentially compacted window as current.
      if (status === 'running' || status === 'failed') continue
      return { compacted: true }
    }
    if (message.role !== "assistant") continue
    const tokens = message.tokens
    if (!tokens) continue
    const totalTokens = sumContextTokenRecord(tokens)
    if (totalTokens > 0) {
      return { messageId: message.id ?? "", totalTokens, tokens }
    }
  }
  return null
}

/** Pending counts are placeholders, never measured zero usage. */
export const buildSessionContextUsage = (
  baseline: ContextTokenBaselineResult,
  contextLimit: number,
  outputLimit: number,
): SessionContextUsage | null => {
  if (!baseline) return null
  const pending = 'compacted' in baseline
  const totalTokens = pending ? 0 : baseline.totalTokens
  return {
    ...(pending ? { pending: true } : {}),
    totalTokens,
    percentage: contextLimit > 0 ? Math.round((totalTokens / contextLimit) * 100) : 0,
    contextLimit: contextLimit || 0,
    outputLimit: outputLimit || undefined,
    normalizedOutput: !pending && outputLimit > 0
      ? Math.round((readContextTokenCount(baseline.tokens.output) / outputLimit) * 100)
      : undefined,
    thresholdLimit: contextLimit > 0 ? contextLimit : 200000,
    lastMessageId: pending ? undefined : baseline.messageId,
  }
}
