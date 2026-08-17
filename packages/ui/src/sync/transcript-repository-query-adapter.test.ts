import { beforeEach, describe, expect, test } from "bun:test"
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query"
import type { Event, Message, Part } from "@opencode-ai/sdk/v2/client"

import {
  createSessionTranscriptController,
  getPreviousTranscriptPageParam,
  isRetryableSessionMessagePageError,
  sessionMessagePageQueryKey,
  sessionMessagePageRetry,
  sessionTranscriptQueryKey,
  SessionMessageHttpError,
  SessionMessagePageContractError,
  type SessionTranscriptFetcher,
} from "./session-message-query"
// sessionMessagePageRetry used in failure-retention test for 4xx no-retry.
import { createTranscriptActiveScopeRegistry } from "./session-transcript-query-cache"
import { createQueryTranscriptRepository } from "./transcript-repository-query-adapter"
import { createMemoryTranscriptDurableStore } from "./transcript-durable-store"
import { createTranscriptDurableQueryQueue } from "./transcript-durable-store-query"
import {
  messageNeedsExactMaterialization,
  type TranscriptTransportPage,
} from "./transcript-repository"

const DIRECTORY = "/repo"
const SESSION = "ses_1"
const TRANSPORT = "runtime-a"
const GENERATION = 1

function userMessage(id: string): Message {
  return { id, sessionID: SESSION, role: "user", time: { created: 1 } } as Message
}

function assistantMessage(id: string): Message {
  return { id, sessionID: SESSION, role: "assistant", time: { created: 1 } } as Message
}

function textPart(id: string, messageID: string, text = id): Part {
  return { id, messageID, sessionID: SESSION, type: "text", text } as Part
}

function transportPage(
  records: Array<{ info: Message; parts?: Part[] }>,
  options: { cursor?: string; complete?: boolean; turnCount?: number } = {},
): TranscriptTransportPage {
  return {
    records: records.map((record) => ({
      info: record.info,
      parts: record.parts ?? [],
    })),
    cursor: options.cursor,
    complete: options.complete ?? !options.cursor,
    turnCount: options.turnCount ?? 1,
  }
}

describe("session transcript query keys", () => {
  test("canonical key includes transport, generation, directory, sessionID", () => {
    expect(sessionTranscriptQueryKey(
      { directory: " /repo ", sessionID: SESSION },
      TRANSPORT,
      GENERATION,
    )).toEqual([TRANSPORT, GENERATION, "session-transcript", "/repo", SESSION])
  })

  test("transport page key includes generation", () => {
    expect(sessionMessagePageQueryKey(
      { directory: "/repo", sessionID: SESSION, limit: 4, before: "msg_1" },
      TRANSPORT,
      GENERATION,
    )).toEqual([
      TRANSPORT,
      GENERATION,
      "sessionMessages",
      "page",
      "/repo",
      SESSION,
      4,
      "msg_1",
    ])
  })
})

describe("retry classification", () => {
  test("retries network / timeout / 502 / 503 / 504 up to twice", () => {
    expect(isRetryableSessionMessagePageError(new Error("Failed to fetch"))).toBe(true)
    expect(isRetryableSessionMessagePageError(new Error("timed out after 30000ms"))).toBe(true)
    expect(isRetryableSessionMessagePageError(new SessionMessageHttpError(502))).toBe(true)
    expect(isRetryableSessionMessagePageError(new SessionMessageHttpError(503))).toBe(true)
    expect(isRetryableSessionMessagePageError(new SessionMessageHttpError(504))).toBe(true)
    expect(sessionMessagePageRetry(0, new SessionMessageHttpError(503))).toBe(true)
    expect(sessionMessagePageRetry(1, new SessionMessageHttpError(503))).toBe(true)
    expect(sessionMessagePageRetry(2, new SessionMessageHttpError(503))).toBe(false)
  })

  test("fails immediately on 4xx and contract errors", () => {
    expect(isRetryableSessionMessagePageError(new SessionMessageHttpError(404))).toBe(false)
    expect(isRetryableSessionMessagePageError(new SessionMessageHttpError(400))).toBe(false)
    expect(isRetryableSessionMessagePageError(new SessionMessagePageContractError("bad cursor"))).toBe(false)
    expect(sessionMessagePageRetry(0, new SessionMessageHttpError(404))).toBe(false)
  })
})

describe("getPreviousTranscriptPageParam", () => {
  test("complete closes previous page", () => {
    expect(getPreviousTranscriptPageParam({
      kind: "tail",
      messageOrder: [],
      messagesByID: {},
      partsByMessageID: {},
      cursor: null,
      complete: true,
      turnCount: 1,
      sync: { liveRevision: 0, confirmedHeadMessageID: null },
    })).toBe(undefined)
  })

  test("incomplete returns cursor", () => {
    expect(getPreviousTranscriptPageParam({
      kind: "tail",
      messageOrder: [],
      messagesByID: {},
      partsByMessageID: {},
      cursor: "msg_10",
      complete: false,
      turnCount: 1,
      sync: { liveRevision: 0, confirmedHeadMessageID: null },
    })).toBe("msg_10")
  })
})

