/**
 * How one HTTP session-message page folds into existing store state.
 *
 * The decision is resolved once, here, from `(purpose, stale)` and then read by
 * every layer that needs it: the loader's stale gate, the reducer's apply gate,
 * and materialization's message/part merge. Layers must not re-derive it from
 * `purpose` or staleness on their own — that is how the same rule ended up
 * encoded three times with divergent exceptions.
 */

/** Why the page was fetched. Determines both page size and merge behavior. */
export type SessionMessagePagePurpose = "initial" | "prepend" | "recovery" | "materialize"

/**
 * Fate of a page that lost the race against live SSE.
 * - `drop`: discard it; live state is strictly better.
 * - `backfill`: still usable for messages the live stream never delivered.
 */
export type StalePageDisposition = "drop" | "backfill"

/**
 * - `upsert`: fetched snapshots replace existing message objects.
 * - `insert-only`: only messages absent from the store are added; existing
 *   objects keep their identity, so newer live snapshots always win.
 */
export type MessageMergeMode = "upsert" | "insert-only"

/**
 * - `replace`: the fetched part snapshot is authoritative for the message.
 * - `skip-existing`: messages that already have parts are left untouched
 *   (history pagination must not rewrite the rendered tail).
 */
export type PartMergeMode = "replace" | "skip-existing"

/**
 * Which existing parts may keep in-flight streaming text/output that the
 * snapshot omits or truncates.
 */
export type StreamingPreservation = "assistant" | "all" | "none"

export type SessionMergeStrategy = {
  /** Stable label for debugging / telemetry; not a behavioral input. */
  readonly id: string
  readonly onStale: StalePageDisposition
  readonly messages: MessageMergeMode
  readonly parts: PartMergeMode
  readonly preserveStreaming: StreamingPreservation
}

const strategy = (value: SessionMergeStrategy): SessionMergeStrategy => Object.freeze(value)

/**
 * Strategy for a page that is still current. Only `recovery` reconciles server
 * truth against a transcript the live stream already owns, so it is the only
 * purpose that upserts existing message objects.
 */
const CURRENT: Readonly<Record<SessionMessagePagePurpose, SessionMergeStrategy>> = Object.freeze({
  initial: strategy({
    id: "initial",
    onStale: "drop",
    messages: "insert-only",
    parts: "replace",
    preserveStreaming: "assistant",
  }),
  prepend: strategy({
    id: "history",
    onStale: "drop",
    messages: "insert-only",
    parts: "skip-existing",
    preserveStreaming: "assistant",
  }),
  recovery: strategy({
    id: "recovery",
    onStale: "backfill",
    messages: "upsert",
    parts: "replace",
    preserveStreaming: "assistant",
  }),
  materialize: strategy({
    id: "materialize",
    onStale: "drop",
    messages: "insert-only",
    parts: "replace",
    preserveStreaming: "assistant",
  }),
})

/**
 * Recovery that lost the race: still worth applying, because a reconnect page
 * is the only source for messages the SSE gap swallowed. Staleness downgrades
 * exactly one dimension — `upsert` becomes `insert-only` — so the page fills
 * holes without overwriting the newer objects live events just committed.
 */
const STALE_RECOVERY = strategy({
  id: "recovery-backfill",
  onStale: "backfill",
  messages: "insert-only",
  parts: "replace",
  preserveStreaming: "assistant",
})

/**
 * Send-confirmation gap fill. The transcript already owns everything it holds,
 * so this page may only add messages it is missing and may never rewrite parts
 * that exist. Reactive send remediation runs while live SSE owns the tail, and
 * an `upsert`/`replace` page there replays an older snapshot over live rows —
 * silently dropping already-finished tool and reasoning parts.
 */
export const SEND_GAP_FILL_SESSION_MERGE_STRATEGY = strategy({
  id: "send-gap-fill",
  onStale: "backfill",
  messages: "insert-only",
  parts: "skip-existing",
  preserveStreaming: "assistant",
})

/**
 * Default for callers that materialize records outside the page pipeline
 * (post-mutation refetches, orphan repair). Matches `initial`.
 */
export const DEFAULT_SESSION_MERGE_STRATEGY = CURRENT.initial

export function resolveSessionMergeStrategy(input: {
  purpose: SessionMessagePagePurpose
  stale?: boolean
}): SessionMergeStrategy {
  const current = CURRENT[input.purpose] ?? DEFAULT_SESSION_MERGE_STRATEGY
  if (!input.stale || current.onStale === "drop") return current
  return STALE_RECOVERY
}

/**
 * Whether a page fetched for `purpose` must be discarded once live state has
 * moved past it. The loader's pre-reducer checkpoints and the reducer's apply
 * gate both read this, so they cannot disagree.
 */
export function shouldDropStalePage(purpose: SessionMessagePagePurpose): boolean {
  return resolveSessionMergeStrategy({ purpose, stale: true }).onStale === "drop"
}

export function shouldPreserveStreamingParts(
  merge: SessionMergeStrategy,
  role: string | undefined,
): boolean {
  if (merge.preserveStreaming === "none") return false
  if (merge.preserveStreaming === "all") return true
  return role === "assistant"
}
