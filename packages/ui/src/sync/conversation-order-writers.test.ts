/**
 * Writer-path constraint: message id is identity. Array / `messageOrder`
 * position is conversation order (oldest → newest).
 *
 * These public seams must locate and insert by identity, not by id rank.
 * The fixture is an earlier high-id row followed by later low-id turns —
 * id-sort and conversation order disagree.
 */
import { describe, expect, test } from "bun:test"
import type { Event, Message, Part } from "@opencode-ai/sdk/v2/client"

import { applyTranscriptDirectoryEvent, type TranscriptEventDraft } from "./transcript-event-reducer"
import { materializeSessionSnapshots } from "./materialization"
import { mergeOptimisticPage } from "./optimistic"
import { mergeSessionTranscript, projectFlatFromTranscriptData } from "./transcript-merge"
import { resolveSessionMergeStrategy } from "./session-merge-strategy"
import {
  createStoreTranscriptRepository,
  type TranscriptStoreSurface,
} from "./transcript-repository-store-adapter"
import type { TranscriptScope, TranscriptTransportPage } from "./transcript-repository"
import type { SessionHistoryBoundary } from "./types"

const SESSION = "ses_1"
const DIRECTORY = "/workspace"
const SCOPE: TranscriptScope = { directory: DIRECTORY, sessionID: SESSION }
const MATERIALIZE_MERGE = resolveSessionMergeStrategy({ purpose: "materialize" })

const user = (id: string): Message =>
  ({ id, sessionID: SESSION, role: "user", time: { created: 1 } }) as Message

const assistant = (id: string): Message =>
  ({ id, sessionID: SESSION, role: "assistant", time: { created: 1 } }) as Message

const textPart = (id: string, messageID: string): Part =>
  ({ id, messageID, sessionID: SESSION, type: "text", text: id }) as Part

/** Older high-id user, then later low-id turns. */
const LIVE_ORDER = ["msg_9", "msg_1", "msg_2", "msg_3"] as const

const liveConversation = (): Message[] => [
  user("msg_9"),
  assistant("msg_1"),
  user("msg_2"),
  assistant("msg_3"),
]

function transcriptDraft(messages: Message[]): TranscriptEventDraft {
  return { message: { [SESSION]: messages }, part: {} }
}

function messageUpdated(info: Message): Event {
  return { type: "message.updated", properties: { info } } as Event
}

function messageRemoved(messageID: string): Event {
  return {
    type: "message.removed",
    properties: { sessionID: SESSION, messageID },
  } as Event
}

function transportPage(messages: Message[]): TranscriptTransportPage {
  return {
    records: messages.map((info) => ({ info, parts: [] })),
    complete: true,
    turnCount: 2,
  }
}

function createHarnessStore(messages: Message[] = []): TranscriptStoreSurface {
  let state: {
    message: Record<string, Message[]>
    part: Record<string, Part[]>
    session_history_boundary: Record<string, SessionHistoryBoundary>
  } = {
    message: messages.length > 0 ? { [SESSION]: messages } : {},
    part: {},
    session_history_boundary: {},
  }
  return {
    getState: () => state,
    setState: (partial) => {
      const next = typeof partial === "function" ? partial(state) : partial
      state = { ...state, ...next }
    },
    subscribe: () => () => {},
  }
}

