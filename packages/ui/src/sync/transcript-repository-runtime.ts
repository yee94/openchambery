/**
 * Production TranscriptRepository binding (Ticket 09 — QueryCache sole authority).
 *
 * SyncProvider creates one Query-backed repository, one active-scope registry,
 * one cache budget, and one reconnect compensation controller, then binds them
 * here. Readers/writers resolve the live binding; a binding revision lets
 * observers that subscribed before the provider effect re-subscribe after swap.
 *
 * Ephemeral store-backed adapters remain available for unit tests that never
 * mount SyncProvider; production must not bind the store adapter.
 */

import type { StoreApi } from "zustand"

import { getRuntimeGeneration, getRuntimeTransportIdentity } from "@/lib/runtime-switch"
import type { ChildStoreManager, DirectoryStore } from "./child-store"
import {
  createStoreTranscriptRepository,
  type TranscriptStoreSurface,
} from "./transcript-repository-store-adapter"
import type {
  TranscriptCommand,
  TranscriptCommandResult,
  TranscriptHydrationState,
  TranscriptMessageMaterializationState,
  TranscriptRepository,
  TranscriptScope,
} from "./transcript-repository"
import {
  beginTranscriptAuthorityRefresh,
  endTranscriptAuthorityRefresh,
} from "./transcript-authority-refresh-flight"
import {
  enqueueExactFill,
  type ExactFillPriority,
} from "./transcript-exact-fill-scheduler"

type TranscriptRepositoryBinding = {
  kind: "query" | "store-test"
  repository: TranscriptRepository
  childStores?: ChildStoreManager
}

let binding: TranscriptRepositoryBinding | null = null
let bindingRevision = 0
const bindingListeners = new Set<() => void>()

function bumpBindingRevision(): void {
  bindingRevision += 1
  for (const listener of bindingListeners) listener()
}

/**
 * Cast a pure TranscriptStoreSurface (or test harness with message/part maps).
 * Production DirectoryStore is never a transcript write surface after batch 2 —
 * callers must pass an explicit TranscriptStoreSurface or bind Query.
 */
function asStoreSurface(
  store: StoreApi<DirectoryStore> | TranscriptStoreSurface,
): TranscriptStoreSurface {
  return store as unknown as TranscriptStoreSurface
}

/**
 * Subscribe to production repository binding changes (Ticket 09).
 * Observers that may mount before SyncProvider use this so they re-subscribe
 * from an ephemeral/store fallback onto the Query repository after bind.
 */
export function subscribeTranscriptRepositoryBinding(listener: () => void): () => void {
  bindingListeners.add(listener)
  return () => {
    bindingListeners.delete(listener)
  }
}

/** Monotonic revision of the production repository binding. */
export function getTranscriptRepositoryBindingRevision(): number {
  return bindingRevision
}

/**
 * Bind the production TranscriptRepository (Query-backed after Ticket 09).
 * Replaces any previous binding and notifies binding listeners.
 */
export function bindTranscriptRepositoryInstance(
  repository: TranscriptRepository,
): TranscriptRepository {
  if (binding?.repository === repository) {
    return repository
  }
  binding = { kind: "query", repository }
  bumpBindingRevision()
  return repository
}

/** Clear the production binding (tests / provider dispose). */
export function unbindTranscriptRepository(): void {
  if (!binding) return
  binding = null
  bumpBindingRevision()
}

/**
 * Resolve the production TranscriptRepository. When SyncProvider has not bound
 * yet, returns null so callers can no-op or fall back safely.
 */
export function getTranscriptRepository(): TranscriptRepository | null {
  return binding?.repository ?? null
}

/**
 * Require the production repository. Throws when SyncProvider has not bound —
 * production writers must only run after provider mount.
 */
export function requireTranscriptRepository(): TranscriptRepository {
  const repository = getTranscriptRepository()
  if (!repository) {
    throw new Error("TranscriptRepository is not bound — SyncProvider must mount first")
  }
  return repository
}

