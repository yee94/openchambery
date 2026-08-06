/**
 * Runtime seam for Query reconnect compensation (Ticket 07/09).
 *
 * Production authority is QueryCache: SyncProvider registers a Query
 * compensation controller via `mountProductionTranscriptStack` so event-pipeline
 * onDisconnect / onCompensation recover gaps through Query reconcile only
 * (no dual-write with a second transcript authority).
 *
 * When no controller is registered (tests / dispose), all hooks are no-ops.
 */

import type { EventPipelineCompensationTrigger } from "./event-pipeline"
import type {
  TranscriptReconnectCompensationController,
} from "./session-transcript-reconnect-compensation"
import type { TranscriptData, TranscriptScope } from "./transcript-repository"

let registered: TranscriptReconnectCompensationController | null = null

/**
 * Register the Query reconnect compensation controller.
 * Production mounts this from `mountProductionTranscriptStack`.
 * Passing null clears the registration (tests / dispose).
 */
export function registerTranscriptReconnectCompensationController(
  controller: TranscriptReconnectCompensationController | null,
): void {
  if (registered && registered !== controller) {
    // Cancel in-flight work from the previous controller before swap.
    registered.cancelAll("reregister")
  }
  registered = controller
}

/** True when a Query compensation controller is registered. */
export function hasTranscriptReconnectCompensationController(): boolean {
  return registered != null
}

/**
 * Disconnect hook: fix recovery checkpoints before replay merge.
 * No-op when no Query controller is registered.
 */
export function notifyTranscriptReconnectDisconnect(input: {
  lastEventID: string | null
  reason: string
  transport?: string
  generation?: number
}): void {
  registered?.captureCheckpoints(input)
}

/**
 * Ready-barrier compensation hook.
 * No-op when no Query controller is registered (store path keeps resync).
 */
export function notifyTranscriptReconnectCompensation(
  trigger: EventPipelineCompensationTrigger,
): void {
  registered?.onCompensation(trigger)
}

/**
 * Observe-path ensure for inactive sessions marked stale after reconnect.
 * Returns null when no controller is registered or the session is not stale.
 */
export async function ensureTranscriptOnObserve(
  scope: TranscriptScope,
): Promise<TranscriptData | null> {
  if (!registered) return null
  return registered.ensureOnObserve(scope)
}

/** Cancel all compensation work (runtime switch). */
export function cancelTranscriptReconnectCompensation(reason?: string): void {
  registered?.cancelAll(reason)
}