describe("InfiniteQueryObserver transcript controller", () => {
  let client: QueryClient
  let calls: Array<{ before?: string; limit: number }>
  let pages: Map<string, TranscriptTransportPage>

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          retryDelay: 1,
        },
      },
    })
    calls = []
    pages = new Map()
    pages.set("tail", transportPage(
      [
        { info: userMessage("msg_10"), parts: [textPart("p10", "msg_10")] },
        { info: assistantMessage("msg_11"), parts: [textPart("p11", "msg_11")] },
      ],
      { cursor: "msg_10", complete: false, turnCount: 1 },
    ))
    pages.set("msg_10", transportPage(
      [
        { info: userMessage("msg_01"), parts: [textPart("p01", "msg_01")] },
        { info: assistantMessage("msg_02"), parts: [textPart("p02", "msg_02")] },
      ],
      { cursor: "msg_01", complete: false, turnCount: 1 },
    ))
    pages.set("msg_01", transportPage(
      [{ info: userMessage("msg_00"), parts: [textPart("p00", "msg_00")] }],
      { complete: true, turnCount: 1 },
    ))
  })

  const fetcher: SessionTranscriptFetcher = async ({ before, limit }) => {
    calls.push({ before, limit })
    const key = before?.trim() || "tail"
    const page = pages.get(key)
    if (!page) throw new Error(`missing page ${key}`)
    return page
  }

  const makeController = (overrides?: Partial<Parameters<typeof createSessionTranscriptController>[0]>) =>
    createSessionTranscriptController({
      directory: DIRECTORY,
      sessionID: SESSION,
      fetcher,
      transport: TRANSPORT,
      generation: GENERATION,
      client,
      initialLimit: 2,
      historyLimit: 2,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      ...overrides,
    })

  test("initial tail via real InfiniteQueryObserver", async () => {
    const controller = makeController()
    const data = await controller.ensureInitial()
    expect(data.pages).toHaveLength(1)
    expect(data.pages[0]?.messageOrder).toEqual(["msg_10", "msg_11"])
    expect(data.pages[0]?.cursor).toBe("msg_10")
    expect(calls.filter((c) => !c.before)).toHaveLength(1)
    controller.destroy()
  })

  test("fetchPreviousPage prepends older page and shares concurrent flights", async () => {
    const controller = makeController()
    await controller.ensureInitial()
    calls.length = 0

    let release: ((page: TranscriptTransportPage) => void) | undefined
    const slowFetcher: SessionTranscriptFetcher = async ({ before, limit }) => {
      calls.push({ before, limit })
      if (!before) return pages.get("tail")!
      return new Promise((resolve) => {
        release = resolve
      })
    }
    const slow = createSessionTranscriptController({
      directory: DIRECTORY,
      sessionID: SESSION,
      fetcher: slowFetcher,
      transport: TRANSPORT,
      generation: GENERATION,
      client,
      initialLimit: 2,
      historyLimit: 2,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
    })
    // Seed cache with tail so previous page can run.
    client.setQueryData(sessionTranscriptQueryKey(
      { directory: DIRECTORY, sessionID: SESSION },
      TRANSPORT,
      GENERATION,
    ), await controller.getData() ?? (await controller.ensureInitial()))

    const first = slow.fetchPreviousPage()
    const second = slow.fetchPreviousPage()
    // Allow microtasks to schedule the fetch.
    await Promise.resolve()
    expect(calls.filter((c) => c.before === "msg_10").length).toBeLessThanOrEqual(1)
    release?.(pages.get("msg_10")!)
    const [a, b] = await Promise.all([first, second])
    expect(a.pages.length).toBeGreaterThanOrEqual(1)
    expect(b.pages.length).toBe(a.pages.length)
    slow.destroy()
    controller.destroy()
  })

  test("pagination failure retains existing pages", async () => {
    // Seed a ready infinite query with one page, then fail previous-page fetch.
    // Disable retry so the failure settles immediately.
    const key = sessionTranscriptQueryKey(
      { directory: DIRECTORY, sessionID: "ses_fail" },
      TRANSPORT,
      GENERATION,
    )
    const seeded = {
      pages: [
        {
          kind: "tail" as const,
          messageOrder: ["msg_10", "msg_11"],
          messagesByID: {
            msg_10: userMessage("msg_10"),
            msg_11: assistantMessage("msg_11"),
          },
          partsByMessageID: {},
          cursor: "msg_10",
          complete: false,
          turnCount: 1,
          sync: { liveRevision: 0, confirmedHeadMessageID: "msg_11" },
        },
      ],
      pageParams: [null as string | null],
    }
    client.setQueryData(key, seeded)

    let failCalls = 0
    const failing: SessionTranscriptFetcher = async ({ before }) => {
      if (!before) {
        return transportPage(
          [{ info: userMessage("msg_10") }, { info: assistantMessage("msg_11") }],
          { cursor: "msg_10", complete: false },
        )
      }
      failCalls += 1
      throw new SessionMessageHttpError(400, "session turn page failed (400)")
    }

    const failClient = new QueryClient({
      defaultOptions: {
        queries: {
          // Classified retry still applies via options; 4xx must not retry.
          retry: sessionMessagePageRetry,
          retryDelay: 1,
        },
      },
    })
    failClient.setQueryData(key, seeded)

    const failController = createSessionTranscriptController({
      directory: DIRECTORY,
      sessionID: "ses_fail",
      fetcher: failing,
      transport: TRANSPORT,
      generation: GENERATION,
      client: failClient,
      initialLimit: 2,
      historyLimit: 2,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
    })

    // Subscribe so the observer is active and sees seeded data.
    const unsub = failController.subscribe(() => undefined)
    // Ensure observer has current options with seeded cache.
    expect(failController.getData()?.pages.length ?? 0).toBeGreaterThanOrEqual(0)

    let caught: unknown
    try {
      await failController.fetchPreviousPage()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    const retained = (caught as { retainedPages?: { pages: unknown[] } })?.retainedPages
    const after = failClient.getQueryData(key) as { pages: unknown[] } | undefined
    expect((retained?.pages.length ?? after?.pages.length ?? 0)).toBe(1)
    expect(failCalls).toBeGreaterThan(0)
    unsub()
    failController.destroy()
  })

  test("complete page closes hasPreviousPage on observer", async () => {
    pages.set("tail", transportPage(
      [{ info: userMessage("only") }],
      { complete: true, turnCount: 1 },
    ))
    const controller = makeController()
    await controller.ensureInitial()
    const result = controller.observer.getCurrentResult()
    expect(result.hasPreviousPage).toBe(false)
    controller.destroy()
  })
})

