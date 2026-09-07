/**
 * Leaf client flag for OpenChamber reasoning projection (`includeReasoning`).
 *
 * No store/React imports — runtime-fetch, event-pipeline, and the transcript
 * adapter read this module. `useUIStore` lifecycle (initial / persist hydrate /
 * setter) keeps the value correct before the first message request.
 *
 * Host/VS Code strip reasoning when the query is the strict string `false`.
 * Missing or any other value keeps full/slim include behavior.
 */

let includeReasoning = true
let revision = 0
const listeners = new Set<() => void>()

/** Whether the client wants reasoning parts/events (default true). */
export function getIncludeReasoningProjection(): boolean {
  return includeReasoning
}

/**
 * Monotonic projection generation. Bumps on every real flag change so stale
 * async exact/authority/durable completions from a prior generation cannot
 * write reasoning back into a closed Query projection (including off→on→off).
 */
export function getReasoningProjectionRevision(): number {
  return revision
}

/**
 * Sync from UI `showReasoningTraces`. No-op when the value is unchanged.
 * Notifies subscribers only after a real change.
 */
export function setIncludeReasoningProjection(next: boolean): void {
  if (includeReasoning === next) return
  includeReasoning = next
  revision += 1
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // Subscriber failures must not break other listeners or the setter.
    }
  }
}

/** Subscribe to projection flag changes (toggle reset / stream reconnect). */
export function subscribeReasoningProjection(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only: restore defaults between cases. */
export function resetReasoningProjectionClientForTests(): void {
  includeReasoning = true
  revision = 0
  listeners.clear()
}
