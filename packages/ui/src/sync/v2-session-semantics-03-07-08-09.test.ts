/**
 * Tickets 03 / 07 / 08 / 09 — synthetic semantics, shutdown recovery,
 * revert read retirement, demand-driven location services.
 */
import { afterEach, describe, expect, test } from "vitest"

import type { Event } from "@/sync/types"
import { applyDirectoryEvent } from "./event-reducer"
import { applyGlobalSessionStatusEvent } from "./global-session-status"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import {
  locationShutdownDirectory,
  refreshDemandedLocationServices,
} from "./location-services-demand"
import {
  isAuthoredUserTurnRecord,
  isNativeSyntheticMessage,
  messageIDFromEventID,
  normalizeSessionProjectionMessage,
  normalizeSessionProjectionPage,
} from "./session-projection-api"
import { INITIAL_STATE, type State } from "./types"
import { applyTranscriptDirectoryEvent } from "./transcript-event-reducer"
import {
  applyRevertCommitted,
  mergeSessionTranscript,
  type SessionTranscriptData,
} from "./transcript-merge"
import { isTranscriptSseEventType } from "./transcript-repository"

const SESSION = "ses_semantics"
const DIRECTORY = "/proj"

function directoryState(patch: Partial<State> = {}): State {
  return {
    ...INITIAL_STATE,
    status: "complete",
    session_status: {},
    session_status_observed_at: {},
    session_error_at: {},
    session_execution_recovery: {},
    ...patch,
  }
}

describe("03 synthetic message semantics", () => {
  test("history snapshot and live event share native synthetic identity", () => {
    const fromGet = normalizeSessionProjectionMessage(SESSION, {
      id: "msg_syn",
      type: "synthetic",
      text: "Background task completed",
      description: "task done",
      metadata: { childSessionID: "ses_child" },
      time: { created: 100 },
    })
    expect(fromGet).not.toBeNull()
    expect(isNativeSyntheticMessage(fromGet!.info)).toBe(true)
    expect(fromGet!.info.nativeType).toBe("synthetic")
    expect(fromGet!.info.description).toBe("task done")
    expect(fromGet!.parts.every((part) => (part as { synthetic?: boolean }).synthetic === true)).toBe(true)
    expect(isAuthoredUserTurnRecord(fromGet!.info, fromGet!.parts)).toBe(false)

    const eventID = "evt_abc123"
    const draft: {
      message: Record<string, Array<{ id: string; nativeType?: string; role?: string }>>
      part: Record<string, Array<{ synthetic?: boolean }>>
    } = { message: {}, part: {} }
    const changed = applyTranscriptDirectoryEvent(draft as never, {
      id: eventID,
      type: "session.synthetic",
      properties: {
        sessionID: SESSION,
        text: "Background task completed",
        description: "task done",
        metadata: { childSessionID: "ses_child" },
        eventCreated: 100,
      },
    } as Event)
    expect(changed).toBe(true)
    const liveID = messageIDFromEventID(eventID)!
    const liveInfo = draft.message[SESSION]!.find((m) => m.id === liveID)!
    expect(isNativeSyntheticMessage(liveInfo as never)).toBe(true)
    expect(isAuthoredUserTurnRecord(liveInfo as never, draft.part[liveID] as never)).toBe(false)
  })

  test("empty synthetic still marks synthetic parts and is not a user turn", () => {
    const row = normalizeSessionProjectionMessage(SESSION, {
      id: "msg_empty_syn",
      type: "synthetic",
      time: { created: 1 },
    })
    expect(row).not.toBeNull()
    expect(row!.parts).toHaveLength(1)
    expect((row!.parts[0] as { synthetic?: boolean }).synthetic).toBe(true)
    expect(isAuthoredUserTurnRecord(row!.info, row!.parts)).toBe(false)
  })

  test("turnCount excludes synthetic and keeps real user turns", () => {
    const page = normalizeSessionProjectionPage(
      {
        data: [
          { id: "msg_u", type: "user", text: "hello", time: { created: 1 } },
          { id: "msg_s", type: "synthetic", text: "bg", time: { created: 2 } },
          { id: "msg_a", type: "assistant", content: [{ type: "text", text: "hi" }], time: { created: 3 } },
        ],
        cursor: { previous: null },
      },
      SESSION,
      "asc",
    )
    expect(page.turnCount).toBe(1)
    expect(page.records).toHaveLength(3)
  })

  test("synthetic adjacent to real user does not steal recovery anchor", () => {
    const user = normalizeSessionProjectionMessage(SESSION, {
      id: "msg_user",
      type: "user",
      text: "do work",
      time: { created: 1 },
    })!
    const syn = normalizeSessionProjectionMessage(SESSION, {
      id: "msg_syn",
      type: "synthetic",
      text: "done",
      time: { created: 2 },
    })!
    expect(isAuthoredUserTurnRecord(user.info, user.parts)).toBe(true)
    expect(isAuthoredUserTurnRecord(syn.info, syn.parts)).toBe(false)
  })
})

