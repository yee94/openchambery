import type { Message, Part } from "@/lib/opencode/v2-types"
import type { Event } from "@/sync/types"

import type { SessionMessageHttpPage } from "./session-message-query"
import { getTranscriptDurableByteBudget } from "./session-cache-limits"
import type {
  TranscriptDurableGeneration,
  TranscriptDurableScope,
  TranscriptDurableStore,
} from "./transcript-durable-store"
import {
  transcriptDurableGenerationKey,
  transcriptDurableScopeKey,
} from "./transcript-durable-store"
import type { TranscriptTransportPage } from "./transcript-repository"

/**
 * Map a resolved Query identity onto the durable four-field scope.
 *
 * Query `TranscriptScope` still treats transport/generation as optional; the
 * store does not. Callers must resolve live identity before crossing this seam.
 *
 * With a `partition` (stable runtime instance key), the durable scope ignores
 * the in-memory transport fingerprint and generation counter: both change on
 * every cold start and LAN⇄relay swap, which would make settled bodies
 * unreachable after an app restart. Generation is pinned to 0 in that mode.
 */
export function toTranscriptDurableScope(
  identity: {
    transport: string
    generation: number
    directory: string
    sessionID: string
  },
  partition?: string,
): TranscriptDurableScope {
  if (partition) {
    return {
      transport: partition,
      generation: 0,
      directory: identity.directory,
      sessionID: identity.sessionID,
    }
  }
  return {
    transport: identity.transport,
    generation: identity.generation,
    directory: identity.directory,
    sessionID: identity.sessionID,
  }
}

export function transportPageFromHttpPage(page: SessionMessageHttpPage): TranscriptTransportPage {
  return {
    records: page.records.map((record) => ({
      info: record.info as Message,
      parts: (record.parts ?? []) as Part[],
    })),
    cursor: typeof page.cursor === "string" ? page.cursor : undefined,
    complete: page.complete,
    turnCount: page.turnCount,
    requestedTurnLimit: page.requestedTurnLimit,
  }
}

export type TranscriptDurableSseAction =
  | { readonly action: "remove"; readonly messageID: string }
  | { readonly action: "persist"; readonly messageID: string }
  | { readonly action: "skip" }

/**
 * Classify a transcript SSE event for durable writes.
 *
 * Streaming `part.delta` stays in Query only — the store rejects open
 * assistants anyway, and enqueueing every token would reorder behind deletes.
 * `message.removed` is a durable delete. Other message/part events persist the
 * settled snapshot after Query merge.
 */
export function transcriptDurableSseAction(event: Event): TranscriptDurableSseAction {
  if (event.type === "message.part.delta") return { action: "skip" }
  const properties = (event as { properties?: Record<string, unknown> }).properties
  if (event.type === "message.removed") {
    const messageID = properties?.messageID
    return typeof messageID === "string" && messageID.length > 0
      ? { action: "remove", messageID }
      : { action: "skip" }
  }
  if (event.type === "message.updated") {
    const info = properties?.info as { id?: unknown } | undefined
    return typeof info?.id === "string" && info.id.length > 0
      ? { action: "persist", messageID: info.id }
      : { action: "skip" }
  }
  if (event.type === "message.part.updated") {
    const part = properties?.part as { messageID?: unknown } | undefined
    return typeof part?.messageID === "string" && part.messageID.length > 0
      ? { action: "persist", messageID: part.messageID }
      : { action: "skip" }
  }
  if (event.type === "message.part.removed") {
    const messageID = properties?.messageID
    return typeof messageID === "string" && messageID.length > 0
      ? { action: "persist", messageID }
      : { action: "skip" }
  }
  return { action: "skip" }
}

