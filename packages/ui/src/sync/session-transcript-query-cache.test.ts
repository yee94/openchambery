import { beforeEach, describe, expect, test } from "bun:test"
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query"

import {
  createTranscriptActiveScopeRegistry,
  createTranscriptCacheOpCounters,
  createTranscriptQueryCacheBudget,
  isTranscriptSessionQueryKey,
  seedCanonicalTranscriptQuery,
  seedTransportPageQuery,
  sessionTranscriptCheckpointQueryKey,
  sessionTranscriptReconcileTaskQueryKey,
  sessionTranscriptTailTaskQueryKey,
  transcriptSessionKeyFamilyFilters,
  type TranscriptCacheScope,
} from "./session-transcript-query-cache"
import {
  sessionMessagePageQueryKey,
  sessionTranscriptQueryKey,
} from "./session-message-query"
import {
  MOBILE_SESSION_CACHE_LIMIT,
  SESSION_CACHE_LIMIT,
  VSCODE_SESSION_CACHE_LIMIT,
} from "./session-cache-limits"
import { createQueryTranscriptRepository } from "./transcript-repository-query-adapter"
import type { TranscriptTransportPage } from "./transcript-repository"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"

const TRANSPORT = "runtime-cache"
const GENERATION = 1
const DIRECTORY = "/repo"

function scope(sessionID: string, generation = GENERATION): TranscriptCacheScope {
  return {
    transport: TRANSPORT,
    generation,
    directory: DIRECTORY,
    sessionID,
  }
}

function infinitePages(pageCount: number) {
  return {
    pages: Array.from({ length: pageCount }, (_, i) => ({
      kind: i === pageCount - 1 ? "tail" : "history",
      messageOrder: [`msg_${i}`],
      messagesByID: {},
      partsByMessageID: {},
      cursor: i === 0 ? null : `msg_${i}`,
      complete: i === 0,
      turnCount: 1,
      sync: { liveRevision: 0, confirmedHeadMessageID: `msg_${i}` },
    })),
    pageParams: Array.from({ length: pageCount }, (_, i) => (i === pageCount - 1 ? null : `c_${i}`)),
  }
}

function userMessage(id: string, sessionID = "ses_1"): Message {
  return { id, sessionID, role: "user", time: { created: 1 } } as Message
}

function textPart(id: string, messageID: string, sessionID = "ses_1"): Part {
  return { id, messageID, sessionID, type: "text", text: id } as Part
}

function transportPage(
  records: Array<{ info: Message; parts?: Part[] }>,
  options: { cursor?: string; complete?: boolean } = {},
): TranscriptTransportPage {
  return {
    records: records.map((record) => ({
      info: record.info,
      parts: record.parts ?? [],
    })),
    cursor: options.cursor,
    complete: options.complete ?? !options.cursor,
    turnCount: 1,
  }
}

describe("session cache capacity constants", () => {
  test("platform targets match product budgets", () => {
    expect(VSCODE_SESSION_CACHE_LIMIT).toBe(4)
    expect(MOBILE_SESSION_CACHE_LIMIT).toBe(12)
    expect(SESSION_CACHE_LIMIT).toBe(40)
  })
})

