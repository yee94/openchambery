import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

mock.restore()

import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from "../lib/runtime-url"
import type { Event } from '@/sync/types'
import type { TranscriptEventDraft } from "./transcript-event-reducer"

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
const here = dirname(fileURLToPath(import.meta.url))

type FetchCall = {
  url: URL
  method: string
  body: unknown
}

const SESSION = "ses_1"

const INBOX_COMPACTION = {
  id: "inbox_compact",
  sessionID: SESSION,
  timeCreated: 1_700_000_000_000,
  type: "compaction",
  delivery: "steer",
}

const COMPACTION_RUNNING = {
  id: "msg_compact",
  type: "compaction",
  time: { created: 40 },
  status: "running",
  reason: "manual",
  summary: "folding history",
  recent: "last turn",
}

const COMPACTION_COMPLETED = {
  ...COMPACTION_RUNNING,
  status: "completed",
  summary: "kept the last two turns",
}

const COMPACTION_FAILED = {
  id: "msg_compact_fail",
  type: "compaction",
  time: { created: 41 },
  status: "failed",
  reason: "auto",
  error: { type: "error", message: "model refused" },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("postSessionCompact (ticket 08)", () => {
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
    responseImpl = async () => jsonResponse({ data: INBOX_COMPACTION })
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      let body: unknown = null
      try {
        const text = await request.clone().text()
        body = text ? JSON.parse(text) : null
      } catch {
        body = null
      }
      calls.push({
        url: new URL(request.url),
        method: request.method,
        body,
      })
      return responseImpl(calls[calls.length - 1]!)
    }) as typeof fetch
    const { resetSessionCompactionBarrier } = await import("./session-compaction-api")
    resetSessionCompactionBarrier()
  })

  afterEach(() => {
    setRuntimeUrlResolver(previousResolver)
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow })
    globalThis.fetch = originalFetch
  })

  afterAll(() => {
    mock.restore()
  })

  test("POSTs /api/session/:encodedSessionID/compact with directory and does not call session.summarize", async () => {
    const { postSessionCompact } = await import("./session-compaction-api")

    const inbox = await postSessionCompact({
      sessionID: "ses/a b",
      directory: "/repo a",
    })

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.method).toBe("POST")
    expect(call.url.pathname).toBe(`/api/session/${encodeURIComponent("ses/a b")}/compact`)
    expect(call.url.searchParams.get("directory")).toBe("/repo a")
    expect(inbox.id).toBe("inbox_compact")
    expect(inbox.type).toBe("compaction")
    expect(inbox.sessionID).toBe(SESSION)
  })

  test("HTTP non-2xx throws and does not return empty success", async () => {
    responseImpl = async () => new Response("nope", { status: 500 })
    const { postSessionCompact } = await import("./session-compaction-api")
    await expect(
      postSessionCompact({ sessionID: SESSION, directory: "/repo" }),
    ).rejects.toThrow()
  })

  test("malformed JSON throws", async () => {
    responseImpl = async () =>
      new Response("not-json", { status: 200, headers: { "content-type": "application/json" } })
    const { postSessionCompact } = await import("./session-compaction-api")
    await expect(
      postSessionCompact({ sessionID: SESSION, directory: "/repo" }),
    ).rejects.toThrow()
  })

  test("successful compact arms the inbox barrier", async () => {
    const { postSessionCompact, isCompactionBarrierActive, canPromoteInboxItem } = await import("./session-compaction-api")
    await postSessionCompact({ sessionID: SESSION, directory: "/repo" })
    expect(isCompactionBarrierActive(SESSION)).toBe(true)
    expect(canPromoteInboxItem({ sessionID: SESSION })).toBe(false)
  })
})

