import { describe, expect, test } from "bun:test"

import {
  beginSessionMessageLoad,
  failSessionMessageLoad,
  getSessionPrefetch,
  markSessionPrefetchDirty,
  setSessionPrefetch,
  shouldSkipSessionPrefetch,
  type SessionPrefetchMeta,
} from "../session-prefetch-cache"
import type { SessionHistoryBoundary } from "../types"

const exhausted = (loadedTurns = 2): SessionHistoryBoundary => ({ kind: "exhausted", loadedTurns })
const hasMore = (loadedTurns = 2, cursor = "msg_x"): SessionHistoryBoundary => ({ kind: "has-more", cursor, loadedTurns })
const unknown = (): SessionHistoryBoundary => ({ kind: "unknown", loadedTurns: 0 })

const readyInfo = (overrides: Partial<SessionPrefetchMeta> = {}): SessionPrefetchMeta => ({
  requestedLimit: 30,
  at: 1_000,
  status: "ready",
  loadGeneration: 0,
  ...overrides,
})

describe("shouldSkipSessionPrefetch — boundary + request freshness", () => {
  test("does not skip when only metadata exists without cached messages", () => {
    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: false,
      boundary: exhausted(),
      info: readyInfo(),
      pageSize: 30,
      now: 1_001,
    })).toBe(false)
  })

  test("does not skip a recent request when the session identity is missing", () => {
    expect(shouldSkipSessionPrefetch({
      hasSession: false,
      hasMessages: true,
      boundary: exhausted(),
      info: readyInfo(),
      pageSize: 30,
      now: 1_001,
    })).toBe(false)
  })

  test("an unknown boundary always fetches, even with cached messages and a fresh ready request", () => {
    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      boundary: unknown(),
      info: readyInfo(),
      pageSize: 30,
      now: 1_001,
    })).toBe(false)
  })

  test("a missing boundary entry also fetches", () => {
    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      info: readyInfo(),
      pageSize: 30,
      now: 1_001,
    })).toBe(false)
  })

  test("a known boundary with no freshness info refreshes in the background instead of skipping", () => {
    // The caller keeps the known UI facts (boundary in the child store), but
    // must still issue the pull that re-establishes request freshness.
    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      boundary: exhausted(),
      pageSize: 30,
    })).toBe(false)
    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      boundary: hasMore(),
      pageSize: 30,
    })).toBe(false)
  })

  test("an exhausted boundary reuses a fresh ready request regardless of turns", () => {
    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      boundary: exhausted(1),
      info: readyInfo({ requestedLimit: 30 }),
      pageSize: 200,
      now: 1_001,
    })).toBe(true)
  })

  test("a has-more boundary skips a smaller request when loaded turns exceed the page size", () => {
    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      boundary: hasMore(200),
      info: readyInfo(),
      pageSize: 30,
      now: 1_001,
    })).toBe(true)
  })

  test("a has-more boundary does not skip a larger request than the loaded turns", () => {
    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      boundary: hasMore(50),
      info: readyInfo(),
      pageSize: 200,
      now: 1_001,
    })).toBe(false)
  })

  test("a has-more boundary at exactly the requested coverage follows the TTL", () => {
    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      boundary: hasMore(200),
      info: readyInfo(),
      pageSize: 200,
      now: 1_001,
    })).toBe(true)
    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      boundary: hasMore(200),
      info: readyInfo(),
      pageSize: 200,
      now: 1_000 + 60_000,
    })).toBe(false)
  })

  test("request status other than ready never skips", () => {
    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      boundary: exhausted(),
      info: readyInfo({ status: "loading" }),
      pageSize: 30,
      now: 1_001,
    })).toBe(false)
    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      boundary: exhausted(),
      info: readyInfo({ status: "error", error: "boom" }),
      pageSize: 30,
      now: 1_001,
    })).toBe(false)
  })
})

