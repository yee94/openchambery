/**
 * Ticket 10 — deterministic long-gap runtime validation.
 *
 * Real QueryClient + createQueryTranscriptRepository +
 * createTranscriptReconnectCompensationController + createSessionReconcileService.
 * No production-code changes; helpers stay in this file.
 *
 * Covers:
 * 1) Multi-page signed continuation + multi-round latest-head chase
 * 2) Host resetRequired (anchor missing / total budget) → destructive tail
 */

import { afterEach, describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/react-query"

import { createSessionReconcileService } from "../../../web/server/lib/session-turn-pages/reconcile.service.js"
import {
  createTranscriptReconnectCompensationController,
} from "./session-transcript-reconnect-compensation"
import {
  isTranscriptSessionQueryKey,
} from "./session-transcript-query-cache"
import { sessionTranscriptQueryKey } from "./session-message-query"
import { createQueryTranscriptRepository } from "./transcript-repository-query-adapter"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRANSPORT = "test-transport-long-gap"
const GENERATION = 1
const DIRECTORY = "/repo-long-gap"
const SESSION_ID = "ses_long_gap"
const RUNTIME_KEY = "test-runtime-long-gap"
const TEST_SECRET = Buffer.from("test-long-gap-reconcile-secret!!", "utf8")
const FIXED_NOW = 1_700_100_000_000

const SCOPE = {
  directory: DIRECTORY,
  sessionID: SESSION_ID,
  transport: TRANSPORT,
  generation: GENERATION,
}

// ---------------------------------------------------------------------------
// Record / page helpers (test-local only)
// ---------------------------------------------------------------------------

/** Monotonic clock for chronological Host/client ordering (unique per message). */
let nextCreatedAt = 1_000

function msg(id, role, extras = {}) {
  const created =
    typeof extras?.time?.created === "number"
      ? extras.time.created
      : (nextCreatedAt += 1)
  const { time: _ignored, ...rest } = extras
  return {
    id,
    sessionID: SESSION_ID,
    role,
    time: { created },
    ...rest,
  }
}

function part(id, messageID, text = `text-${messageID}`) {
  return {
    id,
    messageID,
    sessionID: SESSION_ID,
    type: "text",
    text,
  }
}

function turn(userId, assistantId, userText, assistantText) {
  return [
    {
      info: msg(userId, "user"),
      parts: [part(`p_${userId}`, userId, userText ?? `prompt-${userId}`)],
    },
    {
      info: msg(assistantId, "assistant"),
      parts: [part(`p_${assistantId}`, assistantId, assistantText ?? `reply-${assistantId}`)],
    },
  ]
}

function resetCreatedClock() {
  nextCreatedAt = 1_000
}

function idsOf(records) {
  return records.map((r) => r.info.id)
}

/**
 * Cursor-based Host fetchPage over a mutable chronological transcript.
 * - `before` omitted → newest window
 * - `before` = message id → strictly older than that id
 * - `nextCursor` = oldest id of the returned window (or null at history start)
 */
function createChronologicalHost(initialRecords = []) {
  /** @type {Array<{ info: object, parts: object[] }>} */
  let records = [...initialRecords]
  let headProbeCount = 0
  /** @type {null | (() => void)} */
  let onHeadProbe = null

  const api = {
    getRecords: () => records,
    setRecords: (next) => {
      records = [...next]
    },
    append: (...entries) => {
      records = [...records, ...entries]
    },
    replace: (next) => {
      records = [...next]
    },
    /**
     * Invoked once per fetchPage call with limit === 1 (Host latest-head probe).
     * Used to append a new turn so the first complete round chases latest head.
     */
    setOnHeadProbe: (fn) => {
      onHeadProbe = fn
    },
    getHeadProbeCount: () => headProbeCount,
    fetchPage: async ({ before, limit }) => {
      const pageLimit =
        typeof limit === "number" && Number.isFinite(limit) && limit > 0
          ? Math.floor(limit)
          : 100

      if (pageLimit === 1) {
        headProbeCount += 1
        if (typeof onHeadProbe === "function") {
          onHeadProbe({ headProbeCount, before, limit: pageLimit })
        }
      }

      const all = records
      let endExclusive = all.length
      if (typeof before === "string" && before.length > 0) {
        const idx = all.findIndex((entry) => entry?.info?.id === before)
        if (idx < 0) {
          return { records: [], nextCursor: null, complete: true }
        }
        endExclusive = idx
      }

      const start = Math.max(0, endExclusive - pageLimit)
      const pageRecords = all.slice(start, endExclusive)
      const nextCursor =
        start > 0 && pageRecords.length > 0
          ? pageRecords[0].info.id
          : null

      return {
        records: pageRecords,
        nextCursor,
        complete: nextCursor == null,
      }
    },
  }

  return api
}

function mapReconcileOk(result) {
  if (!result || result.ok !== true) {
    const code = result?.error ?? "reconcile_failed"
    const err = new Error(String(code))
    err.name = "HostReconcileError"
    err.code = code
    throw err
  }
  return {
    records: Array.isArray(result.records) ? result.records : [],
    anchorFound: result.anchorFound === true,
    capturedHeadMessageID: result.capturedHeadMessageID ?? null,
    latestHeadMessageID: result.latestHeadMessageID ?? null,
    continuation: result.continuation ?? null,
    complete: result.complete === true,
    resetRequired: result.resetRequired === true,
    scannedRecords: Number.isFinite(result.scannedRecords) ? result.scannedRecords : 0,
    responseBytes: Number.isFinite(result.responseBytes) ? result.responseBytes : 0,
  }
}

function createRealFetchReconcile(service, callLog) {
  return async (input) => {
    callLog.push({
      anchor: input.anchor,
      continuation: input.continuation,
      sessionID: input.sessionID,
      directory: input.directory,
    })
    const result = await service.reconcile({
      sessionID: input.sessionID,
      directory: input.directory,
      ...(input.continuation
        ? { continuation: input.continuation }
        : { anchor: input.anchor }),
      signal: input.signal,
    })
    return mapReconcileOk(result)
  }
}

function countFetchingQueries(client, predicate) {
  let count = 0
  for (const query of client.getQueryCache().getAll()) {
    if (predicate && !predicate(query)) continue
    if (query.state.fetchStatus === "fetching") count += 1
  }
  return count
}

function listReconcileTaskStatuses(client) {
  const out = []
  for (const query of client.getQueryCache().getAll()) {
    if (
      !isTranscriptSessionQueryKey(
        query.queryKey,
        {
          transport: TRANSPORT,
          generation: GENERATION,
          directory: DIRECTORY,
          sessionID: SESSION_ID,
        },
        "reconcile-task",
      )
    ) {
      continue
    }
    out.push({
      queryKey: query.queryKey,
      data: query.state.data,
      fetchStatus: query.state.fetchStatus,
    })
  }
  return out
}

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Ticket 10 long-gap runtime (Host reconcile + Query compensation)", () => {
  /** @type {QueryClient | undefined} */
  let client
  /** @type {Array<{ destroy: () => void }>} */
  let controllers = []
  /** @type {Array<{ destroy?: () => void }>} */
  let repos = []

  afterEach(() => {
    for (const c of controllers) c.destroy()
    controllers = []
    for (const r of repos) r.destroy?.()
    repos = []
    client?.clear()
    client = undefined
    resetCreatedClock()
  })

  test("long gap: signed continuation + multi-round head chase merges full unique transcript", async () => {
    resetCreatedClock()
    // Message IDs are zero-padded and strictly increasing so Binary/cmp order
    // matches chronological Host order (role letters must not dominate sort).
    // Client starts with only the stable anchor turn (01/02).
    // After disconnect, Host holds 01..10 — more than pageRecordLimit=4 — so the
    // first reconcile round must emit a signed ocr2 continuation.
    // On the first round's latest-head probe, Host appends 11/12 so capturedHead
    // != latestHead and the controller performs a second-round head chase.
    const IDs = {
      u1: "msg_01", a1: "msg_02",
      u2: "msg_03", a2: "msg_04",
      u3: "msg_05", a3: "msg_06",
      u4: "msg_07", a4: "msg_08",
      u5: "msg_09", a5: "msg_10",
      u6: "msg_11", a6: "msg_12",
    }
    const anchorTurn = turn(IDs.u1, IDs.a1, "anchor-prompt", "anchor-reply")
    const gapTurns = [
      ...turn(IDs.u2, IDs.a2),
      ...turn(IDs.u3, IDs.a3),
      ...turn(IDs.u4, IDs.a4),
      ...turn(IDs.u5, IDs.a5),
    ]
    const chaseTurn = turn(IDs.u6, IDs.a6, "chase-prompt", "chase-reply")

    const host = createChronologicalHost([...anchorTurn, ...gapTurns])
    let appendedChase = false
    host.setOnHeadProbe(() => {
      // Only the first head probe of round-1 completion should extend the head.
      if (appendedChase) return
      if (host.getHeadProbeCount() !== 1) return
      host.append(...chaseTurn)
      appendedChase = true
    })

    const service = createSessionReconcileService({
      fetchPage: host.fetchPage,
      runtimeKey: RUNTIME_KEY,
      continuationSecret: TEST_SECRET,
      clock: () => FIXED_NOW,
      continuationTtlMs: 15 * 60 * 1000,
      pageRecordLimit: 4,
      pageByteLimit: 1024 * 1024,
      totalPageLimit: 20,
      totalByteLimit: 5 * 1024 * 1024,
      scanLimit: 50,
    })

    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const initialCursor = "cur_authoritative_older"
    let ensureCalls = 0
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetcher: async () => {
        ensureCalls += 1
        // Authoritative initial tail: only anchor turn; older history remains.
        return {
          records: anchorTurn,
          complete: false,
          cursor: initialCursor,
          turnCount: 1,
        }
      },
    })
    repos.push(repo)

    const callLog = []
    const controller = createTranscriptReconnectCompensationController({
      client,
      repository: repo,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: () => [],
      getViewedSession: () => ({ directory: DIRECTORY, sessionID: SESSION_ID }),
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetchReconcile: createRealFetchReconcile(service, callLog),
    })
    controllers.push(controller)

    await repo.ensureInitial(SCOPE)
    const unsub = repo.subscribe(SCOPE, () => {})

    const beforeBoundary = repo.getTranscript(SCOPE).boundary
    expect(beforeBoundary.kind).toBe("has-more")
    expect(beforeBoundary.cursor).toBe(initialCursor)
    expect(repo.getTranscript(SCOPE).messageOrder).toEqual([IDs.u1, IDs.a1])

    // Fixed checkpoint before any compensation (replay order is covered elsewhere).
    controller.captureCheckpoints({ lastEventID: "evt_long_gap", reason: "disconnect" })
    const checkpointPending = controller.getCheckpoint(SCOPE)
    expect(checkpointPending?.anchorMessageID).toBe(IDs.u1)
    expect(checkpointPending?.state).toBe("pending")
    expect(checkpointPending?.lastEventID).toBe("evt_long_gap")

    controller.onCompensation({
      lastEventId: "evt_long_gap",
      disconnectedAt: FIXED_NOW - 60_000,
      runtimeGeneration: GENERATION,
      reason: "reconnect",
      transport: "ws",
      isReconnect: true,
    })

    await waitFor(() => !controller.isSessionInFlight(DIRECTORY, SESSION_ID))

    // --- Continuation actually appeared (signed ocr2) ---
    const continuationCalls = callLog.filter(
      (c) => typeof c.continuation === "string" && c.continuation.length > 0,
    )
    expect(continuationCalls.length).toBeGreaterThanOrEqual(1)
    for (const c of continuationCalls) {
      expect(c.continuation.startsWith("ocr2.")).toBe(true)
    }

    // --- At least two rounds (anchor-bearing requests) ---
    const anchorCalls = callLog.filter(
      (c) => typeof c.anchor === "string" && c.anchor.length > 0 && !c.continuation,
    )
    expect(anchorCalls.length).toBeGreaterThanOrEqual(2)
    expect(anchorCalls[0]?.anchor).toBe(IDs.u1)
    // Round-2 anchor is round-1 captured head (newest at first page of round 1).
    // With Host head a5 (msg_10) then chase a6, first-round captured head is msg_10.
    expect(anchorCalls[1]?.anchor).toBe(IDs.a5)

    // Head probe ran and chase turn was published mid-flight.
    expect(host.getHeadProbeCount()).toBeGreaterThanOrEqual(1)
    expect(appendedChase).toBe(true)

    const transcript = repo.getTranscript(SCOPE)
    const expectedIds = [
      IDs.u1, IDs.a1,
      IDs.u2, IDs.a2,
      IDs.u3, IDs.a3,
      IDs.u4, IDs.a4,
      IDs.u5, IDs.a5,
      IDs.u6, IDs.a6,
    ]

    // Unique + full message set
    expect(transcript.messageOrder).toEqual(expectedIds)
    expect(new Set(transcript.messageOrder).size).toBe(expectedIds.length)

    // Every message has complete parts
    for (const id of expectedIds) {
      expect(transcript.messagesByID[id]?.id).toBe(id)
      const parts = transcript.partsByMessageID[id] ?? []
      expect(parts.length).toBeGreaterThanOrEqual(1)
      expect(parts.every((p) => p.messageID === id)).toBe(true)
      const textPart = parts.find((p) => p.type === "text")
      expect(textPart?.text).toBeTruthy()
    }

    // Pagination boundary / cursor keep initial authoritative history semantics
    // (reconcile complete must never rewrite older-history exhaustion).
    expect(transcript.boundary.kind).toBe("has-more")
    expect(transcript.boundary.cursor).toBe(initialCursor)
    expect(transcript.boundary).toEqual(beforeBoundary)

    // Checkpoint complete (multi-round chase may advance checkpoint.anchorMessageID
    // to the prior round's captured head; original fixed capture was asserted above).
    const checkpointDone = controller.getCheckpoint(SCOPE)
    expect(checkpointDone?.state).toBe("complete")
    expect(checkpointDone?.continuation).toBe(null)
    expect(checkpointDone?.lastEventID).toBe("evt_long_gap")
    expect(checkpointDone?.capturedHeadMessageID).toBe(IDs.a6)
    expect(checkpointDone?.latestHeadMessageID).toBe(IDs.a6)

    // Controller flight settled
    expect(controller.isSessionInFlight(DIRECTORY, SESSION_ID)).toBe(false)

    // Related Query fetching count is 0
    const relatedFetching = countFetchingQueries(client, (query) =>
      isTranscriptSessionQueryKey(query.queryKey, {
        transport: TRANSPORT,
        generation: GENERATION,
        directory: DIRECTORY,
        sessionID: SESSION_ID,
      }),
    )
    expect(relatedFetching).toBe(0)
    expect(client.isFetching()).toBe(0)

    // Reconcile task key status complete
    const tasks = listReconcileTaskStatuses(client)
    expect(tasks.length).toBeGreaterThanOrEqual(1)
    const terminal = tasks.filter((t) => t.data?.status === "complete")
    expect(terminal.length).toBeGreaterThanOrEqual(1)
    for (const t of tasks) {
      expect(t.fetchStatus).not.toBe("fetching")
      expect(["complete", "running", "reset", "error", "cancelled"]).toContain(
        t.data?.status,
      )
    }
    // No task still running
    expect(tasks.every((t) => t.data?.status !== "running")).toBe(true)

    // ensureInitial only for the original seed (no destructive reset on this path)
    expect(ensureCalls).toBe(1)

    // Canonical query still present
    const canonicalKey = sessionTranscriptQueryKey(
      { directory: DIRECTORY, sessionID: SESSION_ID },
      TRANSPORT,
      GENERATION,
    )
    expect(client.getQueryData(canonicalKey)).toBeTruthy()

    unsub()
  })

  test("resetRequired (anchor missing): destructive tail clears old chain and settles", async () => {
    resetCreatedClock()
    // Client holds u1/a1 with has-more cursor. Host no longer has that anchor
    // (history rewritten / compacted) → resetRequired → destructiveReset tail.
    const oldTurn = turn("msg_10_old_u", "msg_11_old_a", "old-prompt", "old-reply")
    const newTail = turn("msg_20_new_u", "msg_21_new_a", "new-prompt", "new-reply")

    const host = createChronologicalHost(newTail)

    const service = createSessionReconcileService({
      fetchPage: host.fetchPage,
      runtimeKey: RUNTIME_KEY,
      continuationSecret: TEST_SECRET,
      clock: () => FIXED_NOW,
      continuationTtlMs: 15 * 60 * 1000,
      pageRecordLimit: 4,
      pageByteLimit: 1024 * 1024,
      totalPageLimit: 10,
      totalByteLimit: 5 * 1024 * 1024,
    })

    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const oldCursor = "cur_old_chain"
    let ensureCalls = 0
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetcher: async () => {
        ensureCalls += 1
        if (ensureCalls === 1) {
          return {
            records: oldTurn,
            complete: false,
            cursor: oldCursor,
            turnCount: 1,
          }
        }
        // Post-destructive authoritative tail
        return {
          records: newTail,
          complete: true,
          turnCount: 1,
        }
      },
    })
    repos.push(repo)

    const callLog = []
    const controller = createTranscriptReconnectCompensationController({
      client,
      repository: repo,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: () => [],
      getViewedSession: () => ({ directory: DIRECTORY, sessionID: SESSION_ID }),
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetchReconcile: createRealFetchReconcile(service, callLog),
    })
    controllers.push(controller)

    await repo.ensureInitial(SCOPE)
    const unsub = repo.subscribe(SCOPE, () => {})

    expect(repo.getTranscript(SCOPE).messageOrder).toEqual(["msg_10_old_u", "msg_11_old_a"])
    expect(repo.getTranscript(SCOPE).boundary.kind).toBe("has-more")
    expect(repo.getTranscript(SCOPE).boundary.cursor).toBe(oldCursor)

    controller.captureCheckpoints({ lastEventID: "evt_reset", reason: "disconnect" })
    expect(controller.getCheckpoint(SCOPE)?.anchorMessageID).toBe("msg_10_old_u")

    controller.onCompensation({
      lastEventId: "evt_reset",
      disconnectedAt: FIXED_NOW - 30_000,
      runtimeGeneration: GENERATION,
      reason: "reconnect",
      transport: "ws",
      isReconnect: true,
    })

    await waitFor(() => !controller.isSessionInFlight(DIRECTORY, SESSION_ID))

    // Host was asked with the missing anchor
    expect(callLog.length).toBeGreaterThanOrEqual(1)
    expect(callLog[0]?.anchor).toBe("msg_10_old_u")

    const transcript = repo.getTranscript(SCOPE)
    // Old chain cleared; new tail in effect
    expect(transcript.messageOrder).toEqual(["msg_20_new_u", "msg_21_new_a"])
    expect(transcript.messageOrder).not.toContain("msg_10_old_u")
    expect(transcript.messageOrder).not.toContain("msg_11_old_a")
    expect(transcript.messagesByID["msg_10_old_u"]).toBeUndefined()
    expect(transcript.partsByMessageID["msg_20_new_u"]?.length).toBeGreaterThanOrEqual(1)
    expect(transcript.partsByMessageID["msg_21_new_a"]?.length).toBeGreaterThanOrEqual(1)

    // New authoritative boundary from destructive ensure (exhausted)
    expect(transcript.boundary.kind).toBe("exhausted")

    // Flight + fetching settled
    expect(controller.isSessionInFlight(DIRECTORY, SESSION_ID)).toBe(false)
    expect(
      countFetchingQueries(client, (query) =>
        isTranscriptSessionQueryKey(query.queryKey, {
          transport: TRANSPORT,
          generation: GENERATION,
          directory: DIRECTORY,
          sessionID: SESSION_ID,
        }),
      ),
    ).toBe(0)
    expect(client.isFetching()).toBe(0)

    // Task key terminal (reset path)
    const tasks = listReconcileTaskStatuses(client)
    expect(tasks.length).toBeGreaterThanOrEqual(1)
    expect(tasks.some((t) => t.data?.status === "reset")).toBe(true)
    expect(tasks.every((t) => t.data?.status !== "running")).toBe(true)

    // ensureInitial + destructiveReset ensure
    expect(ensureCalls).toBeGreaterThanOrEqual(2)

    // Checkpoint cleared after successful destructive tail
    expect(controller.getCheckpoint(SCOPE)).toBeUndefined()

    unsub()
  })

  test("resetRequired (total page budget): destructive tail rebuilds and settles", async () => {
    resetCreatedClock()
    // Anchor never appears within totalPageLimit → Host resetRequired.
    const clientTurn = turn("msg_50_budget_u", "msg_51_budget_a")
    // Infinite-ish older stream without the client anchor.
    let pageSeq = 0
    const host = createChronologicalHost([])
    host.fetchPage = async ({ before, limit }) => {
      // Head probe: report a stable synthetic head
      if (limit === 1) {
        return {
          records: [
            {
              info: msg("msg_99_head_live", "assistant"),
              parts: [part("p_head_live", "msg_99_head_live")],
            },
          ],
          nextCursor: null,
          complete: true,
        }
      }
      pageSeq += 1
      const base = 80 + pageSeq * 2
      const u = `msg_${String(base).padStart(2, "0")}_scan_u`
      const a = `msg_${String(base + 1).padStart(2, "0")}_scan_a`
      // Always offer an older cursor so total budget exhausts before history end.
      return {
        records: [
          { info: msg(u, "user"), parts: [part(`p_${u}`, u)] },
          { info: msg(a, "assistant"), parts: [part(`p_${a}`, a)] },
        ],
        nextCursor: `opaque_budget_${pageSeq}`,
        complete: false,
      }
    }

    const service = createSessionReconcileService({
      fetchPage: host.fetchPage,
      runtimeKey: RUNTIME_KEY,
      continuationSecret: TEST_SECRET,
      clock: () => FIXED_NOW,
      continuationTtlMs: 15 * 60 * 1000,
      pageRecordLimit: 2,
      pageByteLimit: 1024 * 1024,
      totalPageLimit: 2,
      totalByteLimit: 5 * 1024 * 1024,
      scanLimit: 10,
    })

    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const newTail = turn("msg_60_rebuilt_u", "msg_61_rebuilt_a", "rebuilt", "ok")
    let ensureCalls = 0
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetcher: async () => {
        ensureCalls += 1
        if (ensureCalls === 1) {
          return {
            records: clientTurn,
            complete: false,
            cursor: "cur_budget_old",
            turnCount: 1,
          }
        }
        return {
          records: newTail,
          complete: true,
          turnCount: 1,
        }
      },
    })
    repos.push(repo)

    const callLog = []
    const controller = createTranscriptReconnectCompensationController({
      client,
      repository: repo,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: () => [],
      getViewedSession: () => ({ directory: DIRECTORY, sessionID: SESSION_ID }),
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetchReconcile: createRealFetchReconcile(service, callLog),
    })
    controllers.push(controller)

    await repo.ensureInitial(SCOPE)
    const unsub = repo.subscribe(SCOPE, () => {})

    controller.captureCheckpoints({ lastEventID: "evt_budget", reason: "disconnect" })
    expect(controller.getCheckpoint(SCOPE)?.anchorMessageID).toBe("msg_50_budget_u")

    controller.onCompensation({
      lastEventId: "evt_budget",
      disconnectedAt: FIXED_NOW - 10_000,
      runtimeGeneration: GENERATION,
      reason: "reconnect",
      transport: "ws",
      isReconnect: true,
    })

    await waitFor(() => !controller.isSessionInFlight(DIRECTORY, SESSION_ID))

    // Continuation may appear on page 1; page 2 hits total budget → resetRequired.
    expect(callLog.length).toBeGreaterThanOrEqual(1)
    const sawContinuation = callLog.some(
      (c) => typeof c.continuation === "string" && c.continuation.startsWith("ocr2."),
    )
    // With totalPageLimit=2 and pageRecordLimit=2, first response continues,
    // second promotes resetRequired (no second continuation for a third page).
    expect(sawContinuation).toBe(true)
    // Controller must have walked at least the first continuation page.
    expect(callLog.length).toBeGreaterThanOrEqual(2)

    const transcript = repo.getTranscript(SCOPE)
    expect(transcript.messageOrder).toEqual(["msg_60_rebuilt_u", "msg_61_rebuilt_a"])
    expect(transcript.messageOrder).not.toContain("msg_50_budget_u")
    expect(transcript.boundary.kind).toBe("exhausted")

    expect(controller.isSessionInFlight(DIRECTORY, SESSION_ID)).toBe(false)
    expect(client.isFetching()).toBe(0)
    expect(
      countFetchingQueries(client, (query) =>
        isTranscriptSessionQueryKey(query.queryKey, {
          transport: TRANSPORT,
          generation: GENERATION,
          directory: DIRECTORY,
          sessionID: SESSION_ID,
        }),
      ),
    ).toBe(0)

    const tasks = listReconcileTaskStatuses(client)
    expect(tasks.some((t) => t.data?.status === "reset")).toBe(true)
    expect(ensureCalls).toBeGreaterThanOrEqual(2)
    expect(controller.getCheckpoint(SCOPE)).toBeUndefined()

    void pageSeq
    unsub()
  })
})
