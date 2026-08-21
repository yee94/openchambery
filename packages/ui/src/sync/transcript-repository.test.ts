import { describe, expect, test } from "bun:test"
import type { Event, Message, Part } from "@opencode-ai/sdk/v2/client"

import {
  hasTailAssistantMissingSettledCompletion,
  isTranscriptSseEventType,
  projectPagination,
  projectTranscriptData,
  type TranscriptRepository,
  type TranscriptScope,
  type TranscriptTransportPage,
} from "./transcript-repository"
import {
  createStoreTranscriptRepository,
  type TranscriptStoreSurface,
} from "./transcript-repository-store-adapter"
import type { SessionHistoryBoundary } from "./types"
import { UNKNOWN_SESSION_HISTORY_BOUNDARY } from "./types"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIRECTORY = "/workspace"
const SESSION = "ses_1"
const SCOPE: TranscriptScope = { directory: DIRECTORY, sessionID: SESSION }

function userMessage(id: string, sessionID = SESSION): Message {
  return { id, sessionID, role: "user", time: { created: 1 } } as Message
}

function assistantMessage(id: string, sessionID = SESSION, parentID?: string): Message {
  return {
    id,
    sessionID,
    role: "assistant",
    ...(parentID ? { parentID } : {}),
    time: { created: 1 },
  } as Message
}

function textPart(id: string, messageID: string, text = id): Part {
  return { id, messageID, sessionID: SESSION, type: "text", text } as Part
}

function page(
  records: Array<{ info: Message; parts?: Part[] }>,
  options: {
    cursor?: string
    complete?: boolean
    turnCount?: number
    requestedTurnLimit?: number
  } = {},
): TranscriptTransportPage {
  return {
    records: records.map((record) => ({
      info: record.info,
      parts: record.parts ?? [],
    })),
    cursor: options.cursor,
    complete: options.complete ?? !options.cursor,
    ...(typeof options.turnCount === "number" ? { turnCount: options.turnCount } : {}),
    ...(typeof options.requestedTurnLimit === "number"
      ? { requestedTurnLimit: options.requestedTurnLimit }
      : {}),
  }
}

type HarnessState = {
  message: Record<string, Message[]>
  part: Record<string, Part[]>
  session_history_boundary: Record<string, SessionHistoryBoundary>
  session_status: Record<string, unknown>
  session_status_observed_at: Record<string, number>
  session_diff: Record<string, unknown>
  todo: Record<string, unknown>
  permission: Record<string, unknown>
  question: Record<string, unknown>
  session: []
}

