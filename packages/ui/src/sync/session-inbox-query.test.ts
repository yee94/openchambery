import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { queryClient } from "@/lib/queryRuntime"
import { runtimeFetch } from "@/lib/runtime-fetch"
import { refreshSessionInbox, sessionInboxQueryOptions } from "./session-inbox-query"
import {
  forgetUnpromotedInbox,
  rememberUnpromotedInbox,
  resetInboxTerminalReceiptsForTests,
  selectInboxOverlayChips,
  updateInboxOverlayDelivery,
  useSessionInboxOverlayStore,
} from "./session-inbox-overlay"
import type { SessionInboxUser } from "./session-prompt-api"

const runtime = vi.hoisted(() => ({ transport: "runtime-a", generation: 1 }))
vi.mock("@/lib/runtime-fetch", () => ({ runtimeFetch: vi.fn() }))
vi.mock("@/lib/runtime-switch", async (original) => ({
  ...await original<typeof import("@/lib/runtime-switch")>(),
  getRuntimeGeneration: () => runtime.generation,
  getRuntimeTransportIdentity: () => runtime.transport,
}))
const scope = { directory: "/project", sessionID: "session-a" }
const row = (id: string): SessionInboxUser => ({ id, sessionID: scope.sessionID, type: "user", delivery: "queue", timeCreated: 1, payload: { text: id } })
const response = (items: SessionInboxUser[]) => new Response(JSON.stringify(items), { headers: { "content-type": "application/json" } })
const visible = () => selectInboxOverlayChips(scope.sessionID).map((item) => item.messageID)
function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => { resolve = done })
  vi.mocked(runtimeFetch).mockReturnValueOnce(promise)
  return resolve
}

beforeEach(() => {
  queryClient.clear()
  vi.mocked(runtimeFetch).mockReset()
  runtime.transport = "runtime-a"
  runtime.generation = 1
  resetInboxTerminalReceiptsForTests()
  useSessionInboxOverlayStore.setState({ bySession: {} })
})
afterEach(() => { queryClient.clear() })

test("cold restore and warm revisit fetch authority, with concurrent consumers sharing one GET", async () => {
  const resolve = deferredResponse()
  const first = refreshSessionInbox(scope)
  const second = refreshSessionInbox(scope)
  expect(runtimeFetch).toHaveBeenCalledTimes(1)
  resolve(response([row("queued")]))
  await Promise.all([first, second])
  expect(visible()).toEqual(["queued"])
  expect(runtimeFetch).toHaveBeenCalledWith("/api/session/session-a/inbox", expect.objectContaining({ query: { directory: "/project" }, signal: expect.any(AbortSignal) }))
  vi.mocked(runtimeFetch).mockResolvedValueOnce(response([]))
  await refreshSessionInbox(scope)
  expect(visible()).toEqual([])
  expect(runtimeFetch).toHaveBeenCalledTimes(2)
})

test("a failed refresh retains prior queue and Query data; retry can recover", async () => {
  vi.mocked(runtimeFetch).mockResolvedValueOnce(response([row("queued")]))
  await refreshSessionInbox(scope)
  vi.mocked(runtimeFetch).mockRejectedValue(new Error("offline"))
  await expect(refreshSessionInbox(scope)).rejects.toThrow("offline")
  expect(visible()).toEqual(["queued"])
  expect(queryClient.getQueryData(sessionInboxQueryOptions(scope).queryKey)?.items).toEqual([row("queued")])
  expect(runtimeFetch).toHaveBeenCalledTimes(3)
  vi.mocked(runtimeFetch).mockResolvedValueOnce(response([]))
  await refreshSessionInbox(scope)
  expect(visible()).toEqual([])
})

