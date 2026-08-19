import { afterEach, describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { QueryClient } from "@tanstack/react-query"

import { isTranscriptAuthorityRefreshInFlight } from "./transcript-authority-refresh-flight"
import { resetExactFillSchedulerForTests } from "./transcript-exact-fill-scheduler"
import {
  bindTranscriptRepositoryInstance,
  getTranscriptMessageMaterializationState,
  getTranscriptRepository,
  getTranscriptRepositoryBindingRevision,
  materializeTranscriptMessage,
  refreshTranscriptFromAuthority,
  retryTranscriptInitial,
  subscribeTranscriptRepositoryBinding,
  transcriptScope,
  unbindTranscriptRepository,
} from "./transcript-repository-runtime"
import { createQueryTranscriptRepository } from "./transcript-repository-query-adapter"
import { createStoreTranscriptRepository, type TranscriptStoreSurface } from "./transcript-repository-store-adapter"
import type { SessionHistoryBoundary } from "./types"

function userMessage(id: string, sessionID = "ses_1"): Message {
  return { id, sessionID, role: "user", time: { created: 1 } } as Message
}

function createHarnessStore(): TranscriptStoreSurface {
  let state: {
    message: Record<string, Message[]>
    part: Record<string, never>
    session_history_boundary: Record<string, SessionHistoryBoundary>
  } = {
    message: {},
    part: {},
    session_history_boundary: {},
  }
  const listeners = new Set<(s: typeof state, p: typeof state) => void>()
  return {
    getState: () => state as never,
    setState: (partial) => {
      const prev = state
      const next = typeof partial === "function" ? partial(state as never) : partial
      state = { ...state, ...next } as typeof state
      for (const listener of listeners) listener(state, prev)
    },
    subscribe: (listener) => {
      const wrapped = (s: typeof state, p: typeof state) => listener(s as never, p as never)
      listeners.add(wrapped)
      return () => {
        listeners.delete(wrapped)
      }
    },
  }
}

describe("transcript repository binding (Ticket 09)", () => {
  test("binding revision notifies and observers re-read Query after swap", () => {
    unbindTranscriptRepository()
    const store = createHarnessStore()
    const storeRepo = createStoreTranscriptRepository({ getStore: () => store })
    // Simulate pre-provider ephemeral path: no production bind yet.
    expect(getTranscriptRepository()).toBeNull()

    let notifications = 0
    const unsub = subscribeTranscriptRepositoryBinding(() => {
      notifications += 1
    })
    const rev0 = getTranscriptRepositoryBindingRevision()

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const queryRepo = createQueryTranscriptRepository({
      client,
      fetcher: async () => ({
        records: [{ info: userMessage("msg_1"), parts: [] }],
        complete: true,
        turnCount: 1,
      }),
    })
    bindTranscriptRepositoryInstance(queryRepo)
    expect(getTranscriptRepositoryBindingRevision()).toBeGreaterThan(rev0)
    expect(notifications).toBe(1)
    expect(getTranscriptRepository()).toBe(queryRepo)

    // Write via Query apply and read through bound repository.
    queryRepo.apply(transcriptScope("/ws", "ses_1"), {
      type: "http-page",
      purpose: "initial",
      page: {
        records: [{ info: userMessage("msg_1"), parts: [] }],
        complete: true,
        turnCount: 1,
      },
    })
    const data = getTranscriptRepository()!.getTranscript(transcriptScope("/ws", "ses_1"))
    expect(data.messageOrder).toEqual(["msg_1"])

    unsub()
    unbindTranscriptRepository()
    queryRepo.destroy()
    void storeRepo
  })

  test("purgeGeneration clears seeded canonical data for old generation", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const repo = createQueryTranscriptRepository({
      client,
      transport: "transport-a",
      generation: 1,
      probe: {
        getTransport: () => "transport-a",
        getGeneration: () => 1,
      },
    })
    bindTranscriptRepositoryInstance(repo)
    // Seed via apply (no HTTP) so we do not depend on live runtime identity.
    repo.apply(transcriptScope("/ws", "ses_1", {
      transport: "transport-a",
      generation: 1,
    }), {
      type: "http-page",
      purpose: "initial",
      page: {
        records: [{ info: userMessage("msg_1"), parts: [] }],
        complete: true,
        turnCount: 1,
      },
    })
    expect(repo.getTranscript(transcriptScope("/ws", "ses_1", {
      transport: "transport-a",
      generation: 1,
    })).messageOrder.length).toBe(1)

    repo.purgeGeneration("transport-a", 1)
    expect(repo.getTranscript(transcriptScope("/ws", "ses_1", {
      transport: "transport-a",
      generation: 1,
    })).messageOrder).toEqual([])

    unbindTranscriptRepository()
    repo.destroy()
  })
})

