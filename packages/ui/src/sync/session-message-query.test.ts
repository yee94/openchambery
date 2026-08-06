import { beforeEach, describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/react-query"

import {
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
