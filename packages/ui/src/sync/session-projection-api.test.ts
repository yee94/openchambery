import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

mock.restore()

import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from "../lib/runtime-url"

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window

type FetchCall = {
  url: URL
  method: string
  signal?: AbortSignal | null
}

const SESSION = "ses_1"

const USER_JSON = {
  id: "msg_user",
  type: "user",
  time: { created: 10 },
  text: "hello from user",
}

const ASSISTANT_JSON = {
  id: "msg_asst",
  type: "assistant",
  time: { created: 20, completed: 30 },
  agent: "build",
  model: { id: "gpt", providerID: "openai" },
  content: [
    { type: "text", text: "answer" },
    { type: "reasoning", text: "think" },
    {
      type: "tool",
      id: "tool_1",
      name: "read",
      time: { created: 21, ran: 22, completed: 23 },
      state: {
        status: "completed",
        input: { path: "/repo/README.md" },
        content: [{ type: "text", text: "file body" }],
      },
    },
  ],
}

const SYNTHETIC_JSON = {
  id: "msg_syn",
  type: "synthetic",
  time: { created: 11 },
  text: "synthetic body",
  description: "synthetic label",
}

const SYSTEM_JSON = {
  id: "msg_sys",
  type: "system",
  time: { created: 12 },
  text: "system instruction",
}