function createHarnessStore(initial?: Partial<HarnessState>): TranscriptStoreSurface {
  let state: HarnessState = {
    message: {},
    part: {},
    session_history_boundary: {},
    session_status: {},
    session_status_observed_at: {},
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    session: [],
    ...initial,
  }
  const listeners = new Set<
    (
      state: Parameters<Parameters<TranscriptStoreSurface["subscribe"]>[0]>[0],
      prev: Parameters<Parameters<TranscriptStoreSurface["subscribe"]>[0]>[0],
    ) => void
  >()

  return {
    getState: () => state as ReturnType<TranscriptStoreSurface["getState"]>,
    setState: (partial) => {
      const prev = state
      const nextPartial =
        typeof partial === "function"
          ? partial(state as ReturnType<TranscriptStoreSurface["getState"]>)
          : partial
      state = { ...state, ...nextPartial } as HarnessState
      for (const listener of listeners) {
        listener(
          state as ReturnType<TranscriptStoreSurface["getState"]>,
          prev as ReturnType<TranscriptStoreSurface["getState"]>,
        )
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

function createRepo(options?: {
  store?: TranscriptStoreSurface
  liveRevision?: number
  shadows?: Map<string, { message: Message; parts: Part[] }>
}): {
  repo: TranscriptRepository
  store: TranscriptStoreSurface
  shadows: Map<string, { message: Message; parts: Part[] }>
} {
  const store = options?.store ?? createHarnessStore()
  const shadows = options?.shadows ?? new Map()
  const repo = createStoreTranscriptRepository({
    getStore: () => store,
    getLiveRevision: () => options?.liveRevision ?? 0,
    clearOptimisticShadow: ({ messageID }) => {
      shadows.delete(messageID)
    },
    setOptimisticShadow: ({ message, parts }) => {
      shadows.set(message.id, { message, parts: [...parts] })
    },
  })
  return { repo, store, shadows }
}

// ---------------------------------------------------------------------------
// Pure projection helpers
// ---------------------------------------------------------------------------

describe("transcript repository projections", () => {
  test("projectPagination maps unknown / has-more / exhausted correctly", () => {
    expect(projectPagination(SESSION, { kind: "unknown", loadedTurns: 0 })).toEqual({
      sessionID: SESSION,
      boundary: { kind: "unknown", loadedTurns: 0 },
      hasPreviousPage: false,
      isComplete: false,
      cursor: null,
      loadedTurns: 0,
    })

    expect(projectPagination(SESSION, { kind: "has-more", cursor: "msg_1", loadedTurns: 2 })).toEqual({
      sessionID: SESSION,
      boundary: { kind: "has-more", cursor: "msg_1", loadedTurns: 2 },
      hasPreviousPage: true,
      isComplete: false,
      cursor: "msg_1",
      loadedTurns: 2,
    })

    expect(projectPagination(SESSION, { kind: "exhausted", loadedTurns: 4 })).toEqual({
      sessionID: SESSION,
      boundary: { kind: "exhausted", loadedTurns: 4 },
      hasPreviousPage: false,
      isComplete: true,
      cursor: null,
      loadedTurns: 4,
    })
  })

  test("projectTranscriptData builds chronological order and parts map", () => {
    const m1 = userMessage("msg_1")
    const m2 = assistantMessage("msg_2", SESSION, "msg_1")
    const p1 = textPart("part_1", "msg_1", "hello")
    const data = projectTranscriptData({
      sessionID: SESSION,
      messages: [m1, m2],
      parts: { msg_1: [p1] },
      boundary: { kind: "exhausted", loadedTurns: 1 },
      liveRevision: 3,
    })

    expect(data.messageOrder).toEqual(["msg_1", "msg_2"])
    expect(data.messagesByID.msg_1).toBe(m1)
    expect(data.messagesByID.msg_2).toBe(m2)
    expect(data.partsByMessageID.msg_1).toEqual([p1])
    expect(data.partsByMessageID.msg_2).toBeUndefined()
    expect(data.liveRevision).toBe(3)
    expect(data.boundary).toEqual({ kind: "exhausted", loadedTurns: 1 })
  })

  test("isTranscriptSseEventType accepts only transcript event types", () => {
    expect(isTranscriptSseEventType("message.updated")).toBe(true)
    expect(isTranscriptSseEventType("message.part.delta")).toBe(true)
    expect(isTranscriptSseEventType("session.updated")).toBe(false)
    expect(isTranscriptSseEventType("permission.updated")).toBe(false)
  })
})

describe("hasTailAssistantMissingSettledCompletion", () => {
  const tail = (message: Message) => ({
    messageOrder: message ? [message.id] : [],
    messagesByID: message ? { [message.id]: message } : {},
  })

  test("terminal finish without completed marks the settle gap", () => {
    expect(hasTailAssistantMissingSettledCompletion(tail({
      ...assistantMessage("msg_a"),
      finish: "stop",
      tokens: { input: 1, output: 2, reasoning: 3 },
    } as Message))).toBe(true)
    expect(hasTailAssistantMissingSettledCompletion(tail({
      ...assistantMessage("msg_a"),
      finish: "length",
    } as Message))).toBe(true)
  })

  test("completed, streaming, and interrupted tails are not gaps", () => {
    expect(hasTailAssistantMissingSettledCompletion(tail({
      ...assistantMessage("msg_a"),
      finish: "stop",
      time: { created: 1, completed: 2 },
    } as Message))).toBe(false)
    expect(hasTailAssistantMissingSettledCompletion(tail(assistantMessage("msg_a")))).toBe(false)
    expect(hasTailAssistantMissingSettledCompletion(tail({
      ...assistantMessage("msg_a"),
      finish: "canceled",
    } as Message))).toBe(false)
    expect(hasTailAssistantMissingSettledCompletion(tail({
      ...assistantMessage("msg_a"),
      finish: "stop",
      error: { name: "MessageAbortedError", data: { message: "aborted" } },
    } as Message))).toBe(false)
  })

  test("user tail and empty transcript are not gaps", () => {
    expect(hasTailAssistantMissingSettledCompletion(tail(userMessage("msg_u")))).toBe(false)
    expect(hasTailAssistantMissingSettledCompletion(tail(null as unknown as Message))).toBe(false)
    expect(hasTailAssistantMissingSettledCompletion({ messageOrder: [], messagesByID: {} })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Store adapter — reads
// ---------------------------------------------------------------------------

describe("store TranscriptRepository — reads", () => {
  test("empty store projects unknown boundary and empty transcript", () => {
    const { repo } = createRepo()
    const data = repo.getTranscript(SCOPE)
    const pagination = repo.getPagination(SCOPE)

    expect(data.messageOrder).toEqual([])
    expect(data.boundary).toEqual(UNKNOWN_SESSION_HISTORY_BOUNDARY)
    expect(data.liveRevision).toBe(0)
    expect(pagination.hasPreviousPage).toBe(false)
    expect(pagination.isComplete).toBe(false)
    expect(pagination.cursor).toBeNull()
    expect(repo.getRequestState?.(SCOPE)).toEqual({ sessionID: SESSION, status: "idle" })
  })

  test("getMessage and getParts read by id", () => {
    const m1 = userMessage("msg_1")
    const p1 = textPart("part_1", "msg_1")
    const store = createHarnessStore({
      message: { [SESSION]: [m1] },
      part: { msg_1: [p1] },
      session_history_boundary: {
        [SESSION]: { kind: "exhausted", loadedTurns: 1 },
      },
    })
    const { repo } = createRepo({ store })

    expect(repo.getMessage(SCOPE, "msg_1")).toBe(m1)
    expect(repo.getMessage(SCOPE, "missing")).toBeUndefined()
    expect(repo.getParts(SCOPE, "msg_1")).toEqual([p1])
    expect(repo.getParts(SCOPE, "missing")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Store adapter — HTTP page commands
// ---------------------------------------------------------------------------

describe("store TranscriptRepository — http-page commands", () => {
  test("initial tail establishes transcript data and exhausted boundary", () => {
    const { repo } = createRepo()
    const m1 = userMessage("msg_1")
    const p1 = textPart("part_1", "msg_1", "hi")

    const result = repo.apply(SCOPE, {
      type: "http-page",
      purpose: "initial",
      page: page([{ info: m1, parts: [p1] }], { complete: true, turnCount: 1 }),
    })

    expect(result.applied).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.boundary).toEqual({ kind: "exhausted", loadedTurns: 1 })

    const data = repo.getTranscript(SCOPE)
    expect(data.messageOrder).toEqual(["msg_1"])
    expect(data.messagesByID.msg_1).toEqual(m1)
    expect(data.partsByMessageID.msg_1?.[0]?.id).toBe("part_1")
    expect(repo.getPagination(SCOPE).isComplete).toBe(true)
    expect(repo.getPagination(SCOPE).hasPreviousPage).toBe(false)
  })

  test("initial incomplete page yields has-more pagination", () => {
    const { repo } = createRepo()
    const m2 = userMessage("msg_2")

    const result = repo.apply(SCOPE, {
      type: "http-page",
      purpose: "initial",
      page: page([{ info: m2 }], { cursor: "msg_2", complete: false, turnCount: 1 }),
    })

    expect(result.applied).toBe(true)
    expect(result.boundary).toEqual({ kind: "has-more", cursor: "msg_2", loadedTurns: 1 })
    const pagination = repo.getPagination(SCOPE)
    expect(pagination.hasPreviousPage).toBe(true)
    expect(pagination.cursor).toBe("msg_2")
    expect(pagination.isComplete).toBe(false)
  })

  test("prepend inserts older history and accumulates loadedTurns", () => {
    const { repo } = createRepo()
    const m2 = userMessage("msg_2")
    const m1 = userMessage("msg_1")

    repo.apply(SCOPE, {
      type: "http-page",
      purpose: "initial",
      page: page([{ info: m2 }], { cursor: "msg_2", complete: false, turnCount: 1 }),
    })

    const result = repo.apply(SCOPE, {
      type: "http-page",
      purpose: "prepend",
      page: page([{ info: m1 }], { complete: true, turnCount: 1 }),
    })

    expect(result.applied).toBe(true)
    expect(result.boundary).toEqual({ kind: "exhausted", loadedTurns: 2 })

    const data = repo.getTranscript(SCOPE)
    // Chronological order: msg_1 then msg_2 (id-sorted binary merge)
    expect(data.messageOrder).toEqual(["msg_1", "msg_2"])
    expect(repo.getPagination(SCOPE).isComplete).toBe(true)
    expect(repo.getPagination(SCOPE).hasPreviousPage).toBe(false)
  })

  test("prepend with advancing cursor keeps hasPreviousPage", () => {
    const { repo } = createRepo()
    const m3 = userMessage("msg_3")
    const m2 = userMessage("msg_2")

    repo.apply(SCOPE, {
      type: "http-page",
      purpose: "initial",
      page: page([{ info: m3 }], { cursor: "msg_3", complete: false, turnCount: 1 }),
    })

    repo.apply(SCOPE, {
      type: "http-page",
      purpose: "prepend",
      page: page([{ info: m2 }], { cursor: "msg_2", complete: false, turnCount: 1 }),
    })

    const pagination = repo.getPagination(SCOPE)
    expect(pagination.hasPreviousPage).toBe(true)
    expect(pagination.cursor).toBe("msg_2")
    expect(pagination.loadedTurns).toBe(2)
    expect(repo.getTranscript(SCOPE).messageOrder).toEqual(["msg_2", "msg_3"])
  })

  test("recovery applies page with upsert semantics when live revision is current", () => {
    const { repo } = createRepo()
    const m1 = userMessage("msg_1")
    const m1Updated = { ...m1, time: { created: 2 } } as Message

    repo.apply(SCOPE, {
      type: "http-page",
      purpose: "initial",
      page: page([{ info: m1 }], { complete: true, turnCount: 1 }),
    })

    const result = repo.apply(SCOPE, {
      type: "http-page",
      purpose: "recovery",
      page: page([{ info: m1Updated }], { complete: true, turnCount: 1 }),
      capturedLiveRevision: 1,
      liveRevision: 1,
    })

    expect(result.applied).toBe(true)
    // recovery + not-stale uses upsert — message object may be replaced
    const data = repo.getTranscript(SCOPE)
    expect(data.messagesByID.msg_1).toEqual(m1Updated)
  })

  test("stale recovery becomes insert-only and keeps live message object", () => {
    const { repo } = createRepo()
    const m1 = userMessage("msg_1")
    const m1Stale = { ...m1, time: { created: 0 } } as Message
    const m2 = userMessage("msg_2")

    repo.apply(SCOPE, {
      type: "http-page",
      purpose: "initial",
      page: page([{ info: m1 }], { complete: true, turnCount: 1 }),
    })

    // Live revision advanced past capture — recovery still backfills missing IDs
    // but does not overwrite existing message objects.
    const result = repo.apply(SCOPE, {
      type: "http-page",
      purpose: "recovery",
      page: page(
        [{ info: m1Stale }, { info: m2 }],
        { complete: true, turnCount: 2 },
      ),
      capturedLiveRevision: 1,
      liveRevision: 5,
    })

    expect(result.applied).toBe(true)
    const data = repo.getTranscript(SCOPE)
    expect(data.messagesByID.msg_1).toBe(m1) // live object preserved
    expect(data.messagesByID.msg_2).toEqual(m2) // gap filled
    expect(data.messageOrder).toEqual(["msg_1", "msg_2"])
  })

  test("materialize inserts missing messages", () => {
    const { repo } = createRepo()
    const m1 = userMessage("msg_1")
    const m2 = assistantMessage("msg_2", SESSION, "msg_1")
    const p2 = textPart("part_2", "msg_2", "reply")

    repo.apply(SCOPE, {
      type: "http-page",
      purpose: "initial",
      page: page([{ info: m1 }], { complete: true, turnCount: 1 }),
    })

    const result = repo.apply(SCOPE, {
      type: "http-page",
      purpose: "materialize",
      page: page([{ info: m2, parts: [p2] }], { complete: true, turnCount: 1 }),
    })

    expect(result.applied).toBe(true)
    const data = repo.getTranscript(SCOPE)
    expect(data.messageOrder).toEqual(["msg_1", "msg_2"])
    expect(data.partsByMessageID.msg_2?.[0]?.id).toBe("part_2")
  })

  test("stale initial page is dropped and preserves prior transcript", () => {
    const { repo } = createRepo()
    const m1 = userMessage("msg_1")

    repo.apply(SCOPE, {
      type: "http-page",
      purpose: "initial",
      page: page([{ info: m1 }], { complete: true, turnCount: 1 }),
    })

    const m2 = userMessage("msg_2")
    const result = repo.apply(SCOPE, {
      type: "http-page",
      purpose: "initial",
      page: page([{ info: m2 }], { complete: true, turnCount: 1 }),
      capturedLiveRevision: 1,
      liveRevision: 3,
    })

    expect(result.applied).toBe(false)
    expect(repo.getTranscript(SCOPE).messageOrder).toEqual(["msg_1"])
  })

  test("page contract error (incomplete without cursor) is not applied", () => {
    const { repo } = createRepo()

    const result = repo.apply(SCOPE, {
      type: "http-page",
      purpose: "initial",
      page: page([{ info: userMessage("msg_1") }], {
        complete: false,
        // missing cursor — contract violation
      }),
    })

    // complete defaults to !cursor so without cursor complete becomes true.
    // Force incomplete with empty cursor via explicit shape:
    const bad = repo.apply(SCOPE, {
      type: "http-page",
      purpose: "initial",
      page: {
        records: [{ info: userMessage("msg_1"), parts: [] }],
        cursor: "",
        complete: false,
        turnCount: 1,
      },
    })

    expect(bad.applied).toBe(false)
    expect(bad.error).toBeTruthy()
    expect(repo.getTranscript(SCOPE).messageOrder).toEqual([])
    void result
  })
})

// ---------------------------------------------------------------------------
// Store adapter — SSE merge
// ---------------------------------------------------------------------------

describe("store TranscriptRepository — sse-event commands", () => {
  test("message.updated inserts a new message", () => {
    const { repo } = createRepo()
    const info = userMessage("msg_1")

    const result = repo.apply(SCOPE, {
      type: "sse-event",
      event: {
        type: "message.updated",
        properties: { info },
      } as Event,
    })

    expect(result.applied).toBe(true)
    expect(result.changed).toBe(true)
    expect(repo.getTranscript(SCOPE).messageOrder).toEqual(["msg_1"])
    expect(repo.getMessage(SCOPE, "msg_1")).toEqual(info)
  })

  test("message.part.updated and delta update parts", () => {
    const { repo } = createRepo()
    const info = assistantMessage("msg_a")
    const part = textPart("part_a", "msg_a", "hel")

    repo.apply(SCOPE, {
      type: "sse-event",
      event: {
        type: "message.updated",
        properties: { info },
      } as Event,
    })

    repo.apply(SCOPE, {
      type: "sse-event",
      event: {
        type: "message.part.updated",
        properties: { sessionID: SESSION, part },
      } as Event,
    })

    expect(repo.getParts(SCOPE, "msg_a")).toEqual([part])

    const deltaResult = repo.apply(SCOPE, {
      type: "sse-event",
      event: {
        type: "message.part.delta",
        properties: {
          sessionID: SESSION,
          messageID: "msg_a",
          partID: "part_a",
          field: "text",
          delta: "lo",
        },
      } as Event,
    })

    expect(deltaResult.changed).toBe(true)
    const parts = repo.getParts(SCOPE, "msg_a")
    expect((parts[0] as { text?: string }).text).toBe("hello")
  })

  test("message.removed deletes message and parts", () => {
    const { repo } = createRepo()
    const info = userMessage("msg_1")
    const part = textPart("part_1", "msg_1")

    repo.apply(SCOPE, {
      type: "http-page",
      purpose: "initial",
      page: page([{ info, parts: [part] }], { complete: true, turnCount: 1 }),
    })

    const result = repo.apply(SCOPE, {
      type: "sse-event",
      event: {
        type: "message.removed",
        properties: { sessionID: SESSION, messageID: "msg_1" },
      } as Event,
    })

    expect(result.changed).toBe(true)
    expect(repo.getTranscript(SCOPE).messageOrder).toEqual([])
    expect(repo.getParts(SCOPE, "msg_1")).toEqual([])
  })

  test("non-transcript events are no-ops", () => {
    const { repo } = createRepo()
    const result = repo.apply(SCOPE, {
      type: "sse-event",
      event: {
        type: "session.updated",
        properties: { info: { id: SESSION } },
      } as Event,
    })
    expect(result.applied).toBe(false)
    expect(result.changed).toBe(false)
  })

  test("SSE during HTTP preserves live part over prepend skip-existing", () => {
    const { repo } = createRepo()
    const m2 = userMessage("msg_2")
    const m1 = userMessage("msg_1")
    const livePart = textPart("part_2", "msg_2", "live")

    // Establish tail
    repo.apply(SCOPE, {
      type: "http-page",
      purpose: "initial",
      page: page([{ info: m2, parts: [textPart("part_2", "msg_2", "stale")] }], {
        cursor: "msg_2",
        complete: false,
        turnCount: 1,
      }),
    })

    // Live SSE updates the part while history HTTP is in flight
    repo.apply(SCOPE, {
      type: "sse-event",
      event: {
        type: "message.part.updated",
        properties: { sessionID: SESSION, part: livePart },
      } as Event,
    })

    // Prepend older page that also re-sends msg_2 with stale parts — skip-existing
    repo.apply(SCOPE, {
      type: "http-page",
      purpose: "prepend",
      page: page(
        [
          { info: m1, parts: [] },
          { info: m2, parts: [textPart("part_2", "msg_2", "stale-from-http")] },
        ],
        { complete: true, turnCount: 1 },
      ),
    })

    const parts = repo.getParts(SCOPE, "msg_2")
    expect((parts[0] as { text?: string }).text).toBe("live")
    expect(repo.getTranscript(SCOPE).messageOrder).toEqual(["msg_1", "msg_2"])
  })
})

// ---------------------------------------------------------------------------
// Store adapter — optimistic
// ---------------------------------------------------------------------------

describe("store TranscriptRepository — optimistic commands", () => {
  test("optimistic-add inserts message and parts and tracks shadow", () => {
    const { repo, shadows } = createRepo()
    const message = userMessage("msg_opt")
    const parts = [textPart("part_opt", "msg_opt", "pending")]

    const result = repo.apply(SCOPE, {
      type: "optimistic-add",
      message,
      parts,
    })

    expect(result.applied).toBe(true)
    expect(result.changed).toBe(true)
    expect(repo.getTranscript(SCOPE).messageOrder).toEqual(["msg_opt"])
    expect(repo.getParts(SCOPE, "msg_opt")[0]?.id).toBe("part_opt")
    expect(shadows.has("msg_opt")).toBe(true)
  })

  test("optimistic-confirm clears shadow and keeps visible row", () => {
    const { repo, shadows } = createRepo()
    const message = userMessage("msg_opt")

    repo.apply(SCOPE, {
      type: "optimistic-add",
      message,
      parts: [textPart("part_opt", "msg_opt")],
    })

    const result = repo.apply(SCOPE, {
      type: "optimistic-confirm",
      messageID: "msg_opt",
    })

    expect(result.applied).toBe(true)
    expect(result.changed).toBe(false)
    expect(shadows.has("msg_opt")).toBe(false)
    expect(repo.getTranscript(SCOPE).messageOrder).toEqual(["msg_opt"])
  })

  test("optimistic-remove clears shadow and removes visible row", () => {
    const { repo, shadows } = createRepo()
    const message = userMessage("msg_opt")

    repo.apply(SCOPE, {
      type: "optimistic-add",
      message,
      parts: [textPart("part_opt", "msg_opt")],
    })

    const result = repo.apply(SCOPE, {
      type: "optimistic-remove",
      messageID: "msg_opt",
    })

    expect(result.applied).toBe(true)
    expect(result.changed).toBe(true)
    expect(shadows.has("msg_opt")).toBe(false)
    expect(repo.getTranscript(SCOPE).messageOrder).toEqual([])
    expect(repo.getParts(SCOPE, "msg_opt")).toEqual([])
  })

  test("http-page with matching optimistic confirms by message id", () => {
    const { repo } = createRepo()
    const message = userMessage("msg_opt")
    const optimisticParts = [textPart("local_part", "msg_opt", "pending")]
    const serverParts = [textPart("server_part", "msg_opt", "accepted")]

    repo.apply(SCOPE, {
      type: "optimistic-add",
      message,
      parts: optimisticParts,
    })

    const result = repo.apply(SCOPE, {
      type: "http-page",
      purpose: "materialize",
      page: page([{ info: message, parts: serverParts }], { complete: true, turnCount: 1 }),
      optimistic: [{ message, parts: optimisticParts }],
    })

    expect(result.applied).toBe(true)
    expect(result.confirmedOptimisticIDs).toContain("msg_opt")
    // Server parts preferred once confirmed
    const parts = repo.getParts(SCOPE, "msg_opt")
    expect(parts.some((p) => p.id === "server_part")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Store adapter — reset
// ---------------------------------------------------------------------------

describe("store TranscriptRepository — reset command", () => {
  test("reset without page clears messages, parts, and boundary", () => {
    const { repo } = createRepo()
    const m1 = userMessage("msg_1")

    repo.apply(SCOPE, {
      type: "http-page",
      purpose: "initial",
      page: page([{ info: m1, parts: [textPart("p1", "msg_1")] }], {
        complete: true,
        turnCount: 1,
      }),
    })

    const result = repo.apply(SCOPE, { type: "reset" })

    expect(result.applied).toBe(true)
    expect(result.changed).toBe(true)
    expect(repo.getTranscript(SCOPE).messageOrder).toEqual([])
    expect(repo.getTranscript(SCOPE).boundary).toEqual(UNKNOWN_SESSION_HISTORY_BOUNDARY)
    expect(repo.getPagination(SCOPE).hasPreviousPage).toBe(false)
  })

  test("reset with page rebuilds tail and cursor chain", () => {
    const { repo } = createRepo()
    const old = userMessage("msg_old")
    const fresh = userMessage("msg_fresh")

    repo.apply(SCOPE, {
      type: "http-page",
      purpose: "initial",
      page: page([{ info: old }], { cursor: "msg_old", complete: false, turnCount: 1 }),
    })

    const result = repo.apply(SCOPE, {
      type: "reset",
      page: page([{ info: fresh }], { complete: true, turnCount: 1 }),
    })

    expect(result.applied).toBe(true)
    expect(repo.getTranscript(SCOPE).messageOrder).toEqual(["msg_fresh"])
    expect(repo.getPagination(SCOPE).isComplete).toBe(true)
    expect(repo.getMessage(SCOPE, "msg_old")).toBeUndefined()
  })

  test("reset clears only transcript fields and preserves non-transcript session state", () => {
    const status = { type: "busy" as const }
    const todos = [{ id: "t1", content: "keep", status: "pending" }]
    const permissions = [{ id: "perm_1" }]
    const questions = [{ id: "q_1" }]
    const diffs = [{ file: "a.ts", status: "modified" }]
    const otherMessage = userMessage("msg_other", "ses_other")
    // Parts for another session must carry that session's ID so orphan-part
    // cleanup by sessionID cannot confuse ownership.
    const otherPart = {
      ...textPart("part_other", "msg_other"),
      sessionID: "ses_other",
    } as Part

    const store = createHarnessStore({
      message: {
        [SESSION]: [userMessage("msg_1")],
        ses_other: [otherMessage],
      },
      part: {
        msg_1: [textPart("p1", "msg_1")],
        msg_other: [otherPart],
      },
      session_history_boundary: {
        [SESSION]: { kind: "exhausted", loadedTurns: 1 },
        ses_other: { kind: "has-more", cursor: "msg_other", loadedTurns: 2 },
      },
      session_status: { [SESSION]: status },
      session_status_observed_at: { [SESSION]: 42 },
      session_diff: { [SESSION]: diffs },
      todo: { [SESSION]: todos },
      permission: { [SESSION]: permissions },
      question: { [SESSION]: questions },
    })
    const { repo } = createRepo({ store })

    type HarnessSnapshot = ReturnType<typeof store.getState> & {
      session_status?: Record<string, unknown>
      session_status_observed_at?: Record<string, number>
      session_diff?: Record<string, unknown>
      todo?: Record<string, unknown>
      permission?: Record<string, unknown>
      question?: Record<string, unknown>
    }
    const before = store.getState() as HarnessSnapshot
    const result = repo.apply(SCOPE, { type: "reset" })

    expect(result.applied).toBe(true)
    expect(result.changed).toBe(true)

    const after = store.getState() as HarnessSnapshot
    // Transcript fields for the target session are cleared.
    expect(after.message?.[SESSION]).toBeUndefined()
    expect(after.part?.msg_1).toBeUndefined()
    expect(after.session_history_boundary?.[SESSION]).toBeUndefined()
    expect(repo.getTranscript(SCOPE).messageOrder).toEqual([])
    expect(repo.getTranscript(SCOPE).boundary).toEqual(UNKNOWN_SESSION_HISTORY_BOUNDARY)

    // Other sessions' transcript data is untouched (same references).
    expect(after.message?.ses_other).toBe(before.message?.ses_other)
    expect(after.part?.msg_other).toBe(before.part?.msg_other)
    expect(after.session_history_boundary?.ses_other).toBe(
      before.session_history_boundary?.ses_other,
    )

    // Non-transcript maps on the harness host stay untouched (same references).
    expect(after.session_status).toBe(before.session_status)
    expect(after.session_status_observed_at).toBe(before.session_status_observed_at)
    expect(after.session_diff).toBe(before.session_diff)
    expect(after.todo).toBe(before.todo)
    expect(after.permission).toBe(before.permission)
    expect(after.question).toBe(before.question)
    expect(after.session_status?.[SESSION]).toEqual(status)
    expect(after.todo?.[SESSION]).toEqual(todos)
    expect(after.permission?.[SESSION]).toEqual(permissions)
    expect(after.question?.[SESSION]).toEqual(questions)
    expect(after.session_diff?.[SESSION]).toEqual(diffs)
  })
})

// ---------------------------------------------------------------------------
// Store adapter — subscription
// ---------------------------------------------------------------------------

describe("store TranscriptRepository — subscribe", () => {
  test("notifies on transcript change and unsubscribes cleanly", () => {
    const { repo } = createRepo()
    let notifications = 0
    const unsub = repo.subscribe(SCOPE, () => {
      notifications += 1
    })

    repo.apply(SCOPE, {
      type: "http-page",
      purpose: "initial",
      page: page([{ info: userMessage("msg_1") }], { complete: true, turnCount: 1 }),
    })
    expect(notifications).toBe(1)

    unsub()
    repo.apply(SCOPE, {
      type: "optimistic-add",
      message: userMessage("msg_2"),
      parts: [],
    })
    expect(notifications).toBe(1)
  })

  test("does not notify for unrelated session scope", () => {
    const { repo } = createRepo()
    let notifications = 0
    repo.subscribe(SCOPE, () => {
      notifications += 1
    })

    repo.apply(
      { directory: DIRECTORY, sessionID: "ses_other" },
      {
        type: "http-page",
        purpose: "initial",
        page: page([{ info: userMessage("msg_x", "ses_other") }], {
          complete: true,
          turnCount: 1,
        }),
      },
    )
    expect(notifications).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Contract surface completeness
// ---------------------------------------------------------------------------

describe("TranscriptRepository contract surface", () => {
  test("repository exposes all required read and command entrypoints", () => {
    const { repo } = createRepo()
    expect(typeof repo.getTranscript).toBe("function")
    expect(typeof repo.getPagination).toBe("function")
    expect(typeof repo.getMessage).toBe("function")
    expect(typeof repo.getParts).toBe("function")
    expect(typeof repo.apply).toBe("function")
    expect(typeof repo.subscribe).toBe("function")
    expect(typeof repo.getRequestState).toBe("function")
  })

  test("all command discriminators are accepted", () => {
    const { repo } = createRepo()
    const commands = [
      {
        type: "http-page" as const,
        purpose: "initial" as const,
        page: page([], { complete: true, turnCount: 0 }),
      },
      {
        type: "sse-event" as const,
        event: { type: "message.updated", properties: { info: userMessage("m") } } as Event,
      },
      {
        type: "optimistic-add" as const,
        message: userMessage("o"),
        parts: [],
      },
      { type: "optimistic-confirm" as const, messageID: "o" },
      { type: "optimistic-remove" as const, messageID: "o" },
      { type: "reset" as const },
      {
        type: "materialize-snapshots" as const,
        records: [{ info: userMessage("snap"), parts: [] }],
      },
      { type: "remove-message" as const, messageID: "snap" },
    ]

    for (const command of commands) {
      const result = repo.apply(SCOPE, command)
      expect(typeof result.applied).toBe("boolean")
      expect(typeof result.changed).toBe("boolean")
    }
  })
})

describe("store TranscriptRepository — materialize / remove-message", () => {
  test("materialize-snapshots upserts records without touching boundary", () => {
    const { repo } = createRepo()
    const m1 = userMessage("msg_1")
    repo.apply(SCOPE, {
      type: "http-page",
      purpose: "initial",
      page: page([{ info: m1 }], { complete: true, turnCount: 1 }),
    })
    const boundaryBefore = repo.getPagination(SCOPE).boundary

    const m1Updated = { ...m1, time: { created: 99 } } as Message
    const m2 = assistantMessage("msg_2", SESSION, "msg_1")
    const result = repo.apply(SCOPE, {
      type: "materialize-snapshots",
      records: [
        { info: m1Updated, parts: [textPart("p1", "msg_1")] },
        { info: m2, parts: [textPart("p2", "msg_2")] },
      ],
    })

    expect(result.applied).toBe(true)
    expect(result.changed).toBe(true)
    expect(repo.getTranscript(SCOPE).messageOrder).toEqual(["msg_1", "msg_2"])
    expect(repo.getPagination(SCOPE).boundary).toEqual(boundaryBefore)
  })

  test("remove-message deletes one message and its parts", () => {
    const { repo } = createRepo()
    const m1 = userMessage("msg_1")
    const m2 = userMessage("msg_2")
    repo.apply(SCOPE, {
      type: "http-page",
      purpose: "initial",
      page: page(
        [
          { info: m1, parts: [textPart("p1", "msg_1")] },
          { info: m2, parts: [textPart("p2", "msg_2")] },
        ],
        { complete: true, turnCount: 2 },
      ),
    })

    const result = repo.apply(SCOPE, { type: "remove-message", messageID: "msg_1" })
    expect(result.changed).toBe(true)
    expect(repo.getTranscript(SCOPE).messageOrder).toEqual(["msg_2"])
    expect(repo.getParts(SCOPE, "msg_1")).toEqual([])
    expect(repo.getParts(SCOPE, "msg_2")[0]?.id).toBe("p2")
  })

  test("http-page applies a transport page as the sole write path", () => {
    const { repo } = createRepo()
    const m1 = userMessage("msg_1")
    repo.apply(SCOPE, { type: "reset" })
    const result = repo.apply(SCOPE, {
      type: "http-page",
      purpose: "initial",
      page: {
        records: [{ info: m1, parts: [] }],
        cursor: "msg_1",
        complete: false,
        turnCount: 1,
        requestedTurnLimit: 6,
      },
    })
    expect(result.applied).toBe(true)
    expect(repo.getTranscript(SCOPE).messageOrder).toEqual(["msg_1"])
    expect(repo.getPagination(SCOPE).cursor).toBe("msg_1")
  })
})
