import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  reduceSessionMessagePage,
  type SessionMessageReducerState,
} from "./session-message-reducer"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])

function message(id: string, sessionID = "ses_1"): Message {
  return { id, sessionID, role: "assistant", time: { created: 1 } } as Message
}

function userMessage(id: string, sessionID = "ses_1"): Message {
  return { id, sessionID, role: "user", time: { created: 1 } } as Message
}

function part(id: string, messageID: string, type = "text", text = id): Part {
  return { id, messageID, sessionID: "ses_1", type, text } as Part
}

function emptyState(): SessionMessageReducerState {
  return { message: {}, part: {} }
}

function page(
  records: Array<{ info: Message; parts?: Part[] }>,
  options: { cursor?: string; complete?: boolean } = {},
) {
  return {
    ok: true as const,
    records: records.map((record) => ({
      info: record.info,
      parts: record.parts ?? [],
    })),
    cursor: options.cursor,
    complete: options.complete ?? !options.cursor,
  }
}

describe("reduceSessionMessagePage — initial", () => {
  test("atomically writes messages and parts on first load", () => {
    const state = emptyState()
    const result = reduceSessionMessagePage(state, "ses_1", page([
      { info: userMessage("msg_1"), parts: [part("prt_1", "msg_1")] },
      { info: message("msg_2"), parts: [part("prt_2", "msg_2")] },
    ], { complete: true }), { purpose: "initial", skipPartTypes: SKIP_PARTS })

    expect(result.applied).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.messagesChanged).toBe(true)
    expect(result.partsChanged).toBe(true)
    expect(result.message.ses_1?.map((item) => item.id)).toEqual(["msg_1", "msg_2"])
    expect(result.part.msg_1?.map((item) => item.id)).toEqual(["prt_1"])
    expect(result.part.msg_2?.map((item) => item.id)).toEqual(["prt_2"])
    expect(result.meta).toEqual({
      limit: 2,
      cursor: undefined,
      complete: true,
    })
  })

  test("marks empty successful page as materialized complete", () => {
    const result = reduceSessionMessagePage(
      emptyState(),
      "ses_1",
      page([], { complete: true }),
      { purpose: "initial", skipPartTypes: SKIP_PARTS },
    )

    expect(result.applied).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.message.ses_1).toEqual([])
    expect(result.meta).toEqual({ limit: 0, cursor: undefined, complete: true })
    expect(result.commands).toEqual([])
  })

  test("partial page records incomplete meta and cursor", () => {
    const result = reduceSessionMessagePage(
      emptyState(),
      "ses_1",
      page([{ info: message("msg_10"), parts: [part("prt_10", "msg_10")] }], {
        cursor: "msg_10",
        complete: false,
      }),
      { purpose: "initial", skipPartTypes: SKIP_PARTS },
    )

    expect(result.meta).toEqual({
      limit: 1,
      cursor: "msg_10",
      complete: false,
    })
  })
})

describe("reduceSessionMessagePage — prepend", () => {
  test("prepends older history with sort and dedupe", () => {
    const newer = message("msg_2")
    const newerPart = part("prt_2", "msg_2")
    const state: SessionMessageReducerState = {
      message: { ses_1: [newer] },
      part: { msg_2: [newerPart] },
      meta: { limit: 1, cursor: "msg_2", complete: false },
    }

    const older = userMessage("msg_1")
    const olderPart = part("prt_1", "msg_1")
    const result = reduceSessionMessagePage(
      state,
      "ses_1",
      page(
        [
          { info: older, parts: [olderPart] },
          { info: newer, parts: [newerPart] },
        ],
        { cursor: "msg_1", complete: false },
      ),
      { purpose: "prepend", skipPartTypes: SKIP_PARTS },
    )

    expect(result.message.ses_1?.map((item) => item.id)).toEqual(["msg_1", "msg_2"])
    expect(result.message.ses_1?.[1]).toBe(newer)
    expect(result.part.msg_2).toBe(newerPart ? state.part.msg_2 : undefined)
    expect(result.part.msg_1?.map((item) => item.id)).toEqual(["prt_1"])
    expect(result.meta).toEqual({
      limit: 2,
      cursor: "msg_1",
      complete: false,
    })
  })

  test("does not overwrite existing parts for messages already in store", () => {
    const existingPart = part("prt_1", "msg_1", "text", "live")
    const state: SessionMessageReducerState = {
      message: { ses_1: [message("msg_1"), message("msg_2")] },
      part: { msg_1: [existingPart], msg_2: [part("prt_2", "msg_2")] },
    }

    const result = reduceSessionMessagePage(
      state,
      "ses_1",
      page([
        { info: message("msg_1"), parts: [part("prt_1", "msg_1", "text", "stale")] },
        { info: userMessage("msg_0"), parts: [part("prt_0", "msg_0")] },
      ], { cursor: undefined, complete: true }),
      { purpose: "prepend", skipPartTypes: SKIP_PARTS },
    )

    expect(result.part.msg_1?.[0]).toBe(existingPart)
    expect(result.part.msg_0?.map((item) => item.id)).toEqual(["prt_0"])
  })
})

