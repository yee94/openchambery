import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import type { Event, Message, Part, PermissionRequest, QuestionRequest, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { applyTranscriptDirectoryEvent } from "../transcript-event-reducer"
import type { TranscriptEventDraft } from "../transcript-event-reducer"
import { applyDirectoryEvent } from "../event-reducer"
import { INITIAL_STATE, type State } from "../types"

function transcriptDraft(overrides: Partial<TranscriptEventDraft> = {}): TranscriptEventDraft {
  return {
    message: {},
    part: {},
    ...overrides,
  }
}

function directoryState(overrides: Partial<State> = {}): State {
  return {
    ...INITIAL_STATE,
    ...overrides,
  }
}

function deltaEvent(): Event {
  return {
    type: "message.part.delta",
    properties: {
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: "hello",
    },
  } as Event
}

function messageUpdatedEvent(info: Message): Event {
  return {
    type: "message.updated",
    properties: { info },
  } as Event
}

function partUpdatedEvent(part?: Part): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: part ?? ({
        id: "prt_1",
        messageID: "msg_1",
        sessionID: "ses_1",
        type: "text",
        text: "hi",
      } as Part),
    },
  } as Event
}

function topLevelSessionOnlyPartUpdatedEvent(): Event {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: "ses_1",
      part: {
        id: "prt_1",
        messageID: "msg_1",
        type: "text",
        text: "hi",
      } as Part,
    },
  } as Event
}

describe("applyTranscriptDirectoryEvent", () => {
  test("keeps a loaded session renderable while a new assistant waits for its first part", () => {
    const openAssistant = {
      id: "msg_open",
      sessionID: "ses_1",
      role: "assistant",
      time: { created: 1 },
    } as Message
    const draft = transcriptDraft({
      message: {
        ses_1: [
          { id: "msg_user", sessionID: "ses_1", role: "user", time: { created: 1 } } as Message,
        ],
      },
      part: {
        msg_user: [{ id: "prt_u", messageID: "msg_user", sessionID: "ses_1", type: "text", text: "hi" } as Part],
      },
    })
    const nextAssistant = {
      ...openAssistant,
      id: "msg_new",
    } as Message

    expect(applyTranscriptDirectoryEvent(draft, messageUpdatedEvent(nextAssistant))).toBe(true)
    expect(draft.message.ses_1?.map((m) => m.id)).toContain("msg_new")
    expect(draft.part.msg_new).toEqual([])
    expect(draft.part.msg_user).toBeDefined()
  })

  test("does not invent empty parts for the first assistant on a cold session", () => {
    const draft = transcriptDraft()
    const nextAssistant = {
      id: "msg_1",
      sessionID: "ses_1",
      role: "assistant",
      time: { created: 1 },
    } as Message

    expect(applyTranscriptDirectoryEvent(draft, messageUpdatedEvent(nextAssistant))).toBe(true)
    expect(draft.part.msg_1).toBeUndefined()
  })

  test("orphan delta reports incomplete materialization without changing parts", () => {
    const result = applyTranscriptDirectoryEvent(transcriptDraft(), deltaEvent())
    expect(result).toEqual({
      changed: false,
      materialization: {
        type: "incomplete-session-snapshot",
        reason: "orphan-delta",
        messageID: "msg_1",
        partID: "prt_1",
      },
    })
  })

  test("missing delta part reports incomplete materialization", () => {
    const result = applyTranscriptDirectoryEvent(
      transcriptDraft({
        part: {
          msg_1: [{ id: "prt_other", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "x" } as Part],
        },
      }),
      deltaEvent(),
    )
    expect(typeof result === "object" && result && "materialization" in result).toBe(true)
  })

  test("part updated without owning message reports materialization hint", () => {
    const draft = transcriptDraft()
    const result = applyTranscriptDirectoryEvent(draft, partUpdatedEvent())
    expect(draft.part.msg_1?.map((item) => item.id)).toEqual(["prt_1"])
    expect(typeof result === "object" && result && "materialization" in result).toBe(true)
  })

  test("top-level sessionID on part.updated is accepted", () => {
    const draft = transcriptDraft({
      message: {
        ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as Message],
      },
    })
    const result = applyTranscriptDirectoryEvent(draft, topLevelSessionOnlyPartUpdatedEvent())
    expect(draft.part.msg_1?.map((item) => item.id)).toEqual(["prt_1"])
    expect(result === true || (typeof result === "object" && result.changed)).toBe(true)
  })
})

describe("applyDirectoryEvent (non-transcript production domains)", () => {
  test("message SSE is a no-op on production State", () => {
    const draft = directoryState()
    expect(applyDirectoryEvent(draft, messageUpdatedEvent({
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      time: { created: 1 },
    } as Message))).toBe(false)
  })

  test("session.status mutates directory status only", () => {
    const draft = directoryState()
    const result = applyDirectoryEvent(draft, {
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "busy" } as SessionStatus },
    } as Event)
    expect(result).toBe(true)
    expect(draft.session_status.ses_1).toEqual({ type: "busy" })
  })

  test("permission.asked mutates permission map", () => {
    const draft = directoryState()
    const permission = {
      id: "perm_1",
      sessionID: "ses_1",
      permission: "edit",
    } as PermissionRequest
    expect(applyDirectoryEvent(draft, {
      type: "permission.asked",
      properties: permission,
    } as Event)).toBe(true)
    expect(draft.permission.ses_1?.[0]?.id).toBe("perm_1")
  })

  test("question.asked mutates question map", () => {
    const draft = directoryState()
    const question = {
      id: "q_1",
      sessionID: "ses_1",
    } as QuestionRequest
    expect(applyDirectoryEvent(draft, {
      type: "question.asked",
      properties: question,
    } as Event)).toBe(true)
    expect(draft.question.ses_1?.[0]?.id).toBe("q_1")
  })

  test("session.created inserts visible session into catalog", () => {
    const draft = directoryState()
    const session = {
      id: "ses_1",
      title: "Hello",
      time: { created: 1, updated: 1 },
      version: "1",
    } as Session
    expect(applyDirectoryEvent(draft, {
      type: "session.created",
      properties: { info: session },
    } as Event)).toBe(true)
    expect(draft.session.some((s) => s.id === "ses_1")).toBe(true)
  })
})
