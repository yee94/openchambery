import { afterEach, describe, expect, test, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Message, Part } from "@/lib/opencode/v2-types"
import type { Event } from "./types"
import { normalizeSessionProjectionMessage } from "./session-projection-api"
import { createQueryTranscriptRepository } from "./transcript-repository-query-adapter"
import { createStoreTranscriptRepository, type TranscriptStoreSurface } from "./transcript-repository-store-adapter"
import { fetchProductionTranscriptTransportPage } from "./transcript-repository-production"
import { materializeSessionSnapshots } from "./materialization"
import { mergeOptimisticPage } from "./optimistic"
import { createMemoryTranscriptDurableStore } from "./transcript-durable-store"
import type { SessionMessageReducerState } from "./session-message-reducer"

const { fetchPage, fetchContext } = vi.hoisted(() => ({
  fetchPage: vi.fn(),
  fetchContext: vi.fn(),
}))
vi.mock("./session-projection-api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./session-projection-api")>(),
  fetchSessionProjectionPage: fetchPage,
  fetchSessionContext: fetchContext,
}))

const scope = { directory: "/workspace", sessionID: "ses_order", transport: "test", generation: 1 }
const messageID = "msg_order"
function fixture() {
  return normalizeSessionProjectionMessage(scope.sessionID, {
    id: messageID,
    type: "assistant",
    time: { created: 1, completed: 2 },
    finish: "stop",
    content: [
      { type: "reasoning", text: "Inspect the project" },
      { type: "text", text: "First read the build instructions." },
      { type: "tool", id: "call-z", name: "read", state: { status: "completed", input: {}, output: "done", time: { start: 1, end: 2 } } },
      { type: "text", text: "Now build the application." },
      { type: "tool", id: "call-a", name: "shell", state: { status: "completed", input: {}, output: "done", time: { start: 1, end: 2 } } },
    ],
  })!
}
const ids = (parts: readonly Part[]) => parts.map((part) => part.id)
const page = () => ({ records: [fixture()], complete: true, turnCount: 0 })
const event = (type: string, properties: Record<string, unknown>) => ({ type, properties }) as Event

function repository(kind: "query" | "store") {
  if (kind === "query") {
    const client = new QueryClient()
    const repo = createQueryTranscriptRepository({ client, transport: "test", generation: 1 })
    cleanups.push(() => { repo.destroy(); client.clear() })
    return repo
  }
  let state: SessionMessageReducerState = { message: {}, part: {} }
  const store: TranscriptStoreSurface = {
    getState: () => state,
    setState: (partial) => { state = { ...state, ...(typeof partial === "function" ? partial(state) : partial) } },
    subscribe: () => () => {},
  }
  return createStoreTranscriptRepository({ getStore: () => store })
}

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

