/**
 * Production Query transcript stack (Ticket 09 atomic cutover).
 *
 * One shared active registry, cache budget, Query repository, and reconnect
 * compensation controller per SyncProvider lifecycle.
 */

import type { Message, Part } from '@/lib/opencode/v2-types'

import type { QueryClient } from "@tanstack/react-query"

import { queryClient as defaultQueryClient } from "@/lib/queryRuntime"
import {
  getRuntimeGeneration,
  getRuntimeTransportIdentity,
} from "@/lib/runtime-switch"
import { opencodeClient } from "@/lib/opencode/client"

import {
  createTranscriptActiveScopeRegistry,
  createTranscriptQueryCacheBudget,
} from "./session-transcript-query-cache"
import { createTranscriptReconnectCompensationController } from "./session-transcript-reconnect-compensation"
import { resyncDirectorySessionStatuses } from "./session-status-reconciliation"
import {
  createQueryTranscriptRepository,
  type QueryTranscriptRepository,
} from "./transcript-repository-query-adapter"
import {
  bindTranscriptRepositoryInstance,
  requireTranscriptRepository,
  transcriptScope,
  unbindTranscriptRepository,
} from "./transcript-repository-runtime"
import {
  registerTranscriptReconnectCompensationController,
} from "./transcript-reconnect-compensation-runtime"
import {
  fetchSessionContext,
  fetchSessionProjectionPage,
  isAuthoredUserTurnRecord,
  normalizeSessionProjectionMessage,
} from "./session-projection-api"
import { rememberCompactionBarrierFromRecords } from "./session-compaction-api"
import {
  fetchExactSessionMessageRecord,
  findMissingAssistantParentUserIDs,
  recoverAssistantTailBoundary,
} from "./transcript-parent-recovery"
import { stripMessageDiffSnapshots } from "./sanitize"
import type { SessionMessagePagePurpose } from "./session-merge-strategy"
import type { TranscriptTransportPage } from "./transcript-repository"
import { getInitialSessionTurnLimit, getHistorySessionTurnLimit } from "./session-message-policy"
import type { ChildStoreManager } from "./child-store"
import type { TranscriptDurableStore } from "./transcript-durable-store"
import { createRuntimeTranscriptDurableStore } from "./transcript-durable-store-runtime"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function sortParts(parts: Part[]): Part[] {
  return parts.filter((part) => !!part?.id).sort((a, b) => cmp(a.id, b.id))
}

type OrderedRecord = TranscriptTransportPage["records"][number]

function recordCreated(record: OrderedRecord): number {
  return typeof record.info?.time?.created === "number" ? record.info.time.created : 0
}

/**
 * Overlay context freshness onto the projection first-page window.
 *
 * Context traversal order is the order source; ids never rank records.
 *
 * - Same id: prefer context body (post-checkpoint freshness).
 * - Context-only rows at or before the last context row the projection also
 *   listed (overlap anchor) are the **older prefix** or mid-window gaps: omit —
 *   the projection continuation cursor still owns that history.
 * - Context-only rows after the overlap anchor are the **newer tail**: append in
 *   context traversal order so first paint is not missing live turns the
 *   projection page has not listed.
 * - Without any overlap, only rows not created before the projection window end
 *   are the newer tail (equal `created` stays in context order).
 * - When projection is empty after system filtering, keep context rows with the
 *   projection cursor so older history remains reachable.
 */
export function mergeInitialProjectionAndContext(
  projection: TranscriptTransportPage,
  context: TranscriptTransportPage | null | undefined,
): TranscriptTransportPage {
  if (!context || context.records.length === 0) return projection

  const contextById = new Map(
    context.records.map((record) => [record.info.id, record] as const),
  )

  if (projection.records.length === 0) {
    return {
      records: context.records,
      cursor: projection.cursor,
      complete: projection.complete,
      turnCount: context.turnCount,
      requestedTurnLimit: projection.requestedTurnLimit ?? context.requestedTurnLimit,
    }
  }

  const projectionIds = new Set(
    projection.records.map((record) => record.info.id).filter((id): id is string => typeof id === "string"),
  )
  const records: OrderedRecord[] = projection.records.map(
    (record) => contextById.get(record.info.id) ?? record,
  )

  let anchorIndex = -1
  context.records.forEach((record, index) => {
    if (projectionIds.has(record.info?.id)) anchorIndex = index
  })
  const windowEndCreated = recordCreated(projection.records[projection.records.length - 1]!)

  for (let index = anchorIndex + 1; index < context.records.length; index += 1) {
    const record = context.records[index]!
    const id = record.info?.id
    if (typeof id !== "string" || projectionIds.has(id)) continue
    if (anchorIndex < 0 && recordCreated(record) < windowEndCreated) continue
    records.push(record)
  }

  const turnCount = records.filter((entry) => isAuthoredUserTurnRecord(entry.info, entry.parts)).length
  return {
    records,
    cursor: projection.cursor,
    complete: projection.complete,
    turnCount,
    requestedTurnLimit: projection.requestedTurnLimit ?? context.requestedTurnLimit,
  }
}