describe("createQueryTranscriptRepository", () => {
  let client: QueryClient
  const scope = {
    directory: DIRECTORY,
    sessionID: SESSION,
    transport: TRANSPORT,
    generation: GENERATION,
  }

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 1 } },
    })
  })

  test("apply http-page + getTranscript + pagination", () => {
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
    })
    const result = repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage(
        [
          { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1")] },
          { info: assistantMessage("msg_2"), parts: [textPart("p2", "msg_2")] },
        ],
        { cursor: "msg_1", complete: false, turnCount: 1 },
      ),
    })
    expect(result.applied).toBe(true)
    const transcript = repo.getTranscript(scope)
    expect(transcript.messageOrder).toEqual(["msg_1", "msg_2"])
    expect(repo.getMessage(scope, "msg_1")?.id).toBe("msg_1")
    expect(repo.getParts(scope, "msg_1")[0]?.id).toBe("p1")
    const pagination = repo.getPagination(scope)
    expect(pagination.hasPreviousPage).toBe(true)
    expect(pagination.cursor).toBe("msg_1")
    repo.destroy()
  })

  test("SSE merge via setQueryData preserves unrelated message refs", () => {
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage(
        [
          { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "a")] },
          { info: assistantMessage("msg_2"), parts: [textPart("p2", "msg_2", "b")] },
        ],
        { complete: true },
      ),
    })
    const beforeUser = repo.getMessage(scope, "msg_1")
    const beforeUserParts = repo.getParts(scope, "msg_1")

    repo.apply(scope, {
      type: "sse-event",
      event: {
        type: "message.part.updated",
        properties: { part: textPart("p2", "msg_2", "b2") },
      } as Event,
    })
    expect(repo.getMessage(scope, "msg_1")).toBe(beforeUser)
    expect(repo.getParts(scope, "msg_1")).toBe(beforeUserParts)
    expect((repo.getParts(scope, "msg_2")[0] as { text?: string })?.text).toBe("b2")
    repo.destroy()
  })

  test("narrow subscribe notifies on change and keeps pagination stable when unchanged", () => {
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
    })
    let notifyCount = 0
    const unsub = repo.subscribe(scope, () => {
      notifyCount += 1
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage(
        [{ info: userMessage("msg_1"), parts: [textPart("p1", "msg_1")] }],
        { complete: true },
      ),
    })
    expect(notifyCount).toBeGreaterThan(0)
    const paginationA = repo.getPagination(scope)
    const paginationB = repo.getPagination(scope)
    expect(paginationA).toBe(paginationB)
    unsub()
    repo.destroy()
  })

  test("ensureInitial + fetchPreviousPage through repository", async () => {
    const pages = new Map<string, TranscriptTransportPage>()
    pages.set("tail", transportPage(
      [{ info: userMessage("msg_10") }, { info: assistantMessage("msg_11") }],
      { cursor: "msg_10", complete: false },
    ))
    pages.set("msg_10", transportPage(
      [{ info: userMessage("msg_01") }],
      { complete: true },
    ))
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      initialLimit: 2,
      historyLimit: 2,
      fetcher: async ({ before }) => {
        const key = before?.trim() || "tail"
        const page = pages.get(key)
        if (!page) throw new Error(`missing ${key}`)
        return page
      },
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
    })

    const initial = await repo.ensureInitial(scope)
    expect(initial.messageOrder).toContain("msg_10")
    const older = await repo.fetchPreviousPage(scope)
    expect(older.messageOrder[0]).toBe("msg_01")
    expect(repo.getPagination(scope).isComplete).toBe(true)
    repo.destroy()
  })

  test("reset clears transcript", () => {
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([{ info: userMessage("msg_1") }], { complete: true }),
    })
    expect(repo.getTranscript(scope).messageOrder).toHaveLength(1)
    repo.apply(scope, { type: "reset" })
    expect(repo.getTranscript(scope).messageOrder).toHaveLength(0)
    repo.destroy()
  })

  test("hasSession is false when canonical query data is absent", () => {
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
    })
    expect(repo.hasSession?.(scope)).toBe(false)
    expect(repo.getTranscript(scope).messageOrder).toHaveLength(0)
    repo.destroy()
  })

  test("hasSession is true for non-empty loaded transcript", () => {
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([{ info: userMessage("msg_1") }], { complete: true }),
    })
    expect(repo.hasSession?.(scope)).toBe(true)
    expect(repo.getTranscript(scope).messageOrder).toEqual(["msg_1"])
    repo.destroy()
  })

  test("hasSession is true for successfully loaded empty tail", async () => {
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      initialLimit: 2,
      historyLimit: 2,
      fetcher: async () => transportPage([], { complete: true, turnCount: 0 }),
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
    })
    expect(repo.hasSession?.(scope)).toBe(false)
    const data = await repo.ensureInitial(scope)
    expect(data.messageOrder).toHaveLength(0)
    expect(repo.hasSession?.(scope)).toBe(true)
    // Projection still empty but session is resolved (not unknown).
    expect(repo.getTranscript(scope).messageOrder).toHaveLength(0)
    repo.destroy()
  })

  test("hasSession is false after reset removes canonical entry", () => {
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([{ info: userMessage("msg_1") }], { complete: true }),
    })
    expect(repo.hasSession?.(scope)).toBe(true)
    repo.apply(scope, { type: "reset" })
    expect(repo.hasSession?.(scope)).toBe(false)
    expect(repo.getTranscript(scope).messageOrder).toHaveLength(0)
    repo.destroy()
  })

  test("ensureInitial on a hot cache does not refetch or replace bodies", async () => {
    let fetches = 0
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      initialLimit: 2,
      historyLimit: 2,
      fetcher: async () => {
        fetches += 1
        if (fetches === 1) {
          return transportPage(
            [{ info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "stale")] }],
            { complete: true },
          )
        }
        return transportPage(
          [{ info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "fresh")] }],
          { complete: true },
        )
      },
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
    })

    await repo.ensureInitial(scope)
    await repo.ensureInitial(scope)
    expect(fetches).toBe(1)
    expect((repo.getParts(scope, "msg_1")[0] as { text?: string })?.text).toBe("stale")
    repo.destroy()
  })

  test("refreshFromAuthority fetches on a hot cache and replaces the tail", async () => {
    let fetches = 0
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      initialLimit: 2,
      historyLimit: 2,
      fetcher: async () => {
        fetches += 1
        if (fetches === 1) {
          return transportPage(
            [
              { info: userMessage("msg_old"), parts: [textPart("p_old", "msg_old", "stale")] },
              { info: assistantMessage("msg_extra") },
            ],
            { complete: true },
          )
        }
        return transportPage(
          [
            { info: userMessage("msg_old"), parts: [textPart("p_old", "msg_old", "fresh")] },
            { info: assistantMessage("msg_new"), parts: [textPart("p_new", "msg_new", "added")] },
          ],
          { complete: true },
        )
      },
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
    })

    await repo.ensureInitial(scope)
    expect(repo.getTranscript(scope).messageOrder).toEqual(["msg_old", "msg_extra"])
    expect((repo.getParts(scope, "msg_old")[0] as { text?: string })?.text).toBe("stale")

    const refreshed = await repo.refreshFromAuthority(scope)
    expect(fetches).toBe(2)
    expect(refreshed.messageOrder).toEqual(["msg_old", "msg_new"])
    expect((repo.getParts(scope, "msg_old")[0] as { text?: string })?.text).toBe("fresh")
    expect(repo.getMessage(scope, "msg_extra")).toBeUndefined()
    expect(repo.getMessage(scope, "msg_new")?.id).toBe("msg_new")
    repo.destroy()
  })

  test("refreshFromAuthority keeps the prior transcript when the fetch fails", async () => {
    let fetches = 0
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      initialLimit: 2,
      historyLimit: 2,
      fetcher: async () => {
        fetches += 1
        if (fetches === 1) {
          return transportPage(
            [{ info: userMessage("msg_keep"), parts: [textPart("p_keep", "msg_keep", "keep")] }],
            { complete: true },
          )
        }
        throw new Error("authority_unavailable")
      },
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
    })

    await repo.ensureInitial(scope)
    await expect(repo.refreshFromAuthority(scope)).rejects.toThrow("authority_unavailable")
    expect(repo.getTranscript(scope).messageOrder).toEqual(["msg_keep"])
    expect((repo.getParts(scope, "msg_keep")[0] as { text?: string })?.text).toBe("keep")
    repo.destroy()
  })

  test("refreshFromAuthority drops unmatched optimistic ids after a successful fetch", async () => {
    const cleared: string[] = []
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      initialLimit: 2,
      historyLimit: 2,
      clearOptimisticShadow: ({ messageID }) => {
        cleared.push(messageID)
      },
      fetcher: async () => transportPage(
        [{ info: userMessage("msg_server") }],
        { complete: true },
      ),
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
    })

    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage(
        [
          { info: userMessage("msg_server") },
          { info: userMessage("msg_optimistic") },
        ],
        { complete: true },
      ),
    })
    const refreshed = await repo.refreshFromAuthority(scope)
    expect(refreshed.messageOrder).toEqual(["msg_server"])
    expect(cleared).toEqual(["msg_optimistic"])
    repo.destroy()
  })

  test("hasSession is true for empty-records http-page apply (loaded empty)", () => {
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([], { complete: true, turnCount: 0 }),
    })
    expect(repo.hasSession?.(scope)).toBe(true)
    expect(repo.getTranscript(scope).messageOrder).toHaveLength(0)
    repo.destroy()
  })
})