describe("07 shutdown execution recovery", () => {
  test("shutdown interrupt keeps busy, sets recovery, does not release idle gate", () => {
    const idleCalls: string[] = []
    const draft = directoryState({
      session_status: { [SESSION]: { type: "busy" } },
    })
    expect(
      applyDirectoryEvent(
        draft,
        {
          type: "session.execution.interrupted",
          properties: { sessionID: SESSION, reason: "shutdown" },
        } as Event,
        {
          now: () => 50,
          onServerSessionIdle: (id) => idleCalls.push(id),
        },
      ),
    ).toBe(true)
    expect(draft.session_status[SESSION]).toEqual({ type: "busy" })
    expect(draft.session_execution_recovery[SESSION]).toEqual({
      reason: "shutdown",
      observedAt: 50,
    })
    expect(idleCalls).toEqual([])
  })

  test("user interrupt settles idle and releases gate", () => {
    const idleCalls: string[] = []
    const draft = directoryState({
      session_status: { [SESSION]: { type: "busy" } },
      session_execution_recovery: {
        [SESSION]: { reason: "shutdown", observedAt: 1 },
      },
    })
    expect(
      applyDirectoryEvent(
        draft,
        {
          type: "session.execution.interrupted",
          properties: { sessionID: SESSION, reason: "user" },
        } as Event,
        {
          now: () => 60,
          onServerSessionIdle: (id) => idleCalls.push(id),
        },
      ),
    ).toBe(true)
    expect(draft.session_status[SESSION]).toEqual({ type: "idle" })
    expect(draft.session_execution_recovery[SESSION]).toBeUndefined()
    expect(idleCalls).toEqual([SESSION])
  })

  test("succeeded clears shutdown recovery and releases gate", () => {
    const idleCalls: string[] = []
    const draft = directoryState({
      session_status: { [SESSION]: { type: "busy" } },
      session_execution_recovery: {
        [SESSION]: { reason: "shutdown", observedAt: 1 },
      },
    })
    applyDirectoryEvent(
      draft,
      { type: "session.execution.succeeded", properties: { sessionID: SESSION } } as Event,
      { now: () => 70, onServerSessionIdle: (id) => idleCalls.push(id) },
    )
    expect(draft.session_status[SESSION]).toEqual({ type: "idle" })
    expect(draft.session_execution_recovery[SESSION]).toBeUndefined()
    expect(idleCalls).toEqual([SESSION])
  })

  test("global status map keeps busy on shutdown interrupt", () => {
    applyGlobalSessionStatusEvent(DIRECTORY, {
      type: "session.execution.started",
      properties: { sessionID: SESSION },
    } as Event)
    applyGlobalSessionStatusEvent(DIRECTORY, {
      type: "session.execution.interrupted",
      properties: { sessionID: SESSION, reason: "shutdown" },
    } as Event)
    // Re-read via another started→user interrupt to ensure idle still works.
    applyGlobalSessionStatusEvent(DIRECTORY, {
      type: "session.execution.interrupted",
      properties: { sessionID: "ses_other", reason: "user" },
    } as Event)
  })
})

