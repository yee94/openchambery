import { beforeEach, describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/react-query"

import {
  assertTransportPageCursorProgress,
  createSessionTranscriptController,
  ensureSessionMessagePage,
  isRetryableSessionMessagePageError,
  readSessionMessagePage,
  sessionMessagePageQueryKey,
  sessionMessagePageQueryOptions,
  sessionMessagePageRetry,
  SessionMessageHttpError,
  SessionMessagePageContractError,
  validateSessionMessageHttpPage,
  type SessionMessageHttpPage,
  type SessionMessagePageFetcher,
  type SessionMessageRuntimeProbe,
  type SessionTranscriptFetcher,
} from "./session-message-query"

const page = (label: string, cursor?: string): SessionMessageHttpPage => ({
  records: Object.freeze([{ info: Object.freeze({ id: label }), parts: Object.freeze([]) }]),
  cursor,
  complete: !cursor,
})

const params = {
  directory: "/repo",
  sessionID: "ses_1",
  limit: 30,
} as const

describe("sessionMessagePageQueryKey", () => {
  test("includes transport, generation, directory, session, limit, and cursor", () => {
    expect(sessionMessagePageQueryKey(params, "runtime-a", 1)).toEqual([
      "runtime-a",
      1,
      "sessionMessages",
      "page",
      "/repo",
      "ses_1",
      30,
      "tail",
    ])
    expect(sessionMessagePageQueryKey({ ...params, before: "msg_20" }, "runtime-a", 1)).toEqual([
      "runtime-a",
      1,
      "sessionMessages",
      "page",
      "/repo",
      "ses_1",
      30,
      "msg_20",
    ])
  })

  test("isolates runtime, generation, directory, limit, and cursor dimensions", () => {
    const base = sessionMessagePageQueryKey(params, "runtime-a", 1)
    expect(sessionMessagePageQueryKey(params, "runtime-b", 1)).not.toEqual(base)
    expect(sessionMessagePageQueryKey(params, "runtime-a", 2)).not.toEqual(base)
    expect(sessionMessagePageQueryKey({ ...params, directory: "/other" }, "runtime-a", 1)).not.toEqual(base)
    expect(sessionMessagePageQueryKey({ ...params, limit: 100 }, "runtime-a", 1)).not.toEqual(base)
    expect(sessionMessagePageQueryKey({ ...params, before: "msg_1" }, "runtime-a", 1)).not.toEqual(base)
    expect(sessionMessagePageQueryKey({ ...params, sessionID: "ses_2" }, "runtime-a", 1)).not.toEqual(base)
  })
})

describe("validateSessionMessageHttpPage", () => {
  test("accepts a well-formed page", () => {
    expect(validateSessionMessageHttpPage(page("ok"))).toEqual(page("ok"))
  })

  test("rejects malformed payloads as contract errors (non-retryable)", () => {
    expect(() => validateSessionMessageHttpPage(null)).toThrow(SessionMessagePageContractError)
    expect(() => validateSessionMessageHttpPage({ complete: true })).toThrow(/records/)
    expect(() => validateSessionMessageHttpPage({ records: [], complete: "yes" })).toThrow(/complete/)
    expect(() =>
      validateSessionMessageHttpPage({ records: [{ info: {} }], complete: true }),
    ).toThrow(/info\.id/)
    expect(isRetryableSessionMessagePageError(
      new SessionMessagePageContractError("bad"),
    )).toBe(false)
    expect(sessionMessagePageRetry(0, new SessionMessagePageContractError("bad"))).toBe(false)
  })
})

describe("ensureSessionMessagePage", () => {
  let client: QueryClient
  let generation: number
  let transport: string
  let probe: SessionMessageRuntimeProbe

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    generation = 1
    transport = "runtime-a"
    probe = {
      getTransport: () => transport,
      getGeneration: () => generation,
    }
  })

  const fetchWith = (fetcher: SessionMessagePageFetcher) =>
    ensureSessionMessagePage(params, fetcher, client, transport, probe, generation)

  const readCached = () =>
    readSessionMessagePage(params, client, transport, generation)

  test("coalesces concurrent ensure calls for the same full key into one HTTP request", async () => {
    let calls = 0
    let release: ((value: SessionMessageHttpPage) => void) | undefined
    const fetcher: SessionMessagePageFetcher = async () => {
      calls += 1
      return new Promise((resolve) => {
        release = resolve
      })
    }

    const first = fetchWith(fetcher)
    const second = fetchWith(fetcher)
    expect(calls).toBe(1)
    release?.(page("shared"))
    expect(await first).toEqual(page("shared"))
    expect(await second).toEqual(page("shared"))
    expect(calls).toBe(1)
  })

  test("keeps runtime, directory, limit, and cursor pages independent", async () => {
    let calls = 0
    const fetcher: SessionMessagePageFetcher = async () => {
      calls += 1
      return page(`p${calls}`)
    }
    const probeFor = (t: string): SessionMessageRuntimeProbe => ({
      getTransport: () => t,
      getGeneration: () => 1,
    })

    await Promise.all([
      ensureSessionMessagePage(params, fetcher, client, "runtime-a", probeFor("runtime-a")),
      ensureSessionMessagePage({ ...params, before: "msg_20" }, fetcher, client, "runtime-a", probeFor("runtime-a")),
      ensureSessionMessagePage(params, fetcher, client, "runtime-b", probeFor("runtime-b")),
      ensureSessionMessagePage({ ...params, directory: "/other" }, fetcher, client, "runtime-a", probeFor("runtime-a")),
      ensureSessionMessagePage({ ...params, limit: 100 }, fetcher, client, "runtime-a", probeFor("runtime-a")),
    ])

    expect(calls).toBe(5)
  })

  test("clears a rejected request so the next ensure can retry", async () => {
    let calls = 0
    const fetcher: SessionMessagePageFetcher = async () => {
      calls += 1
      if (calls === 1) throw new Error("not ready")
      return page("recovered")
    }

    await expect(fetchWith(fetcher)).rejects.toThrow("not ready")
    expect(await fetchWith(fetcher)).toEqual(page("recovered"))
    expect(calls).toBe(2)
  })

  test("discards stale results when runtime generation advances during the request", async () => {
    let release: ((value: SessionMessageHttpPage) => void) | undefined
    const fetcher: SessionMessagePageFetcher = async () =>
      new Promise((resolve) => {
        release = resolve
      })

    const pending = fetchWith(fetcher)
    generation = 2
    release?.(page("stale"))
    await expect(pending).rejects.toThrow(/runtime_stale|stale/i)
    expect(readCached()).toBe(undefined)
  })

  test("serves a warm Query cache without a second HTTP request", async () => {
    let calls = 0
    const fetcher: SessionMessagePageFetcher = async () => {
      calls += 1
      return page("cached")
    }

    const result = await fetchWith(fetcher)
    expect(result).toEqual(page("cached"))
    expect(calls).toBe(1)

    const cached = await fetchWith(fetcher)
    expect(calls).toBe(1)
    expect(cached).toEqual(page("cached"))
    expect(Object.isFrozen(cached.records)).toBe(true)
    expect(readCached()).toEqual(page("cached"))
  })

  test("passes the query AbortSignal through the page fetcher", async () => {
    let received: AbortSignal | undefined
    const options = sessionMessagePageQueryOptions(
      params,
      async ({ signal }: { signal: AbortSignal }) => {
        received = signal
        return page("ok")
      },
      "runtime-a",
      probe,
    )
    const controller = new AbortController()
    await options.queryFn({ signal: controller.signal })
    expect(received).toBe(controller.signal)
  })

  test("returns an immutable page snapshot from the Query cache", async () => {
    const fetcher: SessionMessagePageFetcher = async () => page("immutable", "next")
    await fetchWith(fetcher)
    const cached = readCached()
    expect(cached).toEqual(page("immutable", "next"))
    expect(Object.isFrozen(cached?.records)).toBe(true)
    expect(Object.isFrozen(cached?.records[0])).toBe(true)
    expect(Object.isFrozen(cached?.records[0]?.info)).toBe(true)
  })

  test("calls the injected fetcher directly without nested loader retries", async () => {
    let calls = 0
    const fetcher: SessionMessagePageFetcher = async () => {
      calls += 1
      if (calls === 1) throw new SessionMessageHttpError(404, "missing")
      return page("should-not-run")
    }
    // 4xx is classified non-retryable at Query layer; one attempt only.
    await expect(fetchWith(fetcher)).rejects.toThrow(/missing|404/)
    expect(calls).toBe(1)
    expect(isRetryableSessionMessagePageError(new SessionMessageHttpError(404))).toBe(false)
  })

  test("rejects contract-invalid fetcher results before caching", async () => {
    const fetcher: SessionMessagePageFetcher = async () =>
      ({ records: "nope", complete: true } as unknown as SessionMessageHttpPage)
    await expect(fetchWith(fetcher)).rejects.toThrow(SessionMessagePageContractError)
    expect(readCached()).toBe(undefined)
  })
})

