import { beforeEach, describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/react-query"

import {
  captureSessionMessagePageCommit,
  ensureSessionMessagePage,
  isSessionMessagePageCommitCurrent,
  readSessionMessagePage,
  sessionMessagePageQueryKey,
  sessionMessagePageQueryOptions,
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
  test("includes transport, directory, session, limit, and cursor", () => {
    expect(sessionMessagePageQueryKey(params, "runtime-a")).toEqual([
      "runtime-a",
      "sessionMessages",
      "page",
      "/repo",
      "ses_1",
      30,
      "tail",
    ])
    expect(sessionMessagePageQueryKey({ ...params, before: "msg_20" }, "runtime-a")).toEqual([
      "runtime-a",
      "sessionMessages",
      "page",
      "/repo",
      "ses_1",
      30,
      "msg_20",
    ])
  })

  test("isolates runtime, directory, limit, and cursor dimensions", () => {
    const base = sessionMessagePageQueryKey(params, "runtime-a")
    expect(sessionMessagePageQueryKey(params, "runtime-b")).not.toEqual(base)
    expect(sessionMessagePageQueryKey({ ...params, directory: "/other" }, "runtime-a")).not.toEqual(base)
    expect(sessionMessagePageQueryKey({ ...params, limit: 100 }, "runtime-a")).not.toEqual(base)
    expect(sessionMessagePageQueryKey({ ...params, before: "msg_1" }, "runtime-a")).not.toEqual(base)
    expect(sessionMessagePageQueryKey({ ...params, sessionID: "ses_2" }, "runtime-a")).not.toEqual(base)
  })
})

describe("ensureSessionMessagePage", () => {
  let client: QueryClient
  let generation: number
  let transport: string
  let runtimeKey: string
  let probe: SessionMessageRuntimeProbe

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    generation = 1
    transport = "runtime-a"
    runtimeKey = "runtime-a"
    probe = {
      getTransport: () => transport,
      getGeneration: () => generation,
    }
  })

  const fetchWith = (fetcher: SessionMessagePageFetcher) =>
    ensureSessionMessagePage(params, fetcher, client, transport, runtimeKey, probe)

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
      ensureSessionMessagePage(params, fetcher, client, "runtime-a", "runtime-a", probeFor("runtime-a")),
      ensureSessionMessagePage({ ...params, before: "msg_20" }, fetcher, client, "runtime-a", "runtime-a", probeFor("runtime-a")),
      ensureSessionMessagePage(params, fetcher, client, "runtime-b", "runtime-b", probeFor("runtime-b")),
      ensureSessionMessagePage({ ...params, directory: "/other" }, fetcher, client, "runtime-a", "runtime-a", probeFor("runtime-a")),
      ensureSessionMessagePage({ ...params, limit: 100 }, fetcher, client, "runtime-a", "runtime-a", probeFor("runtime-a")),
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
    expect(readSessionMessagePage(params, client, transport)).toBe(undefined)
  })

  test("serves a warm Query cache without a second HTTP request and allows commit into a new child store", async () => {
    let calls = 0
    const fetcher: SessionMessagePageFetcher = async () => {
      calls += 1
      return page("cached")
    }

    const firstStore = {}
    const capture = captureSessionMessagePageCommit(firstStore, transport, probe)
    const result = await fetchWith(fetcher)
    expect(result).toEqual(page("cached"))
    expect(calls).toBe(1)

    const secondStore = {}
    const cached = await fetchWith(fetcher)
    expect(calls).toBe(1)
    expect(cached).toEqual(page("cached"))
    expect(Object.isFrozen(cached.records)).toBe(true)

    // Cache is store-agnostic: a remounted child store can commit the same page
    // when the runtime capture remains current for that store identity.
    expect(isSessionMessagePageCommitCurrent(capture, firstStore, transport, probe)).toBe(true)
    expect(isSessionMessagePageCommitCurrent(capture, secondStore, transport, probe)).toBe(false)

    const remountCapture = captureSessionMessagePageCommit(secondStore, transport, probe)
    expect(isSessionMessagePageCommitCurrent(remountCapture, secondStore, transport, probe)).toBe(true)
    expect(readSessionMessagePage(params, client, transport)).toEqual(page("cached"))
  })

  test("rejects commit when runtime generation advances after capture", () => {
    const store = {}
    const capture = captureSessionMessagePageCommit(store, transport, probe)
    generation = 9
    expect(isSessionMessagePageCommitCurrent(capture, store, transport, probe)).toBe(false)
  })

  test("rejects commit when transport identity diverges", () => {
    const store = {}
    const capture = captureSessionMessagePageCommit(store, "runtime-a", { getGeneration: () => 1 })
    expect(isSessionMessagePageCommitCurrent(capture, store, "runtime-b", { getGeneration: () => 1 })).toBe(false)
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
    const cached = readSessionMessagePage(params, client, transport)
    expect(cached).toEqual(page("immutable", "next"))
    expect(Object.isFrozen(cached?.records)).toBe(true)
    expect(Object.isFrozen(cached?.records[0])).toBe(true)
  })
})