describe("transcript content order", () => {
  test.each([undefined, "older-cursor"])("production fetch preserves native content order (cursor %s)", async (before) => {
    fetchPage.mockResolvedValue(page())
    fetchContext.mockResolvedValue(page())
    const result = await fetchProductionTranscriptTransportPage({ ...scope, before, limit: 20, signal: new AbortController().signal })
    expect(ids(result.records[0].parts ?? [])).toEqual(ids(fixture().parts))
  })

  describe.each(["query", "store"] as const)("%s repository", (kind) => {
    test.each(["initial", "prepend", "recovery", "materialize"] as const)("%s keeps interleaved text and tools", (purpose) => {
      const repo = repository(kind)
      repo.apply(scope, { type: "http-page", purpose, page: page() })
      expect(ids(repo.getParts(scope, messageID))).toEqual(ids(fixture().parts))
    })

    test("optimistic insertion keeps supplied part order", () => {
      const repo = repository(kind)
      const record = fixture()
      repo.apply(scope, { type: "optimistic-add", message: record.info, parts: record.parts })
      expect(ids(repo.getParts(scope, messageID))).toEqual(ids(record.parts))
    })

    test("part updates, deltas, replacement and removal locate identity without sorting", () => {
      const repo = repository(kind)
      const record = fixture()
      repo.apply(scope, { type: "http-page", purpose: "initial", page: page() })
      const text = record.parts[1]
      repo.apply(scope, { type: "sse-event", event: event("message.part.delta", { sessionID: scope.sessionID, messageID, partID: text.id, field: "text", delta: " More." }) })
      expect(repo.getParts(scope, messageID)[1]).toMatchObject({ text: "First read the build instructions. More." })
      repo.apply(scope, { type: "sse-event", event: event("message.part.updated", { part: { ...text, text: "Updated instructions" } }) })
      expect(ids(repo.getParts(scope, messageID))).toEqual(ids(record.parts))
      expect(repo.getParts(scope, messageID)[1]).toMatchObject({ text: "Updated instructions" })
      const appended = { ...text, id: "aaa-new", text: "After the tools" }
      repo.apply(scope, { type: "sse-event", event: event("message.part.updated", { part: appended }) })
      expect(ids(repo.getParts(scope, messageID))).toEqual([...ids(record.parts), appended.id])
      repo.apply(scope, { type: "sse-event", event: event("message.part.removed", { sessionID: scope.sessionID, messageID, partID: "call-z" }) })
      expect(ids(repo.getParts(scope, messageID))).toEqual([...ids(record.parts).filter((id) => id !== "call-z"), appended.id])
    })

    test("authority refresh repairs a previously id-sorted cache", () => {
      const repo = repository(kind)
      const record = fixture()
      repo.apply(scope, { type: "http-page", purpose: "initial", page: { ...page(), records: [{ ...record, parts: [...record.parts].sort((a, b) => a.id.localeCompare(b.id)) }] } })
      repo.apply(scope, { type: "http-page", purpose: "recovery", page: page() })
      expect(ids(repo.getParts(scope, messageID))).toEqual(ids(record.parts))
    })

    test("V2 stream order survives a matching HTTP snapshot and repeated updates", () => {
      const repo = repository(kind)
      const properties = { sessionID: scope.sessionID, assistantMessageID: messageID }
      for (const [type, extra] of [
        ["session.reasoning.delta", { ordinal: 0, delta: "Inspect the project" }],
        ["session.text.delta", { ordinal: 0, delta: "First read the build instructions." }],
        ["session.tool.input.started", { id: "call-z", name: "read" }],
        ["session.text.delta", { ordinal: 1, delta: "Now build the application." }],
        ["session.tool.input.started", { id: "call-a", name: "shell" }],
      ] as const) {
        repo.apply(scope, { type: "sse-event", event: event(type, { ...properties, ...extra }) })
      }
      expect(ids(repo.getParts(scope, messageID))).toEqual(ids(fixture().parts))
      repo.apply(scope, { type: "http-page", purpose: "recovery", page: page() })
      expect(ids(repo.getParts(scope, messageID))).toEqual(ids(fixture().parts))
      const settled = repo.getParts(scope, messageID)
      repo.apply(scope, { type: "http-page", purpose: "recovery", page: page() })
      expect(repo.getParts(scope, messageID)).toBe(settled)
    })

    test("server replacement keeps an optimistic part in its original slot", () => {
      const repo = repository(kind)
      const record = fixture()
      const optimistic = { ...record.parts[1], id: "zzz-placeholder", __openchamberOptimistic: true }
      repo.apply(scope, { type: "optimistic-add", message: record.info, parts: [optimistic, record.parts[2]] })
      repo.apply(scope, { type: "sse-event", event: event("message.part.updated", { part: record.parts[1] }) })
      expect(ids(repo.getParts(scope, messageID))).toEqual([record.parts[1].id, record.parts[2].id])
    })
  })

  test("optimistic page reconciliation preserves server and placeholder part order", () => {
    const record = fixture()
    const pending = { ...record.info, id: "msg_pending" } as Message
    const result = mergeOptimisticPage({ session: [record.info], part: [{ id: messageID, part: record.parts }], complete: true }, [{ message: pending, parts: record.parts }])
    expect(result.part.map((entry) => ids(entry.part))).toEqual([ids(record.parts), ids(record.parts)])
  })

  test("partial materialization retains missing live parts at their existing neighbors", () => {
    const record = fixture()
    const open = { ...record.info, time: { created: 1 }, finish: undefined } as Message
    const result = materializeSessionSnapshots(
      { message: { [scope.sessionID]: [open] }, part: { [messageID]: record.parts } },
      scope.sessionID,
      [{ info: open, parts: [record.parts[2], record.parts[4]] }],
    )
    expect(ids(result.part[messageID])).toEqual(ids(record.parts))
  })

  test("durable round trip accepts repaired authoritative order", async () => {
    const durable = createMemoryTranscriptDurableStore()
    const record = fixture()
    await durable.upsertSettled(scope, record.info, [...record.parts].reverse())
    await durable.upsertSettled(scope, record.info, record.parts)
    const stored = await durable.readMessage(scope, messageID)
    expect(ids(stored!.parts)).toEqual(ids(record.parts))
  })
})
