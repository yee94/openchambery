/**
 * Ticket 05 public seams: v2 live overlay, disconnect → force GET,
 * stale HTTP reconcile, busy/complete from session.status + execution.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { QueryClient } from "@tanstack/react-query"
import type { Message, Part, SessionStatus } from '@/lib/opencode/v2-types'
import type { Event } from '@/sync/types'

import { applyTranscriptDirectoryEvent, type TranscriptEventDraft } from "./transcript-event-reducer"
import { applyDirectoryEvent } from "./event-reducer"
import { INITIAL_STATE, type State } from "./types"
import { applyGlobalSessionStatusEvent, useGlobalSessionStatusStore } from "./global-session-status"
import { reduceSessionMessagePage, type SessionMessageReducerState } from "./session-message-reducer"
import { shouldDropStalePage } from "./session-merge-strategy"
import { createQueryTranscriptRepository } from "./transcript-repository-query-adapter"
import { isTranscriptSseEventType } from "./transcript-repository"
import { getSessionIdFromPayload } from "./sync-context"

const SESSION = "ses_1"
const DIRECTORY = "/repo"
const here = dirname(fileURLToPath(import.meta.url))

const assistant = (id: string): Message =>
  ({ id, sessionID: SESSION, role: "assistant", time: { created: 1 } }) as Message

const user = (id: string): Message =>
  ({ id, sessionID: SESSION, role: "user", time: { created: 1 } }) as Message

const textPart = (id: string, messageID: string, text: string): Part =>
  ({ id, messageID, sessionID: SESSION, type: "text", text }) as Part

const reasoningPart = (id: string, messageID: string, text: string): Part =>
  ({ id, messageID, sessionID: SESSION, type: "reasoning", text }) as Part

const toolPart = (id: string, messageID: string, status = "pending"): Part =>
  ({
    id,
    messageID,
    sessionID: SESSION,
    type: "tool",
    tool: "read",
    callID: id,
    state: { status, input: "", output: undefined, metadata: {} },
  }) as Part

function draft(messages: Message[], parts: Record<string, Part[]> = {}): TranscriptEventDraft {
  return { message: { [SESSION]: messages }, part: parts }
}

function v2Event(type: string, properties: Record<string, unknown>): Event {
  return { type, properties } as Event
}

describe("v2 live overlay on visible transcript rows", () => {
  test("session.text.delta appends onto an existing assistant text part", () => {
    const parts = { msg_a: [textPart("msg_a:text:0", "msg_a", "Hel")] }
    const state = draft([user("msg_u"), assistant("msg_a")], parts)
    const result = applyTranscriptDirectoryEvent(state, v2Event("session.text.delta", {
      sessionID: SESSION,
      assistantMessageID: "msg_a",
      ordinal: 0,
      delta: "lo",
    }))
    expect(result).not.toBe(false)
    expect((state.part.msg_a?.[0] as { text?: string }).text).toBe("Hello")
    expect(state.message[SESSION]?.map((message) => message.id)).toEqual(["msg_u", "msg_a"])
  })

  test("session.reasoning.delta appends onto an existing reasoning part", () => {
    const state = draft(
      [assistant("msg_a")],
      { msg_a: [reasoningPart("msg_a:reasoning:0", "msg_a", "think")] },
    )
    expect(applyTranscriptDirectoryEvent(state, v2Event("session.reasoning.delta", {
      sessionID: SESSION,
      assistantMessageID: "msg_a",
      ordinal: 0,
      delta: " more",
    }))).not.toBe(false)
    expect((state.part.msg_a?.[0] as { text?: string }).text).toBe("think more")
  })

  test("session.tool events overlay input then complete a tool part", () => {
    const state = draft([assistant("msg_a")], { msg_a: [] })
    expect(applyTranscriptDirectoryEvent(state, v2Event("session.tool.input.started", {
      sessionID: SESSION,
      assistantMessageID: "msg_a",
      id: "tool_1",
      name: "read",
    }))).not.toBe(false)
    expect(applyTranscriptDirectoryEvent(state, v2Event("session.tool.input.delta", {
      sessionID: SESSION,
      assistantMessageID: "msg_a",
      id: "tool_1",
      delta: "{\"p",
    }))).not.toBe(false)
    expect(applyTranscriptDirectoryEvent(state, v2Event("session.tool.called", {
      sessionID: SESSION,
      assistantMessageID: "msg_a",
      id: "tool_1",
      input: { path: "/repo" },
      executed: true,
    }))).not.toBe(false)
    expect(applyTranscriptDirectoryEvent(state, v2Event("session.tool.success", {
      sessionID: SESSION,
      assistantMessageID: "msg_a",
      id: "tool_1",
      content: [{ type: "text", text: "file body" }],
      executed: true,
    }))).not.toBe(false)
    const tool = state.part.msg_a?.find((part) => part.id === "tool_1") as {
      state?: { status?: string; output?: string; input?: unknown }
    } | undefined
    expect(tool?.state?.status).toBe("completed")
    expect(tool?.state?.output).toBe("file body")
  })

  test("1.x message.part.delta still overlays an existing part", () => {
    const state = draft(
      [assistant("msg_a")],
      { msg_a: [textPart("prt_1", "msg_a", "Hel")] },
    )
    expect(applyTranscriptDirectoryEvent(state, v2Event("message.part.delta", {
      sessionID: SESSION,
      messageID: "msg_a",
      partID: "prt_1",
      field: "text",
      delta: "lo",
    }))).toBe(true)
    expect((state.part.msg_a?.[0] as { text?: string }).text).toBe("Hello")
  })

  test("v2 delta for an unknown assistant id appends at the tail", () => {
    const state = draft([user("msg_9"), assistant("msg_1")])
    expect(applyTranscriptDirectoryEvent(state, v2Event("session.text.delta", {
      sessionID: SESSION,
      assistantMessageID: "msg_15",
      ordinal: 0,
      delta: "new",
    }))).not.toBe(false)
    expect(state.message[SESSION]?.map((message) => message.id)).toEqual([
      "msg_9",
      "msg_1",
      "msg_15",
    ])
    expect((state.part.msg_15?.[0] as { text?: string }).text).toBe("new")
  })

  test("Query apply makes a v2 text delta visible on the transcript", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const repo = createQueryTranscriptRepository({
      client,
      transport: "runtime-a",
      generation: 1,
    })
    const scope = { directory: DIRECTORY, sessionID: SESSION, transport: "runtime-a", generation: 1 }
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: {
        records: [{
          info: assistant("msg_a"),
          parts: [textPart("msg_a:text:0", "msg_a", "Hel")],
        }],
        complete: true,
        turnCount: 0,
      },
    })
    const applied = repo.apply(scope, {
      type: "sse-event",
      event: v2Event("session.text.delta", {
        sessionID: SESSION,
        assistantMessageID: "msg_a",
        ordinal: 0,
        delta: "lo",
      }),
    })
    expect(applied.applied).toBe(true)
    expect((repo.getParts(scope, "msg_a")[0] as { text?: string }).text).toBe("Hello")
    repo.destroy()
  })
})

describe("stale HTTP pages reconcile instead of dropping", () => {
  test("materialize and initial do not drop when liveRevision advanced", () => {
    expect(shouldDropStalePage("materialize")).toBe(false)
    expect(shouldDropStalePage("initial")).toBe(false)
    expect(shouldDropStalePage("prepend")).toBe(true)
  })

  test("stale materialize backfills a missing id and keeps the live row", () => {
    const live = assistant("msg_live")
    const livePart = textPart("prt_live", "msg_live", "from sse")
    const state: SessionMessageReducerState = {
      message: { ses_1: [live] },
      part: { msg_live: [livePart] },
    }
    const result = reduceSessionMessagePage(
      state,
      "ses_1",
      {
        ok: true,
        records: [
          { info: assistant("msg_stale"), parts: [textPart("prt_stale", "msg_stale", "page")] },
        ],
        complete: true,
        turnCount: 0,
      },
      {
        purpose: "materialize",
        capturedRevision: 3,
        liveRevision: 5,
      },
    )
    expect(result.applied).toBe(true)
    expect(result.message.ses_1?.map((message) => message.id)).toEqual(["msg_live", "msg_stale"])
    expect(result.part.msg_live?.[0]).toBe(livePart)
    expect((result.part.msg_live?.[0] as { text?: string }).text).toBe("from sse")
  })
})

describe("disconnect aligns with force GET, not event replay", () => {
  test("compensation unknown-gap / observe path force-refreshes the tail", () => {
    const source = readFileSync(join(here, "session-transcript-reconnect-compensation.ts"), "utf8")
    expect(source.includes("refreshFromAuthority")).toBe(true)
    expect(source.includes("session.log")).toBe(false)
    expect(/await repository\.ensureInitial\(scope\)/.test(source)).toBe(false)
  })

  test("v2 live types are transcript SSE, not dropped as unknown", () => {
    expect(isTranscriptSseEventType("session.text.delta")).toBe(true)
    expect(isTranscriptSseEventType("session.reasoning.delta")).toBe(true)
    expect(isTranscriptSseEventType("session.tool.success")).toBe(true)
    expect(isTranscriptSseEventType("session.compaction.started")).toBe(true)
    expect(isTranscriptSseEventType("session.compaction.ended")).toBe(true)
    expect(isTranscriptSseEventType("message.part.delta")).toBe(true)
    expect(isTranscriptSseEventType("session.updated")).toBe(false)
  })
})

describe("busy and complete listen to session.status and session.execution", () => {
  function directory(): State {
    return { ...INITIAL_STATE, session_status: {}, session_status_observed_at: {} }
  }

  test("session.status remains the primary busy/idle signal", () => {
    const state = directory()
    expect(applyDirectoryEvent(state, v2Event("session.status", {
      sessionID: SESSION,
      status: { type: "busy" } as SessionStatus,
    }))).toBe(true)
    expect(state.session_status[SESSION]).toEqual({ type: "busy" })
    expect(applyDirectoryEvent(state, v2Event("session.status", {
      sessionID: SESSION,
      status: { type: "idle" } as SessionStatus,
    }))).toBe(true)
    expect(state.session_status[SESSION]).toEqual({ type: "idle" })
  })

  test("session.execution.started sets busy; succeeded/failed/interrupted set idle", () => {
    const state = directory()
    expect(applyDirectoryEvent(state, v2Event("session.execution.started", {
      sessionID: SESSION,
    }))).toBe(true)
    expect(state.session_status[SESSION]).toEqual({ type: "busy" })
    expect(applyDirectoryEvent(state, v2Event("session.execution.succeeded", {
      sessionID: SESSION,
    }))).toBe(true)
    expect(state.session_status[SESSION]).toEqual({ type: "idle" })
    expect(applyDirectoryEvent(state, v2Event("session.execution.started", {
      sessionID: SESSION,
    }))).toBe(true)
    expect(applyDirectoryEvent(state, v2Event("session.execution.failed", {
      sessionID: SESSION,
    }))).toBe(true)
    expect(state.session_status[SESSION]).toEqual({ type: "idle" })
    expect(applyDirectoryEvent(state, v2Event("session.execution.started", {
      sessionID: SESSION,
    }))).toBe(true)
    expect(applyDirectoryEvent(state, v2Event("session.execution.interrupted", {
      sessionID: SESSION,
    }))).toBe(true)
    expect(state.session_status[SESSION]).toEqual({ type: "idle" })
  })

  test("session.idle is a fallback idle signal, not the only source", () => {
    const state = directory()
    expect(applyDirectoryEvent(state, v2Event("session.idle", { sessionID: SESSION }))).toBe(true)
    expect(state.session_status[SESSION]).toEqual({ type: "idle" })
    const reducer = readFileSync(join(here, "event-reducer.ts"), "utf8")
    expect(reducer.includes('case "session.execution.started"')).toBe(true)
    expect(reducer.includes('case "session.status"')).toBe(true)
    expect(reducer.includes('case "session.idle"')).toBe(true)
  })

  test("global status store follows execution and status, with idle as fallback", () => {
    useGlobalSessionStatusStore.setState({ statusById: new Map() })
    applyGlobalSessionStatusEvent(DIRECTORY, v2Event("session.execution.started", { sessionID: SESSION }))
    expect(useGlobalSessionStatusStore.getState().statusById.get(SESSION)?.status).toBe("busy")
    applyGlobalSessionStatusEvent(DIRECTORY, v2Event("session.status", {
      sessionID: SESSION,
      status: { type: "retry" },
    }))
    expect(useGlobalSessionStatusStore.getState().statusById.get(SESSION)?.status).toBe("retry")
    applyGlobalSessionStatusEvent(DIRECTORY, v2Event("session.execution.succeeded", { sessionID: SESSION }))
    expect(useGlobalSessionStatusStore.getState().statusById.get(SESSION)).toBeUndefined()
    applyGlobalSessionStatusEvent(DIRECTORY, v2Event("session.execution.started", { sessionID: SESSION }))
    applyGlobalSessionStatusEvent(DIRECTORY, v2Event("session.idle", { sessionID: SESSION }))
    expect(useGlobalSessionStatusStore.getState().statusById.get(SESSION)).toBeUndefined()
  })

  test("getSessionIdFromPayload reads v2 live and execution sessionID", () => {
    expect(getSessionIdFromPayload(v2Event("session.text.delta", {
      sessionID: SESSION,
      assistantMessageID: "msg_a",
      ordinal: 0,
      delta: "x",
    }))).toBe(SESSION)
    expect(getSessionIdFromPayload(v2Event("session.execution.started", {
      sessionID: SESSION,
    }))).toBe(SESSION)
  })
})
