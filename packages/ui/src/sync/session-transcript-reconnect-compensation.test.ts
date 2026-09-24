import { afterEach, expect, test, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { createQueryTranscriptRepository } from "./transcript-repository-query-adapter"
import { collectImmediateCompensationSessions, createTranscriptReconnectCompensationController } from "./session-transcript-reconnect-compensation"
import type { TranscriptTransportPage, TranscriptScope } from "./transcript-repository"
import type { Message, Part } from "@/lib/opencode/v2-types"
import { isTranscriptResyncInFlight } from "./transcript-resync-flight"
import { registerTranscriptReconnectCompensationController, notifyTranscriptReconnectCompensation, notifyTranscriptReconnectDisconnect, ensureTranscriptOnObserve } from "./transcript-reconnect-compensation-runtime"

const scope = { directory: "/repo", sessionID: "ses_a", transport: "relay-test", generation: 1 }
const record = (id = "msg_a", sessionID = "ses_a") => ({
  info: { id, sessionID, role: "user", time: { created: 1 } } as Message,
  parts: [{ id: `p_${id}`, messageID: id, sessionID, type: "text", text: id } as Part],
})
const pending = () => {
  let resolve!: (page: TranscriptTransportPage) => void
  let reject!: (error: Error) => void
  const promise = new Promise<TranscriptTransportPage>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const cleanups: Array<() => void> = []
afterEach(() => { registerTranscriptReconnectCompensationController(null); for (const cleanup of cleanups.splice(0)) cleanup() })
function setup(fetcher: (args: { sessionID: string }) => Promise<TranscriptTransportPage>, options: { viewed?: TranscriptScope[]; directories?: string[]; concurrency?: number; status?: () => Promise<void> } = {}) {
  const client = new QueryClient()
  let generation = 1
  let clock = 1000
  const probe = { getTransport: () => scope.transport, getGeneration: () => generation }
  const repo = createQueryTranscriptRepository({ client, probe, fetcher })
  const errors = vi.fn()
  const recovery = createTranscriptReconnectCompensationController({ client, repository: repo, probe, now: () => clock,
    listDirectories: () => options.directories ?? [scope.directory], getBusyOrRetrySessionIDs: () => [],
    getViewedSession: () => options.viewed?.[0] ?? scope, getViewedSessions: () => options.viewed ?? [scope],
    directoryConcurrency: options.concurrency, onError: errors, confirmSessionStatus: options.status,
  })
  cleanups.push(() => { recovery.destroy(); repo.destroy(); client.clear() })
  const seed = (target = scope) => repo.apply(target, { type: "http-page", purpose: "initial", page: { records: [record("msg_a", target.sessionID)], complete: true } })
  const reconnect = () => {
    recovery.captureCheckpoints({ lastEventID: "event", reason: "disconnect" })
    recovery.onCompensation({ isReconnect: true, runtimeGeneration: generation } as Parameters<typeof recovery.onCompensation>[0])
  }
  return { repo, recovery, errors, seed, reconnect, setGeneration: (value: number) => { generation = value }, advance: () => { clock += 60_001 } }
}

test("prioritizes viewed, busy and observed sessions without duplicates", () => {
  expect(collectImmediateCompensationSessions({ directory: "/repo", viewed: scope,
    viewedSessions: [{ directory: "/repo", sessionID: "child" }], busyOrRetrySessionIDs: ["busy", "ses_a"],
    activeScopes: [{ directory: "/repo", sessionID: "busy" }, { directory: "/other", sessionID: "wrong" }],
  }).map((item) => item.sessionID)).toEqual(["child", "ses_a", "busy"])
})

test("first ready performs no gap fetch; repeated reconnect and observer share one native flight", async () => {
  const flight = pending()
  const fetcher = vi.fn(() => flight.promise)
  const { repo, recovery, seed, reconnect } = setup(fetcher)
  seed()
  recovery.onCompensation({ isReconnect: false, runtimeGeneration: 1 } as Parameters<typeof recovery.onCompensation>[0])
  expect(fetcher).not.toHaveBeenCalled()
  reconnect(); reconnect()
  const observed = recovery.ensureOnObserve(scope)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(isTranscriptResyncInFlight(scope.sessionID, scope.directory)).toBe(true)
  expect(repo.getTranscript(scope).messageOrder).toEqual(["msg_a"])
  flight.resolve({ records: [record(), record("msg_b")], complete: true })
  await observed
  expect(repo.getTranscript(scope).messageOrder).toEqual(["msg_a", "msg_b"])
  expect(isTranscriptResyncInFlight(scope.sessionID, scope.directory)).toBe(false)
})

test("failed recovery preserves cached rows and remains retryable on the next visit", async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ records: [record(), record("msg_b")], complete: true })
  const { repo, recovery, seed, reconnect } = setup(fetcher)
  seed(); reconnect()
  await expect(recovery.ensureOnObserve(scope)).rejects.toThrow("offline")
  expect(repo.getTranscript(scope).messageOrder).toEqual(["msg_a"])
  await recovery.ensureOnObserve(scope)
  expect(repo.getTranscript(scope).messageOrder).toEqual(["msg_a", "msg_b"])
})