/**
 * Extra projection pages an unanchored first page may walk back. With the
 * 20-message page this bounds the scan at 100 messages (Host scan default).
 */
export const INITIAL_ANCHOR_SCAN_EXTRA_PAGES = 4

/**
 * OpenCode 2 stores each assistant step as its own message, so one long turn
 * (typical for subagents) can fill the whole first page without its authored
 * user row. The transcript renders turns from that anchor, so walk older
 * projection pages until one appears, history ends, or the bound is reached.
 */
export async function extendInitialPageToAuthoredUserTurn(
  page: TranscriptTransportPage,
  input: { sessionID: string; directory: string; signal: AbortSignal },
): Promise<TranscriptTransportPage> {
  let current = page
  for (
    let scanned = 0;
    scanned < INITIAL_ANCHOR_SCAN_EXTRA_PAGES && current.turnCount === 0 && current.cursor && !current.complete;
    scanned += 1
  ) {
    const older = await fetchSessionProjectionPage({
      sessionID: input.sessionID,
      directory: input.directory,
      cursor: current.cursor,
      signal: input.signal,
    })
    const known = new Set(current.records.map((record) => record.info.id))
    const records = [
      ...older.records.filter((record) => !known.has(record.info.id)),
      ...current.records,
    ]
    current = {
      ...current,
      records,
      cursor: older.cursor,
      complete: older.complete,
      turnCount: records.filter((entry) => isAuthoredUserTurnRecord(entry.info, entry.parts)).length,
    }
  }
  return current
}

/**
 * Production HTTP fetcher for transcript InfiniteQuery / tail tasks.
 * Uses Host turn-page + assistant parent recovery; strips message diffs.
 */
export async function fetchProductionTranscriptTransportPage(input: {
  directory: string
  sessionID: string
  limit: number
  before?: string
  signal: AbortSignal
  purpose?: SessionMessagePagePurpose
}): Promise<TranscriptTransportPage> {
  const rawPurpose = input.before ? "prepend" : (input.purpose ?? "initial")
  const purpose: "initial" | "prepend" | "recovery" | "materialize" =
    rawPurpose === "prepend"
    || rawPurpose === "recovery"
    || rawPurpose === "materialize"
      ? rawPurpose
      : "initial"
  void purpose

  // Ticket 09 batch 2: no nested retry() — Query classifier owns retries;
  // pass abort signal through to Host for cancellation fidelity.
  // Ticket 08: first paint prefers GET /context (post-checkpoint). Prepend
  // still uses the projection cursor so older history remains reachable.
  const projection = await fetchSessionProjectionPage({
    sessionID: input.sessionID,
    directory: input.directory,
    ...(input.before ? { cursor: input.before } : {}),
    signal: input.signal,
  })
  const context = input.before
    ? null
    : await fetchSessionContext({
      sessionID: input.sessionID,
      directory: input.directory,
      signal: input.signal,
    })
  // First paint may overlay GET /context freshness onto the projection window,
  // but pagination authority stays on projection: its cursor covers every
  // first-page id. Replacing records with a strict context subset while keeping
  // the projection cursor would skip intermediate ids on the next older page.
  const merged = mergeInitialProjectionAndContext(projection, context)
  const page = input.before
    ? merged
    : await extendInitialPageToAuthoredUserTurn(merged, input)

  let records = page.records.map((record) => ({
    info: stripMessageDiffSnapshots(record.info),
    parts: sortParts((record.parts ?? []) as Part[]),
  }))

  // Incomplete tails may omit parent user rows; recover by exact message ID.
  if (!input.before && !page.complete) {
    const missing = findMissingAssistantParentUserIDs(records)
    if (missing.length > 0) {
      const scopedClient = opencodeClient.getScopedSdkClient(input.directory)
      const recovered = await recoverAssistantTailBoundary({
        records,
        complete: page.complete,
        requestMessage: async (messageID) => {
          const record = await fetchExactSessionMessageRecord({
            transport: getRuntimeTransportIdentity(),
            generation: getRuntimeGeneration(),
            directory: input.directory,
            sessionID: input.sessionID,
            messageID,
            request: async () => {
              const raw = await scopedClient.session.message({
                sessionID: input.sessionID,
                messageID,
              })
              const data = normalizeSessionProjectionMessage(input.sessionID, raw)
              if (!data?.info?.id) throw new Error("session.message failed: empty response")
              return {
                info: stripMessageDiffSnapshots(data.info),
                parts: sortParts(data.parts ?? []),
              }
            },
          })
          return {
            info: record.info,
            parts: sortParts(record.parts ?? []),
          }
        },
      })
      records = recovered.records.map((record) => ({
        info: record.info,
        parts: sortParts((record.parts ?? []) as Part[]),
      }))
    }
  }

  rememberCompactionBarrierFromRecords(input.sessionID, records)

  return {
    records,
    cursor: page.cursor ?? undefined,
    complete: page.complete,
    turnCount: page.turnCount,
    requestedTurnLimit: input.limit,
  }
}

