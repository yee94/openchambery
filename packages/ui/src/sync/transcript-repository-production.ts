/**
 * Production Query transcript stack (Ticket 09 atomic cutover).
 *
 * One shared active registry, cache budget, Query repository, and reconnect
 * compensation controller per SyncProvider lifecycle.
 */

import type { Message, Part } from "@opencode-ai/sdk/v2/client"
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
  fetchHostSessionTurnPageForPurpose,
  type SessionTurnPage,
} from "./session-turn-page-api"
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

  // Ticket 09 batch 2: no nested retry() — Query classifier owns retries;
  // pass abort signal through to Host for cancellation fidelity.
  const page: SessionTurnPage = await fetchHostSessionTurnPageForPurpose({
    sessionID: input.sessionID,
    directory: input.directory,
    purpose,
    ...(input.before ? { before: input.before } : {}),
    signal: input.signal,
  })

  let records = page.records.map((record) => ({
    info: stripMessageDiffSnapshots(record.info),
    parts: sortParts(record.parts ?? []),
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
            request: () => scopedClient.session.message({
              sessionID: input.sessionID,
              messageID,
              directory: input.directory,
            }),
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