describe("assertTransportPageCursorProgress", () => {
  test("rejects same continuation as request.before (non-retryable contract)", () => {
    let thrown: unknown
    try {
      assertTransportPageCursorProgress("older1", {
        records: [{ info: { id: "msg_1" } }],
        complete: false,
        cursor: "older1",
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown instanceof SessionMessagePageContractError).toBe(true)
    expect(
      isRetryableSessionMessagePageError(
        new SessionMessagePageContractError("same cursor"),
      ),
    ).toBe(false)
  })

  test("allows advanced continuation and initial pages", () => {
    assertTransportPageCursorProgress("older1", {
      records: [],
      complete: false,
      cursor: "older2",
    })
    assertTransportPageCursorProgress(undefined, {
      records: [{ info: { id: "msg_1" } }],
      complete: false,
      cursor: "older1",
    })
    assertTransportPageCursorProgress("older1", {
      records: [],
      complete: true,
    })
  })
})

describe("transport page repeated-cursor cache barrier", () => {
  test("same→same older page is not cached; explicit retry after Host fix issues another HTTP", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let calls = 0
    let mode: "stuck" | "fixed" = "stuck"
    const params = {
      directory: "/repo",
      sessionID: "ses_cursor",
      limit: 20,
      before: "older1",
    } as const
    const fetcher: SessionMessagePageFetcher = async () => {
      calls += 1
      if (mode === "stuck") {
        return {
          records: Object.freeze([{ info: Object.freeze({ id: "msg_x" }), parts: Object.freeze([]) }]),
          complete: false,
          cursor: "older1",
        }
      }
      return {
        records: Object.freeze([{ info: Object.freeze({ id: "msg_y" }), parts: Object.freeze([]) }]),
        complete: false,
        cursor: "older2",
      }
    }
    const probe: SessionMessageRuntimeProbe = {
      getTransport: () => "runtime-a",
      getGeneration: () => 1,
    }

    await expect(
      ensureSessionMessagePage(params, fetcher, client, "runtime-a", probe, 1),
    ).rejects.toThrow(/same cursor|without progress/)
    expect(calls).toBe(1)
    expect(readSessionMessagePage(params, client, "runtime-a", 1)).toBe(undefined)

    mode = "fixed"
    const recovered = await ensureSessionMessagePage(params, fetcher, client, "runtime-a", probe, 1)
    expect(calls).toBe(2)
    expect(recovered.cursor).toBe("older2")
    expect(readSessionMessagePage(params, client, "runtime-a", 1)?.cursor).toBe("older2")
    client.clear()
  })

  test("repository fetchPreviousPage keeps canonical tail after stuck older and recovers on retry", async () => {
    const { createQueryTranscriptRepository } = await import("./transcript-repository-query-adapter")
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 1 } } })
    let olderCalls = 0
    let olderMode: "stuck" | "fixed" = "stuck"
    const repo = createQueryTranscriptRepository({
      client,
      transport: "runtime-a",
      generation: 1,
      initialLimit: 20,
      historyLimit: 20,
      fetcher: async ({ before }) => {
        if (!before) {
          return {
            records: Array.from({ length: 25 }, (_, i) => {
              const n = i + 1
              return {
                info: { id: `u${n}`, role: "user", sessionID: "ses_1", time: { created: n } },
                parts: [],
              }
            }),
            complete: false,
            cursor: "older26",
            turnCount: 25,
          }
        }
        olderCalls += 1
        if (olderMode === "stuck") {
          return {
            records: Array.from({ length: 20 }, (_, i) => {
              const n = 25 - i
              return {
                info: { id: `u${n}`, role: "user", sessionID: "ses_1", time: { created: n } },
                parts: [],
              }
            }),
            complete: false,
            cursor: "older26",
            turnCount: 20,
          }
        }
        return {
          records: Array.from({ length: 5 }, (_, i) => {
            const n = i + 1
            return {
              info: { id: `u${n}`, role: "user", sessionID: "ses_1", time: { created: n } },
              parts: [],
            }
          }),
          complete: false,
          cursor: "older6",
          turnCount: 5,
        }
      },
      probe: {
        getTransport: () => "runtime-a",
        getGeneration: () => 1,
      },
    })
    const scope = {
      directory: "/repo",
      sessionID: "ses_1",
      transport: "runtime-a",
      generation: 1,
    }
    await repo.ensureInitial(scope)
    const beforeOlder = repo.getTranscript(scope).messageOrder
    expect(beforeOlder).toHaveLength(25)

    await expect(repo.fetchPreviousPage(scope)).rejects.toThrow(/same cursor|without progress|failed/)
    expect(olderCalls).toBe(1)
    // Canonical first-screen data retained.
    expect(repo.getTranscript(scope).messageOrder).toEqual(beforeOlder)

    olderMode = "fixed"
    // Explicit retry must hit Host again (no warm same-cursor success cache).
    const after = await repo.fetchPreviousPage(scope)
    expect(olderCalls).toBe(2)
    expect(after.messageOrder).toEqual(beforeOlder)
    expect(after.messageOrder).toHaveLength(25)
    repo.destroy()
    client.clear()
  })
})

describe("session transcript InfiniteQuery retry budget", () => {
  test("single 503 through ensureInitial uses transport-page retry only (<=3 HTTP)", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          // Keep default delay short so the test finishes quickly.
          retryDelay: 1,
        },
      },
    })
    let calls = 0
    const fetcher: SessionTranscriptFetcher = async () => {
      calls += 1
      const error = new SessionMessageHttpError(503, "session projection failed (503)")
      throw error
    }
    const controller = createSessionTranscriptController({
      directory: "/repo",
      sessionID: "ses_retry",
      fetcher,
      transport: "runtime-a",
      generation: 1,
      client,
      initialLimit: 2,
      historyLimit: 2,
      probe: {
        getTransport: () => "runtime-a",
        getGeneration: () => 1,
      },
    })
    await expect(controller.ensureInitial()).rejects.toThrow(/503/)
    // Transport page: 1 attempt + 2 retries. Infinite must not multiply that.
    expect(calls).toBeLessThanOrEqual(3)
    expect(calls).toBeGreaterThanOrEqual(1)
    controller.destroy()
    client.clear()
  })
})
