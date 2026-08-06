import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/react-query"
import { create, type StoreApi } from "zustand"
import type { Message, SessionStatus } from "@opencode-ai/sdk/v2/client"

import { INITIAL_STATE, type State } from "../types"
import type { DirectoryStore } from "../child-store"
import {
  applySessionStatusSnapshot,
  collectSessionStatusSnapshotApplyIds,
  fuseActiveWithLegacyStatus,
  reconcileActiveSessionStatusAfterMessagePull,
  resyncDirectorySessionStatuses,
} from "../session-status-reconciliation"
import type { SessionActiveResult } from "@/lib/opencode/client"
import {
  isLiveRevisionCurrent,
  resolveStrictDomainSessionID,
  shouldTriggerDomainRecovery,
  shouldTriggerStaleResync,
} from "../sync-context"

type StatusSnapshot = Record<string, { type: "idle" | "busy" | "retry"; attempt?: number; message?: string; next?: number }>

function createDirectoryStore(initial: Partial<State> & { message?: Record<string, Message[]> }): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...(initial as Partial<DirectoryStore>),
    session: initial.session ?? [],
    // Keep optional message map on the host for residual status tests only.
    ...(initial.message ? { message: initial.message } as object : {}),
    patch: (partial: Partial<DirectoryStore>) => set(partial),
    replace: (next: DirectoryStore) => set(next),
  } as DirectoryStore))
}

function streamingMessage() {
  // Trailing assistant message with no `time.completed` → actively streaming.
  return [{ id: "msg_1", role: "assistant", time: { created: 1 } }] as Message[]
}

function completedMessage() {
  return [{ id: "msg_1", role: "assistant", time: { created: 1, completed: 2 } }] as Message[]
}

const BUSY: SessionStatus = { type: "busy" }

describe("fuseActiveWithLegacyStatus", () => {
  test("active empty membership converges busy candidates to idle", () => {
    const { snapshot, source } = fuseActiveWithLegacyStatus(
      { state: "supported", membership: {} },
      { ses_a: { type: "busy" } },
      ["ses_a"],
    )
    expect(source).toBe("fused")
    expect(snapshot?.ses_a).toEqual({ type: "idle" })
  })

  test("active running + legacy retry keeps retry", () => {
    const retry = { type: "retry" as const, attempt: 2, message: "x", next: 30 }
    const { snapshot } = fuseActiveWithLegacyStatus(
      { state: "supported", membership: { ses_a: { type: "running" } } },
      { ses_a: retry },
      ["ses_a"],
    )
    expect(snapshot?.ses_a).toEqual(retry)
  })

  test("active running + absent legacy becomes busy", () => {
    const { snapshot } = fuseActiveWithLegacyStatus(
      { state: "supported", membership: { ses_a: { type: "running" } } },
      {},
      ["ses_a"],
    )
    expect(snapshot?.ses_a).toEqual({ type: "busy" })
  })

  test("unsupported/unknown falls back to legacy", () => {
    const legacy = { ses_a: { type: "busy" as const } }
    expect(fuseActiveWithLegacyStatus({ state: "unsupported" }, legacy, ["ses_a"])).toEqual({
      snapshot: legacy,
      source: "legacy",
    })
    expect(fuseActiveWithLegacyStatus({ state: "unknown" }, legacy, ["ses_a"])).toEqual({
      snapshot: legacy,
      source: "legacy",
    })
  })

  test("both missing yields none", () => {
    expect(fuseActiveWithLegacyStatus(null, null, ["ses_a"])).toEqual({
      snapshot: null,
      source: "none",
    })
  })

  test("does not copy foreign active membership IDs into a directory-local fuse", () => {
    // Active has ses_a + ses_b process-wide; directory /a only knows ses_a.
    // Result must never invent ses_b on this store.
    const { snapshot, source } = fuseActiveWithLegacyStatus(
      {
        state: "supported",
        membership: {
          ses_a: { type: "running" },
          ses_b: { type: "running" },
        },
      },
      {},
      ["ses_a"],
    )
    expect(source).toBe("fused")
    expect(snapshot).toEqual({ ses_a: { type: "busy" } })
    expect(snapshot?.ses_b).toBe(undefined)
  })

  test("empty candidates with only foreign membership yields none", () => {
    const { snapshot, source } = fuseActiveWithLegacyStatus(
      {
        state: "supported",
        membership: { ses_foreign: { type: "running" } },
      },
      {},
      [],
    )
    expect(source).toBe("none")
    expect(snapshot).toBe(null)
  })
})