describe("normalize compaction variants (ticket 08)", () => {
  test("running / completed / failed become compaction cards, not assistant text", async () => {
    const { normalizeSessionProjectionMessage, isSessionCompactionCard } = await import("./session-projection-api")

    const running = normalizeSessionProjectionMessage(SESSION, COMPACTION_RUNNING)!
    expect((running.info as { clientRole?: string }).clientRole).toBe("compaction")
    expect(running.parts.some((part) => part.type === "text" && (part as { text?: string }).text === "folding history")).toBe(false)
    expect(isSessionCompactionCard(running.parts[0])).toBe(true)
    expect((running.parts[0] as { status?: string }).status).toBe("running")
    expect((running.parts[0] as { summary?: string }).summary).toBe("folding history")

    const completed = normalizeSessionProjectionMessage(SESSION, COMPACTION_COMPLETED)!
    expect(isSessionCompactionCard(completed.parts[0])).toBe(true)
    expect((completed.parts[0] as { status?: string }).status).toBe("completed")
    expect(completed.parts.some((part) => part.type === "text")).toBe(false)

    const failed = normalizeSessionProjectionMessage(SESSION, COMPACTION_FAILED)!
    expect((failed.parts[0] as { status?: string }).status).toBe("failed")
    expect((failed.parts[0] as { error?: { message?: string } }).error?.message).toBe("model refused")
    expect(failed.parts.some((part) => part.type === "text" && (part as { text?: string }).text === "model refused")).toBe(false)
  })

  test("display normalize does not rewrite a v2 compaction card into /compact", async () => {
    const { normalizeSessionProjectionMessage } = await import("./session-projection-api")
    const { getNormalizedMessageForDisplay } = await import("../components/chat/lib/messageDisplayNormalization")
    const normalized = normalizeSessionProjectionMessage(SESSION, COMPACTION_COMPLETED)!
    const displayed = getNormalizedMessageForDisplay({
      info: normalized.info,
      parts: normalized.parts,
    })
    expect(displayed.parts.some((part) => part.type === "text" && (part as { text?: string }).text === "/compact")).toBe(false)
    expect(displayed.parts[0]?.type).toBe("compaction")
    expect((displayed.parts[0] as { status?: string }).status).toBe("completed")
  })
})

describe("GET session context (ticket 08)", () => {
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
        data: [
          { id: "msg_user", type: "user", time: { created: 10 }, text: "after checkpoint" },
          COMPACTION_COMPLETED,
        ],
      })
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      calls.push({
        url: new URL(request.url),
        method: request.method,
        body: null,
      })
      return responseImpl(calls[calls.length - 1]!)
    }) as typeof fetch
  })

  afterEach(() => {
    setRuntimeUrlResolver(previousResolver)
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow })
    globalThis.fetch = originalFetch
  })

  test("GET /api/session/:id/context uses directory and the same normalize", async () => {
    const { fetchSessionContext, isSessionCompactionCard } = await import("./session-projection-api")
    const page = await fetchSessionContext({
      sessionID: "ses/a b",
      directory: "/repo a",
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("GET")
    expect(calls[0]!.url.pathname).toBe(`/api/session/${encodeURIComponent("ses/a b")}/context`)
    expect(calls[0]!.url.searchParams.get("directory")).toBe("/repo a")
    expect(page.records.map((record) => record.info.id)).toEqual(["msg_user", "msg_compact"])
    const card = page.records.find((record) => record.info.id === "msg_compact")
    expect(isSessionCompactionCard(card?.parts?.[0])).toBe(true)
  })

  test("HTTP non-2xx / missing data / malformed JSON throw instead of empty success", async () => {
    const { fetchSessionContext } = await import("./session-projection-api")
    responseImpl = async () => new Response("nope", { status: 500 })
    await expect(fetchSessionContext({ sessionID: SESSION, directory: "/repo" })).rejects.toThrow()

    responseImpl = async () => jsonResponse({ cursor: null })
    await expect(fetchSessionContext({ sessionID: SESSION, directory: "/repo" })).rejects.toThrow()

    responseImpl = async () =>
      new Response("not-json", { status: 200, headers: { "content-type": "application/json" } })
    await expect(fetchSessionContext({ sessionID: SESSION, directory: "/repo" })).rejects.toThrow()
  })
})

