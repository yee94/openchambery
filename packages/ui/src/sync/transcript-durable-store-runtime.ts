/**
 * Production durable-store selector.
 *
 * Electron talking to its local sidecar uses the HTTP/SQLite cache.
 * Web, VS Code webview, Capacitor, and Electron-on-remote use IndexedDB.
 * Selection is re-evaluated on every call so an endpoint switch cannot keep
 * writing transcript bodies to a remote host.
 */

import { isDesktopLocalOriginActive, isDesktopShell, isVSCodeRuntime } from "@/lib/desktop"
import { isCapacitorApp } from "@/lib/platform"

import { createHttpTranscriptDurableStore } from "./transcript-durable-store-http"
import { createIndexedDBTranscriptDurableStore } from "./transcript-durable-store-indexeddb"
import type {
  TranscriptDurableGeneration,
  TranscriptDurableScope,
  TranscriptDurableStore,
  TranscriptEvictToBytesOptions,
} from "./transcript-durable-store"

export type TranscriptDurableRuntimeKind = "http" | "indexeddb"

export type TranscriptDurableRuntimeDeps = {
  isDesktopShell?: () => boolean
  isDesktopLocalOriginActive?: () => boolean
  isVSCodeRuntime?: () => boolean
  isCapacitorApp?: () => boolean
  createHttpStore?: () => TranscriptDurableStore
  createIndexedDBStore?: () => TranscriptDurableStore
}

/**
 * Electron + local origin only. Every other surface — including a desktop
 * window pointed at a remote host — stays on IndexedDB so conversation
 * bodies never leave the machine through this cache.
 */
export function resolveTranscriptDurableRuntimeKind(
  deps: TranscriptDurableRuntimeDeps = {},
): TranscriptDurableRuntimeKind {
  const desktopShell = deps.isDesktopShell ?? isDesktopShell
  const localOrigin = deps.isDesktopLocalOriginActive ?? isDesktopLocalOriginActive
  const vscode = deps.isVSCodeRuntime ?? isVSCodeRuntime
  const capacitor = deps.isCapacitorApp ?? isCapacitorApp
  if (vscode() || capacitor()) return "indexeddb"
  if (desktopShell() && localOrigin()) return "http"
  return "indexeddb"
}

const settleAll = async (tasks: readonly Promise<unknown>[]): Promise<void> => {
  const results = await Promise.allSettled(tasks)
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
  if (rejected) throw rejected.reason
}

/**
 * Runtime durable store. Factories are injectable so unit tests do not open
 * IndexedDB or touch `runtimeFetch`.
 *
 * `clearGeneration` always hits both backends: after an endpoint switch the
 * previous local SQLite generation must not survive next to IndexedDB rows.
 * `clearAll` / `clearCurrentRuntimeTranscriptCache` hit only the live backend.
 * `destroy` is a no-op so SyncProvider teardown cannot wipe the user cache.
 */
export function createRuntimeTranscriptDurableStore(
  deps: TranscriptDurableRuntimeDeps = {},
): TranscriptDurableStore {
  let httpStore: TranscriptDurableStore | undefined
  let indexedDBStore: TranscriptDurableStore | undefined

  const http = (): TranscriptDurableStore => {
    httpStore ??= (deps.createHttpStore ?? createHttpTranscriptDurableStore)()
    return httpStore
  }
  const indexedDB = (): TranscriptDurableStore => {
    indexedDBStore ??= (deps.createIndexedDBStore ?? createIndexedDBTranscriptDurableStore)()
    return indexedDBStore
  }
  const active = (): TranscriptDurableStore =>
    resolveTranscriptDurableRuntimeKind(deps) === "http" ? http() : indexedDB()

  return {
    readSession: (scope: TranscriptDurableScope) => active().readSession(scope),
    readMessage: (scope, messageID) => active().readMessage(scope, messageID),
    upsertSettled: (scope, info, parts) => active().upsertSettled(scope, info, parts),
    removeMessage: (scope, messageID) => active().removeMessage(scope, messageID),
    clearSession: (scope) => active().clearSession(scope),
    clearGeneration: (generation: TranscriptDurableGeneration) =>
      settleAll([http().clearGeneration(generation), indexedDB().clearGeneration(generation)]),
    evictToBytes: (maxBytes, options?: TranscriptEvictToBytesOptions) =>
      active().evictToBytes(maxBytes, options),
    clearAll: () => active().clearAll(),
    destroy: async () => {
      // Production stack dispose must not delete IndexedDB or SQLite rows.
    },
  }
}

/**
 * Clear the current runtime's transcript cache only.
 *
 * Electron + local origin → HTTP/SQLite. Web / VS Code / Capacitor /
 * remote desktop → IndexedDB. Does not touch the other backend.
 * `clearGeneration` remains the dual-backend path.
 */
export async function clearCurrentRuntimeTranscriptCache(
  deps: TranscriptDurableRuntimeDeps = {},
): Promise<void> {
  await createRuntimeTranscriptDurableStore(deps).clearAll()
}
