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
        cursor: { previous: null, next: "cur_older" },
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
    expect(calls[0]!.url.searchParams.has("order")).toBe(false)
    expect(calls[0]!.url.searchParams.has("before")).toBe(false)
  })

  test("normalizes chat rows and excludes system instructions from literal JSON", async () => {
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
    expect(byID.msg_sys).toBeUndefined()
  })

  test("assistant GET keeps tokens/cost for TPS chrome", async () => {
    responseImpl = async () =>
      jsonResponse({
        data: [{
          id: "msg_asst",
          type: "assistant",
          time: { created: 20, completed: 30 },
          agent: "build",
          model: { id: "gpt", providerID: "openai" },
          finish: "stop",
          cost: 0.042,
          tokens: {
            input: 10,
            output: 44,
            reasoning: 9,
            cache: { read: 2, write: 0 },
          },
          content: [{ type: "text", text: "answer" }],
        }],
        cursor: { previous: null, next: null },
      })
    const { fetchSessionProjectionPage } = await import("./session-projection-api")
    const page = await fetchSessionProjectionPage({
      sessionID: SESSION,
      directory: "/repo",
    })
    const info = page.records[0]?.info as {
      cost?: number
      finish?: string
      tokens?: { output?: number; reasoning?: number; input?: number }
    }
    expect(info.finish).toBe("stop")
    expect(info.cost).toBe(0.042)
    expect(info.tokens?.output).toBe(44)
    expect(info.tokens?.reasoning).toBe(9)
    expect(info.tokens?.input).toBe(10)
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
        cursor: { previous: null, next: "cur_1" },
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
    responseImpl = async () => jsonResponse({ cursor: { previous: null, next: null } })
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

  test("order=desc incomplete pages use cursor.next (previous-only must not look complete)", async () => {
    responseImpl = async () =>
      jsonResponse({
        data: [USER_JSON],
        cursor: { previous: null, next: "older" },
      })
    const { fetchSessionProjectionPage, normalizeSessionProjectionPage } = await import("./session-projection-api")
    const page = await fetchSessionProjectionPage({ sessionID: SESSION, directory: "/repo" })
    expect(page.complete).toBe(false)
    expect(page.cursor).toBe("older")

    // Wire shape from Host: previous null does not mean exhausted under desc.
    const normalized = normalizeSessionProjectionPage(
      { data: [USER_JSON], cursor: { previous: null, next: "older" } },
      SESSION,
      "desc",
    )
    expect(normalized.complete).toBe(false)
    expect(normalized.cursor).toBe("older")
  })

  test("drops 2.0.12 idle/model-switched rows and keeps assistant text content", async () => {
    const { normalizeSessionProjectionMessage } = await import("./session-projection-api")
    expect(normalizeSessionProjectionMessage(SESSION, {
      id: "msg_idle",
      type: "idle",
      outcome: "succeeded",
      time: { created: 1 },
    })).toBeNull()
    expect(normalizeSessionProjectionMessage(SESSION, {
      id: "msg_idle_role",
      role: "idle",
      outcome: "succeeded",
      time: { created: 1 },
    })).toBeNull()
    expect(normalizeSessionProjectionMessage(SESSION, {
      id: "msg_switched",
      type: "model-switched",
      time: { created: 1 },
    })).toBeNull()
    const assistant = normalizeSessionProjectionMessage(SESSION, {
      id: "msg_asst_v2",
      type: "assistant",
      time: { created: 2, completed: 3 },
      content: [
        { type: "reasoning", text: "think" },
        { type: "text", text: "正常" },
      ],
      finish: "stop",
    })
    expect(assistant?.parts.map((part) => (part as { type?: string; text?: string }).text)).toEqual(["think", "正常"])
  })

  test("v2 patch tool projects as apply_patch with its patch metadata", async () => {
    const { normalizeSessionProjectionMessage } = await import("./session-projection-api")
    const files = [{ file: "src/a.ts", patch: "--- a\n+++ b\n", status: "modified", additions: 1, deletions: 2 }]
    const assistant = normalizeSessionProjectionMessage(SESSION, {
      id: "msg_patch",
      type: "assistant",
      time: { created: 1 },
      content: [{
        type: "tool",
        id: "call_patch",
        name: "patch",
        state: { status: "completed", input: { patchText: "*** Begin Patch" }, metadata: { files } },
      }],
    })
    const tool = assistant?.parts[0] as { tool?: string; state?: { input?: unknown; metadata?: unknown } }
    expect(tool.tool).toBe("apply_patch")
    expect(tool.state?.input).toEqual({ patchText: "*** Begin Patch" })
    expect(tool.state?.metadata).toEqual({ files })
  })

  test("real wire reload page: user + assistant content, no idle control row", async () => {
    const { normalizeSessionProjectionPage } = await import("./session-projection-api")
    // Shape captured from isolated backend GET /session/.../message for
    // ses_f373f63c7ffeiHcvYO52c2wz6W (orchestrator success).
    const page = normalizeSessionProjectionPage({
      data: [
        {
          id: "msg_idle_ok",
          time: { created: 1790074467023 },
          type: "idle",
          outcome: "succeeded",
        },
        {
          id: "msg_asst_orch",
          time: { created: 1790074461285, streamed: 1790074467020, completed: 1790074467021 },
          type: "assistant",
          agent: "orchestrator",
          model: { id: "glm-5.3-flash", providerID: "zai-coding-plan", variant: "default" },
          content: [
            { type: "reasoning", text: "think" },
            { type: "text", text: "ORCH_UI_OK_1855" },
          ],
          finish: "stop",
          rawFinish: "stop",
          cost: 0,
          tokens: { input: 10, output: 9, reasoning: 3, cache: { read: 0, write: 0 } },
        },
        {
          id: "msg_user_orch",
          time: { created: 1790074461271 },
          text: "UI-E2E-FIX-ORCH-1855",
          type: "user",
        },
      ],
      cursor: { previous: null, next: null },
    }, SESSION, "desc")

    expect(page.records.map((record) => record.info.role)).toEqual(["user", "assistant"])
    expect(page.records.map((record) => record.info.id)).toEqual(["msg_user_orch", "msg_asst_orch"])
    const assistant = page.records[1]!
    expect(assistant.info.agent).toBe("orchestrator")
    expect(assistant.info.modelID).toBe("glm-5.3-flash")
    expect(assistant.info.providerID).toBe("zai-coding-plan")
    expect(assistant.info.model).toEqual({
      providerID: "zai-coding-plan",
      modelID: "glm-5.3-flash",
      variant: "default",
    })
    expect((assistant.parts ?? []).some((part) => part.type === "text" && (part as { text?: string }).text === "ORCH_UI_OK_1855")).toBe(true)
    expect(page.records.some((record) => (record.info as { type?: string }).type === "idle")).toBe(false)
  })

  test("real wire provider.auth 401 assistant keeps finish/error; idle failed control dropped", async () => {
    const { normalizeSessionProjectionPage } = await import("./session-projection-api")
    // Shape from ses_f374247a7ffe3CZ56e8xJ11VSV (DeepSeek build 401).
    const page = normalizeSessionProjectionPage({
      data: [
        {
          id: "msg_idle_fail",
          time: { created: 3 },
          type: "idle",
          outcome: "failed",
        },
        {
          id: "msg_asst_401",
          time: { created: 2, completed: 3 },
          type: "assistant",
          agent: "build",
          model: { id: "deepseek-flash", providerID: "deepseek", variant: "default" },
          content: null,
          finish: "error",
          error: {
            type: "provider.auth",
            message: "Authentication Fails, Your api key: **** is invalid",
            status: 401,
          },
        },
        {
          id: "msg_user_401",
          time: { created: 1 },
          text: "UI-E2E-FIX-DS-1851",
          type: "user",
        },
      ],
      cursor: { previous: null, next: null },
    }, SESSION, "desc")

    expect(page.records.map((record) => record.info.role)).toEqual(["user", "assistant"])
    const assistant = page.records[1]!
    expect(assistant.info.finish).toBe("error")
    expect(assistant.info.agent).toBe("build")
    const error = assistant.info.error as { type?: string; message?: string; status?: number }
    expect(error.type).toBe("provider.auth")
    expect(error.message).toContain("Authentication Fails")
    expect(error.status).toBe(401)
    expect(assistant.parts ?? []).toEqual([])
    // Must not invent a successful empty assistant from the idle control row.
    expect(page.records).toHaveLength(2)
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