const UNKNOWN_JSON = {
  id: "msg_unknown",
  type: "future-variant",
  time: { created: 13 },
  text: "should not drop the page",
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("fetchSessionProjectionPage", () => {
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
      jsonResponse({
        data: [USER_JSON],
        cursor: { previous: "cur_older", next: null },
      })
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const call: FetchCall = {
        url: new URL(request.url),
        method: request.method,
        signal: init?.signal ?? (input instanceof Request ? input.signal : null),
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

  test("first page GET /api/session/:encodedSessionID/message uses limit=20, order=desc, directory, no cursor", async () => {
    const { fetchSessionProjectionPage } = await import("./session-projection-api")
    const signal = new AbortController().signal

    const page = await fetchSessionProjectionPage({
      sessionID: "ses/a b",
      directory: "/repo a",
      signal,
    })

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.method).toBe("GET")
    expect(call.url.pathname).toBe(`/api/session/${encodeURIComponent("ses/a b")}/message`)
    expect(call.url.searchParams.get("directory")).toBe("/repo a")
    expect(call.url.searchParams.get("limit")).toBe("20")
    expect(call.url.searchParams.get("order")).toBe("desc")
    expect(call.url.searchParams.has("cursor")).toBe(false)
    expect(call.signal?.aborted).toBe(false)

    expect(page.complete).toBe(false)
    expect(page.cursor).toBe("cur_older")
    expect(page.records.map((record) => record.info.id)).toEqual(["msg_user"])
  })

  test("older history sends the projection cursor, not a message-id comparison", async () => {
    const { fetchSessionProjectionPage } = await import("./session-projection-api")

    await fetchSessionProjectionPage({
      sessionID: SESSION,
      directory: "/repo",
      cursor: "cur_from_previous_page",
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url.searchParams.get("cursor")).toBe("cur_from_previous_page")
    expect(calls[0]!.url.searchParams.get("limit")).toBe("20")
    expect(calls[0]!.url.searchParams.get("order")).toBe("desc")
    expect(calls[0]!.url.searchParams.has("before")).toBe(false)
  })

  test("normalizes user / assistant text+reasoning+tool / synthetic / system from literal JSON", async () => {
    responseImpl = async () =>
      jsonResponse({
        data: [ASSISTANT_JSON, SYNTHETIC_JSON, SYSTEM_JSON, USER_JSON],
        cursor: { previous: null, next: null },
      })
    const { fetchSessionProjectionPage } = await import("./session-projection-api")

    const page = await fetchSessionProjectionPage({
      sessionID: SESSION,
      directory: "/repo",
    })

    expect(page.complete).toBe(true)
    expect(page.cursor).toBeUndefined()

    const byID = Object.fromEntries(page.records.map((record) => [record.info.id, record]))
    expect(byID.msg_user?.info.role).toBe("user")
    expect(byID.msg_user?.parts?.some((part) => part.type === "text" && (part as { text?: string }).text === "hello from user")).toBe(true)

    expect(byID.msg_asst?.info.role).toBe("assistant")
    const asstTypes = (byID.msg_asst?.parts ?? []).map((part) => part.type)
    expect(asstTypes).toContain("text")
    expect(asstTypes).toContain("reasoning")
    expect(asstTypes).toContain("tool")
    const tool = byID.msg_asst?.parts?.find((part) => part.type === "tool") as { tool?: string; state?: { output?: string } } | undefined
    expect(tool?.tool).toBe("read")
    expect(tool?.state?.output).toBe("file body")

    expect(byID.msg_syn?.parts?.some((part) => (part as { text?: string }).text === "synthetic body")).toBe(true)
    expect(byID.msg_sys?.parts?.some((part) => (part as { text?: string }).text === "system instruction")).toBe(true)
  })

  test("compaction running / completed / failed stay as compaction cards, not assistant text", async () => {
    responseImpl = async () =>
      jsonResponse({
        data: [
          {
            id: "msg_compact",
            type: "compaction",
            time: { created: 14 },
            status: "completed",
            reason: "manual",
            summary: "kept last turns",
          },
          USER_JSON,
        ],
        cursor: { previous: null, next: null },
      })
    const { fetchSessionProjectionPage, isSessionCompactionCard } = await import("./session-projection-api")

    const page = await fetchSessionProjectionPage({
      sessionID: SESSION,
      directory: "/repo",
    })

    const compact = page.records.find((record) => record.info.id === "msg_compact")
    expect(isSessionCompactionCard(compact?.parts?.[0])).toBe(true)
    expect(compact?.parts?.some((part) => part.type === "text" && (part as { text?: string }).text === "kept last turns")).toBe(false)
    expect(page.records.some((record) => record.info.id === "msg_user")).toBe(true)
  })

  test("unknown type stays as a renderable placeholder and does not drop sibling messages", async () => {
    responseImpl = async () =>
      jsonResponse({
        data: [UNKNOWN_JSON, USER_JSON],
        cursor: { previous: null, next: null },
      })
    const { fetchSessionProjectionPage } = await import("./session-projection-api")

    const page = await fetchSessionProjectionPage({
      sessionID: SESSION,
      directory: "/repo",
    })

    const ids = page.records.map((record) => record.info.id)
    expect(ids).toContain("msg_unknown")
    expect(ids).toContain("msg_user")
    const unknown = page.records.find((record) => record.info.id === "msg_unknown")
    expect(unknown?.parts?.length).toBeGreaterThan(0)
    expect(unknown?.info.id).toBe("msg_unknown")
  })

  test("desc page is emitted oldest-to-newest for the existing render window", async () => {
    responseImpl = async () =>
      jsonResponse({
        data: [
          { ...ASSISTANT_JSON, id: "msg_new" },
          { ...USER_JSON, id: "msg_old" },
        ],
        cursor: { previous: "cur_1", next: null },
      })
    const { fetchSessionProjectionPage } = await import("./session-projection-api")

    const page = await fetchSessionProjectionPage({
      sessionID: SESSION,
      directory: "/repo",
    })

    expect(page.records.map((record) => record.info.id)).toEqual(["msg_old", "msg_new"])
  })

  test("HTTP non-2xx throws and does not return []", async () => {
    responseImpl = async () => new Response("nope", { status: 500 })
    const { fetchSessionProjectionPage } = await import("./session-projection-api")
    await expect(
      fetchSessionProjectionPage({ sessionID: SESSION, directory: "/repo" }),
    ).rejects.toThrow()
  })

  test("malformed JSON throws", async () => {
    responseImpl = async () =>
      new Response("not-json", { status: 200, headers: { "content-type": "application/json" } })
    const { fetchSessionProjectionPage } = await import("./session-projection-api")
    await expect(
      fetchSessionProjectionPage({ sessionID: SESSION, directory: "/repo" }),
    ).rejects.toThrow()
  })

  test("missing data array throws instead of pretending empty success", async () => {
    responseImpl = async () => jsonResponse({ cursor: { previous: null } })
    const { fetchSessionProjectionPage } = await import("./session-projection-api")
    await expect(
      fetchSessionProjectionPage({ sessionID: SESSION, directory: "/repo" }),
    ).rejects.toThrow()
  })

  test("HTML body throws", async () => {
    responseImpl = async () =>
      new Response("<!doctype html><html></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    const { fetchSessionProjectionPage } = await import("./session-projection-api")
    await expect(
      fetchSessionProjectionPage({ sessionID: SESSION, directory: "/repo" }),
    ).rejects.toThrow()
  })

  test("successful empty data is complete, not a thrown failure", async () => {
    responseImpl = async () => jsonResponse({ data: [], cursor: { previous: null, next: null } })
    const { fetchSessionProjectionPage } = await import("./session-projection-api")
    const page = await fetchSessionProjectionPage({ sessionID: SESSION, directory: "/repo" })
    expect(page.records).toEqual([])
    expect(page.complete).toBe(true)
  })
})

describe("reconcileFetched", () => {
  async function loadReconcile() {
    const api = await import("./session-projection-api")
    const record = (id: string, text: string) =>
      api.normalizeSessionProjectionMessage(SESSION, {
        id,
        type: "user",
        time: { created: 1 },
        text,
      })!
    return { ...api, record }
  }

  test("complete tail uses the GET id set: extras dropped, missing added, same id updated", async () => {
    const { reconcileFetched, record } = await loadReconcile()
    const previous = [record("msg_old", "stale"), record("msg_extra", "gone")]
    const fetched = [record("msg_old", "fresh"), record("msg_new", "added")]
    const next = reconcileFetched({
      fetched,
      previous,
      touched: new Set(),
      completeTail: true,
    })
    expect(next.map((item) => item.info.id)).toEqual(["msg_old", "msg_new"])
    expect((next[0]?.parts[0] as { text?: string })?.text).toBe("fresh")
    expect(next.some((item) => item.info.id === "msg_extra")).toBe(false)
  })

  test("incomplete page keeps earlier local rows that the GET did not return", async () => {
    const { reconcileFetched, record } = await loadReconcile()
    const previous = [
      record("msg_01", "history"),
      record("msg_02", "history"),
      record("msg_10", "stale"),
      record("msg_11", "extra-tail"),
    ]
    const fetched = [record("msg_10", "fresh"), record("msg_12", "added")]
    const next = reconcileFetched({
      fetched,
      previous,
      touched: new Set(),
      completeTail: false,
    })
    expect(next.map((item) => item.info.id)).toEqual(["msg_01", "msg_02", "msg_10", "msg_12"])
    expect((next.find((item) => item.info.id === "msg_10")?.parts[0] as { text?: string })?.text).toBe("fresh")
    expect(next.some((item) => item.info.id === "msg_11")).toBe(false)
  })

  test("touched ids keep the local row over this GET", async () => {
    const { reconcileFetched, record } = await loadReconcile()
    const previous = [record("msg_old", "live-sse"), record("msg_extra", "gone")]
    const fetched = [record("msg_old", "from-get"), record("msg_new", "added")]
    const next = reconcileFetched({
      fetched,
      previous,
      touched: new Set(["msg_old"]),
      completeTail: true,
    })
    expect(next.map((item) => item.info.id)).toEqual(["msg_old", "msg_new"])
    expect((next[0]?.parts[0] as { text?: string })?.text).toBe("live-sse")
  })
})