describe("first paint prefers context; prepend stays on projection", () => {
  let previousResolver: ReturnType<typeof getRuntimeUrlResolver>
  let calls: FetchCall[]

  beforeEach(() => {
    previousResolver = getRuntimeUrlResolver()
    configureRuntimeUrlResolver({ apiBaseUrl: "http://127.0.0.1:57123" })
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "https://app.example", href: "https://app.example/" } },
    })
    calls = []
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      calls.push({ url, method: request.method, body: null })
      if (url.pathname.endsWith("/context")) {
        return jsonResponse({
          data: [{ id: "msg_after", type: "user", time: { created: 20 }, text: "after compact" }],
        })
      }
      return jsonResponse({
        data: [
          { id: "msg_after", type: "user", time: { created: 20 }, text: "after compact" },
          { id: "msg_before", type: "user", time: { created: 10 }, text: "before compact" },
        ],
        cursor: { previous: "cur_older", next: null },
      })
    }) as typeof fetch
  })

  afterEach(() => {
    setRuntimeUrlResolver(previousResolver)
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow })
    globalThis.fetch = originalFetch
  })

  test("initial open uses context records and keeps the projection cursor for older history", async () => {
    const { fetchProductionTranscriptTransportPage } = await import("./transcript-repository-production")
    const page = await fetchProductionTranscriptTransportPage({
      directory: "/repo",
      sessionID: SESSION,
      limit: 20,
      signal: new AbortController().signal,
    })
    expect(calls.some((call) => call.url.pathname === `/api/session/${SESSION}/context`)).toBe(true)
    expect(calls.some((call) => call.url.pathname === `/api/session/${SESSION}/message`)).toBe(true)
    expect(page.records.map((record) => record.info.id)).toEqual(["msg_after"])
    expect(page.cursor).toBe("cur_older")
    expect(page.complete).toBe(false)
  })

  test("prepend only GETs projection with the cursor, not context", async () => {
    const { fetchProductionTranscriptTransportPage } = await import("./transcript-repository-production")
    await fetchProductionTranscriptTransportPage({
      directory: "/repo",
      sessionID: SESSION,
      limit: 20,
      before: "cur_older",
      signal: new AbortController().signal,
    })
    expect(calls.every((call) => !call.url.pathname.endsWith("/context"))).toBe(true)
    expect(calls[0]!.url.pathname).toBe(`/api/session/${SESSION}/message`)
    expect(calls[0]!.url.searchParams.get("cursor")).toBe("cur_older")
  })
})

describe("session.compaction.* live overlay", () => {
  test("started / delta / ended / failed update a compaction card, not assistant text", async () => {
    const { applyTranscriptDirectoryEvent } = await import("./transcript-event-reducer")
    const { isSessionCompactionCard } = await import("./session-projection-api")
    const { isTranscriptSseEventType } = await import("./transcript-repository")
    const { isCompactionBarrierActive, resetSessionCompactionBarrier } = await import("./session-compaction-api")
    resetSessionCompactionBarrier()

    expect(isTranscriptSseEventType("session.compaction.started")).toBe(true)
    expect(isTranscriptSseEventType("session.compaction.delta")).toBe(true)
    expect(isTranscriptSseEventType("session.compaction.ended")).toBe(true)
    expect(isTranscriptSseEventType("session.compaction.failed")).toBe(true)

    const draft: TranscriptEventDraft = { message: {}, part: {} }
    const event = (type: string, properties: Record<string, unknown>): Event =>
      ({ type, properties }) as Event

    expect(applyTranscriptDirectoryEvent(draft, event("session.compaction.started", {
      sessionID: SESSION,
      reason: "manual",
      recent: "turn",
      inputID: "msg_compact",
    }))).not.toBe(false)
    expect(isCompactionBarrierActive(SESSION)).toBe(true)
    const started = draft.part.msg_compact?.[0]
    expect(isSessionCompactionCard(started)).toBe(true)
    expect((started as { status?: string }).status).toBe("running")
    expect(draft.part.msg_compact?.some((part) => part.type === "text")).toBe(false)

    expect(applyTranscriptDirectoryEvent(draft, event("session.compaction.delta", {
      sessionID: SESSION,
      text: "fold",
    }))).not.toBe(false)
    expect((draft.part.msg_compact?.[0] as { summary?: string }).summary).toBe("fold")

    expect(applyTranscriptDirectoryEvent(draft, event("session.compaction.ended", {
      sessionID: SESSION,
      reason: "manual",
      text: "kept last turns",
      recent: "turn",
    }))).not.toBe(false)
    expect((draft.part.msg_compact?.[0] as { status?: string }).status).toBe("completed")
    expect((draft.part.msg_compact?.[0] as { summary?: string }).summary).toBe("kept last turns")
    expect(isCompactionBarrierActive(SESSION)).toBe(false)
  })

  test("failed live event marks the card failed and lifts the barrier", async () => {
    const { applyTranscriptDirectoryEvent } = await import("./transcript-event-reducer")
    const { isCompactionBarrierActive, resetSessionCompactionBarrier } = await import("./session-compaction-api")
    resetSessionCompactionBarrier()
    const draft: TranscriptEventDraft = { message: {}, part: {} }
    applyTranscriptDirectoryEvent(draft, {
      type: "session.compaction.started",
      properties: { sessionID: SESSION, reason: "auto" },
    } as Event)
    applyTranscriptDirectoryEvent(draft, {
      type: "session.compaction.failed",
      properties: { sessionID: SESSION, reason: "auto", error: { type: "error", message: "boom" } },
    } as Event)
    const part = Object.values(draft.part)[0]?.[0] as { status?: string; error?: { message?: string } }
    expect(part.status).toBe("failed")
    expect(part.error?.message).toBe("boom")
    expect(isCompactionBarrierActive(SESSION)).toBe(false)
  })
})