describe("transcript key families", () => {
  test("canonical / transport / reserved task and checkpoint shapes", () => {
    const s = scope("ses_a")
    expect(sessionTranscriptQueryKey(
      { directory: s.directory, sessionID: s.sessionID },
      s.transport,
      s.generation,
    )).toEqual([TRANSPORT, GENERATION, "session-transcript", DIRECTORY, "ses_a"])

    expect(sessionMessagePageQueryKey(
      { directory: s.directory, sessionID: s.sessionID, limit: 4, before: "msg_1" },
      s.transport,
      s.generation,
    )).toEqual([
      TRANSPORT,
      GENERATION,
      "sessionMessages",
      "page",
      DIRECTORY,
      "ses_a",
      4,
      "msg_1",
    ])

    expect(sessionTranscriptTailTaskQueryKey(
      { directory: s.directory, sessionID: s.sessionID, purpose: "recovery" },
      s.transport,
      s.generation,
    )).toEqual([
      TRANSPORT,
      GENERATION,
      "session-transcript-task",
      "tail",
      DIRECTORY,
      "ses_a",
      "recovery",
    ])

    expect(sessionTranscriptReconcileTaskQueryKey(
      { directory: s.directory, sessionID: s.sessionID, checkpoint: "cp_1" },
      s.transport,
      s.generation,
    )).toEqual([
      TRANSPORT,
      GENERATION,
      "session-transcript-task",
      "reconcile",
      DIRECTORY,
      "ses_a",
      "cp_1",
    ])

    expect(sessionTranscriptCheckpointQueryKey(
      { directory: s.directory, sessionID: s.sessionID },
      s.transport,
      s.generation,
    )).toEqual([
      TRANSPORT,
      GENERATION,
      "session-transcript-checkpoint",
      DIRECTORY,
      "ses_a",
    ])
  })

  test("isTranscriptSessionQueryKey matches families and scope", () => {
    const s = scope("ses_a")
    const filters = transcriptSessionKeyFamilyFilters(s)
    expect(filters).toHaveLength(5)

    expect(isTranscriptSessionQueryKey(
      sessionTranscriptQueryKey(
        { directory: s.directory, sessionID: s.sessionID },
        s.transport,
        s.generation,
      ),
      s,
      "canonical",
    )).toBe(true)

    expect(isTranscriptSessionQueryKey(
      sessionMessagePageQueryKey(
        { directory: s.directory, sessionID: s.sessionID, limit: 2 },
        s.transport,
        s.generation,
      ),
      s,
      "transport-page",
    )).toBe(true)

    expect(isTranscriptSessionQueryKey(
      sessionTranscriptTailTaskQueryKey(
        { directory: s.directory, sessionID: s.sessionID, purpose: "materialize" },
        s.transport,
        s.generation,
      ),
      s,
      "tail-task",
    )).toBe(true)

    expect(isTranscriptSessionQueryKey(
      [TRANSPORT, GENERATION, "session-transcript", DIRECTORY, "ses_other"],
      s,
      "canonical",
    )).toBe(false)
  })
})

