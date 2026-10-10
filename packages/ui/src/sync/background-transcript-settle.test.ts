import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { createStore, type StoreApi } from "zustand/vanilla"
import type { Message, Part } from "@/lib/opencode/v2-types"
import { getRuntimeGeneration, getRuntimeTransportIdentity } from "@/lib/runtime-switch"
import { resolveChatSessionTranscriptGate } from "../components/chat/chatContainerHost"
import type { ChildStoreManager, DirectoryStore } from "./child-store"
import { INITIAL_STATE, type Event } from "./types"
import type { TranscriptTransportPage } from "./transcript-repository"
import { createQueryTranscriptRepository } from "./transcript-repository-query-adapter"
import { bindTranscriptRepositoryInstance, unbindTranscriptRepository } from "./transcript-repository-runtime"
import { clearDeferredIdleTranscriptSettle, takeDeferredIdleTranscriptSettle } from "./session-idle-materialization"

const mocks = vi.hoisted(() => ({ fetchPage: vi.fn(), generationOffset: 0 }))
const { fetchPage } = mocks
vi.mock("@/lib/runtime-switch", async (original) => {
  const actual = await original<typeof import("@/lib/runtime-switch")>()
  return { ...actual, getRuntimeGeneration: () => actual.getRuntimeGeneration() + mocks.generationOffset }
})
vi.mock("./transcript-repository-production", async (original) => ({
  ...await original<typeof import("./transcript-repository-production")>(),
  fetchProductionTranscriptTransportPage: mocks.fetchPage,
}))
import { handleEvent, setActiveSession } from "./sync-context"

const directory = "/background-test"
const scope = (sessionID: string) => ({ directory, sessionID, transport: getRuntimeTransportIdentity(), generation: getRuntimeGeneration() })
const page = (sessionID: string, text: string): TranscriptTransportPage => ({
  records: [{
    info: { id: `${sessionID}_a`, sessionID, role: "assistant", time: { created: 1, completed: 2 }, finish: "stop", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } as Message,
    parts: [{ id: `${sessionID}_p`, messageID: `${sessionID}_a`, sessionID, type: "text", text } as Part],
  }], complete: true, turnCount: 1,
})

