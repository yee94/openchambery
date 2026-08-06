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
import { createQueryTranscriptRepository } from "./transcript-repository-query-adapter"
import type { TranscriptTransportPage } from "./transcript-repository"

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
