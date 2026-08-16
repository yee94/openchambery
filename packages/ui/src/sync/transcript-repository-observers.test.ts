import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"

import { createStoreTranscriptRepository, type TranscriptStoreSurface } from "./transcript-repository-store-adapter"
import {
  bindTranscriptRepositoryInstance,
  unbindTranscriptRepository,
} from "./transcript-repository-runtime"
import {
  isTranscriptMessagesResolved,
  materializationStatusFromTranscriptData,
  messagesFromTranscriptData,
  readTranscriptCompletionSignature,
  readTranscriptMessages,
  readTranscriptPagination,
  readTranscriptParts,
  subscribeTranscriptScopes,
} from "./transcript-repository-observers"
import type { TranscriptData } from "./transcript-repository"
import type { SessionHistoryBoundary } from "./types"
import { UNKNOWN_SESSION_HISTORY_BOUNDARY } from "./types"

const DIRECTORY = "/workspace"
const SESSION = "ses_1"

function userMessage(id: string): Message {
  return { id, sessionID: SESSION, role: "user", time: { created: 1 } } as Message
}

function textPart(id: string, messageID: string): Part {
  return { id, messageID, sessionID: SESSION, type: "text", text: id } as Part
}

type HarnessState = {
  message: Record<string, Message[]>
  part: Record<string, Part[]>
  session_history_boundary: Record<string, SessionHistoryBoundary>
}

function createHarnessStore(initial?: Partial<HarnessState>): TranscriptStoreSurface {
  let state: HarnessState = {
    message: {},
    part: {},
    session_history_boundary: {},
    ...initial,
  }
  const listeners = new Set<(state: HarnessState, prev: HarnessState) => void>()
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
          state as HarnessState,
          prev as HarnessState,
        )
      }
    },
    subscribe: (listener) => {
      const wrapped = (next: HarnessState, prev: HarnessState) => {
        listener(
          next as ReturnType<TranscriptStoreSurface["getState"]>,
          prev as ReturnType<TranscriptStoreSurface["getState"]>,
        )
      }
      listeners.add(wrapped)
      return () => {
        listeners.delete(wrapped)
      }
    },
  }
}

describe("messagesFromTranscriptData reference stability", () => {
  test("returns previous when messageOrder and message object refs are unchanged", () => {
    const msg1 = userMessage("msg_1")
    const msg2 = userMessage("msg_2")
    const data: TranscriptData = {
      sessionID: SESSION,
      messageOrder: ["msg_1", "msg_2"],
      messagesByID: { msg_1: msg1, msg_2: msg2 },
      partsByMessageID: {},
      boundary: UNKNOWN_SESSION_HISTORY_BOUNDARY,
      liveRevision: 0,
    }
    const first = messagesFromTranscriptData(data)
    expect(first.map((m) => m.id)).toEqual(["msg_1", "msg_2"])
    const second = messagesFromTranscriptData(data, first)
    expect(second).toBe(first)
  })

  test("returns a new array when a message object ref changes", () => {
    const msg1 = userMessage("msg_1")
    const msg2 = userMessage("msg_2")
    const data: TranscriptData = {
      sessionID: SESSION,
      messageOrder: ["msg_1", "msg_2"],
      messagesByID: { msg_1: msg1, msg_2: msg2 },
      partsByMessageID: {},
      boundary: UNKNOWN_SESSION_HISTORY_BOUNDARY,
      liveRevision: 0,
    }
    const previous = messagesFromTranscriptData(data)
    const updatedMsg2 = userMessage("msg_2")
    const nextData: TranscriptData = {
      ...data,
      messagesByID: { msg_1: msg1, msg_2: updatedMsg2 },
      liveRevision: 1,
    }
    const next = messagesFromTranscriptData(nextData, previous)
    expect(next).not.toBe(previous)
    expect(next.map((m) => m.id)).toEqual(["msg_1", "msg_2"])
    expect(next[1]).toBe(updatedMsg2)
  })

  test("returns a new array when messageOrder changes", () => {
    const msg1 = userMessage("msg_1")
    const msg2 = userMessage("msg_2")
    const data: TranscriptData = {
      sessionID: SESSION,
      messageOrder: ["msg_1"],
      messagesByID: { msg_1: msg1 },
      partsByMessageID: {},
      boundary: UNKNOWN_SESSION_HISTORY_BOUNDARY,
      liveRevision: 0,
    }
    const previous = messagesFromTranscriptData(data)
    const nextData: TranscriptData = {
      ...data,
      messageOrder: ["msg_1", "msg_2"],
      messagesByID: { msg_1: msg1, msg_2: msg2 },
      liveRevision: 1,
    }
    const next = messagesFromTranscriptData(nextData, previous)
    expect(next).not.toBe(previous)
    expect(next.map((m) => m.id)).toEqual(["msg_1", "msg_2"])
  })

  test("empty order keeps the stable empty constant", () => {
    const empty: TranscriptData = {
      sessionID: SESSION,
      messageOrder: [],
      messagesByID: {},
      partsByMessageID: {},
      boundary: UNKNOWN_SESSION_HISTORY_BOUNDARY,
      liveRevision: 0,
    }
    const first = messagesFromTranscriptData(empty)
    const second = messagesFromTranscriptData(empty, first)
    expect(first).toBe(second)
    expect(first).toEqual([])
  })
})

