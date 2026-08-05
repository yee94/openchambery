import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

// Clear sticky mocks from other suites before installing this file's doubles.
mock.restore()

import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from "../lib/runtime-url"

/**
 * Red-light contract for `session-turn-page-api.ts`.
 *
 * Production module is not landed yet: these tests must fail until
 * `fetchSessionTurnPage` is implemented and used only for prepend/loadMore.
 */

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window

type FetchCall = {
  url: URL
  method: string
  signal?: AbortSignal | null
  init?: RequestInit
}

describe("fetchSessionTurnPage", () => {
  let previousResolver: ReturnType<typeof getRuntimeUrlResolver>
  let calls: FetchCall[]
  let responseImpl: (call: FetchCall) => Promise<Response>

  beforeEach(() => {
    previousResolver = getRuntimeUrlResolver()
    configureRuntimeUrlResolver({ apiBaseUrl: "http://127.0.0.1:57123" })
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "https://app.example", href: "https://app.example/" } },
    })
    calls = []
    responseImpl = async () =>
      new Response(
        JSON.stringify({
          records: [{ info: { id: "msg_1", role: "user" }, parts: [] }],
          cursor: "msg_1",
          complete: false,
          turnCount: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const call: FetchCall = {
        url: new URL(request.url),
        method: request.method,
        signal: init?.signal ?? (input instanceof Request ? input.signal : null),
        init,
      }
      calls.push(call)
      return responseImpl(call)
    }) as typeof fetch
  })

  afterEach(() => {
    setRuntimeUrlResolver(previousResolver)
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow })
    globalThis.fetch = originalFetch
  })

  afterAll(() => {
    mock.restore()
  })

  test("GET /api/openchamber/sessions/:encodedSessionID/messages with directory,before,turns — omits scanLimit by default", async () => {
    const { fetchSessionTurnPage } = await import("./session-turn-page-api")
    const signal = new AbortController().signal

    const page = await fetchSessionTurnPage({
      sessionID: "ses/a b",
      directory: "/repo a",
      before: "msg_cursor",
      signal,
    })

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.method).toBe("GET")
    expect(call.url.pathname).toBe(
      `/api/openchamber/sessions/${encodeURIComponent("ses/a b")}/messages`,
    )
    expect(call.url.searchParams.get("directory")).toBe("/repo a")
    expect(call.url.searchParams.get("before")).toBe("msg_cursor")
    // Default turns = history link tier (local/relay both 4 for loadMore); test env is local.
    expect(call.url.searchParams.get("turns")).toBe("4")
    // Host owns `_inner_scanLimit`; default client path must not send scanLimit.
    expect(call.url.searchParams.has("scanLimit")).toBe(false)
    // Caller signal is combined with a bounded flight timeout (relay stuck-flight guard).
    expect(call.signal?.aborted).toBe(false)

    expect(page).toEqual({
      records: [{ info: { id: "msg_1", role: "user" }, parts: [] }],
      cursor: "msg_1",
      complete: false,
      turnCount: 1,
    })
  })

  test("omits before when not provided; still omits scanLimit by default", async () => {
    const { fetchSessionTurnPage } = await import("./session-turn-page-api")

    await fetchSessionTurnPage({
      sessionID: "ses_1",
      directory: "/repo",
    })

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url.pathname).toBe("/api/openchamber/sessions/ses_1/messages")
    expect(call.url.searchParams.get("directory")).toBe("/repo")
    expect(call.url.searchParams.has("before")).toBe(false)
    // Bare fetchSessionTurnPage defaults to history/loadMore turn limit (4).
    expect(call.url.searchParams.get("turns")).toBe("4")
    expect(call.url.searchParams.has("scanLimit")).toBe(false)
  })

  test("sends scanLimit only when explicitly overridden", async () => {
    const { fetchSessionTurnPage } = await import("./session-turn-page-api")

    await fetchSessionTurnPage({
      sessionID: "ses_1",
      directory: "/repo",
      scanLimit: 50,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url.searchParams.get("scanLimit")).toBe("50")
  })

  test("throws on HTTP non-2xx", async () => {
    responseImpl = async () => new Response("nope", { status: 500 })
    const { fetchSessionTurnPage } = await import("./session-turn-page-api")
    await expect(
      fetchSessionTurnPage({ sessionID: "ses_1", directory: "/repo", before: "m1" }),
    ).rejects.toThrow()
  })

  test("throws on HTML content-type / body", async () => {
    responseImpl = async () =>
      new Response("<!doctype html><html></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    const { fetchSessionTurnPage } = await import("./session-turn-page-api")
    await expect(
      fetchSessionTurnPage({ sessionID: "ses_1", directory: "/repo", before: "m1" }),
    ).rejects.toThrow()
  })

  test("throws on malformed JSON", async () => {
    responseImpl = async () =>
      new Response("not-json{", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    const { fetchSessionTurnPage } = await import("./session-turn-page-api")
    await expect(
      fetchSessionTurnPage({ sessionID: "ses_1", directory: "/repo", before: "m1" }),
    ).rejects.toThrow()
  })

  test("throws when required fields are missing", async () => {
    responseImpl = async () =>
      new Response(JSON.stringify({ records: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    const { fetchSessionTurnPage } = await import("./session-turn-page-api")
    await expect(
      fetchSessionTurnPage({ sessionID: "ses_1", directory: "/repo", before: "m1" }),
    ).rejects.toThrow()
  })

  test("throws when records is not an array (partial / malformed shape)", async () => {
    responseImpl = async () =>
      new Response(
        JSON.stringify({
          records: "nope",
          cursor: null,
          complete: true,
          turnCount: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    const { fetchSessionTurnPage } = await import("./session-turn-page-api")
    await expect(
      fetchSessionTurnPage({ sessionID: "ses_1", directory: "/repo", before: "m1" }),
    ).rejects.toThrow()
  })

  test("throws when complete is missing", async () => {
    responseImpl = async () =>
      new Response(
        JSON.stringify({
          records: [],
          cursor: null,
          turnCount: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    const { fetchSessionTurnPage } = await import("./session-turn-page-api")
    await expect(
      fetchSessionTurnPage({ sessionID: "ses_1", directory: "/repo", before: "m1" }),
    ).rejects.toThrow()
  })

  test("throws when turnCount is missing or non-number", async () => {
    responseImpl = async () =>
      new Response(
        JSON.stringify({
          records: [],
          cursor: null,
          complete: true,
          turnCount: "1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    const { fetchSessionTurnPage } = await import("./session-turn-page-api")
    await expect(
      fetchSessionTurnPage({ sessionID: "ses_1", directory: "/repo", before: "m1" }),
    ).rejects.toThrow()
  })

  test("throws when turnCount is not an integer in 0..requested turns", async () => {
    responseImpl = async () =>
      new Response(
        JSON.stringify({
          records: [],
          cursor: null,
          complete: true,
          turnCount: 1.5,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    const { fetchSessionTurnPage } = await import("./session-turn-page-api")
    await expect(
      fetchSessionTurnPage({ sessionID: "ses_1", directory: "/repo", before: "m1" }),
    ).rejects.toThrow()

    responseImpl = async () =>
      new Response(
        JSON.stringify({
          records: [],
          cursor: null,
          complete: true,
          turnCount: 4,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    await expect(
      fetchSessionTurnPage({ sessionID: "ses_1", directory: "/repo", before: "m1", turns: 3 }),
    ).rejects.toThrow()

    responseImpl = async () =>
      new Response(
        JSON.stringify({
          records: [],
          cursor: null,
          complete: true,
          turnCount: -1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    await expect(
      fetchSessionTurnPage({ sessionID: "ses_1", directory: "/repo", before: "m1" }),
    ).rejects.toThrow()
  })

  test("accepts server turnCount without client predicate recompute", async () => {
    // Server may declare turnCount without requiring the client to recount user boundaries.
    responseImpl = async () =>
      new Response(
        JSON.stringify({
          records: [
            { info: { id: "msg_a", role: "assistant" }, parts: [] },
            { info: { id: "msg_u", role: "user" }, parts: [] },
          ],
          cursor: "msg_a",
          complete: false,
          turnCount: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    const { fetchSessionTurnPage } = await import("./session-turn-page-api")
    const page = await fetchSessionTurnPage({
      sessionID: "ses_1",
      directory: "/repo",
      before: "m1",
    })
    expect(page.turnCount).toBe(1)
    expect(page.records).toHaveLength(2)
  })

  test("throws when a record is not an object", async () => {
    responseImpl = async () =>
      new Response(
        JSON.stringify({
          records: [null],
          cursor: null,
          complete: true,
          turnCount: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    const { fetchSessionTurnPage } = await import("./session-turn-page-api")
    await expect(
      fetchSessionTurnPage({ sessionID: "ses_1", directory: "/repo", before: "m1" }),
    ).rejects.toThrow()
  })

  test("throws when record.info.id is missing or empty", async () => {
    responseImpl = async () =>
      new Response(
        JSON.stringify({
          records: [{ info: { role: "user" }, parts: [] }],
          cursor: "x",
          complete: false,
          turnCount: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    const { fetchSessionTurnPage } = await import("./session-turn-page-api")
    await expect(
      fetchSessionTurnPage({ sessionID: "ses_1", directory: "/repo", before: "m1" }),
    ).rejects.toThrow()

    responseImpl = async () =>
      new Response(
        JSON.stringify({
          records: [{ info: { id: "", role: "user" }, parts: [] }],
          cursor: "x",
          complete: false,
          turnCount: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    await expect(
      fetchSessionTurnPage({ sessionID: "ses_1", directory: "/repo", before: "m1" }),
    ).rejects.toThrow()
  })

  test("throws when parts is present but not an array", async () => {
    responseImpl = async () =>
      new Response(
        JSON.stringify({
          records: [{ info: { id: "msg_1", role: "user" }, parts: "nope" }],
          cursor: "msg_1",
          complete: false,
          turnCount: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    const { fetchSessionTurnPage } = await import("./session-turn-page-api")
    await expect(
      fetchSessionTurnPage({ sessionID: "ses_1", directory: "/repo", before: "m1" }),
    ).rejects.toThrow()
  })

  test("accepts records with omitted parts", async () => {
    responseImpl = async () =>
      new Response(
        JSON.stringify({
          records: [{ info: { id: "msg_1", role: "user" } }],
          cursor: "msg_1",
          complete: false,
          turnCount: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    const { fetchSessionTurnPage } = await import("./session-turn-page-api")
    const page = await fetchSessionTurnPage({
      sessionID: "ses_1",
      directory: "/repo",
      before: "m1",
    })
    expect(page.records[0]).toEqual({ info: { id: "msg_1", role: "user" } })
  })

  test("complete=true requires cursor=null", async () => {
    responseImpl = async () =>
      new Response(
        JSON.stringify({
          records: [],
          cursor: "still-there",
          complete: true,
          turnCount: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    const { fetchSessionTurnPage } = await import("./session-turn-page-api")
    await expect(
      fetchSessionTurnPage({ sessionID: "ses_1", directory: "/repo", before: "m1" }),
    ).rejects.toThrow()
  })

  test("complete=false requires non-empty cursor string", async () => {
    responseImpl = async () =>
      new Response(
        JSON.stringify({
          records: [{ info: { id: "msg_1", role: "user" }, parts: [] }],
          cursor: null,
          complete: false,
          turnCount: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    const { fetchSessionTurnPage } = await import("./session-turn-page-api")
    await expect(
      fetchSessionTurnPage({ sessionID: "ses_1", directory: "/repo", before: "m1" }),
    ).rejects.toThrow()
  })

  test("rejects empty-string cursor", async () => {
    responseImpl = async () =>
      new Response(
        JSON.stringify({
          records: [{ info: { id: "msg_1", role: "user" }, parts: [] }],
          cursor: "",
          complete: false,
          turnCount: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    const { fetchSessionTurnPage } = await import("./session-turn-page-api")
    await expect(
      fetchSessionTurnPage({ sessionID: "ses_1", directory: "/repo", before: "m1" }),
    ).rejects.toThrow()
  })

  test("rejects partial:true payload", async () => {
    responseImpl = async () =>
      new Response(
        JSON.stringify({
          records: [{ info: { id: "msg_1", role: "user" }, parts: [] }],
          cursor: "msg_1",
          complete: false,
          turnCount: 1,
          partial: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    const { fetchSessionTurnPage } = await import("./session-turn-page-api")
    await expect(
      fetchSessionTurnPage({ sessionID: "ses_1", directory: "/repo", before: "m1" }),
    ).rejects.toThrow()
  })
})