describe("TranscriptQueryCacheBudget with real QueryClient", () => {
  let client: QueryClient
  let counters: ReturnType<typeof createTranscriptCacheOpCounters>
  let registry: ReturnType<typeof createTranscriptActiveScopeRegistry>
  let budget: ReturnType<typeof createTranscriptQueryCacheBudget>

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    counters = createTranscriptCacheOpCounters()
    registry = createTranscriptActiveScopeRegistry()
    budget = createTranscriptQueryCacheBudget({
      client,
      activeRegistry: registry,
      counters,
      getLimit: () => 3,
    })
  })

  test("active retain (registry) and Query observers keep all pages", () => {
    const active = scope("ses_active")
    const inactive = scope("ses_inactive")
    seedCanonicalTranscriptQuery(client, active, infinitePages(5), 100)
    seedCanonicalTranscriptQuery(client, inactive, infinitePages(2), 50)
    const release = registry.retain(active)

    // Force over capacity: add two more inactive so total inactive would need eviction.
    seedCanonicalTranscriptQuery(client, scope("ses_old_a"), infinitePages(1), 10)
    seedCanonicalTranscriptQuery(client, scope("ses_old_b"), infinitePages(1), 20)

    const { evicted } = budget.enforce()
    expect(evicted.map((s) => s.sessionID).sort()).toEqual(["ses_old_a"])
    // Active still has all 5 pages.
    const activeEntry = budget.listCanonical().find((e) => e.scope.sessionID === "ses_active")
    expect(activeEntry?.active).toBe(true)
    expect(activeEntry?.pageCount).toBe(5)
    expect(client.getQueryData(
      sessionTranscriptQueryKey(
        { directory: active.directory, sessionID: active.sessionID },
        active.transport,
        active.generation,
      ),
    )).toBeTruthy()
    release()
  })

  test("Query observer alone marks scope active without registry retain", () => {
    const s = scope("ses_obs")
    seedCanonicalTranscriptQuery(client, s, infinitePages(3), 100)
    const key = sessionTranscriptQueryKey(
      { directory: s.directory, sessionID: s.sessionID },
      s.transport,
      s.generation,
    )
    const observer = new InfiniteQueryObserver(client, {
      queryKey: key,
      queryFn: async () => infinitePages(1).pages[0],
      initialPageParam: null as string | null,
      getPreviousPageParam: () => undefined,
      getNextPageParam: () => undefined,
    })
    // Subscribe so observersCount > 0.
    const unsub = observer.subscribe(() => {})
    expect(budget.isActive(s)).toBe(true)
    expect(registry.isRetained(s)).toBe(false)

    seedCanonicalTranscriptQuery(client, scope("ses_x"), infinitePages(1), 1)
    seedCanonicalTranscriptQuery(client, scope("ses_y"), infinitePages(1), 2)
    seedCanonicalTranscriptQuery(client, scope("ses_z"), infinitePages(1), 3)
    // limit=3; active ses_obs + 3 inactive = 4 → evict oldest inactive.
    const { evicted } = budget.enforce()
    expect(evicted.some((e) => e.sessionID === "ses_obs")).toBe(false)
    expect(evicted.map((e) => e.sessionID)).toContain("ses_x")
    unsub()
    observer.destroy()
  })

  test("inactive LRU orders by dataUpdatedAt and respects preserve", () => {
    seedCanonicalTranscriptQuery(client, scope("ses_1"), infinitePages(1), 10)
    seedCanonicalTranscriptQuery(client, scope("ses_2"), infinitePages(1), 20)
    seedCanonicalTranscriptQuery(client, scope("ses_3"), infinitePages(1), 30)
    seedCanonicalTranscriptQuery(client, scope("ses_4"), infinitePages(1), 40)

    const { evicted } = budget.enforce({
      preserve: [scope("ses_1")],
    })
    // total 4, limit 3, preserve ses_1 → evict oldest non-preserved (ses_2 has 20, ses_1 preserved)
    expect(evicted.map((s) => s.sessionID)).toEqual(["ses_2"])
    expect(client.getQueryData(
      sessionTranscriptQueryKey(
        { directory: DIRECTORY, sessionID: "ses_1" },
        TRANSPORT,
        GENERATION,
      ),
    )).toBeTruthy()
    expect(client.getQueryData(
      sessionTranscriptQueryKey(
        { directory: DIRECTORY, sessionID: "ses_2" },
        TRANSPORT,
        GENERATION,
      ),
    )).toBeUndefined()
  })

  test("purgeSession cancels/removes canonical + transport + reserved families", () => {
    const s = scope("ses_purge")
    seedCanonicalTranscriptQuery(client, s, infinitePages(2), 100)
    seedTransportPageQuery(client, s, 4, undefined, { records: [], complete: true })
    seedTransportPageQuery(client, s, 4, "msg_1", { records: [], complete: false })
    client.setQueryData(
      sessionTranscriptTailTaskQueryKey(
        { directory: s.directory, sessionID: s.sessionID, purpose: "recovery" },
        s.transport,
        s.generation,
      ),
      { status: "running" },
    )
    client.setQueryData(
      sessionTranscriptReconcileTaskQueryKey(
        { directory: s.directory, sessionID: s.sessionID, checkpoint: "cp" },
        s.transport,
        s.generation,
      ),
      { status: "running" },
    )
    client.setQueryData(
      sessionTranscriptCheckpointQueryKey(
        { directory: s.directory, sessionID: s.sessionID },
        s.transport,
        s.generation,
      ),
      { anchorMessageID: "msg_1" },
    )
    // Unrelated session must survive.
    seedCanonicalTranscriptQuery(client, scope("ses_keep"), infinitePages(1), 200)

    const cancelBefore = counters.cancel
    const removeBefore = counters.remove
    budget.purgeSession(s)

    expect(counters.purgeSession).toBe(1)
    expect(counters.cancel).toBeGreaterThan(cancelBefore)
    expect(counters.remove).toBeGreaterThan(removeBefore)

    expect(client.getQueryData(
      sessionTranscriptQueryKey(
        { directory: s.directory, sessionID: s.sessionID },
        s.transport,
        s.generation,
      ),
    )).toBeUndefined()
    expect(client.getQueryData(
      sessionMessagePageQueryKey(
        { directory: s.directory, sessionID: s.sessionID, limit: 4 },
        s.transport,
        s.generation,
      ),
    )).toBeUndefined()
    expect(client.getQueryData(
      sessionTranscriptTailTaskQueryKey(
        { directory: s.directory, sessionID: s.sessionID, purpose: "recovery" },
        s.transport,
        s.generation,
      ),
    )).toBeUndefined()
    expect(client.getQueryData(
      sessionTranscriptCheckpointQueryKey(
        { directory: s.directory, sessionID: s.sessionID },
        s.transport,
        s.generation,
      ),
    )).toBeUndefined()
    expect(client.getQueryData(
      sessionTranscriptQueryKey(
        { directory: DIRECTORY, sessionID: "ses_keep" },
        TRANSPORT,
        GENERATION,
      ),
    )).toBeTruthy()
  })

  test("long-running growth: enforce bounds inactive cache under capacity", () => {
    const limit = 3
    budget = createTranscriptQueryCacheBudget({
      client,
      activeRegistry: registry,
      counters,
      getLimit: () => limit,
    })
    const release = registry.retain(scope("ses_view"))
    seedCanonicalTranscriptQuery(client, scope("ses_view"), infinitePages(8), 1000)

    for (let i = 0; i < 20; i += 1) {
      seedCanonicalTranscriptQuery(
        client,
        scope(`ses_bg_${i}`),
        infinitePages(1),
        i + 1,
      )
      budget.enforce({ preserve: [scope("ses_view")] })
    }

    const listed = budget.listCanonical({
      transport: TRANSPORT,
      generation: GENERATION,
      directory: DIRECTORY,
    })
    expect(listed.length).toBeLessThanOrEqual(limit)
    expect(listed.some((e) => e.scope.sessionID === "ses_view")).toBe(true)
    const view = listed.find((e) => e.scope.sessionID === "ses_view")
    expect(view?.pageCount).toBe(8)
    expect(counters.evictedSessions).toBeGreaterThan(0)
    release()
  })

  test("destructiveReset clears old chain; ensure success keeps only new chain", async () => {
    const s = scope("ses_reset")
    seedCanonicalTranscriptQuery(client, s, infinitePages(3), 10)
    seedTransportPageQuery(client, s, 4, "old_cursor", { records: [], complete: false })
    client.setQueryData(
      sessionTranscriptCheckpointQueryKey(
        { directory: s.directory, sessionID: s.sessionID },
        s.transport,
        s.generation,
      ),
      { state: "pending" },
    )

    const newData = infinitePages(1)
    const result = await budget.destructiveReset(s, async () => {
      seedCanonicalTranscriptQuery(client, s, newData, 999)
      return "ok"
    })
    expect(result).toBe("ok")
    expect(counters.destructiveReset).toBe(1)
    expect(client.getQueryData(
      sessionTranscriptQueryKey(
        { directory: s.directory, sessionID: s.sessionID },
        s.transport,
        s.generation,
      ),
    )).toEqual(newData)
    expect(client.getQueryData(
      sessionMessagePageQueryKey(
        { directory: s.directory, sessionID: s.sessionID, limit: 4, before: "old_cursor" },
        s.transport,
        s.generation,
      ),
    )).toBeUndefined()
    expect(client.getQueryData(
      sessionTranscriptCheckpointQueryKey(
        { directory: s.directory, sessionID: s.sessionID },
        s.transport,
        s.generation,
      ),
    )).toBeUndefined()
  })

  test("destructiveReset ensure failure does not restore old authoritative data", async () => {
    const s = scope("ses_fail")
    seedCanonicalTranscriptQuery(client, s, infinitePages(2), 10)
    seedTransportPageQuery(client, s, 4, undefined, { records: [], complete: true })

    await expect(
      budget.destructiveReset(s, async () => {
        throw new Error("ensure_failed")
      }),
    ).rejects.toThrow("ensure_failed")

    expect(client.getQueryData(
      sessionTranscriptQueryKey(
        { directory: s.directory, sessionID: s.sessionID },
        s.transport,
        s.generation,
      ),
    )).toBeUndefined()
    expect(client.getQueryData(
      sessionMessagePageQueryKey(
        { directory: s.directory, sessionID: s.sessionID, limit: 4 },
        s.transport,
        s.generation,
      ),
    )).toBeUndefined()
  })

  test("listCanonicalScopesForSession tracks seed / purge / eviction without ghosts", () => {
    seedCanonicalTranscriptQuery(client, scope("ses_idx"), infinitePages(1), 10)
    seedCanonicalTranscriptQuery(
      client,
      { ...scope("ses_idx"), directory: "/other" },
      infinitePages(1),
      20,
    )
    seedCanonicalTranscriptQuery(client, scope("ses_other"), infinitePages(1), 30)

    expect(
      budget.listCanonicalScopesForSession("ses_idx", {
        transport: TRANSPORT,
        generation: GENERATION,
      }).map((s) => s.directory).sort(),
    ).toEqual(["/other", DIRECTORY])
    expect(
      budget.listCanonicalScopesForSession("ses_idx", {
        transport: TRANSPORT,
        generation: GENERATION,
        directory: DIRECTORY,
      }),
    ).toEqual([scope("ses_idx")])

    budget.purgeSession(scope("ses_idx"))
    expect(
      budget.listCanonicalScopesForSession("ses_idx", {
        transport: TRANSPORT,
        generation: GENERATION,
      }).map((s) => s.directory),
    ).toEqual(["/other"])
    expect(
      budget.listCanonicalScopesForSession("ses_other", {
        transport: TRANSPORT,
        generation: GENERATION,
      }),
    ).toEqual([scope("ses_other")])

    // LRU eviction must drop the index entry (ghost scope would re-broadcast SSE).
    seedCanonicalTranscriptQuery(client, scope("ses_1"), infinitePages(1), 10)
    seedCanonicalTranscriptQuery(client, scope("ses_2"), infinitePages(1), 20)
    seedCanonicalTranscriptQuery(client, scope("ses_3"), infinitePages(1), 30)
    seedCanonicalTranscriptQuery(client, scope("ses_4"), infinitePages(1), 40)
    const { evicted } = budget.enforce()
    expect(evicted.map((s) => s.sessionID)).toContain("ses_1")
    expect(
      budget.listCanonicalScopesForSession("ses_1", {
        transport: TRANSPORT,
        generation: GENERATION,
      }),
    ).toEqual([])
  })

  test("purgeGeneration and dispose clear session scope index", () => {
    seedCanonicalTranscriptQuery(client, scope("ses_g1", 1), infinitePages(1), 10)
    seedCanonicalTranscriptQuery(client, scope("ses_g2", 2), infinitePages(1), 20)
    expect(
      budget.listCanonicalScopesForSession("ses_g1", {
        transport: TRANSPORT,
        generation: 1,
      }),
    ).toHaveLength(1)

    budget.purgeGeneration(TRANSPORT, 1)
    expect(
      budget.listCanonicalScopesForSession("ses_g1", {
        transport: TRANSPORT,
        generation: 1,
      }),
    ).toEqual([])
    expect(
      budget.listCanonicalScopesForSession("ses_g2", {
        transport: TRANSPORT,
        generation: 2,
      }),
    ).toHaveLength(1)

    budget.dispose()
    expect(
      budget.listCanonicalScopesForSession("ses_g2", {
        transport: TRANSPORT,
        generation: 2,
      }),
    ).toEqual([])
  })

  test("purgeGeneration isolates runtime generations", () => {
    seedCanonicalTranscriptQuery(client, scope("ses_g1", 1), infinitePages(1), 10)
    seedCanonicalTranscriptQuery(client, scope("ses_g2", 2), infinitePages(1), 20)
    seedTransportPageQuery(client, scope("ses_g1", 1), 4, undefined, { records: [] })
    seedTransportPageQuery(client, scope("ses_g2", 2), 4, undefined, { records: [] })

    budget.purgeGeneration(TRANSPORT, 1)

    expect(client.getQueryData(
      sessionTranscriptQueryKey(
        { directory: DIRECTORY, sessionID: "ses_g1" },
        TRANSPORT,
        1,
      ),
    )).toBeUndefined()
    expect(client.getQueryData(
      sessionTranscriptQueryKey(
        { directory: DIRECTORY, sessionID: "ses_g2" },
        TRANSPORT,
        2,
      ),
    )).toBeTruthy()
    expect(client.getQueryData(
      sessionMessagePageQueryKey(
        { directory: DIRECTORY, sessionID: "ses_g2", limit: 4 },
        TRANSPORT,
        2,
      ),
    )).toBeTruthy()
  })

  test("operation counters increment for enforce and purge paths", () => {
    seedCanonicalTranscriptQuery(client, scope("a"), infinitePages(1), 1)
    seedCanonicalTranscriptQuery(client, scope("b"), infinitePages(1), 2)
    seedCanonicalTranscriptQuery(client, scope("c"), infinitePages(1), 3)
    seedCanonicalTranscriptQuery(client, scope("d"), infinitePages(1), 4)
    budget.enforce()
    expect(counters.enforce).toBe(1)
    expect(counters.evictedSessions).toBe(1)
    expect(counters.purgeSession).toBe(1)
    expect(counters.cancel).toBeGreaterThan(0)
    expect(counters.remove).toBeGreaterThan(0)
  })
})

