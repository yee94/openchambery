import type { SessionStatus } from '@/lib/opencode/v2-types'

import type { ChildStoreManager } from "./child-store"

export type ScopedSessionStatusScope = { directory: string; sessionID: string }
export type ScopedSessionStatus = SessionStatus["type"] | "unknown"

export function readScopedSessionStatus(
  childStores: ChildStoreManager,
  scope: ScopedSessionStatusScope,
): ScopedSessionStatus {
  const state = childStores.getChild(scope.directory)?.getState()
  if (!state) return "unknown"
  const status = state.session_status?.[scope.sessionID]
  if (status) return status.type
  return state.session_status_snapshot_at !== undefined ? "idle" : "unknown"
}

export function scopedSessionStatusSignature(
  childStores: ChildStoreManager,
  scopes: ScopedSessionStatusScope[],
): string {
  return scopes.map((scope) => {
    const state = childStores.getChild(scope.directory)?.getState()
    return `${scope.directory}\n${scope.sessionID}\n${state?.session_status?.[scope.sessionID]?.type ?? ""}\n${state?.session_status_snapshot_at ?? ""}`
  }).join("\u0000")
}

/** Subscribes only to requested directory status entries and status snapshots. */
export function subscribeScopedSessionStatuses(
  childStores: ChildStoreManager,
  scopes: ScopedSessionStatusScope[],
  notify: () => void,
): () => void {
  const subscriptions = new Map<string, () => void>()
  const scopesByDirectory = new Map<string, ScopedSessionStatusScope[]>()
  for (const scope of scopes) {
    const entries = scopesByDirectory.get(scope.directory) ?? []
    entries.push(scope)
    scopesByDirectory.set(scope.directory, entries)
  }

  const syncSubscriptions = () => {
    let changed = false
    for (const [directory, unsubscribe] of subscriptions) {
      if (scopesByDirectory.has(directory) && childStores.getChild(directory)) continue
      unsubscribe()
      subscriptions.delete(directory)
      changed = true
    }
    for (const [directory, directoryScopes] of scopesByDirectory) {
      if (subscriptions.has(directory)) continue
      const store = childStores.getChild(directory)
      if (!store) continue
      subscriptions.set(directory, store.subscribe((state, previous) => {
        for (const scope of directoryScopes) {
          if (
            state.session_status?.[scope.sessionID] !== previous.session_status?.[scope.sessionID]
            || state.session_status_snapshot_at !== previous.session_status_snapshot_at
          ) {
            notify()
            return
          }
        }
      }))
      changed = true
    }
    return changed
  }

  syncSubscriptions()
  const unsubscribeRegistry = childStores.subscribeRegistry(() => {
    if (syncSubscriptions()) notify()
  })
  return () => {
    unsubscribeRegistry()
    for (const unsubscribe of subscriptions.values()) unsubscribe()
    subscriptions.clear()
  }
}