export type ProductionTranscriptStack = {
  repository: QueryTranscriptRepository
  destroy: () => void
}

export type MountProductionTranscriptStackInput = {
  client?: QueryClient
  childStores: ChildStoreManager
  getViewedSession?: () => { directory: string; sessionID: string } | null
  getViewedSessions?: () => readonly { directory: string; sessionID: string }[]
  /**
   * Optional settled-transcript cache. Omitted mounts the production runtime
   * adapter (Electron local HTTP/SQLite, otherwise IndexedDB). Injected stores
   * win so tests can stay in-memory.
   */
  durableStore?: TranscriptDurableStore
}

/**
 * Create and bind the production Query transcript stack.
 * Cleanup: cancel compensation → unregister controller → destroy repo → unbind.
 */
export function mountProductionTranscriptStack(
  input: MountProductionTranscriptStackInput,
): ProductionTranscriptStack {
  const client = input.client ?? defaultQueryClient
  const activeRegistry = createTranscriptActiveScopeRegistry()
  const cacheBudget = createTranscriptQueryCacheBudget({
    client,
    activeRegistry,
  })

  const repository = createQueryTranscriptRepository({
    client,
    cacheBudget,
    activeRegistry,
    // Live probes — never pin creation-time transport/generation.
    probe: {
      getTransport: getRuntimeTransportIdentity,
      getGeneration: getRuntimeGeneration,
    },
    fetcher: (args) =>
      fetchProductionTranscriptTransportPage({
        directory: args.directory,
        sessionID: args.sessionID,
        limit: args.limit,
        before: args.before,
        signal: args.signal,
      }),
    initialLimit: getInitialSessionTurnLimit(),
    historyLimit: getHistorySessionTurnLimit(),
    durableStore: input.durableStore ?? createRuntimeTranscriptDurableStore(),
  })

  const compensation = createTranscriptReconnectCompensationController({
    client,
    repository: repository as import("./session-transcript-reconnect-compensation").QueryTranscriptCompensationRepository,
    listDirectories: () => Array.from(input.childStores.children.keys()),
    getBusyOrRetrySessionIDs: (directory) => {
      const store = input.childStores.getChild(directory)
      if (!store) return []
      const status = store.getState().session_status ?? {}
      const ids: string[] = []
      for (const [sessionID, entry] of Object.entries(status)) {
        if (entry && (entry.type === "busy" || entry.type === "retry")) {
          ids.push(sessionID)
        }
      }
      return ids
    },
    getViewedSession: () => input.getViewedSession?.() ?? null,
    getViewedSessions: input.getViewedSessions
      ? () => input.getViewedSessions!()
      : undefined,
    cacheBudget,
    probe: {
      getTransport: getRuntimeTransportIdentity,
      getGeneration: getRuntimeGeneration,
    },
    confirmSessionStatus: async (ref, hint) => {
      const store = input.childStores.getChild(ref.directory)
      if (!store) return
      const current = store.getState().session_status?.[ref.sessionID]
      // Only confirm when there is something to fix: an open turn tail that must
      // not be downgraded to idle, or a stale busy/retry entry that should
      // converge. Idle-with-closed-tail needs no extra fetch churn.
      if (!hint.tailOpen && current?.type !== "busy" && current?.type !== "retry") return
      await resyncDirectorySessionStatuses(
        ref.directory,
        store,
        [ref.sessionID],
        hint.tailOpen ? { tailOpenSessionIds: new Set([ref.sessionID]) } : {},
      )
    },
  })

  bindTranscriptRepositoryInstance(repository)
  registerTranscriptReconnectCompensationController(compensation)

  return {
    repository,
    destroy: () => {
      // Drop Query observers and compensation only. The durable cache is the
      // user's continuity store and must survive SyncProvider remounts.
      compensation.cancelAll("dispose")
      registerTranscriptReconnectCompensationController(null)
      repository.destroy()
      unbindTranscriptRepository()
    },
  }
}

/** Apply HTTP transport page to the production Query repository. */
export function applyProductionHttpPage(input: {
  directory: string
  sessionID: string
  purpose: SessionMessagePagePurpose
  page: TranscriptTransportPage
  capturedLiveRevision?: number
  liveRevision?: number
  skipPartTypes?: ReadonlySet<string>
  optimistic?: readonly { message: Message; parts: Part[] }[]
}) {
  return requireTranscriptRepository().apply(
    transcriptScope(input.directory, input.sessionID),
    {
      type: "http-page",
      purpose: input.purpose,
      page: input.page,
      capturedLiveRevision: input.capturedLiveRevision,
      liveRevision: input.liveRevision,
      skipPartTypes: input.skipPartTypes,
      optimistic: input.optimistic,
    },
  )
}