describe("refreshTranscriptFromAuthority", () => {
  test("replaces a hot cache only after a successful fetch", async () => {
    unbindTranscriptRepository()
    let fetches = 0
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const repo = createQueryTranscriptRepository({
      client,
      transport: "transport-a",
      generation: 1,
      initialLimit: 2,
      fetcher: async () => {
        fetches += 1
        return {
          records: [{
            info: userMessage(fetches === 1 ? "msg_old" : "msg_new"),
            parts: [],
          }],
          complete: true,
          turnCount: 1,
        }
      },
      probe: {
        getTransport: () => "transport-a",
        getGeneration: () => 1,
      },
    })
    bindTranscriptRepositoryInstance(repo)
    const scope = transcriptScope("/ws", "ses_1", {
      transport: "transport-a",
      generation: 1,
    })
    await repo.ensureInitial(scope)
    expect(repo.getTranscript(scope).messageOrder).toEqual(["msg_old"])
    expect(isTranscriptAuthorityRefreshInFlight("ses_1", "/ws")).toBe(false)
    await refreshTranscriptFromAuthority("/ws", "ses_1")
    expect(isTranscriptAuthorityRefreshInFlight("ses_1", "/ws")).toBe(false)
    expect(fetches).toBe(2)
    // Refresh now reconciles instead of resetting: the equal-timestamp msg_old is
    // older-or-equal to the page anchor, so it is kept and msg_new is merged in.
    // Equal created timestamps are a synthetic tiebreak; assert membership, not order.
    expect([...repo.getTranscript(scope).messageOrder].sort()).toEqual(["msg_new", "msg_old"])
    unbindTranscriptRepository()
    repo.destroy()
  })

  test("marks the session in flight until refresh settles, including failure", async () => {
    unbindTranscriptRepository()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const repo = createQueryTranscriptRepository({
      client,
      transport: "transport-a",
      generation: 1,
      initialLimit: 2,
      fetcher: async () => {
        await gate
        throw new Error("authority_unavailable")
      },
      probe: {
        getTransport: () => "transport-a",
        getGeneration: () => 1,
      },
    })
    bindTranscriptRepositoryInstance(repo)
    const pending = refreshTranscriptFromAuthority("/ws", "ses_1")
    expect(isTranscriptAuthorityRefreshInFlight("ses_1", "/ws")).toBe(true)
    release()
    await expect(pending).rejects.toThrow("authority_unavailable")
    expect(isTranscriptAuthorityRefreshInFlight("ses_1", "/ws")).toBe(false)
    unbindTranscriptRepository()
    repo.destroy()
  })
})

describe("retryTranscriptInitial", () => {
  test("purges a failed chain and fetches a fresh tail", async () => {
    unbindTranscriptRepository()
    let fetches = 0
    let fail = true
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const repo = createQueryTranscriptRepository({
      client,
      transport: "transport-a",
      generation: 1,
      initialLimit: 2,
      fetcher: async () => {
        fetches += 1
        if (fail) throw new Error("tail_unavailable")
        return {
          records: [{ info: userMessage("msg_retry"), parts: [] }],
          complete: true,
          turnCount: 1,
        }
      },
      probe: {
        getTransport: () => "transport-a",
        getGeneration: () => 1,
      },
    })
    bindTranscriptRepositoryInstance(repo)
    const scope = transcriptScope("/ws", "ses_1", {
      transport: "transport-a",
      generation: 1,
    })
    await repo.ensureInitial(scope).catch(() => undefined)
    expect(fetches).toBeGreaterThan(0)
    expect(repo.getTranscript(scope).messageOrder).toEqual([])
    fail = false
    await retryTranscriptInitial("/ws", "ses_1")
    expect(repo.getTranscript(scope).messageOrder).toEqual(["msg_retry"])
    unbindTranscriptRepository()
    repo.destroy()
  })
})