describe("reduceSessionMessagePage — recovery", () => {
  test("keeps local history outside the bounded recovery tail", () => {
    const older = userMessage("msg_1")
    const incomplete = message("msg_2")
    const livePart = part("prt_2", "msg_2", "text", "live output")
    const completed = {
      ...incomplete,
      finish: "stop",
      tokens: { input: 10, output: 20 },
      time: { created: 1, completed: 2 },
    } as Message

    const state: SessionMessageReducerState = {
      message: { ses_1: [older, incomplete] },
      part: { msg_2: [livePart] },
    }

    const result = reduceSessionMessagePage(
      state,
      "ses_1",
      page([{ info: completed, parts: [part("prt_2", "msg_2", "text", "")] }], {
        complete: false,
        cursor: "msg_2",
      }),
      { purpose: "recovery", skipPartTypes: SKIP_PARTS },
    )

    expect(result.message.ses_1).toEqual([older, completed])
    expect(result.message.ses_1?.[0]).toBe(older)
    expect(result.part.msg_2?.[0]).toBe(livePart)
    expect(result.meta?.complete).toBe(false)
  })

  test("preserves references when recovered snapshot is equivalent", () => {
    const existing = message("msg_1")
    const existingPart = part("prt_1", "msg_1")
    const state: SessionMessageReducerState = {
      message: { ses_1: [existing] },
      part: { msg_1: [existingPart] },
      meta: { limit: 1, cursor: undefined, complete: true },
    }

    const result = reduceSessionMessagePage(
      state,
      "ses_1",
      page([{ info: { ...existing }, parts: [{ ...existingPart }] }], { complete: true }),
      { purpose: "recovery", skipPartTypes: SKIP_PARTS },
    )

    expect(result.changed).toBe(false)
    expect(result.message).toBe(state.message)
    expect(result.part).toBe(state.part)
    expect(result.applied).toBe(true)
  })
})

describe("reduceSessionMessagePage — materialize", () => {
  test("fills missing assistant parts for orphan materialization", () => {
    const assistant = message("msg_2")
    const state: SessionMessageReducerState = {
      message: { ses_1: [userMessage("msg_1"), assistant] },
      part: {},
    }

    const result = reduceSessionMessagePage(
      state,
      "ses_1",
      page([
        { info: userMessage("msg_1"), parts: [part("prt_1", "msg_1")] },
        { info: assistant, parts: [part("prt_2", "msg_2")] },
      ], { complete: true }),
      { purpose: "materialize", skipPartTypes: SKIP_PARTS },
    )

    expect(result.partsChanged).toBe(true)
    expect(result.part.msg_2?.map((item) => item.id)).toEqual(["prt_2"])
    expect(result.commands).toEqual([])
  })

  test("emits materialize command when assistant parts remain missing", () => {
    const assistant = message("msg_2")
    const state: SessionMessageReducerState = {
      message: { ses_1: [userMessage("msg_1"), assistant] },
      part: {},
    }

    // Server returned the assistant shell without parts — still not renderable.
    const result = reduceSessionMessagePage(
      state,
      "ses_1",
      page([
        { info: userMessage("msg_1"), parts: [part("prt_1", "msg_1")] },
        { info: assistant, parts: [] },
      ], { complete: true }),
      { purpose: "materialize", skipPartTypes: SKIP_PARTS },
    )

    // Empty assistant parts are stored as [] and count as renderable.
    expect(result.part.msg_2).toEqual([])
    expect(result.commands).toEqual([])
  })
})

