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

  test("message.updated settles an existing tail assistant in conversation order", () => {
    const open = {
      id: "msg_2",
      sessionID: "ses_1",
      role: "assistant",
      time: { created: 1 },
    } as Message
    const draft = transcriptDraft({
      message: {
        ses_1: [
          { id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 } } as Message,
          { id: "msg_3", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as Message,
          { id: "msg_9", sessionID: "ses_1", role: "user", time: { created: 1 } } as Message,
          open,
        ],
      },
    })
    const settled = {
      ...open,
      finish: "stop",
      time: { created: 1, completed: 9 },
    } as Message

    expect(applyTranscriptDirectoryEvent(draft, messageUpdatedEvent(settled))).toBe(true)
    expect(draft.message.ses_1?.map((message) => message.id)).toEqual([
      "msg_1",
      "msg_3",
      "msg_9",
      "msg_2",
    ])
    expect((draft.message.ses_1?.[3] as { finish?: string }).finish).toBe("stop")
  })

  test("message.updated appends a new user turn at the tail instead of the id slot", () => {
    const draft = transcriptDraft({
      message: {
        ses_1: [
          { id: "msg_9", sessionID: "ses_1", role: "user", time: { created: 1 } } as Message,
          { id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as Message,
        ],
      },
    })
    const sent = {
      id: "msg_15",
      sessionID: "ses_1",
      role: "user",
      time: { created: 2 },
    } as Message

    expect(applyTranscriptDirectoryEvent(draft, messageUpdatedEvent(sent))).toBe(true)
    expect(draft.message.ses_1?.map((message) => message.id)).toEqual([
      "msg_9",
      "msg_1",
      "msg_15",
    ])
  })

  test("message.updated keeps agent and model identity when a later payload omits them", () => {
    const identified = {
      id: "msg_2",
      sessionID: "ses_1",
      role: "assistant",
      agent: "explorer",
      mode: "explorer",
      providerID: "deepseek",
      modelID: "deepseek-v4-flash",
      variant: "default",
      time: { created: 1 },
    } as Message
    const draft = transcriptDraft({
      message: {
        ses_1: [identified],
      },
    })
    const tokenTick = {
      id: "msg_2",
      sessionID: "ses_1",
      role: "assistant",
      tokens: { input: 12, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1 },
    } as Message

    expect(applyTranscriptDirectoryEvent(draft, messageUpdatedEvent(tokenTick))).toBe(true)

    const next = draft.message.ses_1?.[0] as Message & {
      agent?: string
      mode?: string
      providerID?: string
      modelID?: string
      variant?: string
      tokens?: { output?: number }
    }
    expect(next.agent).toBe("explorer")
    expect(next.mode).toBe("explorer")
    expect(next.providerID).toBe("deepseek")
    expect(next.modelID).toBe("deepseek-v4-flash")
    expect(next.variant).toBe("default")
    expect(next.tokens?.output).toBe(4)
  })

  test("message.updated keeps UserMessage.model.variant object identity (OpenCode 1.4.0)", () => {
    // model is an object — string identity retention used to delete it and
    // hide the live thinking-intensity badge until a cold reload.
    const userPlain = {
      id: "msg_u",
      sessionID: "ses_1",
      role: "user",
      time: { created: 1 },
    } as Message
    const draft = transcriptDraft({
      message: { ses_1: [userPlain] },
    })
    const withModel = {
      id: "msg_u",
      sessionID: "ses_1",
      role: "user",
      model: { providerID: "openai", modelID: "gpt-4o", variant: "think" },
      time: { created: 1 },
    } as Message

    expect(applyTranscriptDirectoryEvent(draft, messageUpdatedEvent(withModel))).toBe(true)
    const next = draft.message.ses_1?.[0] as Message & {
      model?: { providerID?: string; modelID?: string; variant?: string }
    }
    expect(next.model?.variant).toBe("think")
    expect(next.model?.providerID).toBe("openai")
    expect(next.model?.modelID).toBe("gpt-4o")

    // Same-payload echo must retain model (not delete via string emptiness).
    expect(applyTranscriptDirectoryEvent(draft, messageUpdatedEvent(withModel))).toBe(false)
    expect((draft.message.ses_1?.[0] as { model?: { variant?: string } }).model?.variant).toBe("think")
  })

  test("message.updated preserves existing model when the payload omits it", () => {
    const userWithModel = {
      id: "msg_u",
      sessionID: "ses_1",
      role: "user",
      model: { providerID: "openai", modelID: "gpt-4o", variant: "high" },
      time: { created: 1 },
    } as Message
    const draft = transcriptDraft({
      message: { ses_1: [userWithModel] },
    })
    // Partial update that also carries another field so merge runs; omitting
    // model must keep existing (pre-fix: string path deleted the object).
    const partial = {
      id: "msg_u",
      sessionID: "ses_1",
      role: "user",
      agent: "build",
      time: { created: 1 },
    } as Message

    expect(applyTranscriptDirectoryEvent(draft, messageUpdatedEvent(partial))).toBe(true)
    const next = draft.message.ses_1?.[0] as Message & {
      model?: { variant?: string }
      agent?: string
    }
    expect(next.model?.variant).toBe("high")
    expect(next.agent).toBe("build")
  })

  test("message.updated replaces model wholesale when the payload carries a new object", () => {
    const userWithModel = {
      id: "msg_u",
      sessionID: "ses_1",
      role: "user",
      model: { providerID: "openai", modelID: "gpt-4o", variant: "low" },
      time: { created: 1 },
    } as Message
    const draft = transcriptDraft({
      message: { ses_1: [userWithModel] },
    })
    const replacement = {
      id: "msg_u",
      sessionID: "ses_1",
      role: "user",
      model: { providerID: "anthropic", modelID: "claude", variant: "think" },
      time: { created: 1 },
    } as Message

    expect(applyTranscriptDirectoryEvent(draft, messageUpdatedEvent(replacement))).toBe(true)
    const next = draft.message.ses_1?.[0] as Message & {
      model?: { providerID?: string; modelID?: string; variant?: string }
    }
    expect(next.model).toEqual({
      providerID: "anthropic",
      modelID: "claude",
      variant: "think",
    })
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

describe("applyTranscriptDirectoryEvent streaming text and tool status", () => {
  function seededDraft(messageID: string): TranscriptEventDraft {
    return transcriptDraft({
      message: {
        ses_1: [{ id: messageID, sessionID: "ses_1", role: "assistant", time: { created: 1 } } as Message],
      },
    })
  }

  function textPartEvent(messageID: string, partID: string, text: string): Event {
    return partUpdatedEvent({ id: partID, messageID, sessionID: "ses_1", type: "text", text } as Part)
  }

  function textDeltaEvent(messageID: string, partID: string, delta: string): Event {
    return {
      type: "message.part.delta",
      properties: { sessionID: "ses_1", messageID, partID, field: "text", delta },
    } as Event
  }

  function partText(draft: TranscriptEventDraft, messageID: string): string | undefined {
    return (draft.part[messageID]?.[0] as { text?: string } | undefined)?.text
  }

  test("does not duplicate overlapping delta text after a newer part.updated replaces an older one", () => {
    const full = "Fix typo in ToolOutputDialog — toolFailedToReadDiagram vs toolFailedReadDiagram • Let me fix it."
    const draft = seededDraft("msg_1")

    applyTranscriptDirectoryEvent(draft, textPartEvent("msg_1", "prt_1", "Fix typo in ToolOutputDialog — "))
    applyTranscriptDirectoryEvent(draft, textPartEvent("msg_1", "prt_1", full))
    applyTranscriptDirectoryEvent(
      draft,
      textDeltaEvent("msg_1", "prt_1", "toolFailedToReadDiagram vs toolFailedReadDiagram • Let me fix it."),
    )

    expect(draft.part.msg_1).toHaveLength(1)
    expect(partText(draft, "msg_1")).toBe(full)
  })

  test("appends only the non-overlapping suffix of a streaming delta", () => {
    const draft = seededDraft("msg_2")

    applyTranscriptDirectoryEvent(draft, textPartEvent("msg_2", "prt_2", "toolFailedToReadDiagram vs toolFailedRead"))
    applyTranscriptDirectoryEvent(draft, textPartEvent("msg_2", "prt_2", "toolFailedToReadDiagram vs toolFailedReadDiagra"))
    applyTranscriptDirectoryEvent(draft, textDeltaEvent("msg_2", "prt_2", "Diagram • Let me fix it."))

    expect(partText(draft, "msg_2")).toBe("toolFailedToReadDiagram vs toolFailedReadDiagram • Let me fix it.")
  })

  test("appends a non-overlapping delta unchanged", () => {
    const draft = seededDraft("msg_3")

    applyTranscriptDirectoryEvent(draft, textPartEvent("msg_3", "prt_3", "PR comment done — "))
    applyTranscriptDirectoryEvent(draft, textDeltaEvent("msg_3", "prt_3", "Let me fix it."))

    expect(partText(draft, "msg_3")).toBe("PR comment done — Let me fix it.")
  })

  test("preserves legitimate repeated output when no updated-to-delta dedupe window is active", () => {
    const draft = seededDraft("msg_4")

    applyTranscriptDirectoryEvent(draft, textPartEvent("msg_4", "prt_4", "ha"))
    applyTranscriptDirectoryEvent(draft, textDeltaEvent("msg_4", "prt_4", "ha"))

    expect(partText(draft, "msg_4")).toBe("haha")
  })

  test("does not let a stale running tool update overwrite a completed tool part", () => {
    const draft = seededDraft("msg_5")
    const toolPart = (status: string, time: { start: number; end?: number }) => ({
      id: "prt_5",
      messageID: "msg_5",
      sessionID: "ses_1",
      type: "tool",
      tool: "apply_patch",
      state: { status, time },
    } as unknown as Part)

    applyTranscriptDirectoryEvent(draft, partUpdatedEvent(toolPart("completed", { start: 10, end: 20 })))
    expect(applyTranscriptDirectoryEvent(draft, partUpdatedEvent(toolPart("running", { start: 10 })))).toBe(false)

    const state = (draft.part.msg_5?.[0] as { state?: { status?: string; time?: { end?: number } } } | undefined)?.state
    expect(state?.status).toBe("completed")
    expect(state?.time?.end).toBe(20)
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

  test("server idle events release queue abort blocks even on no-op status writes", () => {
    const draft = directoryState({
      session_status: { ses_1: { type: "idle" } },
    })
    const released: string[] = []
    const callbacks = {
      onServerSessionIdle: (sessionID: string) => {
        released.push(sessionID)
      },
      now: () => 42,
    }

    expect(applyDirectoryEvent(draft, {
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    } as Event, callbacks)).toBe(true)
    expect(applyDirectoryEvent(draft, {
      type: "session.error",
      properties: { sessionID: "ses_1" },
    } as Event, callbacks)).toBe(true)
    expect(applyDirectoryEvent(draft, {
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "idle" } as SessionStatus },
    } as Event, callbacks)).toBe(true)
    expect(applyDirectoryEvent(draft, {
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "busy" } as SessionStatus },
    } as Event, callbacks)).toBe(true)

    expect(released).toEqual(["ses_1", "ses_1", "ses_1"])
  })

  test("session.error records session_error_at; idle does not invent error; busy/retry clears it", () => {
    const draft = directoryState({
      session_status: { ses_1: { type: "busy" } },
    })
    expect(applyDirectoryEvent(draft, {
      type: "session.error",
      properties: { sessionID: "ses_1" },
    } as Event)).toBe(true)
    expect(draft.session_status.ses_1).toEqual({ type: "idle" })
    expect(draft.session_error_at.ses_1).toBeUndefined()

    expect(applyDirectoryEvent(draft, {
      type: "session.error",
      properties: { sessionID: "ses_1" },
    } as Event, { now: () => 100 })).toBe(true)
    expect(draft.session_error_at.ses_1).toBe(100)
    expect(draft.session_status.ses_1).toEqual({ type: "idle" })

    expect(applyDirectoryEvent(draft, {
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    } as Event, { now: () => 110 })).toBe(true)
    expect(draft.session_error_at.ses_1).toBe(100)

    expect(applyDirectoryEvent(draft, {
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "idle" } as SessionStatus },
    } as Event, { now: () => 120 })).toBe(true)
    expect(draft.session_error_at.ses_1).toBe(100)

    expect(applyDirectoryEvent(draft, {
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "busy" } as SessionStatus },
    } as Event, { now: () => 130 })).toBe(true)
    expect(draft.session_error_at.ses_1).toBeUndefined()

    expect(applyDirectoryEvent(draft, {
      type: "session.error",
      properties: { sessionID: "ses_1" },
    } as Event, { now: () => 140 })).toBe(true)
    expect(draft.session_error_at.ses_1).toBe(140)
    expect(applyDirectoryEvent(draft, {
      type: "session.status",
      properties: {
        sessionID: "ses_1",
        status: { type: "retry", attempt: 1, message: "x", next: 200 } as SessionStatus,
      },
    } as Event, { now: () => 150 })).toBe(true)
    expect(draft.session_error_at.ses_1).toBeUndefined()
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

  test("session.diff stores summarized file diffs without large body fields", () => {
    const draft = directoryState()
    const heavyDiff = {
      file: "src/hot.ts",
      status: "modified",
      additions: 12,
      deletions: 3,
      patch: "@@ -1,40 +1,50 @@\n" + "x".repeat(5000),
      before: "old-body",
      after: "new-body",
      from: "from-body",
      to: "to-body",
    }

    expect(applyDirectoryEvent(draft, {
      type: "session.diff",
      properties: {
        sessionID: "ses_hot",
        diff: [heavyDiff],
      },
    } as unknown as Event)).toBe(true)

    const stored = draft.session_diff.ses_hot
    expect(stored).toHaveLength(1)
    expect(stored[0]).toEqual({
      file: "src/hot.ts",
      status: "modified",
      additions: 12,
      deletions: 3,
    })
    expect(stored[0].patch).toBeUndefined()
    expect(stored[0].before).toBeUndefined()
    expect(stored[0].after).toBeUndefined()
    expect(stored[0].from).toBeUndefined()
    expect(stored[0].to).toBeUndefined()
  })
})