describe("materializationStatusFromTranscriptData (Ticket 09 batch 1A)", () => {
  test("unknown empty order is not renderable until resolved", () => {
    const empty: TranscriptData = {
      sessionID: SESSION,
      messageOrder: [],
      messagesByID: {},
      partsByMessageID: {},
      boundary: UNKNOWN_SESSION_HISTORY_BOUNDARY,
      liveRevision: 0,
    }
    expect(materializationStatusFromTranscriptData(empty)).toEqual({
      hasMessages: false,
      renderable: false,
      missingPartMessageIDs: [],
    })
    expect(materializationStatusFromTranscriptData(empty, { resolved: true })).toEqual({
      hasMessages: true,
      renderable: true,
      missingPartMessageIDs: [],
    })
  })

  test("settled assistant without parts is not renderable", () => {
    const settled = {
      id: "msg_1",
      sessionID: SESSION,
      role: "assistant",
      finish: "stop",
      time: { created: 1, completed: 2 },
    } as Message
    const data: TranscriptData = {
      sessionID: SESSION,
      messageOrder: ["msg_1"],
      messagesByID: { msg_1: settled },
      partsByMessageID: {},
      boundary: UNKNOWN_SESSION_HISTORY_BOUNDARY,
      liveRevision: 0,
    }
    expect(materializationStatusFromTranscriptData(data)).toEqual({
      hasMessages: true,
      renderable: false,
      missingPartMessageIDs: ["msg_1"],
    })
    expect(messagesFromTranscriptData(data).map((m) => m.id)).toEqual(["msg_1"])
  })
})