test("inactive sessions refresh on demand and successful observe checks are throttled", async () => {
  const fetcher = vi.fn(async ({ sessionID }: { sessionID: string }) => ({ records: [record("msg_a", sessionID)], complete: true }))
  const { recovery, seed, reconnect, advance } = setup(fetcher)
  const inactive = { ...scope, sessionID: "ses_b" }
  seed(); seed(inactive); reconnect()
  await recovery.ensureOnObserve(scope)
  expect(fetcher.mock.calls.map(([args]) => args.sessionID)).toEqual(["ses_a"])
  await recovery.ensureOnObserve(inactive)
  await recovery.ensureOnObserve(inactive)
  expect(fetcher).toHaveBeenCalledTimes(2)
  advance()
  await recovery.ensureOnObserve(inactive)
  expect(fetcher).toHaveBeenCalledTimes(3)
})

test("directory concurrency bounds native refreshes and one failure does not block the next session", async () => {
  const a = pending(), b = pending()
  const other = { ...scope, sessionID: "ses_b" }
  const fetcher = vi.fn(({ sessionID }: { sessionID: string }) => sessionID === "ses_a" ? a.promise : b.promise)
  const { recovery, seed, reconnect } = setup(fetcher, { viewed: [scope, other], concurrency: 1 })
  seed(); seed(other); reconnect()
  const fa = recovery.ensureOnObserve(scope), fb = recovery.ensureOnObserve(other)
  expect(fetcher).toHaveBeenCalledTimes(1)
  a.reject(new Error("a offline"))
  await expect(fa).rejects.toThrow("a offline")
  expect(fetcher).toHaveBeenCalledTimes(2)
  b.resolve({ records: [record("msg_b", "ses_b")], complete: true })
  await fb
})

test("runtime switch discards late native data and cancellation releases queued callers", async () => {
  const flight = pending()
  const other = { ...scope, sessionID: "ses_b" }
  const { repo, recovery, seed, reconnect, setGeneration } = setup(() => flight.promise, { viewed: [scope, other], concurrency: 1 })
  seed(); seed(other); reconnect()
  const fa = recovery.ensureOnObserve(scope), fb = recovery.ensureOnObserve(other)
  setGeneration(2); recovery.cancelAll("runtime-switch")
  expect(isTranscriptResyncInFlight(scope.sessionID, scope.directory)).toBe(false)
  expect(await fb).toBeNull()
  flight.resolve({ records: [record("wrong")], complete: true })
  expect(await fa).toBeNull()
  expect(repo.getTranscript({ ...scope, generation: 2 }).messageOrder).toEqual([])
  expect(repo.getTranscript(scope).messageOrder).toEqual(["msg_a"])
})

test("canonical-only directories and retained cold scopes participate in recovery", async () => {
  const fetcher = vi.fn(async ({ sessionID }: { sessionID: string }) => ({ records: [record("msg_a", sessionID)], complete: true }))
  const { repo, recovery, reconnect } = setup(fetcher, { directories: [] })
  const cold = { ...scope, directory: "/child", sessionID: "cold" }
  const release = repo.subscribe(cold, () => undefined)
  reconnect()
  await recovery.ensureOnObserve(cold)
  expect(fetcher.mock.calls.some(([args]) => args.sessionID === "cold")).toBe(true)
  release()
})

test("status confirmation failure cannot turn a complete transcript into a failed recovery", async () => {
  const { repo, recovery, seed, reconnect, errors } = setup(async () => ({ records: [record("fresh")], complete: true }), { status: async () => { throw new Error("status offline") } })
  seed(); reconnect()
  await recovery.ensureOnObserve(scope)
  expect(repo.getTranscript(scope).messageOrder).toEqual(["fresh"])
  expect(errors).not.toHaveBeenCalled()
})

test("production registration routes disconnect, ready and observe to the same recovery owner", async () => {
  const { repo, recovery, seed } = setup(async () => ({ records: [record("fresh")], complete: true }))
  seed(); registerTranscriptReconnectCompensationController(recovery)
  notifyTranscriptReconnectDisconnect({ reason: "disconnect", lastEventID: null })
  notifyTranscriptReconnectCompensation({ isReconnect: true, runtimeGeneration: 1 } as Parameters<typeof recovery.onCompensation>[0])
  await ensureTranscriptOnObserve(scope)
  expect(repo.getTranscript(scope).messageOrder).toEqual(["fresh"])
})