test("a stale GET cannot erase a live enqueue or revert a delivery change", async () => {
  rememberUnpromotedInbox(row("promoted"))
  const resolve = deferredResponse()
  const flight = refreshSessionInbox(scope)
  updateInboxOverlayDelivery(scope.sessionID, "promoted", "steer")
  rememberUnpromotedInbox(row("new-live"))
  resolve(response([row("promoted"), row("restored")]))
  await flight
  expect(visible()).toEqual(["promoted", "restored", "new-live"])
  expect(selectInboxOverlayChips(scope.sessionID)[0]?.delivery).toBe("steer")
})

test.each(["cancelled", "consumed"] as const)("a %s event wins over an in-flight authority snapshot", async (terminal) => {
  rememberUnpromotedInbox(row("finished"))
  const resolve = deferredResponse()
  const flight = refreshSessionInbox(scope)
  forgetUnpromotedInbox(scope.sessionID, "finished", terminal)
  resolve(response([row("finished"), row("waiting")]))
  await flight
  expect(visible()).toEqual(["waiting"])
})

test.each(["transport", "generation"] as const)("a switched %s cannot receive an old inbox response", async (field) => {
  const resolve = deferredResponse()
  const flight = refreshSessionInbox(scope)
  const rejected = expect(flight).rejects.toThrow("Runtime changed")
  if (field === "transport") runtime.transport = "runtime-b"
  else runtime.generation += 1
  rememberUnpromotedInbox(row("new-runtime"))
  resolve(response([row("old-runtime")]))
  await rejected
  expect(visible()).toEqual(["new-runtime"])
  expect(runtimeFetch).toHaveBeenCalledTimes(1)
})

test("query keys isolate runtime, generation, directory and session", () => {
  const original = sessionInboxQueryOptions(scope).queryKey
  expect(sessionInboxQueryOptions({ ...scope, directory: " /project " }).queryKey).toEqual(original)
  expect(sessionInboxQueryOptions({ ...scope, directory: "/other" }).queryKey).not.toEqual(original)
  expect(sessionInboxQueryOptions({ ...scope, sessionID: "other" }).queryKey).not.toEqual(original)
  runtime.generation += 1
  expect(sessionInboxQueryOptions(scope).queryKey).not.toEqual(original)
  runtime.transport = "runtime-b"
  expect(sessionInboxQueryOptions(scope).queryKey[0]).toBe("runtime-b")
})

test.each([true, false])("stream-ready/reconnect restores viewed queues without scanning unopened sessions (statusOnly=%s)", async (statusOnly) => {
  vi.mocked(runtimeFetch).mockImplementation(async (input) => response(String(input).endsWith("/inbox") ? [row("missed-while-offline")] : []))
  const { createStore } = await import("zustand/vanilla")
  const { INITIAL_STATE } = await import("./types")
  const { resyncDirectoryAfterReconnect, setContextPanelViewedSession } = await import("./sync-context")
  const statuses = await import("./session-status-reconciliation")
  const statusRead = vi.spyOn(statuses, "resyncDirectorySessionStatuses").mockResolvedValue({})
  const store = createStore<import("./child-store").DirectoryStore>((set) => ({ ...INITIAL_STATE, patch: (partial) => set(partial), replace: (next) => set(next) }))
  const routing = { sessionDirectoryById: new Map(), messageSessionById: new Map(), sessionMessageIdsById: new Map() }
  setContextPanelViewedSession(scope.directory, scope.sessionID)
  const inboxCalls = () => vi.mocked(runtimeFetch).mock.calls.filter(([input]) => String(input).endsWith("/inbox"))
  try {
    await resyncDirectoryAfterReconnect("/unopened", store, routing, "stream-reconnect", () => 0, { statusOnly })
    expect(inboxCalls()).toHaveLength(0)
    await resyncDirectoryAfterReconnect(scope.directory, store, routing, "stream-reconnect", () => 0, { statusOnly })
    expect(visible()).toEqual(["missed-while-offline"])
    expect(inboxCalls()).toHaveLength(1)
  } finally {
    setContextPanelViewedSession("", null)
    statusRead.mockRestore()
  }
})