export type TranscriptDurableQueryQueue = {
  wait: (scope: TranscriptDurableScope) => Promise<void>
  persistSettled: (scope: TranscriptDurableScope, info: Message, parts: readonly Part[]) => Promise<void>
  removeMessage: (scope: TranscriptDurableScope, messageID: string) => Promise<void>
  clearSession: (scope: TranscriptDurableScope) => Promise<void>
  clearGeneration: (generation: TranscriptDurableGeneration) => Promise<void>
}

export type TranscriptDurableQueryQueueOptions = {
  /** Active transcript scopes that LRU must not drop. */
  getProtectScopes?: () => readonly TranscriptDurableScope[]
  /** Override the platform durable byte budget (tests). */
  getByteBudget?: () => number
}

/**
 * Per-scope serial durable queue.
 *
 * Writes, deletes, and clears for one scope never overtake each other.
 * `clearGeneration` is a generation barrier so a later persist cannot land
 * after a runtime purge for that transport+generation.
 */
export function createTranscriptDurableQueryQueue(
  store: TranscriptDurableStore,
  options: TranscriptDurableQueryQueueOptions = {},
): TranscriptDurableQueryQueue {
  const scopeTails = new Map<string, Promise<void>>()
  const generationTails = new Map<string, Promise<void>>()

  const waitFor = (scope: TranscriptDurableScope): Promise<void> =>
    Promise.all([
      scopeTails.get(transcriptDurableScopeKey(scope)) ?? Promise.resolve(),
      generationTails.get(transcriptDurableGenerationKey(scope)) ?? Promise.resolve(),
    ]).then(() => undefined)

  const enqueueScope = (
    scope: TranscriptDurableScope,
    task: () => Promise<void>,
  ): Promise<void> => {
    const key = transcriptDurableScopeKey(scope)
    const run = waitFor(scope).then(task, task)
    scopeTails.set(key, run.then(() => undefined, () => undefined))
    return run
  }

  const enqueueGeneration = (
    generation: TranscriptDurableGeneration,
    task: () => Promise<void>,
  ): Promise<void> => {
    const key = transcriptDurableGenerationKey(generation)
    const previous = generationTails.get(key) ?? Promise.resolve()
    const run = previous.then(task, task)
    generationTails.set(key, run.then(() => undefined, () => undefined))
    return run
  }

  // Byte-budget eviction is coalesced across the whole queue: it runs once
  // after every enqueued persist has settled, not once per written row.
  let pendingPersists = 0
  let evictionDirty = false
  let evicting = false
  let evictionWaiters: Array<() => void> = []

  const runEvictionWhenIdle = () => {
    if (pendingPersists > 0 || evicting || !evictionDirty) return
    evictionDirty = false
    evicting = true
    const waiters = evictionWaiters
    evictionWaiters = []
    const budget = (options.getByteBudget ?? getTranscriptDurableByteBudget)()
    void store.evictToBytes(budget, { protect: options.getProtectScopes?.() ?? [] })
      .catch(() => undefined)
      .then(() => {
        evicting = false
        for (const resolve of waiters) resolve()
        runEvictionWhenIdle()
      })
  }

  return {
    wait: waitFor,
    persistSettled: (scope, info, parts) => {
      pendingPersists += 1
      let written = false
      const run = enqueueScope(scope, async () => {
        const result = await store.upsertSettled(scope, info, parts)
        written = result.status === "written"
      })
      const evicted = run.finally(() => {
        pendingPersists -= 1
        if (written) evictionDirty = true
      }).then(() => {
        if (!written) {
          runEvictionWhenIdle()
          return
        }
        const settled = new Promise<void>((resolve) => evictionWaiters.push(resolve))
        runEvictionWhenIdle()
        return settled
      })
      return evicted
    },
    removeMessage: (scope, messageID) =>
      enqueueScope(scope, () => store.removeMessage(scope, messageID)),
    clearSession: (scope) => enqueueScope(scope, () => store.clearSession(scope)),
    clearGeneration: (generation) =>
      enqueueGeneration(generation, () => store.clearGeneration(generation)),
  }
}