describe("materializeTranscriptMessage facade", () => {
  afterEach(() => {
    resetExactFillSchedulerForTests()
    unbindTranscriptRepository()
  })

  test("reports idle when unbound and forwards to the bound Query repository", async () => {
    resetExactFillSchedulerForTests()
    unbindTranscriptRepository()
    expect(getTranscriptMessageMaterializationState("/ws", "ses_1", "msg_a")).toEqual({
      sessionID: "ses_1",
      messageID: "msg_a",
      status: "idle",
    })

    let fetches = 0
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const repo = createQueryTranscriptRepository({
      client,
      transport: "transport-a",
      generation: 1,
      fetchMessage: async () => {
        fetches += 1
        return {
          info: {
            id: "msg_a",
            sessionID: "ses_1",
            role: "assistant",
            time: { created: 2 },
            finish: "stop",
          } as Message,
          parts: [{
            id: "t1",
            messageID: "msg_a",
            sessionID: "ses_1",
            type: "tool",
            tool: "bash",
            state: { status: "completed", output: "via-facade" },
          } as never],
        }
      },
      probe: {
        getTransport: () => "transport-a",
        getGeneration: () => 1,
      },
    })
    bindTranscriptRepositoryInstance(repo)
    repo.apply(transcriptScope("/ws", "ses_1", {
      transport: "transport-a",
      generation: 1,
    }), {
      type: "http-page",
      purpose: "initial",
      page: {
        records: [{
          info: {
            id: "msg_a",
            sessionID: "ses_1",
            role: "assistant",
            time: { created: 2 },
            finish: "stop",
          } as Message,
          parts: [{
            id: "t1",
            messageID: "msg_a",
            sessionID: "ses_1",
            type: "tool",
            tool: "bash",
            state: { status: "completed" },
            slim: true,
          } as never],
        }],
        complete: true,
        turnCount: 1,
      },
    })
    expect(getTranscriptMessageMaterializationState("/ws", "ses_1", "msg_a").status).toBe("idle")
    await materializeTranscriptMessage("/ws", "ses_1", "msg_a")
    expect(fetches).toBe(1)
    expect(getTranscriptMessageMaterializationState("/ws", "ses_1", "msg_a").status).toBe("ready")
    expect(
      (repo.getParts(transcriptScope("/ws", "ses_1"), "msg_a")[0] as { state?: { output?: string } })
        .state?.output,
    ).toBe("via-facade")
    repo.destroy()
  })

  test("facade exact fills share the process-wide concurrency cap", async () => {
    resetExactFillSchedulerForTests()
    unbindTranscriptRepository()
    let inFlight = 0
    let maxInFlight = 0
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const repo = createQueryTranscriptRepository({
      client,
      transport: "transport-a",
      generation: 1,
      fetchMessage: async ({ messageID }) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 20))
        inFlight -= 1
        return {
          info: {
            id: messageID,
            sessionID: "ses_1",
            role: "assistant",
            time: { created: 2 },
            finish: "stop",
          } as Message,
          parts: [{
            id: `t-${messageID}`,
            messageID,
            sessionID: "ses_1",
            type: "tool",
            tool: "bash",
            state: { status: "completed", output: "ok" },
          } as never],
        }
      },
      probe: {
        getTransport: () => "transport-a",
        getGeneration: () => 1,
      },
    })
    bindTranscriptRepositoryInstance(repo)
    const scope = transcriptScope("/ws", "ses_1", {
      transport: "transport-a",
      generation: 1,
    })
    const ids = Array.from({ length: 8 }, (_, i) => `msg_${i}`)
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: {
        records: ids.map((id, index) => ({
          info: {
            id,
            sessionID: "ses_1",
            role: "assistant",
            time: { created: index + 1 },
            finish: "stop",
          } as Message,
          parts: [{
            id: `t-${id}`,
            messageID: id,
            sessionID: "ses_1",
            type: "tool",
            tool: "bash",
            state: { status: "completed" },
            slim: true,
          } as never],
        })),
        complete: true,
        turnCount: ids.length,
      },
    })
    await Promise.all(ids.map((id) => materializeTranscriptMessage("/ws", "ses_1", id, { priority: "user" })))
    expect(maxInFlight).toBeLessThanOrEqual(4)
    expect(maxInFlight).toBeGreaterThan(1)
    repo.destroy()
  })
})