/**
 * Resolve a repository for a concrete write.
 * Prefers the SyncProvider-bound instance; when unbound (unit tests), builds an
 * ephemeral store-backed adapter pinned to the provided store.
 */
export function resolveTranscriptRepositoryForStore(
  directory: string,
  store: StoreApi<DirectoryStore> | TranscriptStoreSurface,
): TranscriptRepository {
  const bound = getTranscriptRepository()
  if (bound) return bound
  const surface = asStoreSurface(store)
  return createStoreTranscriptRepository({
    getStore: (requested) => {
      void requested
      return surface
    },
  })
}

export function transcriptScope(
  directory: string,
  sessionID: string,
  options?: { transport?: string; generation?: number },
): TranscriptScope {
  return {
    directory: directory.trim(),
    sessionID,
    ...(options?.transport !== undefined ? { transport: options.transport } : {}),
    ...(options?.generation !== undefined ? { generation: options.generation } : {}),
  }
}

/**
 * List every current-runtime canonical transcript scope for a session.
 * Local writers that must sweep every directory copy use this (same contract
 * as transcript SSE broadcast). An unbound repository or inventory failure
 * returns [].
 */
export function listCanonicalTranscriptScopes(sessionID: string): TranscriptScope[] {
  try {
    const repository = getTranscriptRepository() as
      | (ReturnType<typeof getTranscriptRepository> & {
        getCacheBudget?: () => {
          listCanonicalScopesForSession: (
            sessionID: string,
            filter?: {
              transport?: string
              generation?: number
            },
          ) => Array<{
            directory: string
            sessionID: string
            transport: string
            generation: number
          }>
        }
      })
      | null
    const transport = getRuntimeTransportIdentity()
    const generation = getRuntimeGeneration()
    return repository?.getCacheBudget?.().listCanonicalScopesForSession(sessionID, {
      transport,
      generation,
    })
      ?.map((scope) => transcriptScope(scope.directory, scope.sessionID, {
        transport: scope.transport,
        generation: scope.generation,
      })) ?? []
  } catch {
    return []
  }
}

/**
 * Apply a production transcript command. Returns null when the repository is
 * unbound (pre-mount).
 */
export function applyTranscriptCommand(
  scope: TranscriptScope,
  command: TranscriptCommand,
): TranscriptCommandResult | null {
  const repository = getTranscriptRepository()
  if (!repository) return null
  return repository.apply(scope, command)
}

/**
 * Fetch previous history page via the Query repository when available.
 * Throws when the production repository does not expose fetchPreviousPage.
 */
export async function fetchTranscriptPreviousPage(
  directory: string,
  sessionID: string,
): Promise<void> {
  const repository = requireTranscriptRepository() as TranscriptRepository & {
    fetchPreviousPage?: (scope: TranscriptScope) => Promise<unknown>
  }
  if (typeof repository.fetchPreviousPage !== "function") {
    throw new Error("TranscriptRepository does not support fetchPreviousPage")
  }
  await repository.fetchPreviousPage(transcriptScope(directory, sessionID))
}

/**
 * Ensure initial tail via the Query repository when available.
 */
export async function ensureTranscriptInitial(
  directory: string,
  sessionID: string,
): Promise<void> {
  const repository = requireTranscriptRepository() as TranscriptRepository & {
    ensureInitial?: (scope: TranscriptScope) => Promise<unknown>
  }
  if (typeof repository.ensureInitial !== "function") {
    throw new Error("TranscriptRepository does not support ensureInitial")
  }
  await repository.ensureInitial(transcriptScope(directory, sessionID))
}

/**
 * User-triggered cold reload after a settled transcript failure.
 *
 * `ensureInitial` on a failed/empty chain is not enough, so retry must purge
 * and ensure a fresh tail. Ensure failure leaves the empty/failed state.
 */
