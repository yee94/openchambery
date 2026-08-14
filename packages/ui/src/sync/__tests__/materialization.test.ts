import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  getSessionMaterializationStatus,
  getSessionMaterializationStatusFromProjection,
  materializeSessionSnapshots,
} from "../materialization"
import { resolveSessionMergeStrategy } from "../session-merge-strategy"

const RECOVERY_MERGE = resolveSessionMergeStrategy({ purpose: "recovery" })
const MATERIALIZE_MERGE = resolveSessionMergeStrategy({ purpose: "materialize" })

function message(id: string, sessionID = "ses_1"): Message {
  return { id, sessionID, role: "assistant", time: { created: 1 } } as Message
}

function userMessage(id: string, sessionID = "ses_1"): Message {
  return { id, sessionID, role: "user", time: { created: 1 } } as Message
}

function part(id: string, messageID: string, type = "text", text = id): Part {
  return { id, messageID, sessionID: "ses_1", type, text } as Part
}

describe("materializeSessionSnapshots", () => {
  test("marks an empty successful page as materialized", () => {
    const result = materializeSessionSnapshots(
      { message: {}, part: {} },
      "ses_1",
      [],
    )

    expect(result.message.ses_1).toEqual([])
    expect(result.messagesChanged).toBe(true)
    expect(getSessionMaterializationStatus(result, "ses_1")).toEqual({
      hasMessages: true,
      renderable: true,
      missingPartMessageIDs: [],
    })
  })

  test("materializes messages and parts together", () => {
    const result = materializeSessionSnapshots(
      { message: {}, part: {} },
      "ses_1",
      [{ info: message("msg_1"), parts: [part("prt_1", "msg_1")] }],
    )

    expect(result.message.ses_1.map((item) => item.id)).toEqual(["msg_1"])
    expect(result.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result.messagesChanged).toBe(true)
    expect(result.partsChanged).toBe(true)
  })

  test("preserves unchanged references", () => {
    const existingMessage = message("msg_1")
    const existingPart = part("prt_1", "msg_1")
    const state = { message: { ses_1: [existingMessage] }, part: { msg_1: [existingPart] } }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: existingMessage, parts: [existingPart] }],
    )

    expect(result.message).toBe(state.message)
    expect(result.part).toBe(state.part)
    expect(result.messagesChanged).toBe(false)
    expect(result.partsChanged).toBe(false)
  })

  test("skips non-rendered part types", () => {
    const result = materializeSessionSnapshots(
      { message: {}, part: {} },
      "ses_1",
      [{ info: message("msg_1"), parts: [part("prt_patch", "msg_1", "patch"), part("prt_text", "msg_1")] }],
      { skipPartTypes: new Set(["patch"]) },
    )

    expect(result.part.msg_1.map((item) => item.id)).toEqual(["prt_text"])
  })

  test("preserves newer live streaming text when a stale snapshot materializes", () => {
    const livePart = part("prt_1", "msg_1", "text", "First chunk ")
    const stalePart = part("prt_1", "msg_1", "text", "")
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [livePart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [stalePart] }],
    )

    expect(result.part.msg_1[0]).toBe(livePart)
    expect((result.part.msg_1[0] as { text?: string })?.text).toBe("First chunk ")
  })

  test("preserves live streaming parts omitted by a stale snapshot", () => {
    const livePart = part("prt_1", "msg_1", "text", "First chunk ")
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [livePart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [] }],
    )

    expect(result.part.msg_1[0]).toBe(livePart)
  })

  test("preserves in-flight tool parts omitted by a lagging mid-turn snapshot", () => {
    const liveTool = {
      id: "prt_tool",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      tool: "read",
      state: { status: "running", input: { path: "a.ts" }, time: { start: 1000 } },
    } as unknown as Part
    const liveReasoning = {
      id: "prt_reason",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "reasoning",
      text: "thinking...",
    } as unknown as Part
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [liveReasoning, liveTool] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      // Lagging GET: reasoning only — tools already admitted via SSE must stay.
      [{ info: message("msg_1"), parts: [liveReasoning] }],
    )

    expect(result.part.msg_1.map((item) => item.id).sort()).toEqual(["prt_reason", "prt_tool"])
    expect(result.part.msg_1.find((item) => item.id === "prt_tool")).toBe(liveTool)
  })

  test("preserves earlier completed tools while the assistant message is still open", () => {
    const completedTool = {
      id: "prt_done",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      tool: "read",
      state: {
        status: "completed",
        input: { path: "a.ts" },
        output: "ok",
        time: { start: 1, end: 2 },
      },
    } as unknown as Part
    const runningTool = {
      id: "prt_run",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      tool: "bash",
      state: { status: "running", input: { command: "ls" }, time: { start: 3 } },
    } as unknown as Part
    const reasoning = {
      id: "prt_reason",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "reasoning",
      text: "next step",
    } as unknown as Part
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [completedTool, runningTool, reasoning] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [reasoning] }],
    )

    expect(result.part.msg_1.map((item) => item.id).sort()).toEqual([
      "prt_done",
      "prt_reason",
      "prt_run",
    ])
  })

  test("drops omitted tools once the snapshot message is settled", () => {
    const completedTool = {
      id: "prt_done",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      tool: "read",
      state: {
        status: "completed",
        input: { path: "a.ts" },
        output: "ok",
        time: { start: 1, end: 2 },
      },
    } as unknown as Part
    const settled = {
      ...message("msg_1"),
      finish: "stop",
      time: { created: 1, completed: 99 },
    } as Message
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [completedTool] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: settled, parts: [] }],
      { merge: RECOVERY_MERGE },
    )

    // Authoritative completed empty parts (e.g. aborted/cleared) win.
    expect(result.part.msg_1).toEqual([])
  })

  test("does not regress live tool status/input when a hollow snapshot re-admits the same id", () => {
    const liveTool = {
      id: "prt_tool",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      tool: "bash",
      state: { status: "running", input: { command: "ls -la" }, time: { start: 1000 } },
    } as unknown as Part
    const hollowTool = {
      id: "prt_tool",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      tool: "bash",
      state: { status: "pending" },
    } as unknown as Part
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [liveTool] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [hollowTool] }],
    )

    const merged = result.part.msg_1[0] as {
      state?: { status?: string; input?: { command?: string }; time?: { start?: number } }
    }
    expect(merged.state?.status).toBe("running")
    expect(merged.state?.input?.command).toBe("ls -la")
    expect(merged.state?.time?.start).toBe(1000)
  })

  test("does not preserve omitted optimistic user text parts beside server snapshot parts", () => {
    const optimisticPart = { id: "prt_optimistic", messageID: "msg_1", type: "text", text: "Hello" } as Part
    const serverPart = part("prt_server", "msg_1", "text", "Hello")
    const state = {
      message: { ses_1: [userMessage("msg_1")] },
      part: { msg_1: [optimisticPart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: userMessage("msg_1"), parts: [serverPart] }],
    )

    expect(result.part.msg_1).toEqual([serverPart])
  })

  test("does not wipe local user parts when idle/materialize/initial snapshots are empty", () => {
    const userPart = part("prt_user", "msg_user", "text", "typed hello")
    const state = {
      message: { ses_1: [userMessage("msg_user")] },
      part: { msg_user: [userPart] },
    }
    const emptyUserSnapshot = [{ info: userMessage("msg_user"), parts: [] as Part[] }]

    for (const purpose of ["initial", "materialize", "recovery"] as const) {
      const result = materializeSessionSnapshots(state, "ses_1", emptyUserSnapshot, {
        merge: resolveSessionMergeStrategy({ purpose }),
      })
      expect(result.part.msg_user).toEqual([userPart])
      expect(result.partsChanged).toBe(false)
      expect(result.part.msg_user[0]).toBe(userPart)
    }
  })

  test("still accepts a non-empty authoritative user part snapshot after local parts exist", () => {
    const localPart = part("prt_local", "msg_user", "text", "pending")
    const serverPart = part("prt_server", "msg_user", "text", "typed hello")
    const state = {
      message: { ses_1: [userMessage("msg_user")] },
      part: { msg_user: [localPart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: userMessage("msg_user"), parts: [serverPart] }],
      { merge: resolveSessionMergeStrategy({ purpose: "materialize" }) },
    )

    expect(result.part.msg_user).toEqual([serverPart])
    expect(result.partsChanged).toBe(true)
  })

  test("preserves state.time from existing part when snapshot drops it", () => {
    const livePart = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      state: { status: "completed", time: { start: 1000, end: 2000 } },
    } as unknown as Part
    const snapshotPart = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      state: { status: "completed" },
    } as unknown as Part
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [livePart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [snapshotPart] }],
    )

    const mergedPart = result.part.msg_1[0] as { state?: { time?: { start?: number; end?: number } } }
    expect(mergedPart.state?.time?.start).toBe(1000)
    expect(mergedPart.state?.time?.end).toBe(2000)
  })

  test("insert-only fills missing finish and completed without replacing the live row", () => {
    const live = message("msg_1")
    const snapshot = {
      ...live,
      finish: "stop",
      time: { created: 1, completed: 9 },
    } as Message
    const result = materializeSessionSnapshots(
      { message: { ses_1: [live] }, part: { msg_1: [part("prt_1", "msg_1", "text", "the answer")] } },
      "ses_1",
      [{ info: snapshot, parts: [part("prt_1", "msg_1", "text", "the answer")] }],
      { merge: MATERIALIZE_MERGE },
    )

    const merged = result.message.ses_1[0] as Message & {
      finish?: string
      time?: { created?: number; completed?: number }
    }
    expect(merged).not.toBe(live)
    expect(merged.id).toBe("msg_1")
    expect(merged.finish).toBe("stop")
    expect(merged.time?.created).toBe(1)
    expect(merged.time?.completed).toBe(9)
    expect(result.messagesChanged).toBe(true)
  })

  test("insert-only still admits the completed snapshot's final text and closed reasoning", () => {
    const live = message("msg_1")
    const openReasoning = {
      ...part("prt_reason", "msg_1", "reasoning", "thinking"),
      time: { start: 1 },
    } as Part
    const closedReasoning = {
      ...openReasoning,
      time: { start: 1, end: 8 },
    } as Part
    const conclusion = part("prt_text", "msg_1", "text", "the answer")
    const snapshot = {
      ...live,
      finish: "stop",
      time: { created: 1, completed: 9 },
    } as Message
    const result = materializeSessionSnapshots(
      { message: { ses_1: [live] }, part: { msg_1: [openReasoning] } },
      "ses_1",
      [{ info: snapshot, parts: [closedReasoning, conclusion] }],
      { merge: MATERIALIZE_MERGE },
    )

    const merged = result.message.ses_1[0] as Message & { finish?: string }
    expect(merged.finish).toBe("stop")
    expect(result.part.msg_1.map((item) => item.id)).toEqual(["prt_reason", "prt_text"])
    expect((result.part.msg_1[0] as { time?: { end?: number } }).time?.end).toBe(8)
    expect((result.part.msg_1[1] as { text?: string }).text).toBe("the answer")
  })

  test("insert-only fills a missing error so an aborted turn can settle", () => {
    const live = message("msg_1")
    const snapshot = {
      ...live,
      error: { name: "UnknownError", data: { message: "aborted" } },
    } as unknown as Message
    const result = materializeSessionSnapshots(
      { message: { ses_1: [live] }, part: { msg_1: [part("prt_1", "msg_1")] } },
      "ses_1",
      [{ info: snapshot, parts: [part("prt_1", "msg_1")] }],
      { merge: MATERIALIZE_MERGE },
    )

    expect(result.message.ses_1[0]).not.toBe(live)
    expect((result.message.ses_1[0] as { error?: { name?: string } }).error?.name).toBe("UnknownError")
  })

  test("insert-only does not strip live finish when the snapshot is still open", () => {
    const live = {
      ...message("msg_1"),
      finish: "stop",
      time: { created: 1, completed: 9 },
    } as Message
    const openSnapshot = message("msg_1")
    const result = materializeSessionSnapshots(
      { message: { ses_1: [live] }, part: { msg_1: [part("prt_1", "msg_1")] } },
      "ses_1",
      [{ info: openSnapshot, parts: [part("prt_1", "msg_1")] }],
      { merge: MATERIALIZE_MERGE },
    )

    expect(result.message.ses_1[0]).toBe(live)
    expect(result.messagesChanged).toBe(false)
  })

  test("insert-only still appends messages the store does not yet hold", () => {
    const existing = userMessage("msg_1")
    const incoming = message("msg_2")
    const result = materializeSessionSnapshots(
      { message: { ses_1: [existing] }, part: {} },
      "ses_1",
      [{ info: incoming, parts: [part("prt_2", "msg_2")] }],
      { merge: MATERIALIZE_MERGE },
    )

    expect(result.message.ses_1.map((item) => item.id)).toEqual(["msg_1", "msg_2"])
    expect(result.message.ses_1[0]).toBe(existing)
  })

  test("insert-only appends a missing message without rewriting conversation order", () => {
    // Same shape as conversation-order: an earlier high-id row, then later low-id turns.
    // Queue send / idle materialize must not id-sort this back into msg_1…msg_9.
    const live = [
      userMessage("msg_9"),
      message("msg_1"),
      userMessage("msg_2"),
      message("msg_3"),
    ]
    const result = materializeSessionSnapshots(
      { message: { ses_1: live }, part: {} },
      "ses_1",
      [{ info: userMessage("msg_4"), parts: [] }],
      { merge: MATERIALIZE_MERGE },
    )

    expect(result.message.ses_1.map((item) => item.id)).toEqual([
      "msg_9",
      "msg_1",
      "msg_2",
      "msg_3",
      "msg_4",
    ])
    expect(result.message.ses_1[0]).toBe(live[0])
  })

  test("recovery replaces fetched message metadata while retaining older local history and live parts", () => {
    const incomplete = message("msg_2")
    const older = userMessage("msg_1")
    const livePart = part("prt_2", "msg_2", "text", "live output")
    const completed = {
      ...incomplete,
      finish: "stop",
      tokens: { input: 10, output: 20 },
      time: { created: 1, completed: 2 },
    } as Message
    const result = materializeSessionSnapshots(
      { message: { ses_1: [older, incomplete] }, part: { msg_2: [livePart] } },
      "ses_1",
      [{ info: completed, parts: [part("prt_2", "msg_2", "text", "")] }],
      { merge: RECOVERY_MERGE },
    )

    expect(result.message.ses_1).toEqual([older, completed])
    expect(result.message.ses_1[0]).toBe(older)
    expect(result.message.ses_1[1]).toBe(completed)
    expect(result.part.msg_2[0]).toBe(livePart)
  })

  test("recovery preserves references for equivalent fetched messages", () => {
    const existing = message("msg_1")
    const state = { message: { ses_1: [existing] }, part: {} }
    const result = materializeSessionSnapshots(state, "ses_1", [{ info: { ...existing }, parts: [] }], { merge: RECOVERY_MERGE })

    expect(result.message).toBe(state.message)
    expect(result.messagesChanged).toBe(false)
  })
})