describe("conversation-order writers", () => {
  test("SSE message.updated settles a tail assistant in place", () => {
    const open = assistant("msg_2")
    const draft = transcriptDraft([
      user("msg_1"),
      assistant("msg_3"),
      user("msg_9"),
      open,
    ])
    const settled = {
      ...open,
      finish: "stop",
      time: { created: 1, completed: 9 },
    } as Message

    expect(applyTranscriptDirectoryEvent(draft, messageUpdated(settled))).toBe(true)
    expect(draft.message[SESSION]?.map((message) => message.id)).toEqual([
      "msg_1",
      "msg_3",
      "msg_9",
      "msg_2",
    ])
    expect((draft.message[SESSION]?.[3] as { finish?: string }).finish).toBe("stop")
  })

  test("SSE message.updated appends a new user turn at the tail", () => {
    const draft = transcriptDraft([user("msg_9"), assistant("msg_1")])

    expect(applyTranscriptDirectoryEvent(draft, messageUpdated(user("msg_15")))).toBe(true)
    expect(draft.message[SESSION]?.map((message) => message.id)).toEqual([
      "msg_9",
      "msg_1",
      "msg_15",
    ])
  })

  test("SSE message.removed deletes by identity and keeps conversation order", () => {
    const draft = transcriptDraft(liveConversation())

    expect(applyTranscriptDirectoryEvent(draft, messageRemoved("msg_2"))).toBe(true)
    expect(draft.message[SESSION]?.map((message) => message.id)).toEqual([
      "msg_9",
      "msg_1",
      "msg_3",
    ])
  })

  test("optimistic merge confirms a tail row without duplicating it", () => {
    const optimistic = user("msg_15")
    const merged = mergeOptimisticPage(
      {
        session: [...liveConversation(), optimistic],
        part: [
          { id: "msg_9", part: [] },
          { id: "msg_1", part: [] },
          { id: "msg_2", part: [] },
          { id: "msg_3", part: [] },
          { id: "msg_15", part: [textPart("p_15", "msg_15")] },
        ],
        complete: true,
      },
      [{ message: optimistic, parts: [textPart("p_opt", "msg_15")] }],
    )

    expect(merged.session.map((message) => message.id)).toEqual([...LIVE_ORDER, "msg_15"])
    expect(merged.confirmed).toEqual(["msg_15"])
  })

  test("optimistic merge appends a missing row at the tail", () => {
    const merged = mergeOptimisticPage(
      {
        session: liveConversation(),
        part: LIVE_ORDER.map((id) => ({ id, part: [] })),
        complete: true,
      },
      [{ message: user("msg_15"), parts: [textPart("p_15", "msg_15")] }],
    )

    expect(merged.session.map((message) => message.id)).toEqual([...LIVE_ORDER, "msg_15"])
  })

  test("insert-only materialize appends without rewriting conversation order", () => {
    const live = liveConversation()
    const result = materializeSessionSnapshots(
      { message: { [SESSION]: live }, part: {} },
      SESSION,
      [{ info: user("msg_4"), parts: [] }],
      { merge: MATERIALIZE_MERGE },
    )

    expect(result.message[SESSION].map((message) => message.id)).toEqual([
      ...LIVE_ORDER,
      "msg_4",
    ])
    expect(result.message[SESSION][0]).toBe(live[0])
  })

  test("Query optimistic-add keeps a queued row at the conversation tail", () => {
    const live = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: transportPage(liveConversation()),
    }).data!

    const added = mergeSessionTranscript(live, SESSION, {
      type: "optimistic-add",
      message: user("msg_15"),
      parts: [textPart("p_15", "msg_15")],
    })

    expect(projectFlatFromTranscriptData(added.data, SESSION).messageOrder).toEqual([
      ...LIVE_ORDER,
      "msg_15",
    ])
  })

  test("Query SSE message.updated settles the live last assistant", () => {
    const open = assistant("msg_2")
    const live = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([user("msg_1"), assistant("msg_3"), user("msg_9"), open]),
    }).data!

    const settled = mergeSessionTranscript(live, SESSION, {
      type: "sse-event",
      event: messageUpdated({
        ...open,
        finish: "stop",
        time: { created: 1, completed: 9 },
      } as Message),
    })

    expect(projectFlatFromTranscriptData(settled.data, SESSION).messageOrder).toEqual([
      "msg_1",
      "msg_3",
      "msg_9",
      "msg_2",
    ])
    expect(
      (projectFlatFromTranscriptData(settled.data, SESSION).messagesByID.msg_2 as { finish?: string })
        .finish,
    ).toBe("stop")
  })

  test("store adapter optimistic-add appends after a non-monotonic live tail", () => {
    const store = createHarnessStore(liveConversation())
    const repo = createStoreTranscriptRepository({ getStore: () => store })

    repo.apply(SCOPE, {
      type: "optimistic-add",
      message: user("msg_15"),
      parts: [textPart("p_15", "msg_15")],
    })

    expect(repo.getTranscript(SCOPE).messageOrder).toEqual([...LIVE_ORDER, "msg_15"])
  })

  test("store adapter SSE remove keeps earlier high-id rows", () => {
    const store = createHarnessStore(liveConversation())
    const repo = createStoreTranscriptRepository({ getStore: () => store })

    repo.apply(SCOPE, {
      type: "sse-event",
      event: messageRemoved("msg_2"),
    })

    expect(repo.getTranscript(SCOPE).messageOrder).toEqual(["msg_9", "msg_1", "msg_3"])
  })
})
