import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

const readHere = (rel: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), rel), "utf8")

mock.restore()

import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from "../lib/runtime-url"

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window

type FetchCall = {
  url: URL
  method: string
  body: unknown
}

const SESSION = "ses_1"
const MESSAGE = "msg_user"

const INBOX_USER = {
  id: MESSAGE,
  sessionID: SESSION,
  timeCreated: 1_700_000_000_000,
  type: "user",
  delivery: "steer",
  payload: { text: "hello from inbox" },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status })
}

describe("idle prompt + interrupt (ticket 06)", () => {
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
    responseImpl = async () => jsonResponse({ data: INBOX_USER })
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      let body: unknown = null
      try {
        const text = await request.clone().text()
        body = text ? JSON.parse(text) : null
      } catch {
        body = null
      }
      const call: FetchCall = {
        url: new URL(request.url),
        method: request.method,
        body,
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

  test("idle send POSTs /api/session/:id/prompt with delivery=steer", async () => {
    const { postIdleSessionPrompt } = await import("./session-prompt-api")

    const inbox = await postIdleSessionPrompt({
      sessionID: "ses/a b",
      directory: "/repo a",
      messageID: MESSAGE,
      text: "hello from inbox",
    })

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.method).toBe("POST")
    expect(call.url.pathname).toBe(`/api/session/${encodeURIComponent("ses/a b")}/prompt`)
    expect(call.url.searchParams.get("directory")).toBe("/repo a")
    expect(call.body).toEqual(expect.objectContaining({
      id: MESSAGE,
      text: "hello from inbox",
      delivery: "steer",
    }))
    expect(inbox.id).toBe(MESSAGE)
    expect(inbox.type).toBe("user")
    expect(inbox.delivery).toBe("steer")
    expect(inbox.sessionID).toBe(SESSION)
  })

  test("inbox item response does not become a transcript row", async () => {
    const { postIdleSessionPrompt, transcriptRowsFromIdlePromptResponse } = await import("./session-prompt-api")

    const inbox = await postIdleSessionPrompt({
      sessionID: SESSION,
      directory: "/repo",
      messageID: MESSAGE,
      text: "hello from inbox",
    })

    expect(transcriptRowsFromIdlePromptResponse(inbox)).toEqual([])
    expect(transcriptRowsFromIdlePromptResponse({ data: inbox })).toEqual([])
  })

  test("matching promote id keeps the optimistic row; mismatch removes it and force GETs", async () => {
    const { confirmOptimisticAgainstPromoted } = await import("./session-prompt-api")
    const removed: string[] = []
    let refreshCalls = 0

    const matched = await confirmOptimisticAgainstPromoted({
      optimisticID: MESSAGE,
      promotedIDs: [MESSAGE, "msg_asst"],
      removeOptimistic: (id) => { removed.push(id) },
      refreshFromAuthority: async () => { refreshCalls += 1 },
    })
    expect(matched).toBe("confirmed")
    expect(removed).toEqual([])
    expect(refreshCalls).toBe(0)

    const missed = await confirmOptimisticAgainstPromoted({
      optimisticID: MESSAGE,
      promotedIDs: ["msg_other"],
      removeOptimistic: (id) => { removed.push(id) },
      refreshFromAuthority: async () => { refreshCalls += 1 },
    })
    expect(missed).toBe("refreshed")
    expect(removed).toEqual([MESSAGE])
    expect(refreshCalls).toBe(1)
  })

  test("interrupt POSTs /api/session/:id/interrupt", async () => {
    responseImpl = async () => emptyResponse(204)
    const { postSessionInterrupt } = await import("./session-prompt-api")

    await postSessionInterrupt({
      sessionID: "ses/a b",
      directory: "/repo a",
    })

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.method).toBe("POST")
    expect(call.url.pathname).toBe(`/api/session/${encodeURIComponent("ses/a b")}/interrupt`)
    expect(call.url.searchParams.get("directory")).toBe("/repo a")
  })

  test("send and STOP wire to v2 prompt / interrupt, not prompt_async / abort", async () => {
    const client = readHere("../lib/opencode/client.ts")
    const actions = readHere("./session-actions.ts")
    expect(client).toContain("postSessionPrompt")
    expect(client).toContain("postSessionInterrupt")
    expect(client).not.toContain("this.client.session.promptAsync")
    expect(actions).toContain("postSessionInterrupt")
    expect(actions).toContain("settleSessionPromptAfterSend")
  })

  test("failed prompt is not an empty success", async () => {
    responseImpl = async () => jsonResponse({ error: "rejected" }, 400)
    const { postIdleSessionPrompt } = await import("./session-prompt-api")

    let error: unknown = null
    try {
      await postIdleSessionPrompt({
        sessionID: SESSION,
        directory: "/repo",
        messageID: MESSAGE,
        text: "hello",
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : String(error)).toContain("400")
  })
})

const INBOX_QUEUED = {
  id: "msg_queued",
  sessionID: SESSION,
  timeCreated: 1_700_000_000_100,
  type: "user",
  delivery: "queue",
  payload: { text: "busy follow-up" },
}

describe("busy inbox queue / steer / cancel (ticket 07)", () => {
  let previousResolver: ReturnType<typeof getRuntimeUrlResolver>
  let calls: FetchCall[]
  let responseImpl: (call: FetchCall) => Promise<Response>

  beforeEach(async () => {
    previousResolver = getRuntimeUrlResolver()
    configureRuntimeUrlResolver({ apiBaseUrl: "http://127.0.0.1:57123" })
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "https://app.example", href: "https://app.example/" } },
    })
    calls = []
    responseImpl = async () => jsonResponse({ data: INBOX_QUEUED })
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      let body: unknown = null
      try {
        const text = await request.clone().text()
        body = text ? JSON.parse(text) : null
      } catch {
        body = null
      }
      const call: FetchCall = {
        url: new URL(request.url),
        method: request.method,
        body,
      }
      calls.push(call)
      return responseImpl(call)
    }) as typeof fetch
    const { useSessionInboxOverlayStore } = await import("./session-inbox-overlay")
    useSessionInboxOverlayStore.setState({ bySession: {} })
  })

  afterEach(() => {
    setRuntimeUrlResolver(previousResolver)
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow })
    globalThis.fetch = originalFetch
  })

  afterAll(() => {
    mock.restore()
  })

  test("busy send POSTs /api/session/:id/prompt with delivery=queue", async () => {
    const { postSessionPrompt } = await import("./session-prompt-api")

    const inbox = await postSessionPrompt({
      sessionID: "ses/a b",
      directory: "/repo a",
      messageID: "msg_queued",
      text: "busy follow-up",
      delivery: "queue",
    })

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.method).toBe("POST")
    expect(call.url.pathname).toBe(`/api/session/${encodeURIComponent("ses/a b")}/prompt`)
    expect(call.url.searchParams.get("directory")).toBe("/repo a")
    expect(call.body).toEqual(expect.objectContaining({
      id: "msg_queued",
      text: "busy follow-up",
      delivery: "queue",
    }))
    expect(inbox.id).toBe("msg_queued")
    expect(inbox.delivery).toBe("queue")
    expect(inbox.type).toBe("user")
  })

  test("steer / queue / cancel use official inbox method and path", async () => {
    const {
      steerSessionInbox,
      queueSessionInbox,
      cancelSessionInbox,
    } = await import("./session-prompt-api")

    responseImpl = async (call) => {
      if (call.method === "DELETE") return emptyResponse(204)
      if (call.url.pathname.endsWith("/steer")) {
        return jsonResponse({ data: { ...INBOX_QUEUED, delivery: "steer" } })
      }
      if (call.url.pathname.endsWith("/queue")) {
        return jsonResponse({ data: { ...INBOX_QUEUED, delivery: "queue" } })
      }
      return jsonResponse({ data: INBOX_QUEUED })
    }

    const steered = await steerSessionInbox({
      sessionID: "ses/a b",
      inboxID: "msg/q 1",
      directory: "/repo a",
    })
    const queued = await queueSessionInbox({
      sessionID: "ses/a b",
      inboxID: "msg/q 1",
      directory: "/repo a",
    })
    await cancelSessionInbox({
      sessionID: "ses/a b",
      inboxID: "msg/q 1",
      directory: "/repo a",
    })

    expect(calls).toHaveLength(3)
    expect(calls[0]!.method).toBe("POST")
    expect(calls[0]!.url.pathname).toBe(
      `/api/session/${encodeURIComponent("ses/a b")}/inbox/${encodeURIComponent("msg/q 1")}/steer`,
    )
    expect(calls[0]!.url.searchParams.get("directory")).toBe("/repo a")
    expect(steered.delivery).toBe("steer")

    expect(calls[1]!.method).toBe("POST")
    expect(calls[1]!.url.pathname).toBe(
      `/api/session/${encodeURIComponent("ses/a b")}/inbox/${encodeURIComponent("msg/q 1")}/queue`,
    )
    expect(queued.delivery).toBe("queue")

    expect(calls[2]!.method).toBe("DELETE")
    expect(calls[2]!.url.pathname).toBe(
      `/api/session/${encodeURIComponent("ses/a b")}/inbox/${encodeURIComponent("msg/q 1")}`,
    )
  })

  test("cancel removes overlay and leaves no transcript residue", async () => {
    const { cancelUnpromotedInboxItem, transcriptRowsFromIdlePromptResponse } = await import("./session-prompt-api")
    const {
      rememberUnpromotedInbox,
      selectInboxOverlayChips,
      useSessionInboxOverlayStore,
    } = await import("./session-inbox-overlay")

    rememberUnpromotedInbox({
      id: "msg_queued",
      sessionID: SESSION,
      timeCreated: 1,
      type: "user",
      delivery: "queue",
      payload: { text: "busy follow-up" },
    })
    expect(selectInboxOverlayChips(SESSION).some((item) => item.queueItemID === "msg_queued")).toBe(true)

    responseImpl = async (call) => {
      if (call.method === "DELETE") return emptyResponse(204)
      if (call.method === "GET" && call.url.pathname.endsWith("/inbox")) {
        return jsonResponse({ data: [] })
      }
      return jsonResponse({ data: [] })
    }

    const result = await cancelUnpromotedInboxItem({
      sessionID: SESSION,
      inboxID: "msg_queued",
      directory: "/repo",
    })

    expect(calls.some((call) => call.method === "DELETE")).toBe(true)
    expect(selectInboxOverlayChips(SESSION).some((item) => item.queueItemID === "msg_queued")).toBe(false)
    expect(useSessionInboxOverlayStore.getState().list(SESSION).map((item) => item.id)).not.toContain("msg_queued")
    expect(result.transcriptRows).toEqual([])
    expect(transcriptRowsFromIdlePromptResponse({ id: "msg_queued", payload: { text: "busy follow-up" } })).toEqual([])
  })

  test("GET inbox replaces overlay by id, not by scanning local message text", async () => {
    const { fetchSessionInbox, replaceInboxOverlayFromAuthority } = await import("./session-prompt-api")
    const { rememberUnpromotedInbox, useSessionInboxOverlayStore } = await import("./session-inbox-overlay")

    rememberUnpromotedInbox({
      id: "msg_local",
      sessionID: SESSION,
      timeCreated: 1,
      type: "user",
      delivery: "queue",
      payload: { text: "same local body" },
    })
    rememberUnpromotedInbox({
      id: "msg_keep",
      sessionID: SESSION,
      timeCreated: 2,
      type: "user",
      delivery: "queue",
      payload: { text: "keep me" },
    })

    responseImpl = async () => jsonResponse({
      data: [
        { ...INBOX_QUEUED, id: "msg_keep", payload: { text: "same local body" } },
        { ...INBOX_QUEUED, id: "msg_server", payload: { text: "same local body" } },
      ],
    })

    const items = await fetchSessionInbox({ sessionID: SESSION, directory: "/repo" })
    replaceInboxOverlayFromAuthority(SESSION, items)

    const ids = useSessionInboxOverlayStore.getState().list(SESSION).map((item) => item.id)
    expect(ids).toEqual(["msg_keep", "msg_server"])
    expect(ids).not.toContain("msg_local")
    const overlaySource = readHere("./session-inbox-overlay.ts")
    expect(overlaySource).not.toMatch(/payload\.text\s*===/)
    expect(overlaySource).not.toMatch(/content\s*===\s*item/)
  })

  test("inbox mutations that fail are not empty successes", async () => {
    const {
      postSessionPrompt,
      steerSessionInbox,
      queueSessionInbox,
      cancelSessionInbox,
      fetchSessionInbox,
    } = await import("./session-prompt-api")
    const { rememberUnpromotedInbox, useSessionInboxOverlayStore } = await import("./session-inbox-overlay")

    rememberUnpromotedInbox({
      id: "msg_queued",
      sessionID: SESSION,
      timeCreated: 1,
      type: "user",
      delivery: "queue",
      payload: { text: "busy follow-up" },
    })

    responseImpl = async () => jsonResponse({ error: "rejected" }, 409)

    const failures: unknown[] = []
    for (const run of [
      () => postSessionPrompt({
        sessionID: SESSION,
        directory: "/repo",
        messageID: "msg_queued",
        text: "busy follow-up",
        delivery: "queue",
      }),
      () => steerSessionInbox({ sessionID: SESSION, inboxID: "msg_queued", directory: "/repo" }),
      () => queueSessionInbox({ sessionID: SESSION, inboxID: "msg_queued", directory: "/repo" }),
      () => cancelSessionInbox({ sessionID: SESSION, inboxID: "msg_queued", directory: "/repo" }),
      () => fetchSessionInbox({ sessionID: SESSION, directory: "/repo" }),
    ]) {
      try {
        await run()
        failures.push(null)
      } catch (error) {
        failures.push(error)
      }
    }

    expect(failures).toHaveLength(5)
    expect(failures.every((error) => error instanceof Error && String(error).includes("409"))).toBe(true)
    expect(useSessionInboxOverlayStore.getState().list(SESSION).map((item) => item.id)).toEqual(["msg_queued"])
  })

  test("same-session busy send and chip actions wire to prompt/inbox, not local body scan", async () => {
    const client = readHere("../lib/opencode/client.ts")
    const promptApi = readHere("./session-prompt-api.ts")
    const store = readHere("./session-ui-store.ts")
    const chatInput = readHere("../components/chat/ChatInput.tsx")
    const wiring = readHere("../components/chat/chatInputSurfaceWiring.ts")
    expect(client).toMatch(/delivery:\s*params\.delivery/)
    expect(client).toContain("postSessionPrompt")
    expect(promptApi).toContain("cancelUnpromotedInboxItem")
    expect(promptApi).toContain("steerSessionInbox")
    expect(promptApi).toContain("queueSessionInbox")
    expect(store).toMatch(/delivery\?:\s*'steer'\s*\|\s*'queue'/)
    expect(chatInput).toContain("delivery: 'queue'")
    expect(chatInput).toContain("cancelUnpromotedInboxItem")
    expect(chatInput).toContain("steerSessionInbox")
    expect(chatInput).toContain("queueSessionInbox")
    expect(wiring).toMatch(/delivery\?:\s*'steer'\s*\|\s*'queue'/)
  })
})