describe("Query adapter cache budget integration", () => {
  let client: QueryClient

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 1, gcTime: Infinity } },
    })
  })

  test("repository subscribe retains active scope without Query observers", () => {
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      cacheBudget: createTranscriptQueryCacheBudget({
        client,
        getLimit: () => 2,
      }),
    })
    const scopeA = {
      directory: DIRECTORY,
      sessionID: "ses_a",
      transport: TRANSPORT,
      generation: GENERATION,
    }
    const unsub = repo.subscribe(scopeA, () => {})
    expect(repo.getCacheBudget().isActive({
      transport: TRANSPORT,
      generation: GENERATION,
      directory: DIRECTORY,
      sessionID: "ses_a",
    })).toBe(true)
    // Seed three inactive + one active via subscribe.
    for (const id of ["ses_b", "ses_c", "ses_d"]) {
      seedCanonicalTranscriptQuery(
        client,
        { transport: TRANSPORT, generation: GENERATION, directory: DIRECTORY, sessionID: id },
        infinitePages(1),
        id === "ses_b" ? 1 : id === "ses_c" ? 2 : 3,
      )
    }
    seedCanonicalTranscriptQuery(
      client,
      { transport: TRANSPORT, generation: GENERATION, directory: DIRECTORY, sessionID: "ses_a" },
      infinitePages(4),
      100,
    )
    const { evicted } = repo.getCacheBudget().enforce()
    expect(evicted.some((e) => e.sessionID === "ses_a")).toBe(false)
    const active = repo.getCacheBudget().listCanonical().find((e) => e.scope.sessionID === "ses_a")
    expect(active?.pageCount).toBe(4)
    unsub()
    expect(repo.getCacheBudget().isActive({
      transport: TRANSPORT,
      generation: GENERATION,
      directory: DIRECTORY,
      sessionID: "ses_a",
    })).toBe(false)
    repo.destroy()
  })

  test("destructiveReset via adapter ensure fails without restoring old pages", async () => {
    const pages = new Map<string, TranscriptTransportPage>()
    pages.set("tail", transportPage(
      [{ info: userMessage("msg_new"), parts: [textPart("p_new", "msg_new")] }],
      { complete: true },
    ))
    // Controller may attempt fetchNextPage + refetch; keep failing until re-enabled.
    let allowFetch = false
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      initialLimit: 2,
      historyLimit: 2,
      fetcher: async () => {
        if (!allowFetch) throw new Error("tail_fetch_failed")
        return pages.get("tail")!
      },
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
    })
    const s = {
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    }
    // Seed old authoritative multi-page chain outside ensure.
    seedCanonicalTranscriptQuery(
      client,
      { transport: TRANSPORT, generation: GENERATION, directory: DIRECTORY, sessionID: "ses_1" },
      infinitePages(3),
      1,
    )
    seedTransportPageQuery(
      client,
      { transport: TRANSPORT, generation: GENERATION, directory: DIRECTORY, sessionID: "ses_1" },
      2,
      "old",
      { records: [], complete: false },
    )

    await expect(repo.destructiveReset(s)).rejects.toThrow("tail_fetch_failed")
    expect(repo.getTranscript(s).messageOrder).toHaveLength(0)
    expect(client.getQueryData(
      sessionMessagePageQueryKey(
        { directory: DIRECTORY, sessionID: "ses_1", limit: 2, before: "old" },
        TRANSPORT,
        GENERATION,
      ),
    )).toBeUndefined()

    // Retry succeeds and only the new chain remains.
    allowFetch = true
    const next = await repo.destructiveReset(s)
    expect(next.messageOrder).toContain("msg_new")
    expect(repo.getTranscript(s).messageOrder).toEqual(["msg_new"])
    repo.destroy()
  })

  test("apply reset without page purges key families", () => {
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
    })
    const s = {
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    }
    seedCanonicalTranscriptQuery(
      client,
      { transport: TRANSPORT, generation: GENERATION, directory: DIRECTORY, sessionID: "ses_1" },
      infinitePages(1),
      1,
    )
    client.setQueryData(
      sessionTranscriptCheckpointQueryKey(
        { directory: DIRECTORY, sessionID: "ses_1" },
        TRANSPORT,
        GENERATION,
      ),
      { state: "pending" },
    )
    repo.apply(s, { type: "reset" })
    expect(repo.getTranscript(s).messageOrder).toHaveLength(0)
    expect(client.getQueryData(
      sessionTranscriptCheckpointQueryKey(
        { directory: DIRECTORY, sessionID: "ses_1" },
        TRANSPORT,
        GENERATION,
      ),
    )).toBeUndefined()
    repo.destroy()
  })
})
