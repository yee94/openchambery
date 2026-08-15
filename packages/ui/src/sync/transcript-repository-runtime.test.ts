import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { QueryClient } from "@tanstack/react-query"

import { isTranscriptAuthorityRefreshInFlight } from "./transcript-authority-refresh-flight"
import {
  bindTranscriptRepositoryInstance,
  getTranscriptRepository,
  getTranscriptRepositoryBindingRevision,
  refreshTranscriptFromAuthority,
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
    expect(repo.getTranscript(scope).messageOrder).toEqual(["msg_new"])
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