describe("Query repository durable cache wiring", () => {
  let client: QueryClient
  const scope = {
    directory: DIRECTORY,
    sessionID: SESSION,
    transport: TRANSPORT,
    generation: GENERATION,
  }
  const durableScope = {
    transport: TRANSPORT,
    generation: GENERATION,
    directory: DIRECTORY,
    sessionID: SESSION,
  }

  const waitUntil = async (predicate: () => boolean | Promise<boolean>, timeout = 800) => {
    const started = Date.now()
    while (!(await predicate())) {
      if (Date.now() - started > timeout) throw new Error("timed out waiting for durable side effect")
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  const settledAssistant = (id: string, text: string, slim = false): { info: Message; parts: Part[] } => ({
    info: { id, sessionID: SESSION, role: "assistant", time: { created: 2 }, finish: "stop" } as Message,
    parts: [{
      id: `${id}-p`,
      messageID: id,
      sessionID: SESSION,
      type: "text",
      text,
      ...(slim ? { slim: true } : {}),
    } as Part],
  })

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 1 } },
    })
  })

  test("local durable hit notifies before the authority tail returns, and the tail still fetches once", async () => {
    const inner = createMemoryTranscriptDurableStore()
    await inner.upsertSettled(durableScope, userMessage("msg_local"), [textPart("p_local", "msg_local", "cached")])
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let fetches = 0
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      durableStore: inner,
      fetcher: async () => {
        fetches += 1
        await gate
        return transportPage(
          [{ info: userMessage("msg_server"), parts: [textPart("p_server", "msg_server", "live")] }],
          { complete: true },
        )
      },
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
    })
    const paints: string[][] = []
    repo.subscribe(scope, () => {
      paints.push([...repo.getTranscript(scope).messageOrder])
    })
    const pending = repo.ensureInitial(scope)
    await waitUntil(() => paints.some((order) => order.includes("msg_local")))
    expect(repo.getTranscript(scope).messageOrder).toContain("msg_local")
    expect(repo.getPagination(scope).boundary.kind).toBe("unknown")
    expect(repo.getPagination(scope).isComplete).toBe(false)
    expect(repo.getRequestState?.(scope)?.status).toBe("loading")
    release()
    await pending
    expect(fetches).toBe(1)
    expect(repo.getTranscript(scope).messageOrder).toContain("msg_server")
    repo.destroy()
  })

  test("identical HTTP content does not produce another durable write", async () => {
    const inner = createMemoryTranscriptDurableStore()
    const upserts: Array<"written" | "skipped"> = []
    const durableStore = {
      ...inner,
      upsertSettled: async (...args: Parameters<typeof inner.upsertSettled>) => {
        const result = await inner.upsertSettled(...args)
        upserts.push(result.status)
        return result
      },
    }
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      durableStore,
    })
    const page = transportPage(
      [{ info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "same")] }],
      { complete: true },
    )
    repo.apply(scope, { type: "http-page", purpose: "initial", page })
    await waitUntil(() => upserts.length >= 1)
    repo.apply(scope, { type: "http-page", purpose: "initial", page })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(upserts.filter((status) => status === "written")).toHaveLength(1)
    repo.destroy()
  })

  test("HTTP full overlays a local slim record and persists the full snapshot", async () => {
    const inner = createMemoryTranscriptDurableStore()
    const slim = settledAssistant("msg_asst", "summary", true)
    await inner.upsertSettled(durableScope, slim.info, slim.parts)
    const full = settledAssistant("msg_asst", "full body")
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      durableStore: inner,
      fetcher: async () => transportPage([full], { complete: true }),
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
    })
    await repo.ensureInitial(scope)
    expect((repo.getParts(scope, "msg_asst")[0] as { text?: string })?.text).toBe("full body")
    await waitUntil(async () => {
      const stored = await inner.readMessage(durableScope, "msg_asst")
      return stored?.completeness === "full"
    })
    expect((await inner.readMessage(durableScope, "msg_asst"))?.completeness).toBe("full")
    repo.destroy()
  })

  test("remove-message and message.removed cascade into the durable store", async () => {
    const inner = createMemoryTranscriptDurableStore()
    const removed: string[] = []
    const durableStore = {
      ...inner,
      removeMessage: async (target: typeof durableScope, messageID: string) => {
        removed.push(messageID)
        await inner.removeMessage(target, messageID)
      },
    }
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      durableStore,
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage(
        [
          { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1")] },
          { info: userMessage("msg_2"), parts: [textPart("p2", "msg_2")] },
        ],
        { complete: true },
      ),
    })
    repo.apply(scope, { type: "remove-message", messageID: "msg_1" })
    repo.apply(scope, {
      type: "sse-event",
      event: {
        type: "message.removed",
        properties: { sessionID: SESSION, messageID: "msg_2" },
      } as Event,
    })
    await waitUntil(() => removed.includes("msg_1") && removed.includes("msg_2"))
    expect(await inner.readMessage(durableScope, "msg_1")).toBeUndefined()
    expect(await inner.readMessage(durableScope, "msg_2")).toBeUndefined()
    repo.destroy()
  })

  test("destructive reset clears the durable session before the new ensure", async () => {
    const inner = createMemoryTranscriptDurableStore()
    let clears = 0
    const durableStore = {
      ...inner,
      clearSession: async (target: typeof durableScope) => {
        clears += 1
        await inner.clearSession(target)
      },
    }
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      durableStore,
      fetcher: async () => transportPage([], { complete: true, turnCount: 0 }),
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([{ info: userMessage("msg_old") }], { complete: true }),
    })
    await waitUntil(async () => (await inner.readSession(durableScope)).records.length === 1)
    await repo.destructiveReset(scope)
    expect(clears).toBeGreaterThan(0)
    expect((await inner.readSession(durableScope)).records).toEqual([])
    expect(repo.getTranscript(scope).messageOrder).toEqual([])
    repo.destroy()
  })

  test("a runtime-stale durable read does not seed or persist into the new scope", async () => {
    const inner = createMemoryTranscriptDurableStore()
    await inner.upsertSettled(
      { ...durableScope, generation: 1 },
      userMessage("msg_local"),
      [textPart("p_local", "msg_local", "stale-gen")],
    )
    let generation = 1
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const persistedGens: number[] = []
    const durableStore = {
      ...inner,
      readSession: async (target: typeof durableScope) => {
        await gate
        return inner.readSession(target)
      },
      upsertSettled: async (target: typeof durableScope, info: Message, parts: readonly Part[]) => {
        persistedGens.push(target.generation)
        return inner.upsertSettled(target, info, parts)
      },
    }
    const repo = createQueryTranscriptRepository({
      client,
      durableStore,
      fetcher: async () => transportPage(
        [{ info: userMessage("msg_server") }],
        { complete: true },
      ),
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => generation,
      },
    })
    const pending = repo.ensureInitial({ directory: DIRECTORY, sessionID: SESSION })
    generation = 2
    release()
    await pending
    const live = repo.getTranscript({ directory: DIRECTORY, sessionID: SESSION })
    expect(live.messageOrder).not.toContain("msg_local")
    expect(persistedGens.every((value) => value !== 2 || live.messageOrder.includes("msg_server"))).toBe(true)
    expect(await inner.readMessage({ ...durableScope, generation: 2 }, "msg_local")).toBeUndefined()
    repo.destroy()
  })

  test("durable read failure keeps the network authority path", async () => {
    const durableStore = {
      ...createMemoryTranscriptDurableStore(),
      readSession: async () => {
        throw new Error("idb down")
      },
    }
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      durableStore,
      fetcher: async () => transportPage(
        [{ info: userMessage("msg_server") }],
        { complete: true },
      ),
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
    })
    const data = await repo.ensureInitial(scope)
    expect(data.messageOrder).toEqual(["msg_server"])
    expect(repo.getRequestState?.(scope)?.status).not.toBe("error")
    repo.destroy()
  })

  test("authority fetch failure keeps the durable paint and exposes request error", async () => {
    const inner = createMemoryTranscriptDurableStore()
    await inner.upsertSettled(durableScope, userMessage("msg_local"), [textPart("p_local", "msg_local")])
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      durableStore: inner,
      fetcher: async () => {
        throw new SessionMessageHttpError(404)
      },
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
    })
    await expect(repo.ensureInitial(scope)).rejects.toThrow()
    expect(repo.getTranscript(scope).messageOrder).toContain("msg_local")
    expect(repo.getPagination(scope).boundary.kind).toBe("unknown")
    expect(repo.getPagination(scope).isComplete).toBe(false)
    expect(repo.hasSession?.(scope)).toBe(true)
    expect(repo.getRequestState?.(scope)?.status).toBe("error")
    expect(repo.getRequestState?.(scope)?.error).toBeDefined()
    repo.destroy()
  })

  test("empty authority success stays distinct from a request error", async () => {
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      durableStore: createMemoryTranscriptDurableStore(),
      fetcher: async () => transportPage([], { complete: true, turnCount: 0 }),
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
    })
    const data = await repo.ensureInitial(scope)
    expect(data.messageOrder).toEqual([])
    expect(repo.hasSession?.(scope)).toBe(true)
    expect(repo.getRequestState?.(scope)?.status).not.toBe("error")
    repo.destroy()
  })

  test("durable full survives an authority slim page in Query and the store", async () => {
    const inner = createMemoryTranscriptDurableStore()
    const full = settledAssistant("msg_asst", "full body")
    await inner.upsertSettled(durableScope, full.info, full.parts)
    const slim = settledAssistant("msg_asst", "summary", true)
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      durableStore: inner,
      fetcher: async () => transportPage([slim], { complete: true }),
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
    })
    await repo.ensureInitial(scope)
    expect((repo.getParts(scope, "msg_asst")[0] as { text?: string })?.text).toBe("full body")
    expect((repo.getParts(scope, "msg_asst")[0] as { slim?: boolean })?.slim).not.toBe(true)
    await waitUntil(async () => {
      const stored = await inner.readMessage(durableScope, "msg_asst")
      return stored?.completeness === "full"
        && (stored.parts[0] as { text?: string })?.text === "full body"
    })
    expect((await inner.readMessage(durableScope, "msg_asst"))?.completeness).toBe("full")
    repo.destroy()
  })

  test("fetchPreviousPage after a durable seed waits for the authority tail first", async () => {
    const inner = createMemoryTranscriptDurableStore()
    await inner.upsertSettled(durableScope, userMessage("msg_local"), [textPart("p_local", "msg_local", "cached")])
    const calls: Array<string | undefined> = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      durableStore: inner,
      fetcher: async ({ before }) => {
        calls.push(before)
        await gate
        if (!before) {
          return transportPage(
            [{ info: userMessage("msg_tail"), parts: [textPart("p_tail", "msg_tail", "live")] }],
            { cursor: "msg_tail", complete: false },
          )
        }
        return transportPage(
          [{ info: userMessage("msg_old"), parts: [textPart("p_old", "msg_old", "older")] }],
          { complete: true },
        )
      },
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
    })
    const paints: string[][] = []
    repo.subscribe(scope, () => {
      paints.push([...repo.getTranscript(scope).messageOrder])
    })
    const pendingInitial = repo.ensureInitial(scope)
    await waitUntil(() => paints.some((order) => order.includes("msg_local")))
    const pendingPrevious = repo.fetchPreviousPage(scope)
    release()
    await pendingInitial
    await pendingPrevious
    expect(calls[0]).toBeUndefined()
    expect(calls.filter((value) => value === undefined)).toHaveLength(1)
    expect(calls).toContain("msg_tail")
    expect(repo.getTranscript(scope).messageOrder).toContain("msg_tail")
    expect(repo.getTranscript(scope).messageOrder).toContain("msg_old")
    repo.destroy()
  })

  test("unapplied commands do not write the durable store", async () => {
    const inner = createMemoryTranscriptDurableStore()
    const upserts: Array<"written" | "skipped"> = []
    const durableStore = {
      ...inner,
      upsertSettled: async (...args: Parameters<typeof inner.upsertSettled>) => {
        const result = await inner.upsertSettled(...args)
        upserts.push(result.status)
        return result
      },
    }
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      durableStore,
    })
    const result = repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: {
        records: [{ info: userMessage("msg_1"), parts: [textPart("p1", "msg_1")] }],
        complete: false,
      },
    })
    expect(result.applied).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(upserts).toEqual([])
    expect((await inner.readSession(durableScope)).records).toEqual([])
    repo.destroy()
  })
})