describe("applySessionStatusSnapshot", () => {
  describe("one-shot snapshot (bootstrap / reconnect / escalated resync)", () => {
    test("keeps a newer busy state when an older absent snapshot completes", () => {
      const store = createDirectoryStore({
        session_status: { ses_a: BUSY },
        session_status_observed_at: { ses_a: 20 },
      })
      const changed = applySessionStatusSnapshot(store, {} as StatusSnapshot, ["ses_a"], 10)
      expect(changed).toBe(false)
      expect(store.getState().session_status.ses_a).toEqual(BUSY)
      expect(store.getState().session_status_observed_at.ses_a).toBe(20)
    })

    test("applies a newer snapshot and records its observation time", () => {
      const store = createDirectoryStore({
        session_status: { ses_a: BUSY },
        session_status_observed_at: { ses_a: 10 },
      })
      const changed = applySessionStatusSnapshot(store, {} as StatusSnapshot, ["ses_a"], 20)
      expect(changed).toBe(true)
      expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
      expect(store.getState().session_status_observed_at.ses_a).toBe(20)
    })

    test("lowers a busy session to idle when the snapshot omits it", () => {
      const store = createDirectoryStore({
        session_status: { ses_a: BUSY },
        message: { ses_a: completedMessage() },
      })
      const changed = applySessionStatusSnapshot(store, {} as StatusSnapshot, ["ses_a"])
      expect(changed).toBe(true)
      expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
    })

    test("snapshot is the source of truth: lowers to idle even if the trailing message looks unfinished", () => {
      // The live /session/status snapshot wins over derived message state — a
      // stale/lost message.updated must never pin a session busy after the
      // server says idle. (Recovery from a missed idle event.)
      const store = createDirectoryStore({
        session_status: { ses_a: BUSY },
        message: { ses_a: streamingMessage() },
      })
      const changed = applySessionStatusSnapshot(store, {} as StatusSnapshot, ["ses_a"])
      expect(changed).toBe(true)
      expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
    })

    test("records idle for a fresh client when the successful snapshot omits the candidate", () => {
      const store = createDirectoryStore({
        session_status: {},
        message: { ses_a: streamingMessage() },
      })
      const changed = applySessionStatusSnapshot(store, {} as StatusSnapshot, ["ses_a"])
      expect(changed).toBe(true)
      expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
    })

    test("raises an idle/unknown session to busy when the snapshot reports it active", () => {
      const store = createDirectoryStore({ session_status: {} })
      const changed = applySessionStatusSnapshot(store, { ses_a: { type: "busy" } }, ["ses_a"])
      expect(changed).toBe(true)
      expect(store.getState().session_status.ses_a).toEqual(BUSY)
    })

    test("updates busy → retry from the snapshot", () => {
      const store = createDirectoryStore({ session_status: { ses_a: BUSY } })
      const retry: SessionStatus = { type: "retry", attempt: 2, message: "x", next: 30 }
      applySessionStatusSnapshot(store, { ses_a: { type: "retry", attempt: 2, message: "x", next: 30 } }, ["ses_a"])
      expect(store.getState().session_status.ses_a).toEqual(retry)
    })

    test("reconnect apply set unions local candidates with snapshot IDs", () => {
      // A background session that went idle→busy while disconnected is present
      // only in the snapshot; local candidates alone would miss it.
      expect(collectSessionStatusSnapshotApplyIds(
        ["ses_local"],
        { ses_background: { type: "busy" } } as StatusSnapshot,
      ).sort()).toEqual(["ses_background", "ses_local"])
    })

    test("applies busy for a snapshot-only session after reconnect", () => {
      const store = createDirectoryStore({ session_status: { ses_local: { type: "idle" } } })
      const applyIds = collectSessionStatusSnapshotApplyIds(
        ["ses_local"],
        { ses_background: { type: "busy" } } as StatusSnapshot,
      )
      const changed = applySessionStatusSnapshot(
        store,
        { ses_background: { type: "busy" } } as StatusSnapshot,
        applyIds,
      )
      expect(changed).toBe(true)
      expect(store.getState().session_status.ses_background).toEqual(BUSY)
      expect(store.getState().session_status.ses_local).toEqual({ type: "idle" })
    })
  })
})

