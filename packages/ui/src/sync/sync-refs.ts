/**
 * Sync refs — imperative access to sync state from non-React code.
 *
 * SyncProvider sets these refs on mount. Store actions (session-ui-store,
 * session-actions) use them to read child-store domain data without hooks.
 */

import type { Config, OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { ChildStoreManager } from "./child-store"
import {
  getSessionMaterializationStatusFromProjection,
  type SessionMaterializationStatus,
} from "./materialization"
import type { State } from "./types"

let _childStores: ChildStoreManager | null = null
let _directory: string = ""
let _registerSessionDirectory: ((sessionID: string, directory: string) => void) | null = null
const configListeners = new Set<(directory: string, config: Config) => void>()
let cachedSessionManager: ChildStoreManager | null = null
let cachedSessionSlices = new Map<string, State["session"]>()
let cachedSessionsById = new Map<string, State["session"][number]>()

export function setSyncRefs(
  _sdk: OpencodeClient,
  childStores: ChildStoreManager,
  directory: string,
  registerSessionDirectory?: (sessionID: string, directory: string) => void,
) {
  _childStores = childStores
  if (cachedSessionManager !== childStores) {
    cachedSessionManager = null
    cachedSessionSlices = new Map()
    cachedSessionsById = new Map()
  }
  _directory = directory
  if (registerSessionDirectory) {
    _registerSessionDirectory = registerSessionDirectory
  }
}

/** Pre-register a session→directory mapping in the routing index.
 *  Called from session-actions when creating sessions so SSE events
 *  arriving before session.created can be routed correctly. */
export function registerSessionDirectory(sessionID: string, directory: string) {
  _registerSessionDirectory?.(sessionID, directory)
}

export function getSyncChildStores(): ChildStoreManager {
  if (!_childStores) throw new Error("ChildStoreManager not initialized — is SyncProvider mounted?")
  return _childStores
}

/** Read current directory's child store state. Returns undefined if not bootstrapped. */
export function getDirectoryState(directory?: string): State | undefined {
  const stores = _childStores
  if (!stores) return undefined
  const dir = directory || _directory
  if (!dir) return undefined
  return stores.getState(dir)
}

/** Read resolved OpenCode config from a directory child store, if bootstrapped. */
export function getSyncConfig(directory?: string): Config | undefined {
  const config = getDirectoryState(directory)?.config
  return config && Object.keys(config).length > 0 ? config : undefined
}

export function subscribeToSyncConfigChanges(listener: (directory: string, config: Config) => void): () => void {
  configListeners.add(listener)
  return () => {
    configListeners.delete(listener)
  }
}

export function emitSyncConfigChanged(directory: string, config: Config): void {
  if (!directory) return
  for (const listener of configListeners) {
    listener(directory, config)
  }
}

/** Read sessions from current directory's child store */
export function getSyncSessions(directory?: string) {
  return getDirectoryState(directory)?.session ?? []
}

/** Read sessions across all initialized child stores */
export function getAllSyncSessions() {
  return Array.from(getAllSyncSessionMap().values())
}

/** Read the cached cross-directory session index, rebuilding only when a session slice changes. */
export function getAllSyncSessionMap(): ReadonlyMap<string, State["session"][number]> {
  const stores = _childStores
  if (!stores) return cachedSessionsById

  let changed = cachedSessionManager !== stores || cachedSessionSlices.size !== stores.children.size
  for (const [directory, store] of stores.children) {
    if (cachedSessionSlices.get(directory) !== store.getState().session) {
      changed = true
      break
    }
  }
  if (!changed) return cachedSessionsById

  const nextSlices = new Map<string, State["session"]>()
  const nextSessionsById = new Map<string, State["session"][number]>()
  for (const [directory, store] of stores.children) {
    const sessions = store.getState().session
    nextSlices.set(directory, sessions)
    for (const session of sessions) {
      if (!session?.id) continue
      nextSessionsById.set(session.id, session)
    }
  }
  cachedSessionManager = stores
  cachedSessionSlices = nextSlices
  cachedSessionsById = nextSessionsById
  return cachedSessionsById
}

export type MaterializedSessionDirectorySnapshot = {
  session: State["session"]
  /**
   * True when the session transcript is loaded for that directory.
   * Production uses TranscriptRepository.hasSession / catalog — never State.message.
   */
  hasTranscript?: boolean
}

/** Resolve a loaded session directory without creating stores or fetching data. */
export function resolveMaterializedSessionDirectory(
  sessionID: string,
  preferredDirectory?: string,
  snapshots?: Iterable<readonly [string, MaterializedSessionDirectorySnapshot]>,
): string | undefined {
  if (snapshots) {
    const matches: string[] = []
    for (const [directory, state] of snapshots) {
      if (!state.session.some((session) => session.id === sessionID)) continue
      if (state.hasTranscript !== true) continue
      if (directory === preferredDirectory) return directory
      matches.push(directory)
    }
    return matches.length === 1 ? matches[0] : undefined
  }

  // Production: catalog + repository hasSession (not child-store message maps).
  const matches: string[] = []
  try {
    const {
      getTranscriptRepository,
      transcriptScope,
      resolveTranscriptRepositoryForStore,
    } = require("./transcript-repository-runtime") as typeof import("./transcript-repository-runtime")
    const bound = getTranscriptRepository()
    if (_childStores) {
      for (const [directory, store] of _childStores.children) {
        const state = store.getState()
        if (!state.session.some((session) => session.id === sessionID)) continue
        const repository = bound ?? resolveTranscriptRepositoryForStore(directory, store)
        if (!repository.hasSession?.(transcriptScope(directory, sessionID))) continue
        if (directory === preferredDirectory) return directory
        matches.push(directory)
      }
    }
    // Query inventory may know scopes before catalog lists them.
    if (matches.length === 0 && bound) {
      const inventory = (bound as {
        getCacheBudget?: () => {
          listCanonical: (filter?: { directory?: string }) => Array<{ scope: { directory: string; sessionID: string } }>
        }
      }).getCacheBudget?.().listCanonical()
      if (inventory) {
        for (const entry of inventory) {
          if (entry.scope.sessionID !== sessionID) continue
          if (entry.scope.directory === preferredDirectory) return entry.scope.directory
          matches.push(entry.scope.directory)
        }
      }
    }
  } catch {
    // Fall through to empty.
  }

  const unique = [...new Set(matches)]
  return unique.length === 1 ? unique[0] : undefined
}

/** Read messages for a session via TranscriptRepository when bound. */
export function getSyncMessages(sessionId: string, directory?: string): import("@opencode-ai/sdk/v2/client").Message[] {
  if (!sessionId) return []
  try {
    // Lazy import avoids circular init with transcript-repository-runtime.
    const {
      getTranscriptRepository,
      transcriptScope,
      resolveTranscriptRepositoryForStore,
    } = require("./transcript-repository-runtime") as typeof import("./transcript-repository-runtime")
    const bound = getTranscriptRepository()
    const dir = directory ?? _directory
    if (bound) {
      const data = bound.getTranscript(transcriptScope(dir, sessionId))
      return data.messageOrder
        .map((id) => data.messagesByID[id])
        .filter((message): message is import("@opencode-ai/sdk/v2/client").Message => Boolean(message))
    }
    if (_childStores) {
      const store = _childStores.getChild(dir)
      if (store) {
        const repository = resolveTranscriptRepositoryForStore(dir, store)
        const data = repository.getTranscript(transcriptScope(dir, sessionId))
        return data.messageOrder
          .map((id) => data.messagesByID[id])
          .filter((message): message is import("@opencode-ai/sdk/v2/client").Message => Boolean(message))
      }
    }
  } catch {
    // Fall through when runtime is unavailable.
  }
  return []
}

/** Read renderability of a session from TranscriptRepository when bound. */
export function getSyncSessionMaterializationStatus(
  sessionId: string,
  directory?: string,
): SessionMaterializationStatus {
  if (!sessionId) return { hasMessages: false, renderable: false, missingPartMessageIDs: [] }
  try {
    const {
      getTranscriptRepository,
      transcriptScope,
      resolveTranscriptRepositoryForStore,
    } = require("./transcript-repository-runtime") as typeof import("./transcript-repository-runtime")
    const {
      materializationStatusFromTranscriptData,
    } = require("./transcript-repository-observers") as typeof import("./transcript-repository-observers")
    const dir = directory ?? _directory
    const bound = getTranscriptRepository()
    if (bound) {
      const scope = transcriptScope(dir, sessionId)
      const data = bound.getTranscript(scope)
      const resolved = bound.hasSession?.(scope)
      return materializationStatusFromTranscriptData(data, {
        resolved: resolved === true ? true : undefined,
      })
    }
    if (_childStores) {
      const store = _childStores.getChild(dir)
      if (store) {
        const repository = resolveTranscriptRepositoryForStore(dir, store)
        const scope = transcriptScope(dir, sessionId)
        const data = repository.getTranscript(scope)
        const resolved = repository.hasSession?.(scope)
        return materializationStatusFromTranscriptData(data, {
          resolved: resolved === true ? true : undefined,
        })
      }
    }
  } catch {
    // Fall through when runtime is unavailable.
  }
  return { hasMessages: false, renderable: false, missingPartMessageIDs: [] }
}

/** Read parts for a message via TranscriptRepository when bound. */
export function getSyncParts(messageId: string, directory?: string): import("@opencode-ai/sdk/v2/client").Part[] {
  if (!messageId) return []
  try {
    const {
      getTranscriptRepository,
      transcriptScope,
      resolveTranscriptRepositoryForStore,
    } = require("./transcript-repository-runtime") as typeof import("./transcript-repository-runtime")
    const bound = getTranscriptRepository()
    const dir = directory ?? _directory
    if (bound) {
      return [...bound.getParts(transcriptScope(dir, messageId), messageId)]
    }
    if (_childStores) {
      const store = _childStores.getChild(dir)
      if (store) {
        const repository = resolveTranscriptRepositoryForStore(dir, store)
        return [...repository.getParts(transcriptScope(dir, messageId), messageId)]
      }
    }
  } catch {
    // Fall through.
  }
  return []
}

/** Read session status from current directory's child store */
export function getSyncSessionStatus(sessionId: string, directory?: string) {
  return getDirectoryState(directory)?.session_status[sessionId]
}