describe("transcript repository readers (Ticket 02)", () => {
  test("readTranscriptMessages returns chronological repository projection", () => {
    const store = createHarnessStore({
      message: {
        [SESSION]: [userMessage("msg_1"), userMessage("msg_2")],
      },
      part: {
        msg_1: [textPart("p1", "msg_1")],
      },
      session_history_boundary: {
        [SESSION]: { kind: "exhausted", loadedTurns: 2 },
      },
    })

    const repo = createStoreTranscriptRepository({ getStore: () => store })
    bindTranscriptRepositoryInstance(repo)
    try {
      const messages = readTranscriptMessages(DIRECTORY, SESSION, store as never)
      expect(messages.map((m) => m.id)).toEqual(["msg_1", "msg_2"])
      expect(readTranscriptParts(DIRECTORY, "msg_1", store as never, SESSION)[0]?.id).toBe("p1")
      expect(isTranscriptMessagesResolved(DIRECTORY, SESSION, store as never)).toBe(true)
      const pagination = readTranscriptPagination(DIRECTORY, SESSION, store as never)
      expect(pagination.isComplete).toBe(true)
      expect(pagination.hasPreviousPage).toBe(false)
      expect(pagination.boundary).toEqual({ kind: "exhausted", loadedTurns: 2 })
    } finally {
      unbindTranscriptRepository()
    }
  })

  test("unresolved session without message key reports false", () => {
    const store = createHarnessStore()
    const repo = createStoreTranscriptRepository({ getStore: () => store })
    bindTranscriptRepositoryInstance(repo)
    try {
      expect(isTranscriptMessagesResolved(DIRECTORY, SESSION, store as never)).toBe(false)
      expect(readTranscriptMessages(DIRECTORY, SESSION, store as never)).toEqual([])
      expect(readTranscriptPagination(DIRECTORY, SESSION, store as never).boundary).toEqual(
        UNKNOWN_SESSION_HISTORY_BOUNDARY,
      )
    } finally {
      unbindTranscriptRepository()
    }
  })

  test("empty loaded session key is resolved (hasSession)", () => {
    const store = createHarnessStore({
      message: { [SESSION]: [] },
      session_history_boundary: {
        [SESSION]: { kind: "exhausted", loadedTurns: 0 },
      },
    })
    const repo = createStoreTranscriptRepository({ getStore: () => store })
    bindTranscriptRepositoryInstance(repo)
    try {
      expect(isTranscriptMessagesResolved(DIRECTORY, SESSION, store as never)).toBe(true)
    } finally {
      unbindTranscriptRepository()
    }
  })

  test("store adapter hasSession tracks message key presence", () => {
    const store = createHarnessStore()
    const repo = createStoreTranscriptRepository({ getStore: () => store })
    expect(repo.hasSession?.({ directory: DIRECTORY, sessionID: SESSION })).toBe(false)
    store.setState({
      message: { [SESSION]: [userMessage("msg_1")] },
    })
    expect(repo.hasSession?.({ directory: DIRECTORY, sessionID: SESSION })).toBe(true)
  })

  test("readTranscriptCompletionSignature fingerprints trailing messages per scope", () => {
    const store = createHarnessStore({
      message: {
        [SESSION]: [userMessage("msg_1"), userMessage("msg_2")],
        ses_other: [userMessage("msg_x")],
      },
      session_history_boundary: {
        [SESSION]: { kind: "exhausted", loadedTurns: 2 },
        ses_other: { kind: "exhausted", loadedTurns: 1 },
      },
    })
    // Patch other session message to have ses_other id
    const other = { ...userMessage("msg_x"), sessionID: "ses_other" } as Message
    store.setState({
      message: {
        [SESSION]: [userMessage("msg_1"), userMessage("msg_2")],
        ses_other: [other],
      },
    })

    const repo = createStoreTranscriptRepository({ getStore: () => store })
    bindTranscriptRepositoryInstance(repo)
    try {
      const scopes = [
        { directory: DIRECTORY, sessionID: SESSION },
        { directory: DIRECTORY, sessionID: "ses_other" },
      ]
      const signature = readTranscriptCompletionSignature(scopes, () => store as never)
      expect(signature).toContain("ses_1:msg_2:user:")
      expect(signature).toContain("ses_other:msg_x:user:")

      let notifications = 0
      const unsub = subscribeTranscriptScopes(scopes, () => {
        notifications += 1
      }, () => store as never)

      store.setState({
        message: {
          ...store.getState().message as Record<string, Message[]>,
          [SESSION]: [userMessage("msg_1"), userMessage("msg_2"), userMessage("msg_3")],
        },
      })
      unsub()
      expect(typeof notifications).toBe("number")
    } finally {
      unbindTranscriptRepository()
    }
  })

  // Subscribe happens from a child passive effect, so the production repository
  // is routinely still unbound at that point. Nothing else re-runs subscribe,
  // so without re-arming the scope never gets a push subscription.
  test("re-attaches scope subscriptions after the production repository binds", () => {
    const store = createHarnessStore({
      message: { [SESSION]: [userMessage("msg_1")] },
      session_history_boundary: { [SESSION]: { kind: "exhausted", loadedTurns: 1 } },
    })
    let notifications = 0
    // No bound repository and no resolvable store: attach finds nothing.
    const unsub = subscribeTranscriptScopes(
      [{ directory: DIRECTORY, sessionID: SESSION }],
      () => {
        notifications += 1
      },
      () => undefined,
    )

    const repo = createStoreTranscriptRepository({ getStore: () => store })
    try {
      bindTranscriptRepositoryInstance(repo)
      const afterBind = notifications
      expect(afterBind).toBeGreaterThan(0)

      store.setState({
        message: { [SESSION]: [userMessage("msg_1"), userMessage("msg_2")] },
      })
      expect(notifications).toBeGreaterThan(afterBind)

      unsub()
      const afterUnsub = notifications
      store.setState({
        message: { [SESSION]: [userMessage("msg_1"), userMessage("msg_2"), userMessage("msg_3")] },
      })
      expect(notifications).toBe(afterUnsub)
    } finally {
      unbindTranscriptRepository()
    }
  })

  test("rebuild signal re-resolves scopes whose directory store appeared later", () => {
    const store = createHarnessStore({
      message: { [SESSION]: [userMessage("msg_1")] },
      session_history_boundary: { [SESSION]: { kind: "exhausted", loadedTurns: 1 } },
    })
    let storeReady = false
    const rebuildListeners = new Set<() => void>()
    let notifications = 0

    const unsub = subscribeTranscriptScopes(
      [{ directory: DIRECTORY, sessionID: SESSION }],
      () => {
        notifications += 1
      },
      () => (storeReady ? store as never : undefined),
      {
        subscribeRebuild: (listener) => {
          rebuildListeners.add(listener)
          return () => {
            rebuildListeners.delete(listener)
          }
        },
      },
    )

    store.setState({ message: { [SESSION]: [userMessage("msg_1"), userMessage("msg_2")] } })
    expect(notifications).toBe(0)

    storeReady = true
    for (const listener of rebuildListeners) listener()
    const afterRebuild = notifications

    store.setState({
      message: { [SESSION]: [userMessage("msg_1"), userMessage("msg_2"), userMessage("msg_3")] },
    })
    expect(notifications).toBeGreaterThan(afterRebuild)

    unsub()
    expect(rebuildListeners.size).toBe(0)
  })
})
