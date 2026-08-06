/**
 * Transcript recovery checkpoint selection + QueryCache helpers (Ticket 07).
 *
 * Checkpoint is fixed on disconnect / recovery-context capture, before any
 * replay merge. Anchor is the newest server-confirmed authored-user turn
 * boundary in the canonical transcript (role/clientRole + synthetic/subtask/
 * compaction rules). Arbitrary assistant heads are never anchors.
 */

import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/react-query"

import { isSyntheticPart } from "@/lib/messages/synthetic"
import { ASSISTANT_SESSION_DIVIDER_PREFIX } from "@/components/chat/hostedSessionHistory"

import {
  sessionTranscriptCheckpointQueryKey,
  type SessionTranscriptCheckpointQueryKey,
  type TranscriptCacheScope,
} from "./session-transcript-query-cache"
import type { TranscriptData } from "./transcript-repository"

// ---------------------------------------------------------------------------
// Authored-user turn boundary (client mirror of Host isUserAuthoredTurnBoundary)
// ---------------------------------------------------------------------------

const hasPartType = (parts: readonly Part[] | undefined, type: string): boolean =>
  Array.isArray(parts)
  && parts.some((part) => part && typeof part === "object" && (part as { type?: unknown }).type === type)

const isHostedSessionDivider = (messageID: string): boolean =>
  messageID.startsWith(ASSISTANT_SESSION_DIVIDER_PREFIX)

/**
 * Whether a message is a stable authored-user turn boundary suitable as a
 * reconcile anchor. Mirrors Host `isUserAuthoredTurnBoundary`:
 * - role/clientRole must be user
 * - excludes fully synthetic, subtask, compaction, hosted session dividers
 * - empty parts on a user message still count
 */
export function isUserAuthoredTurnBoundaryMessage(
  message: Message | undefined,
  parts: readonly Part[] | undefined,
): boolean {
  if (!message?.id) return false
  if (isHostedSessionDivider(message.id)) return false

  const info = message as Message & { clientRole?: unknown; role?: unknown }
  const role = typeof info.clientRole === "string" ? info.clientRole : info.role
  if (role !== "user") return false

  if (!Array.isArray(parts) || parts.length === 0) return true
  if (hasPartType(parts, "subtask")) return false
  if (hasPartType(parts, "compaction")) return false
  if (parts.every((part) => isSyntheticPart(part))) return false
  return true
}

/**
 * Select the newest server-confirmed authored-user turn boundary from a
 * chronological messageOrder (oldest → newest). Returns null when none.
 */
export function selectStableTranscriptAnchorMessageID(
  transcript: Pick<TranscriptData, "messageOrder" | "messagesByID" | "partsByMessageID">,
): string | null {
  for (let index = transcript.messageOrder.length - 1; index >= 0; index -= 1) {
    const id = transcript.messageOrder[index]!
    const message = transcript.messagesByID[id]
    const parts = transcript.partsByMessageID[id]
    if (isUserAuthoredTurnBoundaryMessage(message, parts)) {
      return id
    }
  }
  return null
}

/** Newest message id in the transcript (any role) — continuation/round head tip. */
function selectTranscriptHeadMessageID(
  transcript: Pick<TranscriptData, "messageOrder">,
): string | null {
  if (transcript.messageOrder.length === 0) return null
  return transcript.messageOrder[transcript.messageOrder.length - 1] ?? null
}

// ---------------------------------------------------------------------------
// Checkpoint model
// ---------------------------------------------------------------------------

export type TranscriptRecoveryCheckpointState =
  | "pending"
  | "reconciling"
  | "complete"
  | "reset-required"

/**
 * Disconnect-time recovery snapshot written to QueryCache before replay merge.
 * Fixed for the gap cycle; multi-round chase may update continuation fields
 * only after a completed reconcile round.
 */
export type TranscriptRecoveryCheckpoint = {
  readonly transport: string
  readonly generation: number
  readonly directory: string
  readonly sessionID: string
  /** Newest stable authored-user turn boundary at capture; null → tail ensure path. */
  readonly anchorMessageID: string | null
  readonly lastEventID: string | null
  readonly capturedAt: number
  readonly state: TranscriptRecoveryCheckpointState
  /**
   * Fixed captured head for the active reconcile round (Host capturedHead).
   * Set when the first page of a round returns; used as next-round anchor when
   * latestHead advances.
   */
  readonly capturedHeadMessageID: string | null
  /** Last observed latest head from Host (for multi-round chase). */
  readonly latestHeadMessageID: string | null
  /** Opaque Host continuation for serial page scans within one round. */
  readonly continuation: string | null
  /** Live revision at capture (for recovery merge stale detection). */
  readonly liveRevision: number
}

export function createTranscriptRecoveryCheckpoint(input: {
  transport: string
  generation: number
  directory: string
  sessionID: string
  transcript: TranscriptData
  lastEventID: string | null
  capturedAt?: number
}): TranscriptRecoveryCheckpoint {
  return {
    transport: input.transport,
    generation: input.generation,
    directory: input.directory.trim(),
    sessionID: input.sessionID,
    anchorMessageID: selectStableTranscriptAnchorMessageID(input.transcript),
    lastEventID: input.lastEventID,
    capturedAt: input.capturedAt ?? Date.now(),
    state: "pending",
    capturedHeadMessageID: null,
    latestHeadMessageID: selectTranscriptHeadMessageID(input.transcript),
    continuation: null,
    liveRevision: input.transcript.liveRevision,
  }
}

export function withTranscriptRecoveryCheckpointState(
  checkpoint: TranscriptRecoveryCheckpoint,
  patch: Partial<
    Pick<
      TranscriptRecoveryCheckpoint,
      | "state"
      | "capturedHeadMessageID"
      | "latestHeadMessageID"
      | "continuation"
      | "anchorMessageID"
    >
  >,
): TranscriptRecoveryCheckpoint {
  return {
    ...checkpoint,
    ...patch,
  }
}

// ---------------------------------------------------------------------------
// QueryCache read/write
// ---------------------------------------------------------------------------

export function readTranscriptRecoveryCheckpoint(
  client: Pick<QueryClient, "getQueryData">,
  scope: TranscriptCacheScope,
): TranscriptRecoveryCheckpoint | undefined {
  const key = sessionTranscriptCheckpointQueryKey(
    { directory: scope.directory, sessionID: scope.sessionID },
    scope.transport,
    scope.generation,
  )
  const data = client.getQueryData(key)
  if (!data || typeof data !== "object") return undefined
  const value = data as TranscriptRecoveryCheckpoint
  if (
    value.sessionID !== scope.sessionID
    || value.transport !== scope.transport
    || value.generation !== scope.generation
  ) {
    return undefined
  }
  return value
}

export function writeTranscriptRecoveryCheckpoint(
  client: Pick<QueryClient, "setQueryData">,
  checkpoint: TranscriptRecoveryCheckpoint,
): SessionTranscriptCheckpointQueryKey {
  const key = sessionTranscriptCheckpointQueryKey(
    { directory: checkpoint.directory, sessionID: checkpoint.sessionID },
    checkpoint.transport,
    checkpoint.generation,
  )
  client.setQueryData(key, checkpoint)
  return key
}

export function clearTranscriptRecoveryCheckpoint(
  client: Pick<QueryClient, "removeQueries">,
  scope: TranscriptCacheScope,
): void {
  const key = sessionTranscriptCheckpointQueryKey(
    { directory: scope.directory, sessionID: scope.sessionID },
    scope.transport,
    scope.generation,
  )
  client.removeQueries({ queryKey: key, exact: true })
}