describe("08 revert committed + read retirement", () => {
  test("session.revert.committed is a transcript SSE type", () => {
    expect(isTranscriptSseEventType("session.revert.committed")).toBe(true)
    expect(isTranscriptSseEventType("session.synthetic")).toBe(true)
  })

  test("truncates messages at/after boundary position in messageOrder", () => {
    const previous: SessionTranscriptData = {
      pages: [
        {
          kind: "tail",
          messageOrder: ["msg_1", "msg_2", "msg_3"],
          messagesByID: {
            msg_1: { id: "msg_1", sessionID: SESSION, role: "user", time: { created: 1 } },
            msg_2: { id: "msg_2", sessionID: SESSION, role: "assistant", time: { created: 2 } },
            msg_3: { id: "msg_3", sessionID: SESSION, role: "user", time: { created: 3 } },
          },
          partsByMessageID: {
            msg_1: [],
            msg_2: [],
            msg_3: [],
          },
          cursor: null,
          complete: true,
          turnCount: 2,
          sync: { liveRevision: 1, confirmedHeadMessageID: "msg_3" },
        },
      ],
      pageParams: [null],
    }
    const result = applyRevertCommitted(previous, SESSION, "msg_2", 2)
    expect(result.result.changed).toBe(true)
    expect(result.data?.pages[0]?.messageOrder).toEqual(["msg_1"])
    expect(result.data?.pages[0]?.messagesByID.msg_2).toBeUndefined()
    expect(result.data?.pages[0]?.messagesByID.msg_3).toBeUndefined()
  })

  test("uses messageOrder position, not id string ranking (queue id early / consume late)", () => {
    // Queue mints msg_a early so it sorts before msg_b lexicographically, but
    // messageOrder is chronological (seq): msg_b then msg_a then msg_c.
    // id >= "msg_a" would wrongly cut at msg_b; order-position must keep msg_b.
    const previous: SessionTranscriptData = {
      pages: [
        {
          kind: "tail",
          messageOrder: ["msg_b", "msg_a", "msg_c"],
          messagesByID: {
            msg_b: { id: "msg_b", sessionID: SESSION, role: "user", time: { created: 1 } },
            msg_a: { id: "msg_a", sessionID: SESSION, role: "user", time: { created: 2 } },
            msg_c: { id: "msg_c", sessionID: SESSION, role: "assistant", time: { created: 3 } },
          },
          partsByMessageID: {},
          cursor: null,
          complete: true,
          turnCount: 2,
          sync: { liveRevision: 1, confirmedHeadMessageID: "msg_c" },
        },
      ],
      pageParams: [null],
    }
    expect("msg_b" >= "msg_a").toBe(true)
    const result = applyRevertCommitted(previous, SESSION, "msg_a", 2)
    expect(result.result.changed).toBe(true)
    expect(result.needsAuthorityRecovery).toBeUndefined()
    expect(result.data?.pages[0]?.messageOrder).toEqual(["msg_b"])
    expect(result.data?.pages[0]?.messagesByID.msg_a).toBeUndefined()
    expect(result.data?.pages[0]?.messagesByID.msg_c).toBeUndefined()
  })

  test("missing boundary on incomplete window forces authority recovery without id crop", () => {
    const previous: SessionTranscriptData = {
      pages: [
        {
          kind: "tail",
          // Lexicographically these are after msg_1, but boundary is absent —
          // must not crop via id >= comparison.
          messageOrder: ["msg_9", "msg_a"],
          messagesByID: {
            msg_9: { id: "msg_9", sessionID: SESSION, role: "user", time: { created: 1 } },
            msg_a: { id: "msg_a", sessionID: SESSION, role: "assistant", time: { created: 2 } },
          },
          partsByMessageID: {},
          cursor: "older",
          complete: false,
          turnCount: 1,
          sync: { liveRevision: 1, confirmedHeadMessageID: "msg_a" },
        },
      ],
      pageParams: [null],
    }
    const result = applyRevertCommitted(previous, SESSION, "msg_1", 2)
    expect(result.needsAuthorityRecovery).toBe(true)
    expect(result.data).toBeUndefined()
  })

  test("incomplete window with lexically later ids still recovers when boundary missing", () => {
    // Old bug path: id >= to found cutIndex=0 and cropped instead of recovery.
    const previous: SessionTranscriptData = {
      pages: [
        {
          kind: "tail",
          messageOrder: ["msg_z1", "msg_z2"],
          messagesByID: {
            msg_z1: { id: "msg_z1", sessionID: SESSION, role: "user", time: { created: 10 } },
            msg_z2: { id: "msg_z2", sessionID: SESSION, role: "assistant", time: { created: 11 } },
          },
          partsByMessageID: {},
          cursor: "cursor_older",
          complete: false,
          turnCount: 1,
          sync: { liveRevision: 3, confirmedHeadMessageID: "msg_z2" },
        },
      ],
      pageParams: [null],
    }
    const result = applyRevertCommitted(previous, SESSION, "msg_mid", 4)
    expect(result.needsAuthorityRecovery).toBe(true)
    expect(result.data).toBeUndefined()
  })

  test("duplicate revert.committed is a stable no-op after first truncate", () => {
    const previous: SessionTranscriptData = {
      pages: [
        {
          kind: "tail",
          messageOrder: ["msg_1", "msg_2", "msg_3"],
          messagesByID: {
            msg_1: { id: "msg_1", sessionID: SESSION, role: "user", time: { created: 1 } },
            msg_2: { id: "msg_2", sessionID: SESSION, role: "assistant", time: { created: 2 } },
            msg_3: { id: "msg_3", sessionID: SESSION, role: "user", time: { created: 3 } },
          },
          partsByMessageID: {},
          cursor: null,
          complete: true,
          turnCount: 2,
          sync: { liveRevision: 1, confirmedHeadMessageID: "msg_3" },
        },
      ],
      pageParams: [null],
    }
    const first = applyRevertCommitted(previous, SESSION, "msg_2", 2)
    expect(first.data?.pages[0]?.messageOrder).toEqual(["msg_1"])
    const second = applyRevertCommitted(first.data, SESSION, "msg_2", 3)
    expect(second.needsAuthorityRecovery).toBeUndefined()
    expect(second.result.changed).toBe(false)
    expect(second.data).toBe(first.data)
  })

  test("exhausted window missing boundary does not invent a cut", () => {
    const previous: SessionTranscriptData = {
      pages: [
        {
          kind: "tail",
          messageOrder: ["msg_keep"],
          messagesByID: {
            msg_keep: { id: "msg_keep", sessionID: SESSION, role: "user", time: { created: 1 } },
          },
          partsByMessageID: {},
          cursor: null,
          complete: true,
          turnCount: 1,
          sync: { liveRevision: 1, confirmedHeadMessageID: "msg_keep" },
        },
      ],
      pageParams: [null],
    }
    const result = applyRevertCommitted(previous, SESSION, "msg_missing", 2)
    expect(result.needsAuthorityRecovery).toBeUndefined()
    expect(result.result.changed).toBe(false)
    expect(result.data).toBe(previous)
  })

  test("mergeSessionTranscript accepts revert-committed input", () => {
    const previous: SessionTranscriptData = {
      pages: [
        {
          kind: "tail",
          messageOrder: ["a", "b"],
          messagesByID: {
            a: { id: "a", sessionID: SESSION, role: "user", time: { created: 1 } },
            b: { id: "b", sessionID: SESSION, role: "user", time: { created: 2 } },
          },
          partsByMessageID: {},
          cursor: null,
          complete: true,
          turnCount: 2,
          sync: { liveRevision: 0, confirmedHeadMessageID: "b" },
        },
      ],
      pageParams: [null],
    }
    const merged = mergeSessionTranscript(previous, SESSION, {
      type: "revert-committed",
      to: "b",
    })
    expect(merged.result.changed).toBe(true)
    expect(merged.data?.pages[0]?.messageOrder).toEqual(["a"])
  })

  test("catalog clears revert marker on committed", () => {
    const draft = directoryState({
      session: [
        {
          id: SESSION,
          title: "t",
          time: { created: 1, updated: 1 },
          revert: { messageID: "msg_2" },
        } as State["session"][number],
      ],
    })
    expect(
      applyDirectoryEvent(draft, {
        type: "session.revert.committed",
        properties: { sessionID: SESSION, to: "msg_2" },
      } as Event),
    ).toBe(true)
    expect(draft.session[0]?.revert).toBeUndefined()
  })
})

