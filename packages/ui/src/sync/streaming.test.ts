import { beforeEach, describe, expect, test } from "bun:test"
import type { Message, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { INITIAL_STATE } from "./types"
import { updateStreamingState, useStreamingStore } from "./streaming"
import { createStoreTranscriptRepository } from "./transcript-repository-store-adapter"
import {
  bindTranscriptRepositoryInstance,
  unbindTranscriptRepository,
} from "./transcript-repository-runtime"
import type { SessionHistoryBoundary } from "./types"

const DIRECTORY = "/workspace"
const SESSION = "ses_1"

const message = (id: string, role: "user" | "assistant"): Message => ({
  id,
  role,
  sessionID: SESSION,
} as unknown as Message)

type HarnessState = {
  message: Record<string, Message[]>
  part: Record<string, never>
  session_history_boundary: Record<string, SessionHistoryBoundary>
}

function createHarness(messages: Message[]) {
  let state: HarnessState = {
    message: { [SESSION]: messages },
    part: {},
    session_history_boundary: {},
  }
  const listeners = new Set<() => void>()
  const store = {
    getState: () => state,
    setState: (partial: Partial<HarnessState> | ((s: HarnessState) => Partial<HarnessState>)) => {
      const next = typeof partial === "function" ? partial(state) : partial
      state = { ...state, ...next }
      for (const listener of listeners) listener()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const repo = createStoreTranscriptRepository({
    getStore: () => store as never,
  })
  bindTranscriptRepositoryInstance(repo)
  return {
    setMessages: (next: Message[]) => {
      store.setState({ message: { [SESSION]: next } })
    },
    statusState: (status: SessionStatus = { type: "busy" } as SessionStatus) => ({
      ...INITIAL_STATE,
      session_status: { [SESSION]: status },
    }),
  }
}

describe("updateStreamingState", () => {
  beforeEach(() => {
    unbindTranscriptRepository()
    useStreamingStore.setState({
      streamingMessageIds: new Map(),
      messageStreamStates: new Map(),
    })
  })

  test("does not mark a previous assistant message as streaming during a new user turn", () => {
    const harness = createHarness([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ])
    updateStreamingState(harness.statusState(), { directory: DIRECTORY })
    expect(useStreamingStore.getState().streamingMessageIds.get(SESSION)).toBe("msg_assistant_1")

    harness.setMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
      message("msg_user_2", "user"),
    ])
    updateStreamingState(harness.statusState(), { directory: DIRECTORY })

    expect(useStreamingStore.getState().streamingMessageIds.get(SESSION)).toBeNull()
    expect(useStreamingStore.getState().messageStreamStates.get("msg_assistant_1")?.phase).toBe("completed")
  })

  test("tracks the trailing assistant message once it appears", () => {
    const harness = createHarness([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ])
    updateStreamingState(harness.statusState(), { directory: DIRECTORY })
    harness.setMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
      message("msg_user_2", "user"),
    ])
    updateStreamingState(harness.statusState(), { directory: DIRECTORY })
    expect(useStreamingStore.getState().streamingMessageIds.get(SESSION)).toBeNull()

    harness.setMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
      message("msg_user_2", "user"),
      message("msg_assistant_2", "assistant"),
    ])
    updateStreamingState(harness.statusState(), { directory: DIRECTORY })

    expect(useStreamingStore.getState().streamingMessageIds.get(SESSION)).toBe("msg_assistant_2")
  })

  test("completes the streaming message when the session becomes idle", () => {
    const harness = createHarness([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ])
    updateStreamingState(harness.statusState(), { directory: DIRECTORY })
    expect(useStreamingStore.getState().streamingMessageIds.get(SESSION)).toBe("msg_assistant_1")

    updateStreamingState(harness.statusState({ type: "idle" } as SessionStatus), { directory: DIRECTORY })

    expect(useStreamingStore.getState().streamingMessageIds.get(SESSION)).toBeNull()
    expect(useStreamingStore.getState().messageStreamStates.get("msg_assistant_1")?.phase).toBe("completed")
  })
})