describe("inbox barrier + source contracts", () => {
  test("running compaction blocks queue promote; completed does not", async () => {
    const {
      canPromoteInboxItem,
      isCompactionBarrierActive,
      setSessionCompactionBarrier,
      resetSessionCompactionBarrier,
    } = await import("./session-compaction-api")
    resetSessionCompactionBarrier()
    expect(canPromoteInboxItem({ sessionID: SESSION })).toBe(true)
    setSessionCompactionBarrier(SESSION, true)
    expect(isCompactionBarrierActive(SESSION)).toBe(true)
    expect(canPromoteInboxItem({ sessionID: SESSION })).toBe(false)
    setSessionCompactionBarrier(SESSION, false)
    expect(canPromoteInboxItem({ sessionID: SESSION })).toBe(true)
  })

  test("GET inbox compaction items arm the barrier without becoming user chips", async () => {
    const { parseSessionInboxList } = await import("./session-prompt-api")
    const { parseSessionInboxCompactionList, syncCompactionBarrierFromInbox, isCompactionBarrierActive, resetSessionCompactionBarrier } = await import("./session-compaction-api")
    resetSessionCompactionBarrier()
    const payload = {
      data: [
        INBOX_COMPACTION,
        {
          id: "msg_user",
          sessionID: SESSION,
          type: "user",
          delivery: "queue",
          timeCreated: 1,
          payload: { text: "wait" },
        },
      ],
    }
    const users = parseSessionInboxList(payload)
    expect(users.map((item) => item.id)).toEqual(["msg_user"])
    const compaction = parseSessionInboxCompactionList(payload)
    expect(compaction).toHaveLength(1)
    expect(compaction[0]?.type).toBe("compaction")
    syncCompactionBarrierFromInbox(SESSION, compaction)
    expect(isCompactionBarrierActive(SESSION)).toBe(true)
  })

  test("manual compact is wired to POST /compact, not session.summarize", () => {
    const clientSource = readFileSync(join(here, "../lib/opencode/client.ts"), "utf8")
    expect(clientSource.includes("postSessionCompact")).toBe(true)
    expect(clientSource.includes("this.client.session.summarize")).toBe(false)
  })

  test("session warming is not opened by default", () => {
    const productionSource = readFileSync(join(here, "transcript-repository-production.ts"), "utf8")
    const clientSource = readFileSync(join(here, "../lib/opencode/client.ts"), "utf8")
    const actionsSource = readFileSync(join(here, "session-actions.ts"), "utf8")
    expect(productionSource.includes("/warm")).toBe(false)
    expect(clientSource.includes("session.warm")).toBe(false)
    expect(clientSource.includes("/warm")).toBe(false)
    expect(actionsSource.includes("/warm")).toBe(false)
  })

  test("compaction card and queue waiting copy go through locale keys", () => {
    const cardSource = readFileSync(join(here, "../components/chat/message/CompactionCard.tsx"), "utf8")
    const chipSource = readFileSync(join(here, "../components/chat/QueuedMessageChips.tsx"), "utf8")
    const en = readFileSync(join(here, "../lib/i18n/messages/en.ts"), "utf8")
    const zhCN = readFileSync(join(here, "../lib/i18n/messages/zh-CN.ts"), "utf8")
    expect(cardSource.includes("useI18n")).toBe(true)
    expect(cardSource.includes("chat.activity.compacting")).toBe(true)
    expect(cardSource.includes("chat.activity.compactionCompleted")).toBe(true)
    expect(cardSource.includes("chat.activity.compactionFailed")).toBe(true)
    expect(cardSource.includes("Compacting")).toBe(false)
    expect(chipSource.includes("chat.queuedMessage.waitingForCompaction")).toBe(true)
    expect(en.includes("'chat.activity.compactionFailed'")).toBe(true)
    expect(en.includes("'chat.queuedMessage.waitingForCompaction'")).toBe(true)
    expect(zhCN.includes("'chat.activity.compactionFailed': '压缩失败'")).toBe(true)
    expect(zhCN.includes("'chat.queuedMessage.waitingForCompaction'")).toBe(true)
  })

  test("ChatMessage renders a dedicated compaction card instead of MessageBody text", () => {
    const messageSource = readFileSync(join(here, "../components/chat/ChatMessage.tsx"), "utf8")
    expect(messageSource.includes("CompactionCard")).toBe(true)
    expect(messageSource.includes("getSessionCompactionCard")).toBe(true)
  })
})