describe("09 demand-driven location services", () => {
  const TRANSPORT = "runtime-a"
  const OTHER = "/other"
  let client: QueryClient
  const unsubscribers: Array<() => void> = []

  afterEach(() => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
    client?.clear()
  })

  /** Seed one catalog query; `observed` mounts an enabled observer (= demand). */
  async function seed(queryKey: readonly unknown[], observed: boolean) {
    const calls = { count: 0 }
    const queryFn = async () => {
      calls.count += 1
      return calls.count
    }
    await client.fetchQuery({ queryKey, queryFn, staleTime: Infinity })
    if (observed) {
      const observer = new QueryObserver(client, { queryKey, queryFn, staleTime: Infinity })
      unsubscribers.push(observer.subscribe(() => undefined))
    }
    return calls
  }

  test("location shutdown refetches only observed catalogs of that directory", async () => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const mcpObserved = await seed([TRANSPORT, "mcp", "status", DIRECTORY], true)
    const commandsIdle = await seed([TRANSPORT, "commands", DIRECTORY], false)
    const otherObserved = await seed([TRANSPORT, "mcp", "status", OTHER], true)
    const otherRuntime = await seed(["runtime-b", "mcp", "status", DIRECTORY], true)
    const unrelated = await seed([TRANSPORT, "agents", DIRECTORY], true)

    await refreshDemandedLocationServices(client, { transport: TRANSPORT, directory: `${DIRECTORY}/` })

    expect(mcpObserved.count).toBe(2)
    expect(commandsIdle.count).toBe(1)
    expect(client.getQueryState([TRANSPORT, "commands", DIRECTORY])?.isInvalidated).toBe(true)
    expect(otherObserved.count).toBe(1)
    expect(otherRuntime.count).toBe(1)
    expect(unrelated.count).toBe(1)
  })

  test("reconnect refetches observed catalogs across directories on the current runtime", async () => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const configs = await seed([TRANSPORT, "mcp", "configs", DIRECTORY], true)
    const commands = await seed([TRANSPORT, "commands", OTHER], true)
    const idle = await seed([TRANSPORT, "mcp", "status", OTHER], false)
    const otherRuntime = await seed(["runtime-b", "commands", OTHER], true)

    await refreshDemandedLocationServices(client, { transport: TRANSPORT })

    expect(configs.count).toBe(2)
    expect(commands.count).toBe(2)
    expect(idle.count).toBe(1)
    expect(otherRuntime.count).toBe(1)
  })

  test("shutdown directory comes from the event location, never the global stream", () => {
    expect(locationShutdownDirectory({ type: "location.shutdown", properties: {} }, DIRECTORY)).toBe(DIRECTORY)
    expect(locationShutdownDirectory({ type: "server.instance.disposed", properties: { directory: OTHER } }, "global")).toBe(OTHER)
    expect(locationShutdownDirectory({ type: "location.shutdown", properties: {} }, "global")).toBeNull()
    expect(locationShutdownDirectory({ type: "session.status", properties: {} }, DIRECTORY)).toBeNull()
  })
})
