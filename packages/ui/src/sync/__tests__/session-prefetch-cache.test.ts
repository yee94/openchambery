import { describe, expect, test } from "bun:test"

import {
  beginSessionMessageLoad,
  failSessionMessageLoad,
  getSessionPrefetch,
  markSessionPrefetchDirty,
  setSessionPrefetch,
  shouldSkipSessionPrefetch,
} from "../session-prefetch-cache"

describe("shouldSkipSessionPrefetch", () => {
  test("does not skip when only metadata exists without cached messages", () => {
    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: false,
      info: { limit: 200, complete: true, at: 1_000, status: "ready", loadGeneration: 0 },
      pageSize: 200,
      now: 1_001,
    })).toBe(false)
  })

  test("does not skip a larger fetch when only a smaller partial prefetch is cached", () => {
    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      info: { limit: 50, complete: false, at: 1_000, status: "ready", loadGeneration: 0 },
      pageSize: 200,
      now: 1_001,
    })).toBe(false)
  })

  test("still skips a recent partial prefetch when cached coverage matches the request", () => {
    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      info: { limit: 200, complete: false, at: 1_000, status: "ready", loadGeneration: 0 },
      pageSize: 200,
      now: 1_001,
    })).toBe(true)
  })

  test("does not skip a recent prefetch when the session identity is missing", () => {
    expect(shouldSkipSessionPrefetch({
      hasSession: false,
      hasMessages: true,
      info: { limit: 200, complete: false, at: 1_000, status: "ready", loadGeneration: 0 },
      pageSize: 200,
      now: 1_001,
    })).toBe(false)
  })

  test("keeps pagination metadata through loading and error states", () => {
    const directory = "/prefetch-state"
    const sessionID = "session-state"
    setSessionPrefetch({ directory, sessionID, limit: 30, cursor: "cursor", complete: false, at: 1_000 })

    const generation = beginSessionMessageLoad(directory, sessionID, 30)
    expect(getSessionPrefetch(directory, sessionID)).toEqual({
      limit: 30,
      cursor: "cursor",
      complete: false,
      at: 1_000,
      status: "loading",
      loadGeneration: generation,
    })

    failSessionMessageLoad(directory, sessionID, "network unavailable", undefined, generation)
    expect(getSessionPrefetch(directory, sessionID)).toEqual({
      limit: 30,
      cursor: "cursor",
      complete: false,
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
      limit: 30,
      complete: true,
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
      limit: 10,
      complete: true,
      loadGeneration: first,
    })
    expect(getSessionPrefetch(directory, sessionID)?.status).toBe("loading")
    expect(getSessionPrefetch(directory, sessionID)?.loadGeneration).toBe(second)
  })

  test("isolates loading state by runtime", () => {
    const directory = "/runtime-scoped-prefetch"
    const sessionID = "shared-session"

    beginSessionMessageLoad(directory, sessionID, 30, "runtime-a")
    setSessionPrefetch({ directory, sessionID, runtimeKey: "runtime-b", limit: 30, complete: false, at: 2_000 })

    expect(getSessionPrefetch(directory, sessionID, "runtime-a")?.status).toBe("loading")
    expect(getSessionPrefetch(directory, sessionID, "runtime-b")?.status).toBe("ready")
  })

  test("records the mobile initial request limit through failure", () => {
    const directory = "/mobile-prefetch"
    const sessionID = "mobile-session"

    beginSessionMessageLoad(directory, sessionID, 16)
    expect(getSessionPrefetch(directory, sessionID)?.limit).toBe(16)

    failSessionMessageLoad(directory, sessionID, "network unavailable")
    expect(getSessionPrefetch(directory, sessionID)?.limit).toBe(16)
    expect(getSessionPrefetch(directory, sessionID)?.status).toBe("error")
  })

  test("keeps the larger recorded request limit while a smaller load begins", () => {
    const directory = "/larger-prefetch"
    const sessionID = "larger-session"
    setSessionPrefetch({ directory, sessionID, limit: 30, complete: false })

    beginSessionMessageLoad(directory, sessionID, 16)

    expect(getSessionPrefetch(directory, sessionID)?.limit).toBe(30)
  })
})

describe("markSessionPrefetchDirty", () => {
  test("pierces the complete cache so the next fetch is not skipped", () => {
    const directory = "/dirty-complete"
    const sessionID = "dirty-complete-session"
    // A session that previously fetched to completion would be treated as
    // authoritative forever by shouldSkipSessionPrefetch.
    setSessionPrefetch({ directory, sessionID, limit: 30, complete: true })
    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      info: getSessionPrefetch(directory, sessionID),
      pageSize: 30,
    })).toBe(true)

    // An authoritative live event for that session must force one bounded
    // refetch on the next switch, otherwise a stale transcript survives.
    markSessionPrefetchDirty(directory, [sessionID])

    const info = getSessionPrefetch(directory, sessionID)
    expect(info?.complete).toBe(false)
    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      info,
      pageSize: 30,
    })).toBe(false)
  })

  test("pierces the TTL cache so an in-window entry no longer skips", () => {
    const directory = "/dirty-ttl"
    const sessionID = "dirty-ttl-session"
    const now = Date.now()
    setSessionPrefetch({ directory, sessionID, limit: 30, complete: false, at: now })
    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      info: getSessionPrefetch(directory, sessionID),
      pageSize: 30,
      now: now + 1,
    })).toBe(true)

    markSessionPrefetchDirty(directory, [sessionID])

    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      info: getSessionPrefetch(directory, sessionID),
      pageSize: 30,
      now: now + 1,
    })).toBe(false)
  })

  test("preserves pagination cursor and limit when marking dirty", () => {
    const directory = "/dirty-preserve"
    const sessionID = "dirty-preserve-session"
    setSessionPrefetch({ directory, sessionID, limit: 30, cursor: "cursor-abc", complete: false })

    markSessionPrefetchDirty(directory, [sessionID])

    const info = getSessionPrefetch(directory, sessionID)
    expect(info?.limit).toBe(30)
    expect(info?.cursor).toBe("cursor-abc")
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
    setSessionPrefetch({ directory, sessionID, runtimeKey: "runtime-a", limit: 30, complete: true })
    setSessionPrefetch({ directory, sessionID, runtimeKey: "runtime-b", limit: 30, complete: true })

    markSessionPrefetchDirty(directory, [sessionID], "runtime-a")

    expect(getSessionPrefetch(directory, sessionID, "runtime-a")?.complete).toBe(false)
    expect(getSessionPrefetch(directory, sessionID, "runtime-b")?.complete).toBe(true)
  })

  test("pierces limit > pageSize so a dirty large page still refetches", () => {
    const directory = "/dirty-large-page"
    const sessionID = "dirty-large-session"
    setSessionPrefetch({ directory, sessionID, limit: 200, complete: false, at: Date.now() })
    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      info: getSessionPrefetch(directory, sessionID),
      pageSize: 30,
    })).toBe(true)

    markSessionPrefetchDirty(directory, [sessionID])

    const info = getSessionPrefetch(directory, sessionID)
    expect(info?.at).toBe(0)
    expect(info?.complete).toBe(false)
    expect(info?.limit).toBe(200)
    expect(shouldSkipSessionPrefetch({
      hasSession: true,
      hasMessages: true,
      info,
      pageSize: 30,
    })).toBe(false)
  })
})