describe("getSessionMaterializationStatus", () => {
  test("requires assistant parts for renderable cached state when the assistant is settled", () => {
    const settled = {
      ...message("msg_1"),
      finish: "stop",
      time: { created: 1, completed: 2 },
    } as Message
    const state = {
      message: { ses_1: [settled] },
      part: {},
    }

    expect(getSessionMaterializationStatus(state, "ses_1")).toEqual({
      hasMessages: true,
      renderable: false,
      missingPartMessageIDs: ["msg_1"],
    })
  })

  test("does not treat a trailing open assistant without parts as unrenderable", () => {
    // Live multi-step: message.updated arrives before first part.updated.
    // Must stay renderable or ensureSessionRenderable thrash-GET /messages.
    const open = message("msg_open")
    const state = {
      message: { ses_1: [userMessage("msg_user"), open] },
      part: { msg_user: [part("prt_u", "msg_user")] },
    }

    expect(getSessionMaterializationStatus(state, "ses_1")).toEqual({
      hasMessages: true,
      renderable: true,
      missingPartMessageIDs: [],
    })
  })

  test("still requires parts for non-trailing assistants missing part arrays", () => {
    const older = message("msg_old")
    const open = message("msg_open")
    const state = {
      message: { ses_1: [older, open] },
      part: {},
    }

    expect(getSessionMaterializationStatus(state, "ses_1")).toEqual({
      hasMessages: true,
      renderable: false,
      missingPartMessageIDs: ["msg_old"],
    })
  })

  test("treats user-only cached state as renderable", () => {
    const state = {
      message: { ses_1: [{ ...message("msg_1"), role: "user" } as Message] },
      part: {},
    }

    expect(getSessionMaterializationStatus(state, "ses_1")).toEqual({
      hasMessages: true,
      renderable: true,
      missingPartMessageIDs: [],
    })
  })

  test("projection overload matches MaterializedState form", () => {
    const settled = {
      ...message("msg_1"),
      finish: "stop",
      time: { created: 1, completed: 2 },
    } as Message
    const state = {
      message: { ses_1: [settled] },
      part: {},
    }
    const fromState = getSessionMaterializationStatus(state, "ses_1")
    const fromProjection = getSessionMaterializationStatusFromProjection({
      messages: state.message.ses_1,
      parts: state.part,
    })
    expect(fromProjection).toEqual(fromState)
    expect(getSessionMaterializationStatus({
      messages: state.message.ses_1,
      parts: state.part,
    })).toEqual(fromState)
  })
})