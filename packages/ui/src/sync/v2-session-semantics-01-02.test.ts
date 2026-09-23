/**
 * Tickets 01 / 02 — native queue selection inherit + prompt admission lifecycle.
 *
 * Upstream evidence (readonly): OpenCode core 2.0.12 `SessionInbox.admit` /
 * `reconcile` by stable message id; official app `submit.ts` applies selection
 * only when `delivery === "steer"`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const readHere = (rel: string) => readFileSync(path.join(here, rel), "utf8")

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("01 queued input selection (source + resolve contracts)", () => {
  test("client and routeMessage gate applySendSelection off native queue delivery", () => {
    const client = readHere("../lib/opencode/client.ts")
    const ui = readHere("./session-ui-store.ts")
    expect(client).toContain('const delivery = params.delivery === "queue" ? "queue" : "steer"')
    expect(client).toContain('const applySelection = delivery !== "queue"')
    expect(client).toContain("if (applySelection)")
    expect(client).toContain("reconcilePromptAdmission")
    expect(ui).toContain('params.delivery !== "queue"')
    expect(ui).toContain("applyComposerSelection")
    // Host/Assistant captured queues stay on their own path — do not rewrite
    // message-queue sendConfig capture here.
    expect(readHere("../components/chat/queueAdmission.ts")).toContain("QueueSendConfig")
  })
})

describe("02 prompt admission API", () => {
  let previousResolver: ReturnType<typeof import("@/lib/runtime-url").getRuntimeUrlResolver>
  let calls: Array<{ url: URL; method: string; body: unknown }>
  let responseImpl: (call: { url: URL; method: string; body: unknown }) => Promise<Response>

  beforeEach(async () => {
    const { getRuntimeUrlResolver, configureRuntimeUrlResolver } = await import("@/lib/runtime-url")
    previousResolver = getRuntimeUrlResolver()
    configureRuntimeUrlResolver({ apiBaseUrl: "http://127.0.0.1:57123" })
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "https://app.example", href: "https://app.example/" },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => true,
      },
    })
    calls = []
    responseImpl = async () => jsonResponse({ data: [] })
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      let body: unknown = null
      try {
        const text = await request.clone().text()
        body = text ? JSON.parse(text) : null
      } catch {
        body = null
      }
      const call = { url: new URL(request.url), method: request.method, body }
      calls.push(call)
      return responseImpl(call)
    }) as typeof fetch

    const {
      resetInboxTerminalReceiptsForTests,
      useSessionInboxOverlayStore,
    } = await import("./session-inbox-overlay")
    resetInboxTerminalReceiptsForTests()
    useSessionInboxOverlayStore.setState({ bySession: {} })
  })

  afterEach(async () => {
    const { setRuntimeUrlResolver } = await import("@/lib/runtime-url")
    const { resetInboxTerminalReceiptsForTests } = await import("./session-inbox-overlay")
    resetInboxTerminalReceiptsForTests()
    setRuntimeUrlResolver(previousResolver)
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow })
    globalThis.fetch = originalFetch
  })

  test("postSessionPrompt remembers composer overlay on HTTP success", async () => {
    responseImpl = async () =>
      jsonResponse({
        id: "msg_admit",
        sessionID: "ses_a",
        timeCreated: 10,
        type: "user",
        delivery: "steer",
        payload: { text: "hi" },
      })
    const { postSessionPrompt } = await import("./session-prompt-api")
    const { useSessionInboxOverlayStore } = await import("./session-inbox-overlay")

    const item = await postSessionPrompt({
      sessionID: "ses_a",
      directory: "/repo",
      messageID: "msg_admit",
      text: "hi",
    })
    expect(item.id).toBe("msg_admit")
    expect(useSessionInboxOverlayStore.getState().list("ses_a").map((row) => row.id)).toEqual(["msg_admit"])
    expect(calls[0]?.url.pathname).toContain("/prompt")
  })

  test("isPromptAdmissionRejected separates explicit reject from ambiguous transport", async () => {
    const { isPromptAdmissionRejected } = await import("./session-prompt-api")
    expect(isPromptAdmissionRejected(Object.assign(new Error("x"), { status: 400 }))).toBe(true)
    expect(isPromptAdmissionRejected(Object.assign(new Error("x"), { status: 403 }))).toBe(true)
    expect(isPromptAdmissionRejected(Object.assign(new Error("x"), { status: 409 }))).toBe(true)
    expect(isPromptAdmissionRejected(Object.assign(new Error("x"), { status: 408 }))).toBe(false)
    expect(isPromptAdmissionRejected(Object.assign(new Error("x"), { status: 429 }))).toBe(false)
    expect(isPromptAdmissionRejected(Object.assign(new Error("x"), { status: 503 }))).toBe(false)
    expect(isPromptAdmissionRejected(new TypeError("Failed to fetch"))).toBe(false)
  })

  test("reconcilePromptAdmission finds pending inbox by fixed id", async () => {
    responseImpl = async (call) => {
      if (call.url.pathname.includes("/inbox") && call.method === "GET") {
        return jsonResponse({
          data: [{
            id: "msg_fixed",
            sessionID: "ses_a",
            timeCreated: 1,
            type: "user",
            delivery: "queue",
            payload: { text: "queued" },
          }],
        })
      }
      return jsonResponse({ data: [] })
    }
    const { reconcilePromptAdmission } = await import("./session-prompt-api")
    const result = await reconcilePromptAdmission({
      sessionID: "ses_a",
      directory: "/repo",
      inputID: "msg_fixed",
    })
    expect(result.status).toBe("pending")
    if (result.status === "pending") {
      expect(result.item.id).toBe("msg_fixed")
      expect(result.item.delivery).toBe("queue")
    }
  })

  test("reconcilePromptAdmission treats projection hit as promoted", async () => {
    responseImpl = async (call) => {
      if (call.url.pathname.includes("/inbox") && call.method === "GET") {
        return jsonResponse({ data: [] })
      }
      return jsonResponse({ records: [], complete: true })
    }

    vi.resetModules()
    vi.doMock("./session-projection-api", async () => {
      const actual = await vi.importActual<typeof import("./session-projection-api")>("./session-projection-api")
      return {
        ...actual,
        fetchSessionProjectionPage: vi.fn(async () => ({
          records: [{
            info: { id: "msg_promoted", role: "user", sessionID: "ses_a", time: { created: 1 } },
            parts: [],
          }],
          complete: true,
        })),
      }
    })

    const { reconcilePromptAdmission } = await import("./session-prompt-api")
    const { useSessionInboxOverlayStore, rememberUnpromotedInbox } = await import("./session-inbox-overlay")
    useSessionInboxOverlayStore.setState({ bySession: {} })
    rememberUnpromotedInbox({
      id: "msg_promoted",
      sessionID: "ses_a",
      timeCreated: 1,
      type: "user",
      delivery: "steer",
      payload: { text: "x" },
    })

    const result = await reconcilePromptAdmission({
      sessionID: "ses_a",
      directory: "/repo",
      inputID: "msg_promoted",
    })
    expect(result).toEqual({ status: "promoted", id: "msg_promoted" })
    expect(useSessionInboxOverlayStore.getState().list("ses_a")).toEqual([])
    vi.doUnmock("./session-projection-api")
    vi.resetModules()
  })

  test("settleSessionPromptAfterSend keeps admission when inbox already empty (consumed)", async () => {
    responseImpl = async () => jsonResponse({ data: [] })

    vi.resetModules()
    vi.doMock("./session-projection-api", async () => {
      const actual = await vi.importActual<typeof import("./session-projection-api")>("./session-projection-api")
      return {
        ...actual,
        fetchSessionProjectionPage: vi.fn(async () => ({
          records: [{
            info: { id: "msg_consumed", role: "user", sessionID: "ses_a", time: { created: 1 } },
            parts: [],
          }],
          complete: true,
        })),
      }
    })

    const { settleSessionPromptAfterSend, setOptimisticRefs } = await import("./session-actions")
    const { useSessionInboxOverlayStore } = await import("./session-inbox-overlay")
    useSessionInboxOverlayStore.setState({ bySession: {} })
    setOptimisticRefs(
      () => undefined,
      () => undefined,
      () => undefined,
    )

    await expect(
      settleSessionPromptAfterSend({
        sessionId: "ses_a",
        directory: "/repo",
        optimisticID: "msg_consumed",
        inboxID: "msg_consumed",
        text: "done",
        delivery: "steer",
      }),
    ).resolves.toBeUndefined()

    // Consumed + projected → overlay cleared; must not throw.
    expect(useSessionInboxOverlayStore.getState().list("ses_a")).toEqual([])
    vi.doUnmock("./session-projection-api")
    vi.resetModules()
  })

  test("known inbox events update overlay; unknown leave state", async () => {
    const { applySessionInboxEvent } = await import("./session-prompt-api")
    const {
      resetInboxTerminalReceiptsForTests,
      useSessionInboxOverlayStore,
    } = await import("./session-inbox-overlay")
    resetInboxTerminalReceiptsForTests()
    useSessionInboxOverlayStore.setState({ bySession: {} })

    expect(applySessionInboxEvent({
      type: "session.inbox.enqueued",
      properties: {
        sessionID: "ses_a",
        inboxID: "msg_e",
        item: {
          type: "user",
          delivery: "queue",
          payload: { text: "q" },
        },
      },
    })).toBe(true)
    expect(useSessionInboxOverlayStore.getState().list("ses_a")[0]?.id).toBe("msg_e")
    expect(useSessionInboxOverlayStore.getState().list("ses_a")[0]?.delivery).toBe("queue")

    expect(applySessionInboxEvent({
      type: "session.inbox.delivery.changed",
      properties: { sessionID: "ses_a", inboxID: "msg_e", delivery: "steer" },
    })).toBe(true)
    expect(useSessionInboxOverlayStore.getState().list("ses_a")[0]?.delivery).toBe("steer")

    expect(applySessionInboxEvent({
      type: "session.inbox.cancelled",
      properties: { sessionID: "ses_a", inboxID: "msg_e" },
    })).toBe(true)
    expect(useSessionInboxOverlayStore.getState().list("ses_a")).toEqual([])

    // Non-user enqueued items must not mint empty user chips.
    expect(applySessionInboxEvent({
      type: "session.inbox.enqueued",
      properties: {
        sessionID: "ses_a",
        inboxID: "msg_cmp",
        item: { type: "compaction", delivery: "steer", payload: {} },
      },
    })).toBe(false)
    expect(useSessionInboxOverlayStore.getState().list("ses_a")).toEqual([])

    expect(applySessionInboxEvent({
      type: "session.unknown.future",
      properties: { sessionID: "ses_a", inboxID: "msg_x" },
    })).toBe(false)
  })

  test("cancelled event then late HTTP remember does not resurrect a ghost", async () => {
    let releasePost!: (response: Response) => void
    const postGate = new Promise<Response>((resolve) => {
      releasePost = resolve
    })
    responseImpl = async (call) => {
      if (call.method === "POST" && call.url.pathname.includes("/prompt")) {
        return postGate
      }
      return jsonResponse({ data: [] })
    }

    const { applySessionInboxEvent, postSessionPrompt } = await import("./session-prompt-api")
    const {
      getInboxTerminal,
      resetInboxTerminalReceiptsForTests,
      useSessionInboxOverlayStore,
    } = await import("./session-inbox-overlay")
    resetInboxTerminalReceiptsForTests()
    useSessionInboxOverlayStore.setState({ bySession: {} })

    const pending = postSessionPrompt({
      sessionID: "ses_a",
      directory: "/repo",
      messageID: "msg_race_cancel",
      text: "hi",
    })

    // Wait until the controlled POST is in-flight before cancel + late resolve.
    await vi.waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.url.pathname.includes("/prompt"))).toBe(true)
    })

    expect(applySessionInboxEvent({
      type: "session.inbox.cancelled",
      properties: { sessionID: "ses_a", inboxID: "msg_race_cancel" },
    })).toBe(true)
    expect(getInboxTerminal("ses_a", "msg_race_cancel")).toBe("cancelled")
    expect(useSessionInboxOverlayStore.getState().list("ses_a")).toEqual([])

    releasePost(jsonResponse({
      id: "msg_race_cancel",
      sessionID: "ses_a",
      timeCreated: 10,
      type: "user",
      delivery: "steer",
      payload: { text: "hi" },
    }))

    const item = await pending
    expect(item.id).toBe("msg_race_cancel")
    // Late HTTP must not re-admit a cancelled identity as an executable chip.
    expect(useSessionInboxOverlayStore.getState().list("ses_a")).toEqual([])
    expect(getInboxTerminal("ses_a", "msg_race_cancel")).toBe("cancelled")
  })

  test("delivered/consumed terminal blocks late remember; authority pending can re-surface", async () => {
    const { applySessionInboxEvent, reconcilePromptAdmission } = await import("./session-prompt-api")
    const {
      getInboxTerminal,
      rememberUnpromotedInbox,
      resetInboxTerminalReceiptsForTests,
      useSessionInboxOverlayStore,
    } = await import("./session-inbox-overlay")
    resetInboxTerminalReceiptsForTests()
    useSessionInboxOverlayStore.setState({ bySession: {} })

    rememberUnpromotedInbox({
      id: "msg_consumed",
      sessionID: "ses_a",
      timeCreated: 1,
      type: "user",
      delivery: "steer",
      payload: { text: "x" },
    })
    expect(applySessionInboxEvent({
      type: "session.inbox.delivered",
      properties: { sessionID: "ses_a", inboxID: "msg_consumed" },
    })).toBe(true)
    expect(getInboxTerminal("ses_a", "msg_consumed")).toBe("consumed")
    expect(rememberUnpromotedInbox({
      id: "msg_consumed",
      sessionID: "ses_a",
      timeCreated: 2,
      type: "user",
      delivery: "steer",
      payload: { text: "x" },
    })).toBe(false)
    expect(useSessionInboxOverlayStore.getState().list("ses_a")).toEqual([])

    responseImpl = async (call) => {
      if (call.url.pathname.includes("/inbox") && call.method === "GET") {
        return jsonResponse({
          data: [{
            id: "msg_consumed",
            sessionID: "ses_a",
            timeCreated: 3,
            type: "user",
            delivery: "queue",
            payload: { text: "re-admit" },
          }],
        })
      }
      return jsonResponse({ data: [] })
    }

    const result = await reconcilePromptAdmission({
      sessionID: "ses_a",
      directory: "/repo",
      inputID: "msg_consumed",
    })
    expect(result.status).toBe("pending")
    expect(useSessionInboxOverlayStore.getState().list("ses_a").map((row) => row.id)).toEqual(["msg_consumed"])
  })

  test("reconcile empty inbox + empty projection is unknown (not a new draft)", async () => {
    responseImpl = async () => jsonResponse({ data: [] })
    vi.resetModules()
    vi.doMock("./session-projection-api", async () => {
      const actual = await vi.importActual<typeof import("./session-projection-api")>("./session-projection-api")
      return {
        ...actual,
        fetchSessionProjectionPage: vi.fn(async () => ({
          records: [],
          complete: true,
        })),
      }
    })
    const { reconcilePromptAdmission } = await import("./session-prompt-api")
    const {
      rememberUnpromotedInbox,
      resetInboxTerminalReceiptsForTests,
      useSessionInboxOverlayStore,
    } = await import("./session-inbox-overlay")
    resetInboxTerminalReceiptsForTests()
    useSessionInboxOverlayStore.setState({ bySession: {} })

    const result = await reconcilePromptAdmission({
      sessionID: "ses_a",
      directory: "/repo",
      inputID: "msg_unknown",
    })
    expect(result).toEqual({ status: "unknown" })
    expect(useSessionInboxOverlayStore.getState().list("ses_a")).toEqual([])
    // unknown must not invent a pending draft row
    expect(rememberUnpromotedInbox).toBeTypeOf("function")
    vi.doUnmock("./session-projection-api")
    vi.resetModules()
  })

  test("settle and client source: no throw-on-missing-inbox; fixed-id retry only prompt", () => {
    const actions = readHere("./session-actions.ts")
    const client = readHere("../lib/opencode/client.ts")
    expect(actions).not.toContain("session prompt inbox item was not found after send")
    expect(actions).toContain("isCurrentRuntimeTransport")
    expect(client).toContain("isPromptAdmissionRejected")
    expect(client).toContain("reconcilePromptAdmission")
    expect(client).toMatch(/One bounded prompt-only retry/)
  })

  test("commitStagedRevertBeforeSend applies repository revert-committed after success", () => {
    const actions = readHere("./session-actions.ts")
    expect(actions).toContain("commitStagedRevertBeforeSend")
    expect(actions).toContain('type: "revert-committed"')
    expect(actions).toContain("postSessionRevertCommit")
  })

  test("fork restore uses isAuthoredUserTurnRecord boundary", () => {
    const actions = readHere("./session-actions.ts")
    expect(actions).toContain("isAuthoredUserTurnRecord(forkSourceMessage, forkSourceParts)")
  })
})