describe("retained background transcript completion", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let repository: ReturnType<typeof createQueryTranscriptRepository>
  let store: StoreApi<DirectoryStore>
  let children: ChildStoreManager
  const routing = { sessionDirectoryById: new Map(), messageSessionById: new Map(), sessionMessageIdsById: new Map() } as Parameters<typeof handleEvent>[3]
  const dispatch = (sessionID: string, type = "session.execution.succeeded") => handleEvent(directory, { type, properties: { sessionID } } as Event, children, routing)
  const readText = (sessionID: string) => repository.getParts(scope(sessionID), `${sessionID}_a`)[0]

  beforeEach(() => {
    fetchPage.mockReset()
    mocks.generationOffset = 0
    clearDeferredIdleTranscriptSettle()
    setActiveSession(directory, "foreground")
    store = createStore<DirectoryStore>((set) => ({ ...INITIAL_STATE, patch: (partial) => set(partial), replace: (next) => set(next) }))
    children = { getChild: () => store, ensureChild: () => store, children: new Map([[directory, store]]), mark: () => {} } as unknown as ChildStoreManager
    repository = createQueryTranscriptRepository({
      client, transport: getRuntimeTransportIdentity(), generation: getRuntimeGeneration(),
      fetcher: async ({ sessionID }) => page(sessionID, "before leaving"),
      probe: { getTransport: getRuntimeTransportIdentity, getGeneration: getRuntimeGeneration },
    })
    bindTranscriptRepositoryInstance(repository)
  })
  afterEach(() => {
    setActiveSession("", "")
    unbindTranscriptRepository()
    repository.destroy()
    client.clear()
    clearDeferredIdleTranscriptSettle()
  })

  test("four completed background chats are ready before selection; duplicate terminal frames share each flight", async () => {
    const ids = ["one", "two", "three", "four"]
    await Promise.all(ids.map((id) => repository.ensureInitial(scope(id))))
    fetchPage.mockImplementation(async ({ sessionID }) => page(sessionID, "final answer"))
    for (let tick = 0; tick < 20; tick += 1) {
      for (const id of ids) {
        handleEvent(directory, {
          type: "message.part.updated",
          properties: { part: page(id, `live ${tick}`).records[0]!.parts?.[0] },
        } as Event, children, routing)
      }
    }
    expect(ids.map(readText)).toEqual(ids.map(() => expect.objectContaining({ text: "live 19" })))
    expect(fetchPage).not.toHaveBeenCalled()
    for (const id of ids) { dispatch(id); dispatch(id, "session.idle") }
    await vi.waitFor(() => expect(ids.map(readText)).toEqual(ids.map(() => expect.objectContaining({ text: "final answer" }))))
    expect(fetchPage).toHaveBeenCalledTimes(4)
    for (const id of ids) {
      setActiveSession(directory, id)
      expect(readText(id)).toMatchObject({ text: "final answer" })
      expect(takeDeferredIdleTranscriptSettle(directory, id)).toBe(false)
    }
    expect(fetchPage).toHaveBeenCalledTimes(4)
  })

  test("live background merge paints immediately while final authority is still pending; failure preserves it", async () => {
    await repository.ensureInitial(scope("one"))
    let reject!: (reason: Error) => void
    fetchPage.mockImplementation(() => new Promise((_, fail) => { reject = fail }))
    dispatch("one")
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1))
    handleEvent(directory, { type: "message.part.updated", properties: { part: page("one", "new live answer").records[0]!.parts?.[0] } } as Event, children, routing)
    setActiveSession(directory, "one")
    expect(readText("one")).toMatchObject({ text: "new live answer" })
    const data = repository.getTranscript(scope("one"))
    expect(resolveChatSessionTranscriptGate({
      hasTranscriptShell: true, hasRenderableSessionSnapshot: false,
      transcriptRecords: data.messageOrder.map((id) => ({ info: data.messagesByID[id], parts: [...data.partsByMessageID[id]] })),
      prefetchStatus: "loading", syncLoading: true,
    })).toBe("pass")
    reject(new Error("offline"))
    await vi.waitFor(() => expect(takeDeferredIdleTranscriptSettle(directory, "one")).toBe(true))
    expect(readText("one")).toMatchObject({ text: "new live answer" })
  })

  test("cold conversations do not fetch on completion", async () => {
    dispatch("cold")
    await Promise.resolve()
    expect(fetchPage).not.toHaveBeenCalled()
    expect(takeDeferredIdleTranscriptSettle(directory, "cold")).toBe(true)
  })

  test.each(["session.execution.failed", "session.execution.interrupted"])("%s also settles a retained background chat", async (type) => {
    await repository.ensureInitial(scope("one"))
    fetchPage.mockResolvedValue(page("one", "terminal answer"))
    dispatch("one", type)
    await vi.waitFor(() => expect(readText("one")).toMatchObject({ text: "terminal answer" }))
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  test("shutdown recovery is not treated as completed execution", async () => {
    await repository.ensureInitial(scope("one"))
    handleEvent(directory, { type: "session.execution.interrupted", properties: { sessionID: "one", reason: "shutdown" } } as Event, children, routing)
    await Promise.resolve()
    expect(fetchPage).not.toHaveBeenCalled()
  })

  test("new live content wins against an older in-flight final snapshot", async () => {
    await repository.ensureInitial(scope("one"))
    let finish!: (value: TranscriptTransportPage) => void
    fetchPage.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    dispatch("one")
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1))
    handleEvent(directory, { type: "message.part.updated", properties: { part: page("one", "newer live answer").records[0]!.parts?.[0] } } as Event, children, routing)
    finish(page("one", "older snapshot"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(readText("one")).toMatchObject({ text: "newer live answer" })
  })

  test("a replaced directory store fences a late background response", async () => {
    await repository.ensureInitial(scope("one"))
    let finish!: (value: TranscriptTransportPage) => void
    fetchPage.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    dispatch("one")
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1))
    store = createStore<DirectoryStore>(() => store.getState())
    finish(page("one", "retired response"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(readText("one")).toMatchObject({ text: "before leaving" })
    expect(takeDeferredIdleTranscriptSettle(directory, "one")).toBe(false)
  })

  test("runtime generation changes discard a pending response without leaking a deferred retry", async () => {
    const originalScope = scope("one")
    await repository.ensureInitial(originalScope)
    let finish!: (value: TranscriptTransportPage) => void
    fetchPage.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    dispatch("one")
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1))
    mocks.generationOffset += 1
    finish(page("one", "old runtime response"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(repository.getParts(originalScope, "one_a")[0]).toMatchObject({ text: "before leaving" })
    expect(takeDeferredIdleTranscriptSettle(directory, "one")).toBe(false)
  })
})