describe("SessionPrefetchMeta — request lifecycle only", () => {
  test("begin → ready keeps only request fields (no pagination facts)", () => {
    const directory = "/lifecycle-ready"
    const sessionID = "lifecycle-ready-session"

    const generation = beginSessionMessageLoad(directory, sessionID, 30)
    setSessionPrefetch({ directory, sessionID, requestedLimit: 30, loadGeneration: generation })

    const info = getSessionPrefetch(directory, sessionID)
    expect(info).toEqual({
      requestedLimit: 30,
      at: info!.at,
      status: "ready",
      loadGeneration: generation,
    })
    // The entry shape carries no pagination fact at all.
    expect("cursor" in info!).toBe(false)
    expect("complete" in info!).toBe(false)
    expect("limit" in info!).toBe(false)
  })

  test("keeps the requested limit through loading and error states", () => {
    const directory = "/prefetch-state"
    const sessionID = "session-state"
    setSessionPrefetch({ directory, sessionID, requestedLimit: 30, at: 1_000 })

    const generation = beginSessionMessageLoad(directory, sessionID, 30)
    expect(getSessionPrefetch(directory, sessionID)).toEqual({
      requestedLimit: 30,
      at: 1_000,
      status: "loading",
      loadGeneration: generation,
    })

    failSessionMessageLoad(directory, sessionID, "network unavailable", undefined, generation)
    expect(getSessionPrefetch(directory, sessionID)).toEqual({
      requestedLimit: 30,
      at: 1_000,
      status: "error",
      error: "network unavailable",
      loadGeneration: generation,
    })
  })

  test("ignores a stale fail after a newer load began", () => {
    const directory = "/stale-fail"
    const sessionID = "session-stale-fail"
    const first = beginSessionMessageLoad(directory, sessionID, 30)
    const second = beginSessionMessageLoad(directory, sessionID, 30)
    expect(second).toBeGreaterThan(first)
    expect(getSessionPrefetch(directory, sessionID)?.status).toBe("loading")

    failSessionMessageLoad(directory, sessionID, "first load failed", undefined, first)
    expect(getSessionPrefetch(directory, sessionID)?.status).toBe("loading")
    expect(getSessionPrefetch(directory, sessionID)?.loadGeneration).toBe(second)

    setSessionPrefetch({
      directory,
      sessionID,
      requestedLimit: 30,
      loadGeneration: second,
    })
    expect(getSessionPrefetch(directory, sessionID)?.status).toBe("ready")
  })

  test("ignores a stale success after a newer load began", () => {
    const directory = "/stale-ready"
    const sessionID = "session-stale-ready"
    const first = beginSessionMessageLoad(directory, sessionID, 30)
    const second = beginSessionMessageLoad(directory, sessionID, 30)

    setSessionPrefetch({
      directory,
      sessionID,
      requestedLimit: 10,
      loadGeneration: first,
    })
    expect(getSessionPrefetch(directory, sessionID)?.status).toBe("loading")
    expect(getSessionPrefetch(directory, sessionID)?.loadGeneration).toBe(second)
  })

  test("isolates loading state by runtime", () => {
    const directory = "/runtime-scoped-prefetch"
    const sessionID = "shared-session"

    beginSessionMessageLoad(directory, sessionID, 30, "runtime-a")
    setSessionPrefetch({ directory, sessionID, runtimeKey: "runtime-b", requestedLimit: 30, at: 2_000 })

    expect(getSessionPrefetch(directory, sessionID, "runtime-a")?.status).toBe("loading")
    expect(getSessionPrefetch(directory, sessionID, "runtime-b")?.status).toBe("ready")
  })

  test("records the mobile initial request limit through failure", () => {
    const directory = "/mobile-prefetch"
    const sessionID = "mobile-session"

    beginSessionMessageLoad(directory, sessionID, 16)
    expect(getSessionPrefetch(directory, sessionID)?.requestedLimit).toBe(16)

    failSessionMessageLoad(directory, sessionID, "network unavailable")
    expect(getSessionPrefetch(directory, sessionID)?.requestedLimit).toBe(16)
    expect(getSessionPrefetch(directory, sessionID)?.status).toBe("error")
  })

  test("keeps the larger recorded request limit while a smaller load begins", () => {
    const directory = "/larger-prefetch"
    const sessionID = "larger-session"
    setSessionPrefetch({ directory, sessionID, requestedLimit: 30 })

    beginSessionMessageLoad(directory, sessionID, 16)

    expect(getSessionPrefetch(directory, sessionID)?.requestedLimit).toBe(30)
  })
})

describe("markSessionPrefetchDirty", () => {
  test("pierces the TTL cache so an in-window entry no longer skips", () => {
    const directory = "/dirty-ttl"
    const sessionID = "dirty-ttl-session"
    const now = Date.now()
    setSessionPrefetch({ directory, sessionID, requestedLimit: 30, at: now })
    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      boundary: hasMore(30),
      info: getSessionPrefetch(directory, sessionID),
      pageSize: 30,
      now: now + 1,
    })).toBe(true)

    markSessionPrefetchDirty(directory, [sessionID])

    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      boundary: hasMore(30),
      info: getSessionPrefetch(directory, sessionID),
      pageSize: 30,
      now: now + 1,
    })).toBe(false)
  })

  test("a dirty exhausted boundary still refetches", () => {
    const directory = "/dirty-complete"
    const sessionID = "dirty-complete-session"
    setSessionPrefetch({ directory, sessionID, requestedLimit: 30 })
    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      boundary: exhausted(),
      info: getSessionPrefetch(directory, sessionID),
      pageSize: 30,
    })).toBe(true)

    markSessionPrefetchDirty(directory, [sessionID])

    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      boundary: exhausted(),
      info: getSessionPrefetch(directory, sessionID),
      pageSize: 30,
    })).toBe(false)
  })

  test("preserves the request lifecycle fields when marking dirty", () => {
    const directory = "/dirty-preserve"
    const sessionID = "dirty-preserve-session"
    setSessionPrefetch({ directory, sessionID, requestedLimit: 30 })

    markSessionPrefetchDirty(directory, [sessionID])

    const info = getSessionPrefetch(directory, sessionID)
    expect(info?.requestedLimit).toBe(30)
    expect(info?.at).toBe(0)
    expect(info?.status).toBe("ready")
  })

  test("is a no-op for sessions with no prefetch entry", () => {
    const directory = "/dirty-missing"
    const sessionID = "dirty-missing-session"

    // Should not throw and should not create an entry.
    markSessionPrefetchDirty(directory, [sessionID])

    expect(getSessionPrefetch(directory, sessionID)).toBe(undefined)
  })

  test("scopes dirty marks by runtime key", () => {
    const directory = "/dirty-runtime"
    const sessionID = "dirty-runtime-session"
    setSessionPrefetch({ directory, sessionID, runtimeKey: "runtime-a", requestedLimit: 30 })
    setSessionPrefetch({ directory, sessionID, runtimeKey: "runtime-b", requestedLimit: 30 })

    markSessionPrefetchDirty(directory, [sessionID], "runtime-a")

    expect(getSessionPrefetch(directory, sessionID, "runtime-a")?.at).toBe(0)
    expect(getSessionPrefetch(directory, sessionID, "runtime-b")?.at).not.toBe(0)
  })
})