describe("reconcileActiveSessionStatusAfterMessagePull", () => {
  test("lowers an unchanged busy status to idle after a successful tail pull", async () => {
    const statusBeforePull: SessionStatus = { type: "busy" }
    const store = createDirectoryStore({
      session_status: { ses_a: statusBeforePull },
    })
    let loads = 0

    await reconcileActiveSessionStatusAfterMessagePull({
      directory: "/repo",
      sessionID: "ses_a",
      store,
      statusBeforePull,
      statusObservedAtBeforePull: undefined,
      hasMessages: true,
      now: () => 100,
      skipActive: true,
      loadSnapshot: async () => {
        loads += 1
        return {}
      },
    })

    expect(loads).toBe(1)
    expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
    expect(store.getState().session_status_observed_at.ses_a).toBe(100)
    expect(store.getState().session_status_snapshot_at).toBe(100)
  })

  test("active 200 empty membership converges busy to idle", async () => {
    const statusBeforePull: SessionStatus = { type: "busy" }
    const store = createDirectoryStore({
      session_status: { ses_a: statusBeforePull },
    })

    await resyncDirectorySessionStatuses("/repo", store, ["ses_a"], {
      now: () => 50,
      loadSnapshot: async () => ({ ses_a: { type: "busy" } }),
      loadActive: async () => ({ state: "supported", membership: {} }),
    })

    expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
    expect(store.getState().session_status_snapshot_at).toBe(50)
  })

  test("successful fused snapshot converges global fallback for directory apply ids", async () => {
    const store = createDirectoryStore({
      session_status: { ses_a: { type: "busy" }, ses_b: { type: "busy" } },
    })
    const converged: Array<{
      directory: string
      snapshot: Record<string, { type?: string }>
      applyIds: string[]
    }> = []

    await resyncDirectorySessionStatuses("/repo", store, ["ses_a", "ses_b"], {
      now: () => 55,
      loadSnapshot: async () => ({ ses_a: { type: "busy" } }),
      loadActive: async () => ({ state: "supported", membership: {} }),
      onAuthoritativeGlobalStatusConverge: (directory, snapshot, applyIds) => {
        converged.push({ directory, snapshot, applyIds: [...applyIds].sort() })
      },
    })

    expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
    expect(store.getState().session_status.ses_b).toEqual({ type: "idle" })
    // Absence from snapshot + applyIds means idle (clears sticky global busy).
    expect(converged).toEqual([{
      directory: "/repo",
      snapshot: {},
      applyIds: ["ses_a", "ses_b"],
    }])
  })

  test("failed resync does not converge global fallback (preserves sticky busy)", async () => {
    const busy: SessionStatus = { type: "busy" }
    const store = createDirectoryStore({
      session_status: { ses_a: busy },
    })
    let convergeCalls = 0

    await resyncDirectorySessionStatuses("/repo", store, ["ses_a"], {
      now: () => 56,
      loadSnapshot: async () => null,
      loadActive: async () => ({ state: "unknown" }),
      onAuthoritativeGlobalStatusConverge: () => {
        convergeCalls += 1
      },
    })

    expect(store.getState().session_status.ses_a).toBe(busy)
    expect(convergeCalls).toBe(0)
  })

  test("live SSE newer than snapshot is preferred when converging global fallback", async () => {
    // Snapshot request starts at t=100; live busy lands at t=150 before apply.
    // Child store keeps live busy; converge payload must report busy not idle.
    const store = createDirectoryStore({
      session_status: { ses_a: { type: "busy" } },
    })
    let resolveSnapshot: ((snapshot: StatusSnapshot) => void) | undefined
    const converged: Array<{
      snapshot: Record<string, { type?: string }>
      applyIds: string[]
    }> = []

    const resync = resyncDirectorySessionStatuses("/repo", store, ["ses_a"], {
      now: () => 100,
      skipActive: true,
      loadSnapshot: () => new Promise<StatusSnapshot>((resolve) => {
        resolveSnapshot = resolve
      }),
      onAuthoritativeGlobalStatusConverge: (_directory, snapshot, applyIds) => {
        converged.push({ snapshot, applyIds: [...applyIds] })
      },
    })
    await Promise.resolve()

    // Live SSE wins via observed_at > requestedAt; empty snapshot would idle.
    store.setState({
      session_status: { ses_a: { type: "busy" } },
      session_status_observed_at: { ses_a: 150 },
    })
    resolveSnapshot?.({})
    await resync

    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
    expect(store.getState().session_status_observed_at.ses_a).toBe(150)
    expect(converged).toEqual([{
      snapshot: { ses_a: { type: "busy" } },
      applyIds: ["ses_a"],
    }])
  })

  test("converges busy when active membership keeps the session running", async () => {
    const store = createDirectoryStore({
      session_status: { ses_a: { type: "idle" } },
    })
    const converged: Array<Record<string, { type?: string }>> = []

    await resyncDirectorySessionStatuses("/repo", store, ["ses_a"], {
      now: () => 57,
      loadSnapshot: async () => ({}),
      loadActive: async () => ({
        state: "supported",
        membership: { ses_a: { type: "running" } },
      }),
      onAuthoritativeGlobalStatusConverge: (_directory, snapshot) => {
        converged.push(snapshot)
      },
    })

    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
    expect(converged).toEqual([{ ses_a: { type: "busy" } }])
  })

  test("404 active unsupported falls back to legacy", async () => {
    const store = createDirectoryStore({
      session_status: { ses_a: { type: "idle" } },
    })

    await resyncDirectorySessionStatuses("/repo", store, ["ses_a"], {
      now: () => 60,
      loadSnapshot: async () => ({ ses_a: { type: "busy" } }),
      loadActive: async () => ({ state: "unsupported" }),
    })

    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
  })

  test("5xx/malformed active preserves prior when legacy also fails", async () => {
    const busy: SessionStatus = { type: "busy" }
    const store = createDirectoryStore({
      session_status: { ses_a: busy },
    })

    await resyncDirectorySessionStatuses("/repo", store, ["ses_a"], {
      now: () => 70,
      loadSnapshot: async () => null,
      loadActive: async () => ({ state: "unknown" }),
    })

    expect(store.getState().session_status.ses_a).toBe(busy)
    expect(store.getState().session_status_snapshot_at).toBe(undefined)
  })

  test("active supported still fuses when legacy snapshot fails", async () => {
    const store = createDirectoryStore({
      session_status: { ses_a: { type: "busy" } },
    })

    await resyncDirectorySessionStatuses("/repo", store, ["ses_a"], {
      now: () => 75,
      loadSnapshot: async () => null,
      loadActive: async () => ({
        state: "supported",
        membership: { ses_a: { type: "running" } },
      }),
    })

    expect(store.getState().session_status.ses_a).toEqual({ type: "busy" })
    expect(store.getState().session_status_snapshot_at).toBe(75)
  })

  test("empty candidates + failed legacy + foreign-only active preserves prior state", async () => {
    // Directory has no local candidates, legacy fails, and active membership
    // only lists sessions from other directories. Must not invent foreign IDs
    // and must not advance session_status_snapshot_at.
    const busy: SessionStatus = { type: "busy" }
    const store = createDirectoryStore({
      session_status: { ses_local: busy },
    })

    const result = await resyncDirectorySessionStatuses("/a", store, [], {
      now: () => 80,
      loadSnapshot: async () => null,
      loadActive: async () => ({
        state: "supported",
        membership: { ses_foreign: { type: "running" } },
      }),
    })

    expect(result).toBe(null)
    expect(store.getState().session_status).toEqual({ ses_local: busy })
    expect(store.getState().session_status.ses_foreign).toBe(undefined)
    expect(store.getState().session_status_snapshot_at).toBe(undefined)
  })

  test("does not write foreign active sessions into another directory store", async () => {
    const storeA = createDirectoryStore({ session_status: { ses_a: { type: "idle" } } })

    await resyncDirectorySessionStatuses("/a", storeA, ["ses_a"], {
      now: () => 90,
      loadSnapshot: async () => ({}),
      loadActive: async () => ({
        state: "supported",
        membership: {
          ses_a: { type: "running" },
          ses_b: { type: "running" },
        },
      }),
    })

    expect(storeA.getState().session_status.ses_a).toEqual({ type: "busy" })
    expect(storeA.getState().session_status.ses_b).toBe(undefined)
  })

  test("keeps a live status transition that arrives while the snapshot is loading", async () => {
    const statusBeforePull: SessionStatus = { type: "busy" }
    const store = createDirectoryStore({
      session_status: { ses_a: statusBeforePull },
    })
    let resolveSnapshot: ((snapshot: StatusSnapshot) => void) | undefined

    const reconciliation = reconcileActiveSessionStatusAfterMessagePull({
      directory: "/repo",
      sessionID: "ses_a",
      store,
      statusBeforePull,
      statusObservedAtBeforePull: undefined,
      hasMessages: true,
      now: () => 100,
      skipActive: true,
      loadSnapshot: () => new Promise<StatusSnapshot>((resolve) => {
        resolveSnapshot = resolve
      }),
    })
    await Promise.resolve()

    const newerBusy: SessionStatus = { type: "busy" }
    store.setState({
      session_status: { ses_a: newerBusy },
      session_status_observed_at: { ses_a: 101 },
    })
    resolveSnapshot?.({})
    await reconciliation

    expect(store.getState().session_status.ses_a).toBe(newerBusy)
    expect(store.getState().session_status_observed_at.ses_a).toBe(101)
  })

  test("shares one directory snapshot across tail reconciliation and reconnect resync", async () => {
    const statusBeforePull: SessionStatus = { type: "busy" }
    const store = createDirectoryStore({
      session_status: { ses_a: statusBeforePull, ses_b: { type: "busy" } },
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const runtimeProbe = {
      getTransport: () => "transport-a",
      getGeneration: () => 1,
    }
    let loads = 0
    let resolveSnapshot: ((snapshot: StatusSnapshot) => void) | undefined
    const loadSnapshot = () => {
      loads += 1
      return new Promise<StatusSnapshot>((resolve) => {
        resolveSnapshot = resolve
      })
    }
    const sharedOptions = {
      queryClient,
      transport: "transport-a",
      runtimeProbe,
      loadSnapshot,
      skipActive: true as const,
      now: () => 100,
    }

    const tailReconciliation = reconcileActiveSessionStatusAfterMessagePull({
      directory: "/repo",
      sessionID: "ses_a",
      store,
      statusBeforePull,
      statusObservedAtBeforePull: undefined,
      hasMessages: true,
      ...sharedOptions,
    })
    const reconnectResync = resyncDirectorySessionStatuses(
      "/repo",
      store,
      ["ses_b"],
      sharedOptions,
    )
    await Promise.resolve()

    expect(loads).toBe(1)
    resolveSnapshot?.({})
    await Promise.all([tailReconciliation, reconnectResync])

    expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
    expect(store.getState().session_status.ses_b).toEqual({ type: "idle" })
    expect(store.getState().session_status_observed_at).toEqual({ ses_a: 100, ses_b: 100 })
  })

  test("shares one process-global active request across multi-directory resync", async () => {
    const storeA = createDirectoryStore({ session_status: { ses_a: { type: "busy" } } })
    const storeB = createDirectoryStore({ session_status: { ses_b: { type: "busy" } } })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const runtimeProbe = {
      getTransport: () => "transport-a",
      getGeneration: () => 1,
    }
    let activeLoads = 0
    let resolveActive: ((result: SessionActiveResult) => void) | undefined
    const loadActive = () => {
      activeLoads += 1
      return new Promise<SessionActiveResult>((resolve) => {
        resolveActive = resolve
      })
    }
    const shared = {
      queryClient,
      transport: "transport-a",
      runtimeProbe,
      loadActive,
      loadSnapshot: async () => ({}),
      now: () => 200,
    }

    const a = resyncDirectorySessionStatuses("/a", storeA, ["ses_a"], shared)
    const b = resyncDirectorySessionStatuses("/b", storeB, ["ses_b"], shared)
    await Promise.resolve()
    expect(activeLoads).toBe(1)
    resolveActive?.({ state: "supported", membership: {} })
    await Promise.all([a, b])

    expect(storeA.getState().session_status.ses_a).toEqual({ type: "idle" })
    expect(storeB.getState().session_status.ses_b).toEqual({ type: "idle" })
  })

  test("preserves busy when the authoritative status snapshot fails", async () => {
    const statusBeforePull: SessionStatus = { type: "busy" }
    const store = createDirectoryStore({
      session_status: { ses_a: statusBeforePull },
    })

    await reconcileActiveSessionStatusAfterMessagePull({
      directory: "/repo",
      sessionID: "ses_a",
      store,
      statusBeforePull,
      statusObservedAtBeforePull: undefined,
      hasMessages: true,
      now: () => 100,
      skipActive: true,
      loadSnapshot: async () => null,
    })

    expect(store.getState().session_status.ses_a).toBe(statusBeforePull)
    expect(store.getState().session_status_snapshot_at).toBe(undefined)
  })

  test("skips reconciliation when the same busy entry was observed during the message pull", async () => {
    const statusBeforePull: SessionStatus = { type: "busy" }
    const store = createDirectoryStore({
      session_status: { ses_a: statusBeforePull },
      session_status_observed_at: { ses_a: 10 },
    })
    let loads = 0

    store.setState({ session_status_observed_at: { ses_a: 11 } })
    await reconcileActiveSessionStatusAfterMessagePull({
      directory: "/repo",
      sessionID: "ses_a",
      store,
      statusBeforePull,
      statusObservedAtBeforePull: 10,
      hasMessages: true,
      loadSnapshot: async () => {
        loads += 1
        return {}
      },
    })

    expect(loads).toBe(0)
    expect(store.getState().session_status.ses_a).toBe(statusBeforePull)
    expect(store.getState().session_status_observed_at.ses_a).toBe(11)
  })

  test("adds no status request for history, empty, idle, stale, or superseded pulls", async () => {
    const busy: SessionStatus = { type: "busy" }
    const idle: SessionStatus = { type: "idle" }
    const store = createDirectoryStore({ session_status: { ses_a: busy } })
    let loads = 0
    const loadSnapshot = async () => {
      loads += 1
      return {} as StatusSnapshot
    }

    await reconcileActiveSessionStatusAfterMessagePull({
      directory: "/repo",
      sessionID: "ses_a",
      store,
      statusBeforePull: busy,
      statusObservedAtBeforePull: undefined,
      hasMessages: true,
      isTailPage: false,
      loadSnapshot,
    })
    await reconcileActiveSessionStatusAfterMessagePull({
      directory: "/repo",
      sessionID: "ses_a",
      store,
      statusBeforePull: busy,
      statusObservedAtBeforePull: undefined,
      hasMessages: false,
      loadSnapshot,
    })
    await reconcileActiveSessionStatusAfterMessagePull({
      directory: "/repo",
      sessionID: "ses_a",
      store,
      statusBeforePull: idle,
      statusObservedAtBeforePull: undefined,
      hasMessages: true,
      loadSnapshot,
    })
    await reconcileActiveSessionStatusAfterMessagePull({
      directory: "/repo",
      sessionID: "ses_a",
      store,
      statusBeforePull: busy,
      statusObservedAtBeforePull: undefined,
      hasMessages: true,
      isStale: () => true,
      loadSnapshot,
    })

    store.setState({ session_status: { ses_a: { type: "busy" } } })
    await reconcileActiveSessionStatusAfterMessagePull({
      directory: "/repo",
      sessionID: "ses_a",
      store,
      statusBeforePull: busy,
      statusObservedAtBeforePull: undefined,
      hasMessages: true,
      loadSnapshot,
    })

    expect(loads).toBe(0)
  })
})

describe("shouldTriggerStaleResync", () => {
  const STALE_MS = 20_000
  const COOLDOWN_MS = 15_000

  test("does NOT trigger when heartbeats are recent (quiet-but-connected session)", () => {
    // 5s ago a heartbeat arrived — stream is alive even though no meaningful
    // events came through. This is the core fix for issue #1656.
    const now = 100_000
    const lastStreamActivityAt = now - 5_000
    expect(shouldTriggerStaleResync(lastStreamActivityAt, 0, now, STALE_MS, COOLDOWN_MS)).toBe(false)
  })

  test("does NOT trigger when a non-heartbeat event is recent", () => {
    const now = 100_000
    const lastStreamActivityAt = now - 3_000
    expect(shouldTriggerStaleResync(lastStreamActivityAt, 0, now, STALE_MS, COOLDOWN_MS)).toBe(false)
  })

  test("triggers when no events at all (including heartbeats) for the stale threshold", () => {
    const now = 100_000
    const lastStreamActivityAt = now - STALE_MS - 1
    expect(shouldTriggerStaleResync(lastStreamActivityAt, 0, now, STALE_MS, COOLDOWN_MS)).toBe(true)
  })

  test("does NOT trigger when within the resync cooldown even if stream is stale", () => {
    const now = 100_000
    const lastStreamActivityAt = now - STALE_MS - 1
    const lastFullResyncAt = now - 5_000 // only 5s ago, cooldown is 15s
    expect(shouldTriggerStaleResync(lastStreamActivityAt, lastFullResyncAt, now, STALE_MS, COOLDOWN_MS)).toBe(false)
  })

  test("triggers when stream is stale AND cooldown has elapsed", () => {
    const now = 100_000
    const lastStreamActivityAt = now - STALE_MS - 1
    const lastFullResyncAt = now - COOLDOWN_MS - 1
    expect(shouldTriggerStaleResync(lastStreamActivityAt, lastFullResyncAt, now, STALE_MS, COOLDOWN_MS)).toBe(true)
  })

  test("does NOT trigger when no events have been received yet (lastStreamActivityAt is 0)", () => {
    // Prevents firing before the first heartbeat arrives
    expect(shouldTriggerStaleResync(0, 0, 100_000, STALE_MS, COOLDOWN_MS)).toBe(false)
  })

  test("uses default thresholds when omitted", () => {
    const now = 100_000
    // 45s since last activity (> 40s default), 20s since last resync (> 15s default)
    expect(shouldTriggerStaleResync(now - 45_000, now - 20_000, now)).toBe(true)
    // 10s since last activity (< 40s default)
    expect(shouldTriggerStaleResync(now - 10_000, 0, now)).toBe(false)
  })
})

describe("shouldTriggerDomainRecovery", () => {
  const now = 100_000
  const base = {
    isViewed: true,
    status: BUSY,
    lastTransportActivityAt: now - 1_000,
    lastDomainActivityAt: now - 60_001,
    lastFullResyncAt: 0,
    now,
  }

  test("triggers for a viewed busy session with fresh transport and stale domain activity", () => {
    expect(shouldTriggerDomainRecovery(base)).toBe(true)
  })

  test("requires an active local status", () => {
    expect(shouldTriggerDomainRecovery({ ...base, status: { type: "idle" } })).toBe(false)
  })

  test("requires the currently viewed session", () => {
    expect(shouldTriggerDomainRecovery({ ...base, isViewed: false })).toBe(false)
  })

  test("leaves transport-stale recovery to the reconnect path", () => {
    expect(shouldTriggerDomainRecovery({ ...base, lastTransportActivityAt: now - 40_000 })).toBe(false)
  })

  test("respects the directory recovery cooldown", () => {
    expect(shouldTriggerDomainRecovery({ ...base, lastFullResyncAt: now - 30_000 })).toBe(false)
  })
})

describe("domain recovery event ownership and freshness", () => {
  test("does not assign an unknown message event to the viewed session", () => {
    const payload = {
      type: "message.part.delta",
      properties: { messageID: "msg_unknown", partID: "prt_1", field: "text", delta: "x" },
    } as never
    expect(resolveStrictDomainSessionID(payload, new Map([["msg_known", "ses_viewed"]]))).toBe(undefined)
  })

  test("resolves a known message event through the routing index", () => {
    const payload = {
      type: "message.part.delta",
      properties: { messageID: "msg_known", partID: "prt_1", field: "text", delta: "x" },
    } as never
    expect(resolveStrictDomainSessionID(payload, new Map([["msg_known", "ses_viewed"]]))).toBe("ses_viewed")
  })

  test("skips a recovery snapshot after its live revision changes", () => {
    expect(isLiveRevisionCurrent(4, 5)).toBe(false)
    expect(isLiveRevisionCurrent(4, 4)).toBe(true)
  })
})
