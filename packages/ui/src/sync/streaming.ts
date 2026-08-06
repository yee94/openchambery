/**
 * Streaming lifecycle tracking.
 *
 * Derives streaming state from directory session_status + TranscriptRepository
 * trailing assistant (Ticket 09 batch 2 — no production State.message).
 */

import { create } from "zustand"
import type { Message, SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { State } from "./types"
import {
  getTranscriptRepository,
  transcriptScope,
} from "./transcript-repository-runtime"
import { messagesFromTranscriptData } from "./transcript-repository-observers"
import type { StoreApi } from "zustand"
import type { DirectoryStore } from "./child-store"

type StreamPhase = "streaming" | "cooldown" | "completed"

type MessageStreamState = {
  phase: StreamPhase
  startedAt: number
  lastUpdateAt: number
  completedAt?: number
}

export type StreamingStore = {
  /** Currently streaming message per session */
  streamingMessageIds: Map<string, string | null>
  /** Lifecycle phase per message */
  messageStreamStates: Map<string, MessageStreamState>
}

export const useStreamingStore = create<StreamingStore>()(() => ({
  streamingMessageIds: new Map(),
  messageStreamStates: new Map(),
}))

export function resetStreamingState() {
  useStreamingStore.setState({
    streamingMessageIds: new Map(),
    messageStreamStates: new Map(),
  })
}

/** Only update lastUpdateAt every this many ms to avoid 60Hz store churn */
const STREAMING_HEARTBEAT_MS = 1000

export type StreamingStatusState = Pick<State, "session_status">

/**
 * Derive streaming from status + repository transcript tail for one directory.
 */
export function updateStreamingState(
  state: StreamingStatusState,
  options?: {
    directory?: string
    store?: StoreApi<DirectoryStore>
  },
) {
  const now = Date.now()
  const currentStore = useStreamingStore.getState()
  const currentStreamingIds = currentStore.streamingMessageIds
  const currentStreamStates = currentStore.messageStreamStates

  const nextStreamingIds = new Map<string, string | null>()
  const nextStreamStates = new Map(currentStreamStates)
  let changed = false

  const busySessionIds = new Set<string>()
  for (const [sessionID, status] of Object.entries(state.session_status ?? {})) {
    if ((status as SessionStatus).type === "busy") {
      busySessionIds.add(sessionID)
    }
  }

  const completeStreamingMessage = (sessionID: string, msgId: string) => {
    nextStreamingIds.set(sessionID, null)
    const existing = nextStreamStates.get(msgId)
    if (existing && existing.phase === "streaming") {
      nextStreamStates.set(msgId, {
        ...existing,
        phase: "completed",
        completedAt: now,
      })
    }
    changed = true
  }

  const directory = options?.directory ?? ""
  // Ticket 09 batch 2: production streaming reads only the bound Query repository.
  // No resolveTranscriptRepositoryForStore fallback (avoids store-backed production reads).
  const repository = getTranscriptRepository()
  void options?.store

  for (const sessionID of busySessionIds) {
    let messages: Message[] = []
    if (repository && directory) {
      messages = messagesFromTranscriptData(
        repository.getTranscript(transcriptScope(directory, sessionID)),
      )
    }
    if (messages.length === 0) continue

    // Only the trailing assistant turn can be streaming. If a new user turn is
    // last, the next assistant message has not arrived yet.
    let streamingMsg: Message | null = null
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        break
      }
      if (messages[i].role === "assistant") {
        streamingMsg = messages[i]
        break
      }
    }

    if (!streamingMsg) {
      const prevId = currentStreamingIds.get(sessionID)
      if (prevId) {
        completeStreamingMessage(sessionID, prevId)
      }
      continue
    }

    const prevId = currentStreamingIds.get(sessionID)
    if (prevId !== streamingMsg.id) changed = true
    nextStreamingIds.set(sessionID, streamingMsg.id)

    const existing = nextStreamStates.get(streamingMsg.id)
    if (!existing || existing.phase !== "streaming") {
      nextStreamStates.set(streamingMsg.id, {
        phase: "streaming",
        startedAt: existing?.startedAt ?? now,
        lastUpdateAt: now,
      })
      changed = true
    } else if (now - existing.lastUpdateAt >= STREAMING_HEARTBEAT_MS) {
      nextStreamStates.set(streamingMsg.id, {
        ...existing,
        lastUpdateAt: now,
      })
      changed = true
    }
  }

  for (const [sessionID, msgId] of currentStreamingIds) {
    if (!msgId) continue
    const isStillBusy = busySessionIds.has(sessionID)
    if (isStillBusy) continue

    completeStreamingMessage(sessionID, msgId)
  }

  if (changed) {
    useStreamingStore.setState({
      streamingMessageIds: nextStreamingIds,
      messageStreamStates: nextStreamStates,
    })
  }
}