describe("reduceSessionMessagePage — streaming and optimistic", () => {
  test("authoritative completed part replaces streaming part", () => {
    const streaming = part("prt_1", "msg_1", "text", "partial")
    const state: SessionMessageReducerState = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [streaming] },
    }

    const completed = {
      ...part("prt_1", "msg_1", "text", "partial final"),
      time: { end: 99 },
    } as Part

    const result = reduceSessionMessagePage(
      state,
      "ses_1",
      page([{ info: message("msg_1"), parts: [completed] }], { complete: true }),
      { purpose: "initial", skipPartTypes: SKIP_PARTS },
    )

    expect(result.part.msg_1?.[0]).toBe(completed)
    expect((result.part.msg_1?.[0] as { text?: string })?.text).toBe("partial final")
  })

  test("preserves newer live streaming text when snapshot is stale", () => {
    const livePart = part("prt_1", "msg_1", "text", "First chunk ")
    const state: SessionMessageReducerState = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [livePart] },
    }

    const result = reduceSessionMessagePage(
      state,
      "ses_1",
      page([{ info: message("msg_1"), parts: [part("prt_1", "msg_1", "text", "")] }], {
        complete: true,
      }),
      { purpose: "initial", skipPartTypes: SKIP_PARTS },
    )

    expect(result.part.msg_1?.[0]).toBe(livePart)
  })

  test("keeps optimistic user message until server confirms it", () => {
    const optimisticUser = userMessage("msg_opt")
    const optimisticPart = part("prt_opt", "msg_opt", "text", "Hello")
    const state = emptyState()

    const result = reduceSessionMessagePage(
      state,
      "ses_1",
      page([{ info: message("msg_2"), parts: [part("prt_2", "msg_2")] }], { complete: true }),
      {
        purpose: "initial",
        skipPartTypes: SKIP_PARTS,
        optimistic: [{ message: optimisticUser, parts: [optimisticPart] }],
      },
    )

    expect(result.message.ses_1?.map((item) => item.id)).toEqual(["msg_2", "msg_opt"])
    expect(result.part.msg_opt?.map((item) => item.id)).toEqual(["prt_opt"])
    expect(result.confirmedOptimisticIDs).toEqual([])
  })

  test("confirms optimistic user message when server page includes it", () => {
    const optimisticUser = userMessage("msg_opt")
    const optimisticPart = part("prt_opt", "msg_opt", "text", "Hello")
    const serverPart = part("prt_server", "msg_opt", "text", "Hello")

    const result = reduceSessionMessagePage(
      emptyState(),
      "ses_1",
      page([{ info: optimisticUser, parts: [serverPart] }], { complete: true }),
      {
        purpose: "initial",
        skipPartTypes: SKIP_PARTS,
        optimistic: [{ message: optimisticUser, parts: [optimisticPart] }],
      },
    )

    expect(result.message.ses_1?.map((item) => item.id)).toEqual(["msg_opt"])
    expect(result.part.msg_opt).toEqual([serverPart])
    expect(result.confirmedOptimisticIDs).toEqual(["msg_opt"])
    expect(result.commands).toEqual([
      {
        type: "clear-optimistic",
        messageIDs: ["msg_opt"],
      },
    ])
  })
})