describe("InfiniteQueryObserver is available for model-layer use", () => {
  test("constructs without React", () => {
    const client = new QueryClient()
    const observer = new InfiniteQueryObserver(client, {
      queryKey: ["t"],
      queryFn: async () => ({ items: [] as string[], next: null as string | null }),
      initialPageParam: null as string | null,
      getPreviousPageParam: () => undefined,
      getNextPageParam: () => undefined,
    })
    expect(observer.getCurrentResult().status).toBeTruthy()
    observer.destroy()
  })
})

describe("Query repository on-demand message materialization", () => {
  let client: QueryClient
  const scope = {
    directory: DIRECTORY,
    sessionID: SESSION,
    transport: TRANSPORT,
    generation: GENERATION,
  }
  const durableScope = {
    transport: TRANSPORT,
    generation: GENERATION,
    directory: DIRECTORY,
    sessionID: SESSION,
  }

  const waitUntil = async (predicate: () => boolean | Promise<boolean>, timeout = 800) => {
    const started = Date.now()
    while (!(await predicate())) {
      if (Date.now() - started > timeout) throw new Error("timed out waiting for materialization")
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  const settledAssistant = (id: string, created = 2): Message =>
    ({ id, sessionID: SESSION, role: "assistant", time: { created }, finish: "stop" }) as Message

  const slimTool = (id: string, messageID: string): Part =>
    ({
      id,
      messageID,
      sessionID: SESSION,
      type: "tool",
      tool: "bash",
      callID: id,
      state: { status: "completed" },
      slim: true,
    }) as unknown as Part

  const fullTool = (id: string, messageID: string, output: string): Part =>
    ({
      id,
      messageID,
      sessionID: SESSION,
      type: "tool",
      tool: "bash",
      callID: id,
      state: { status: "completed", output },
    }) as unknown as Part

  const slimText = (id: string, messageID: string, text: string): Part =>
    ({ id, messageID, sessionID: SESSION, type: "text", text, slim: true }) as Part

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 1 } },
    })
  })

  test("messageNeedsExactMaterialization is only true for slim tool/reasoning/file", () => {
    expect(messageNeedsExactMaterialization([slimTool("t1", "msg_a")])).toBe(true)
    expect(messageNeedsExactMaterialization([
      { id: "r1", messageID: "msg_a", sessionID: SESSION, type: "reasoning", text: "", time: { start: 1 }, slim: true } as unknown as Part,
    ])).toBe(true)
    expect(messageNeedsExactMaterialization([
      { id: "f1", messageID: "msg_a", sessionID: SESSION, type: "file", mime: "text/plain", url: "file://f1", slim: true } as unknown as Part,
    ])).toBe(true)
    expect(messageNeedsExactMaterialization([slimText("p1", "msg_a", "summary")])).toBe(false)
    expect(messageNeedsExactMaterialization([fullTool("t1", "msg_a", "done")])).toBe(false)
  })

  test("skips Host fetch when the message has no slim tool/reasoning/file parts", async () => {
    let fetches = 0
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      fetchMessage: async () => {
        fetches += 1
        throw new Error("should not fetch")
      },
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([
        { info: settledAssistant("msg_text"), parts: [slimText("p1", "msg_text", "ok")] },
      ], { complete: true }),
    })
    expect(repo.getMessageMaterializationState(scope, "msg_text").status).toBe("ready")
    await repo.materializeMessage(scope, "msg_text")
    expect(fetches).toBe(0)
    expect(repo.getMessageMaterializationState(scope, "msg_text").status).toBe("ready")
    repo.destroy()
  })

  test("shares one Host request across concurrent expands", async () => {
    let fetches = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      fetchMessage: async () => {
        fetches += 1
        await gate
        return {
          info: settledAssistant("msg_a"),
          parts: [fullTool("t1", "msg_a", "body")],
        }
      },
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([
        { info: settledAssistant("msg_a"), parts: [slimTool("t1", "msg_a")] },
      ], { complete: true }),
    })
    const first = repo.materializeMessage(scope, "msg_a")
    const second = repo.materializeMessage(scope, "msg_a")
    expect(repo.getMessageMaterializationState(scope, "msg_a").status).toBe("loading")
    release()
    await Promise.all([first, second])
    expect(fetches).toBe(1)
    expect(repo.getMessageMaterializationState(scope, "msg_a").status).toBe("ready")
    expect((repo.getParts(scope, "msg_a")[0] as { state?: { output?: string } }).state?.output).toBe("body")
    repo.destroy()
  })

  test("subscribe sees loading then ready", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      fetchMessage: async () => {
        await gate
        return {
          info: settledAssistant("msg_a"),
          parts: [fullTool("t1", "msg_a", "body")],
        }
      },
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([
        { info: settledAssistant("msg_a"), parts: [slimTool("t1", "msg_a")] },
      ], { complete: true }),
    })
    const statuses: string[] = []
    repo.subscribe(scope, () => {
      statuses.push(repo.getMessageMaterializationState(scope, "msg_a").status)
    })
    const pending = repo.materializeMessage(scope, "msg_a")
    await waitUntil(() => statuses.includes("loading"))
    release()
    await pending
    expect(statuses).toContain("loading")
    expect(statuses.at(-1)).toBe("ready")
    repo.destroy()
  })

  test("failed fill keeps slim, exposes error, and retries", async () => {
    let fetches = 0
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      fetchMessage: async () => {
        fetches += 1
        if (fetches === 1) throw new Error("unavailable")
        return {
          info: settledAssistant("msg_a"),
          parts: [fullTool("t1", "msg_a", "recovered")],
        }
      },
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([
        { info: settledAssistant("msg_a"), parts: [slimTool("t1", "msg_a")] },
      ], { complete: true }),
    })
    await repo.materializeMessage(scope, "msg_a")
    expect(repo.getMessageMaterializationState(scope, "msg_a")).toEqual({
      sessionID: SESSION,
      messageID: "msg_a",
      status: "error",
      error: "unavailable",
    })
    expect((repo.getParts(scope, "msg_a")[0] as { slim?: boolean }).slim).toBe(true)
    await repo.materializeMessage(scope, "msg_a")
    expect(repo.getMessageMaterializationState(scope, "msg_a").status).toBe("ready")
    expect((repo.getParts(scope, "msg_a")[0] as { state?: { output?: string } }).state?.output).toBe("recovered")
    expect(fetches).toBe(2)
    repo.destroy()
  })

  test("full Host snapshot overlays a slim user file part", async () => {
    const user = {
      id: "msg_user",
      sessionID: SESSION,
      role: "user",
      time: { created: 1 },
    } as Message
    const slimFile = {
      id: "f1",
      messageID: "msg_user",
      sessionID: SESSION,
      type: "file",
      mime: "image/png",
      filename: "shot.png",
      slim: true,
    } as unknown as Part
    const fullFile = {
      ...slimFile,
      slim: false,
      url: "data:image/png;base64,full",
    } as unknown as Part
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      fetchMessage: async () => ({ info: user, parts: [fullFile] }),
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([{ info: user, parts: [slimFile] }], { complete: true }),
    })
    await repo.materializeMessage(scope, "msg_user")
    const part = repo.getParts(scope, "msg_user")[0] as { slim?: boolean; url?: string }
    expect(part.slim).not.toBe(true)
    expect(part.url).toBe("data:image/png;base64,full")
    expect(repo.getMessageMaterializationState(scope, "msg_user").status).toBe("ready")
    repo.destroy()
  })

  test("a fill that leaves slim parts is an error, not ready", async () => {
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      fetchMessage: async () => ({
        info: settledAssistant("msg_a"),
        parts: [slimTool("t1", "msg_a")],
      }),
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([
        { info: settledAssistant("msg_a"), parts: [slimTool("t1", "msg_a")] },
      ], { complete: true }),
    })
    await repo.materializeMessage(scope, "msg_a")
    expect(repo.getMessageMaterializationState(scope, "msg_a").status).toBe("error")
    expect((repo.getParts(scope, "msg_a")[0] as { slim?: boolean }).slim).toBe(true)
    repo.destroy()
  })

  test("full Host snapshot overlays the existing slim part", async () => {
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      fetchMessage: async () => ({
        info: settledAssistant("msg_a"),
        parts: [fullTool("t1", "msg_a", "full body")],
      }),
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([
        { info: settledAssistant("msg_a"), parts: [slimTool("t1", "msg_a")] },
      ], { complete: true }),
    })
    await repo.materializeMessage(scope, "msg_a")
    const part = repo.getParts(scope, "msg_a")[0] as { slim?: boolean; state?: { output?: string } }
    expect(part.slim).not.toBe(true)
    expect(part.state?.output).toBe("full body")
    repo.destroy()
  })

  test("a late result from a previous runtime does not write the current Query", async () => {
    let generation = GENERATION
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const repo = createQueryTranscriptRepository({
      client,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => generation,
      },
      fetchMessage: async () => {
        await gate
        return {
          info: settledAssistant("msg_a"),
          parts: [fullTool("t1", "msg_a", "stale-full")],
        }
      },
    })
    const pinned = { ...scope, generation: GENERATION }
    repo.apply(pinned, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([
        { info: settledAssistant("msg_a"), parts: [slimTool("t1", "msg_a")] },
      ], { complete: true }),
    })
    const liveScope = { directory: DIRECTORY, sessionID: SESSION }
    const pending = repo.materializeMessage(liveScope, "msg_a")
    generation = GENERATION + 1
    release()
    await pending
    expect(repo.getTranscript(liveScope).messageOrder).toEqual([])
    expect((repo.getParts(pinned, "msg_a")[0] as { slim?: boolean }).slim).toBe(true)
    expect(repo.getMessageMaterializationState(liveScope, "msg_a").status).toBe("idle")
    repo.destroy()
  })

  test("one message failure leaves another already-full message intact", async () => {
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      fetchMessage: async ({ messageID }) => {
        if (messageID === "msg_fail") throw new Error("only this one")
        return {
          info: settledAssistant(messageID),
          parts: [fullTool(`${messageID}-t`, messageID, "ok")],
        }
      },
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([
        { info: settledAssistant("msg_fail", 2), parts: [slimTool("t-fail", "msg_fail")] },
        { info: settledAssistant("msg_ok", 3), parts: [fullTool("t-ok", "msg_ok", "already")] },
      ], { complete: true, turnCount: 2 }),
    })
    await repo.materializeMessage(scope, "msg_fail")
    expect(repo.getMessageMaterializationState(scope, "msg_fail").status).toBe("error")
    expect((repo.getParts(scope, "msg_fail")[0] as { slim?: boolean }).slim).toBe(true)
    expect((repo.getParts(scope, "msg_ok")[0] as { state?: { output?: string } }).state?.output).toBe("already")
    expect(repo.getMessageMaterializationState(scope, "msg_ok").status).toBe("ready")
    repo.destroy()
  })

  test("successful full fill enqueues a durable full write", async () => {
    const inner = createMemoryTranscriptDurableStore()
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      durableStore: inner,
      fetchMessage: async () => ({
        info: settledAssistant("msg_a"),
        parts: [fullTool("t1", "msg_a", "persisted")],
      }),
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([
        { info: settledAssistant("msg_a"), parts: [slimTool("t1", "msg_a")] },
      ], { complete: true }),
    })
    await waitUntil(async () => Boolean(await inner.readMessage(durableScope, "msg_a")))
    await repo.materializeMessage(scope, "msg_a")
    await waitUntil(async () => {
      const stored = await inner.readMessage(durableScope, "msg_a")
      return stored?.completeness === "full"
    })
    expect((await inner.readMessage(durableScope, "msg_a"))?.completeness).toBe("full")
    const storedPart = (await inner.readMessage(durableScope, "msg_a"))?.parts[0] as {
      slim?: boolean
      state?: { output?: string }
    }
    expect(storedPart.slim).not.toBe(true)
    expect(storedPart.state?.output).toBe("persisted")
    repo.destroy()
  })
})