export async function retryTranscriptInitial(
  directory: string,
  sessionID: string,
): Promise<void> {
  const repository = requireTranscriptRepository() as TranscriptRepository & {
    destructiveReset?: (scope: TranscriptScope) => Promise<unknown>
    ensureInitial?: (scope: TranscriptScope) => Promise<unknown>
  }
  const scope = transcriptScope(directory, sessionID)
  if (typeof repository.destructiveReset === "function") {
    await repository.destructiveReset(scope)
    return
  }
  if (typeof repository.ensureInitial !== "function") {
    throw new Error("TranscriptRepository does not support retryInitial")
  }
  await repository.ensureInitial(scope)
}

/**
 * User-triggered refresh: fetch a fresh tail, reconcile-page merge, then
 * delete only in-range non-optimistic absences. Failure keeps the prior
 * transcript. Do not use ensureInitial (enter-and-sync reconcile without
 * that delete pass) or destructiveReset (ensure failure blanks the chat).
 */
export async function refreshTranscriptFromAuthority(
  directory: string,
  sessionID: string,
): Promise<void> {
  const repository = requireTranscriptRepository() as TranscriptRepository & {
    refreshFromAuthority?: (scope: TranscriptScope) => Promise<unknown>
  }
  if (typeof repository.refreshFromAuthority !== "function") {
    throw new Error("TranscriptRepository does not support refreshFromAuthority")
  }
  beginTranscriptAuthorityRefresh(directory, sessionID)
  try {
    await repository.refreshFromAuthority(transcriptScope(directory, sessionID))
  } finally {
    endTranscriptAuthorityRefresh(directory, sessionID)
  }
}

/**
 * Purge one session's transcript families (delete / eviction).
 * No-op when the bound repository lacks purgeSession.
 */
/**
 * Fetch the exact Host snapshot for one message and merge it into Query.
 * UI Activity lanes call this; the repository no-ops when the message has
 * no slim tool / reasoning / file / text parts.
 *
 * All callers share the process-wide exact-fill scheduler (concurrency ≤4).
 * Pass `priority: "user"` for expand / retry so they jump ahead of background
 * cold-start and pagination fills.
 */
export async function materializeTranscriptMessage(
  directory: string,
  sessionID: string,
  messageID: string,
  options?: { readonly priority?: ExactFillPriority },
): Promise<void> {
  const repository = requireTranscriptRepository()
  if (typeof repository.materializeMessage !== "function") {
    throw new Error("TranscriptRepository does not support materializeMessage")
  }
  const scope = transcriptScope(directory, sessionID)
  const key = `${directory}\n${sessionID}\n${messageID}`
  await enqueueExactFill(
    key,
    () => repository.materializeMessage!(scope, messageID),
    { priority: options?.priority ?? "background" },
  )
}

/**
 * Read-only hydration phase for the bound Query repository.
 * Unbound / store-test repositories without the method report idle.
 */
export function getTranscriptHydrationState(
  directory: string,
  sessionID: string,
): TranscriptHydrationState {
  const repository = getTranscriptRepository()
  if (!repository || typeof repository.getHydrationState !== "function") {
    return { sessionID, phase: "idle", p0Satisfied: false }
  }
  return repository.getHydrationState(transcriptScope(directory, sessionID))
}

/**
 * Read-only exact-message fill status. Unbound / store-test repositories
 * report idle so later UI can subscribe without throwing.
 */
export function getTranscriptMessageMaterializationState(
  directory: string,
  sessionID: string,
  messageID: string,
): TranscriptMessageMaterializationState {
  const repository = getTranscriptRepository()
  if (!repository || typeof repository.getMessageMaterializationState !== "function") {
    return { sessionID, messageID, status: "idle" }
  }
  return repository.getMessageMaterializationState(
    transcriptScope(directory, sessionID),
    messageID,
  )
}

export function purgeTranscriptSession(directory: string, sessionID: string): void {
  const repository = getTranscriptRepository() as
    | (TranscriptRepository & { purgeSession?: (scope: TranscriptScope) => void })
    | null
  repository?.purgeSession?.(transcriptScope(directory, sessionID))
}