describe("reduceSessionMessagePage — race and error semantics", () => {
  test("stale recovery fills missing messages while preserving newer live content", () => {
    const previousAssistant = message("msg_1")
    const missingUser = userMessage("msg_2")
    const liveAssistant = message("msg_3")
    const halfReasoning = part("prt_1", "msg_1", "reasoning", "half")
    const completedReasoning = {
      ...part("prt_1", "msg_1", "reasoning", "complete reasoning"),
      time: { end: 10 },
    } as Part
    const liveReasoning = part("prt_3", "msg_3", "reasoning", "newer reasoning from sse")
    const staleReasoning = part("prt_3", "msg_3", "reasoning", "newer")
    const state: SessionMessageReducerState = {
      message: { ses_1: [previousAssistant, liveAssistant] },
      part: { msg_1: [halfReasoning], msg_3: [liveReasoning] },
    }

    const result = reduceSessionMessagePage(
      state,
      "ses_1",
      page([
        { info: previousAssistant, parts: [completedReasoning] },
        { info: missingUser, parts: [part("prt_2", "msg_2", "text", "sent prompt")] },
        { info: { ...liveAssistant }, parts: [staleReasoning] },
      ], { complete: true }),
      {
        purpose: "recovery",
        skipPartTypes: SKIP_PARTS,
        capturedRevision: 3,
        liveRevision: 5,
      },
    )

    expect(result.applied).toBe(true)
    expect(result.message.ses_1?.map((item) => item.id)).toEqual(["msg_1", "msg_2", "msg_3"])
    expect(result.message.ses_1?.[0]).toBe(previousAssistant)
    expect(result.message.ses_1?.[2]).toBe(liveAssistant)
    expect((result.part.msg_1?.[0] as { text?: string }).text).toBe("complete reasoning")
    expect((result.part.msg_1?.[0] as { time?: { end?: number } }).time?.end).toBe(10)
    expect((result.part.msg_3?.[0] as { text?: string }).text).toBe("newer reasoning from sse")
  })

  test("skips stale initial pages", () => {
    const existing = message("msg_live")
    const existingPart = part("prt_live", "msg_live", "text", "from sse")
    const state: SessionMessageReducerState = {
      message: { ses_1: [existing] },
      part: { msg_live: [existingPart] },
    }

    const result = reduceSessionMessagePage(
      state,
      "ses_1",
      page([{ info: message("msg_stale"), parts: [part("prt_stale", "msg_stale")] }], { complete: true }),
      {
        purpose: "initial",
        skipPartTypes: SKIP_PARTS,
        capturedRevision: 3,
        liveRevision: 5,
      },
    )

    expect(result.applied).toBe(false)
    expect(result.changed).toBe(false)
    expect(result.message).toBe(state.message)
    expect(result.part).toBe(state.part)
  })

  test("applies when live revision matches captured revision", () => {
    const state = emptyState()
    const result = reduceSessionMessagePage(
      state,
      "ses_1",
      page([{ info: message("msg_1"), parts: [part("prt_1", "msg_1")] }], { complete: true }),
      {
        purpose: "recovery",
        skipPartTypes: SKIP_PARTS,
        capturedRevision: 4,
        liveRevision: 4,
      },
    )

    expect(result.applied).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.message.ses_1?.map((item) => item.id)).toEqual(["msg_1"])
  })

  test("error page preserves prior state without writing empty success", () => {
    const existing = message("msg_1")
    const existingPart = part("prt_1", "msg_1")
    const state: SessionMessageReducerState = {
      message: { ses_1: [existing] },
      part: { msg_1: [existingPart] },
      meta: { limit: 1, cursor: undefined, complete: true },
    }

    const result = reduceSessionMessagePage(
      state,
      "ses_1",
      { ok: false, error: "network failed" },
      { purpose: "initial", skipPartTypes: SKIP_PARTS },
    )

    expect(result.applied).toBe(false)
    expect(result.changed).toBe(false)
    expect(result.message).toBe(state.message)
    expect(result.part).toBe(state.part)
    expect(result.meta).toBe(state.meta)
    expect(result.error).toBe("network failed")
  })

  test("unchanged successful page keeps message and part references stable", () => {
    const existingMessage = message("msg_1")
    const existingPart = part("prt_1", "msg_1")
    const state: SessionMessageReducerState = {
      message: { ses_1: [existingMessage] },
      part: { msg_1: [existingPart] },
      meta: { limit: 1, cursor: undefined, complete: true },
    }

    const result = reduceSessionMessagePage(
      state,
      "ses_1",
      page([{ info: existingMessage, parts: [existingPart] }], { complete: true }),
      { purpose: "initial", skipPartTypes: SKIP_PARTS },
    )

    expect(result.applied).toBe(true)
    expect(result.changed).toBe(false)
    expect(result.messagesChanged).toBe(false)
    expect(result.partsChanged).toBe(false)
    expect(result.message).toBe(state.message)
    expect(result.part).toBe(state.part)
  })

  test("skips non-rendered part types", () => {
    const result = reduceSessionMessagePage(
      emptyState(),
      "ses_1",
      page([{
        info: message("msg_1"),
        parts: [part("prt_patch", "msg_1", "patch"), part("prt_text", "msg_1")],
      }], { complete: true }),
      { purpose: "initial", skipPartTypes: SKIP_PARTS },
    )

    expect(result.part.msg_1?.map((item) => item.id)).toEqual(["prt_text"])
  })
})