describe("Query repository durable byte-budget eviction", () => {
  const scope = {
    directory: DIRECTORY,
    sessionID: SESSION,
    transport: TRANSPORT,
    generation: GENERATION,
  }
  const durableScope = {
    transport: TRANSPORT,
    generation: GENERATION,
    directory: DIRECTORY,
    sessionID: SESSION,
  }
  const otherDurableScope = { ...durableScope, sessionID: "ses_2" }

  const waitUntil = async (predicate: () => boolean | Promise<boolean>, timeout = 800) => {
    const started = Date.now()
    while (!(await predicate())) {
      if (Date.now() - started > timeout) throw new Error("timed out waiting for durable eviction")
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  test("a successful persist evicts unprotected LRU rows in the same queue", async () => {
    const inner = createMemoryTranscriptDurableStore()
    const evicts: Array<{ maxBytes: number; protect: string[] }> = []
    const durableStore = {
      ...inner,
      evictToBytes: async (maxBytes: number, options?: { protect?: readonly typeof durableScope[] }) => {
        evicts.push({
          maxBytes,
          protect: (options?.protect ?? []).map((item) => item.sessionID),
        })
        return inner.evictToBytes(maxBytes, options)
      },
    }
    const activeRegistry = createTranscriptActiveScopeRegistry()
    const release = activeRegistry.retain({
      transport: TRANSPORT,
      generation: GENERATION,
      directory: DIRECTORY,
      sessionID: SESSION,
    })
    const repo = createQueryTranscriptRepository({
      client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      transport: TRANSPORT,
      generation: GENERATION,
      durableStore,
      activeRegistry,
      getDurableByteBudget: () => 0,
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage(
        [{ info: userMessage("msg_keep"), parts: [textPart("p_keep", "msg_keep", "keep")] }],
        { complete: true },
      ),
    })
    repo.apply({ ...scope, sessionID: "ses_2" }, {
      type: "http-page",
      purpose: "initial",
      page: transportPage(
        [{ info: { ...userMessage("msg_drop"), sessionID: "ses_2" }, parts: [textPart("p_drop", "msg_drop", "drop")] }],
        { complete: true },
      ),
    })
    await waitUntil(async () => (await inner.readSession(durableScope)).records.length === 1)
    await waitUntil(() => evicts.length >= 2)
    expect((await inner.readSession(durableScope)).records.map((record) => record.messageID)).toEqual(["msg_keep"])
    expect((await inner.readSession(otherDurableScope)).records).toEqual([])
    expect(evicts.some((item) => item.maxBytes === 0 && item.protect.includes(SESSION))).toBe(true)
    release()
    repo.destroy()
  })

  test("hash-skipped writes do not run evictToBytes", async () => {
    const inner = createMemoryTranscriptDurableStore()
    let evicts = 0
    const durableStore = {
      ...inner,
      evictToBytes: async (maxBytes: number, options?: { protect?: readonly typeof durableScope[] }) => {
        evicts += 1
        return inner.evictToBytes(maxBytes, options)
      },
    }
    const queue = createTranscriptDurableQueryQueue(durableStore, {
      getByteBudget: () => 1024,
      getProtectScopes: () => [],
    })
    const info = userMessage("msg_same")
    const parts = [textPart("p_same", "msg_same", "same")]
    await queue.persistSettled(durableScope, info, parts)
    await queue.persistSettled(durableScope, info, parts)
    expect(evicts).toBe(1)
    expect((await inner.readSession(durableScope)).records).toHaveLength(1)
  })
})
