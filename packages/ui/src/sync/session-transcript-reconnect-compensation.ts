/**
 * Query reconnect compensation controller (Ticket 07).
 *
 * Lifecycle:
 * 1. onDisconnect / recovery-context capture → fix recovery checkpoints from
 *    canonical transcript (before any replay merge).
 * 2. onCompensation with isReconnect:false → skip gap compensation.
 * 3. onCompensation with isReconnect:true → after ready barrier (replay already
 *    flushed), schedule reconcile tasks for the immediate set.
 *
 * Immediate set = active repository/Query observers ∪ viewed ∪ busy/retry.
 * Per-directory concurrency default 2; per-session single-flight; continuation
 * pages strictly serial. Inactive canonical sessions are marked stale and
 * ensure on observe.
 *
 * Production store adapter remains bound; this controller is only active when
 * a Query repository is registered via the runtime seam (Ticket 09 cutover).
 */

import type { QueryClient } from "@tanstack/react-query"

import {
  getRuntimeGeneration,
  getRuntimeTransportIdentity,
} from "@/lib/runtime-switch"

import type { EventPipelineCompensationTrigger } from "./event-pipeline"
import {
  fetchSessionTranscriptReconcile,
  type SessionTranscriptReconcilePage,
} from "./session-transcript-reconcile-api"
import {
  clearTranscriptRecoveryCheckpoint,
  createTranscriptRecoveryCheckpoint,
  readTranscriptRecoveryCheckpoint,
  writeTranscriptRecoveryCheckpoint,
  withTranscriptRecoveryCheckpointState,
  type TranscriptRecoveryCheckpoint,
} from "./session-transcript-recovery-checkpoint"
import {
  createTranscriptActiveScopeRegistry,
  createTranscriptQueryCacheBudget,
  normalizeTranscriptCacheScope,
  sessionTranscriptReconcileTaskQueryKey,
  transcriptCacheScopeKey,
  type TranscriptCacheScope,
  type TranscriptQueryCacheBudget,
} from "./session-transcript-query-cache"
import type {
  TranscriptData,
  TranscriptRepository,
  TranscriptScope,
} from "./transcript-repository"
import type { SessionMessageRuntimeProbe } from "./session-message-query"
import { SessionMessageRuntimeStaleError } from "./session-message-query"

// ---------------------------------------------------------------------------
// Query repository surface required by the controller
// ---------------------------------------------------------------------------

/**
 * Minimal Query-backed repository surface used by compensation.
 * Production store adapter does not implement ensureInitial / destructiveReset;
 * Ticket 09 registers a Query repository that does.
 */
export type QueryTranscriptCompensationRepository = TranscriptRepository & {
  ensureInitial: (scope: TranscriptScope) => Promise<TranscriptData>
  destructiveReset: (scope: TranscriptScope) => Promise<TranscriptData>
  getCacheBudget?: () => TranscriptQueryCacheBudget
}

// ---------------------------------------------------------------------------
// Priority / immediate set
// ---------------------------------------------------------------------------

export type CompensationSessionRef = {
  readonly directory: string
  readonly sessionID: string
}

export type CollectImmediateCompensationSessionsInput = {
  /** Active scopes from Query observers + repository listeners. */
  readonly activeScopes: readonly CompensationSessionRef[]
  readonly viewed?: CompensationSessionRef | null
  /**
   * Additional viewed sessions (e.g. Context Panel open child + main chat).
   * Precedence: viewedSessions order, then singular viewed, then busy/retry, then active.
   */
  readonly viewedSessions?: readonly CompensationSessionRef[]
  /** Non-idle (busy / retry) session statuses in the directory. */
  readonly busyOrRetrySessionIDs?: readonly string[]
  readonly directory: string
}

/**
 * Immediate compensation set for one directory:
 * active observers ∪ viewed ∪ busy/retry. Deduped, stable order:
 * viewed first, then busy/retry, then remaining active.
 */
export function collectImmediateCompensationSessions(
  input: CollectImmediateCompensationSessionsInput,
): CompensationSessionRef[] {
  const directory = input.directory.trim()
  const seen = new Set<string>()
  const out: CompensationSessionRef[] = []

  const push = (sessionID: string | undefined | null) => {
    if (!sessionID || seen.has(sessionID)) return
    seen.add(sessionID)
    out.push({ directory, sessionID })
  }

  for (const ref of input.viewedSessions ?? []) {
    if (ref.directory.trim() !== directory) continue
    push(ref.sessionID)
  }
  if (input.viewed?.directory.trim() === directory) {
    push(input.viewed.sessionID)
  }
  for (const sessionID of input.busyOrRetrySessionIDs ?? []) {
    push(sessionID)
  }
  for (const scope of input.activeScopes) {
    if (scope.directory.trim() !== directory) continue
    push(scope.sessionID)
  }
  return out
}

// ---------------------------------------------------------------------------
// Controller deps / API
// ---------------------------------------------------------------------------

export type TranscriptReconnectCompensationController = {
  /** Capture checkpoints for known canonical sessions before replay merge. */
  captureCheckpoints: (input: {
    lastEventID: string | null
    reason: string
    transport?: string
    generation?: number
  }) => void
  /**
   * Ready-barrier compensation entry.
   * First ready (`isReconnect:false`) skips gap work (optional light upstream strategy).
   */
  onCompensation: (trigger: EventPipelineCompensationTrigger) => void
  /**
   * Observe-path ensure for inactive sessions marked stale after reconnect.
   * Returns whether ensure was scheduled/ran.
   */
  ensureOnObserve: (scope: TranscriptScope) => Promise<TranscriptData | null>
  /** Cancel all in-flight tasks (runtime switch / dispose). */
  cancelAll: (reason?: string) => void
  /** Test / diagnostics: whether a session has a pending/reconciling checkpoint. */
  getCheckpoint: (
    scope: TranscriptScope,
  ) => TranscriptRecoveryCheckpoint | undefined
  /** Test: mark of sessions currently in-flight. */
  isSessionInFlight: (directory: string, sessionID: string) => boolean
  destroy: () => void
}

export type CreateTranscriptReconnectCompensationControllerInput = {
  client: QueryClient
  repository: QueryTranscriptCompensationRepository
  /**
   * Enumerate directories that currently have child stores / catalogs.
   * Used to scope checkpoint capture and immediate scheduling.
   */
  listDirectories: () => readonly string[]
  /**
   * List busy/retry session IDs for a directory (authoritative status map).
   */
  getBusyOrRetrySessionIDs: (directory: string) => readonly string[]
  /**
   * Currently viewed session (any directory), if any.
   * Prefer {@link getViewedSessions} when the host can expose multiple surfaces
   * (main chat + Context Panel child).
   */
  getViewedSession: () => CompensationSessionRef | null
  /**
   * All currently viewed sessions across surfaces. When provided, takes
   * precedence over {@link getViewedSession} for immediate-set priority.
   */
  getViewedSessions?: () => readonly CompensationSessionRef[]
  /**
   * Optional cache budget for listing canonical sessions + active scopes.
   * Defaults to repository.getCacheBudget() when present.
   */
  cacheBudget?: TranscriptQueryCacheBudget
  transport?: string
  generation?: number
  probe?: SessionMessageRuntimeProbe
  /** Per-directory concurrent session tasks (default 2). */
  directoryConcurrency?: number
  /**
   * Host reconcile fetch (default {@link fetchSessionTranscriptReconcile}).
   * Injectable for tests.
   */
  fetchReconcile?: typeof fetchSessionTranscriptReconcile
  /**
   * Optional now() for tests.
   */
  now?: () => number
  /**
   * Optional logger for non-sensitive diagnostics (session IDs / codes only).
   */
  onError?: (error: unknown, context: {
    directory: string
    sessionID: string
    phase: string
  }) => void
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const DEFAULT_DIRECTORY_CONCURRENCY = 2
/** In-process observe-time reconcile head-check throttle. */
const OBSERVE_HEAD_CHECK_TTL_MS = 60_000

function resolveIdentity(
  input: CreateTranscriptReconnectCompensationControllerInput,
  scope?: TranscriptScope,
): { transport: string; generation: number } {
  const transport =
    scope?.transport
    ?? input.transport
    ?? (input.probe?.getTransport ?? getRuntimeTransportIdentity)()
  const generation =
    scope?.generation
    ?? input.generation
    ?? (input.probe?.getGeneration ?? getRuntimeGeneration)()
  return { transport, generation }
}

function assertRuntimeCurrent(
  expected: { transport: string; generation: number },
  input: CreateTranscriptReconnectCompensationControllerInput,
): void {
  const transport = (input.probe?.getTransport ?? getRuntimeTransportIdentity)()
  const generation = (input.probe?.getGeneration ?? getRuntimeGeneration)()
  if (transport !== expected.transport || generation !== expected.generation) {
    throw new SessionMessageRuntimeStaleError()
  }
}

function toTranscriptScope(
  ref: CompensationSessionRef,
  identity: { transport: string; generation: number },
): TranscriptScope {
  return {
    directory: ref.directory.trim(),
    sessionID: ref.sessionID,
    transport: identity.transport,
    generation: identity.generation,
  }
}

function toCacheScope(
  ref: CompensationSessionRef,
  identity: { transport: string; generation: number },
): TranscriptCacheScope {
  return normalizeTranscriptCacheScope({
    transport: identity.transport,
    generation: identity.generation,
    directory: ref.directory.trim(),
    sessionID: ref.sessionID,
  })
}

function flightKey(directory: string, sessionID: string): string {
  return `${directory.trim()}\n${sessionID}`
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTranscriptReconnectCompensationController(
  input: CreateTranscriptReconnectCompensationControllerInput,
): TranscriptReconnectCompensationController {
  const client = input.client
  const repository = input.repository
  const cacheBudget =
    input.cacheBudget
    ?? repository.getCacheBudget?.()
    ?? createTranscriptQueryCacheBudget({
      client,
      activeRegistry: createTranscriptActiveScopeRegistry(),
    })
  const directoryConcurrency = Math.max(
    1,
    Math.floor(input.directoryConcurrency ?? DEFAULT_DIRECTORY_CONCURRENCY),
  )
  const fetchReconcile = input.fetchReconcile ?? fetchSessionTranscriptReconcile
  const now = input.now ?? Date.now

  let destroyed = false
  /** Generation epoch for cancel-on-switch; bumped by cancelAll. */
  let controllerEpoch = 0
  /** Per-session in-flight promises (single-flight). */
  const sessionFlights = new Map<string, Promise<void>>()
  /** Abort controllers for active session tasks. */
  const sessionAborts = new Map<string, AbortController>()
  /** Directory worker queues: pending session refs. */
  const directoryQueues = new Map<string, CompensationSessionRef[]>()
  /** Directory active worker counts. */
  const directoryActive = new Map<string, number>()
  /** Inactive sessions marked stale — ensure on next observe. */
  const staleOnObserve = new Set<string>()
  /** Observe-time head-check throttle (not persisted). */
  const observeHeadCheckedAt = new Map<string, { checkedAt: number }>()
  /** In-flight observe-time head checks (single-flight per scope). */
  const observeHeadInFlight = new Set<string>()

  const markStale = (directory: string, sessionID: string) => {
    staleOnObserve.add(flightKey(directory, sessionID))
  }

  const clearStale = (directory: string, sessionID: string) => {
    staleOnObserve.delete(flightKey(directory, sessionID))
  }

  const cancelSession = (key: string) => {
    const abort = sessionAborts.get(key)
    if (abort) {
      abort.abort()
      sessionAborts.delete(key)
    }
    sessionFlights.delete(key)
  }

  const cancelAll = (_reason?: string) => {
    controllerEpoch += 1
    for (const key of [...sessionAborts.keys()]) {
      cancelSession(key)
    }
    directoryQueues.clear()
    directoryActive.clear()
  }

  /**
   * Active scopes for immediate compensation / capture:
   * - canonical entries that are active (Query observers OR retained)
   * - activeRegistry.listRetained() scopes that may not yet have a canonical
   *   query entry (repository subscribe before ensureInitial)
   * Filtered to the current transport / generation (and optional directory).
   */
  const listActiveCompensationScopes = (
    identity: { transport: string; generation: number },
    directory?: string,
  ): CompensationSessionRef[] => {
    const dirFilter =
      directory === undefined ? undefined : directory.trim()
    const byKey = new Map<string, CompensationSessionRef>()

    for (const entry of cacheBudget.listCanonical({
      transport: identity.transport,
      generation: identity.generation,
      directory: dirFilter,
    })) {
      if (!entry.active) continue
      if (dirFilter !== undefined && entry.scope.directory !== dirFilter) continue
      byKey.set(flightKey(entry.scope.directory, entry.scope.sessionID), {
        directory: entry.scope.directory,
        sessionID: entry.scope.sessionID,
      })
    }

    for (const scope of cacheBudget.activeRegistry.listRetained()) {
      if (scope.transport !== identity.transport) continue
      if (scope.generation !== identity.generation) continue
      if (dirFilter !== undefined && scope.directory !== dirFilter) continue
      byKey.set(flightKey(scope.directory, scope.sessionID), {
        directory: scope.directory,
        sessionID: scope.sessionID,
      })
    }

    return Array.from(byKey.values())
  }

  /**
   * Shared directory universe for capture + immediate scheduling:
   * listDirectories ∪ canonical scopes ∪ activeRegistry retained ∪ viewed.
   * Every directory in this set has its busy/retry sessions considered.
   */
  const listCompensationDirectories = (
    identity: { transport: string; generation: number },
    viewedSessions: readonly CompensationSessionRef[],
  ): Set<string> => {
    const directories = new Set(
      input.listDirectories().map((d) => d.trim()).filter(Boolean),
    )
    for (const entry of cacheBudget.listCanonical({
      transport: identity.transport,
      generation: identity.generation,
    })) {
      directories.add(entry.scope.directory)
    }
    for (const scope of cacheBudget.activeRegistry.listRetained()) {
      if (scope.transport !== identity.transport) continue
      if (scope.generation !== identity.generation) continue
      directories.add(scope.directory)
    }
    for (const viewed of viewedSessions) {
      if (viewed.directory) directories.add(viewed.directory.trim())
    }
    return directories
  }

  const resolveViewedSessions = (): CompensationSessionRef[] => {
    if (input.getViewedSessions) {
      const seen = new Set<string>()
      const out: CompensationSessionRef[] = []
      for (const ref of input.getViewedSessions()) {
        const directory = ref.directory.trim()
        const sessionID = ref.sessionID
        if (!directory || !sessionID) continue
        const key = flightKey(directory, sessionID)
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ directory, sessionID })
      }
      return out
    }
    const viewed = input.getViewedSession()
    if (!viewed?.sessionID) return []
    return [{ directory: viewed.directory.trim(), sessionID: viewed.sessionID }]
  }

  const captureCheckpoints = (captureInput: {
    lastEventID: string | null
    reason: string
    transport?: string
    generation?: number
  }) => {
    if (destroyed) return
    const identity = {
      transport: captureInput.transport ?? resolveIdentity(input).transport,
      generation: captureInput.generation ?? resolveIdentity(input).generation,
    }
    const capturedAt = now()
    const viewedSessions = resolveViewedSessions()
    const directories = listCompensationDirectories(identity, viewedSessions)

    // Capture for every known canonical session in this transport/generation
    // plus retained-only scopes (no canonical entry yet) plus viewed / busy.
    const canonical = cacheBudget.listCanonical({
      transport: identity.transport,
      generation: identity.generation,
    })
    const targets = new Map<string, CompensationSessionRef>()
    for (const entry of canonical) {
      targets.set(
        flightKey(entry.scope.directory, entry.scope.sessionID),
        { directory: entry.scope.directory, sessionID: entry.scope.sessionID },
      )
    }
    // Retained scopes may exist before ensureInitial seeds a canonical query.
    for (const scope of cacheBudget.activeRegistry.listRetained()) {
      if (scope.transport !== identity.transport) continue
      if (scope.generation !== identity.generation) continue
      targets.set(flightKey(scope.directory, scope.sessionID), {
        directory: scope.directory,
        sessionID: scope.sessionID,
      })
    }
    for (const viewed of viewedSessions) {
      targets.set(flightKey(viewed.directory, viewed.sessionID), {
        directory: viewed.directory,
        sessionID: viewed.sessionID,
      })
    }
    // Busy/retry across the full shared directory universe (includes
    // canonical-only directories that listDirectories may omit).
    for (const directory of directories) {
      for (const sessionID of input.getBusyOrRetrySessionIDs(directory)) {
        targets.set(flightKey(directory, sessionID), { directory, sessionID })
      }
    }

    for (const ref of targets.values()) {
      const scope = toTranscriptScope(ref, identity)
      const transcript = repository.getTranscript(scope)
      // Skip empty unknown sessions that have never been loaded — still mark
      // for ensure-on-observe when they appear later as inactive cache entries.
      const checkpoint = createTranscriptRecoveryCheckpoint({
        transport: identity.transport,
        generation: identity.generation,
        directory: ref.directory,
        sessionID: ref.sessionID,
        transcript,
        lastEventID: captureInput.lastEventID,
        capturedAt,
      })
      writeTranscriptRecoveryCheckpoint(client, checkpoint)
    }

    // Mark inactive canonical sessions stale (not in active/viewed/busy set).
    const immediateKeys = new Set<string>()
    for (const directory of directories) {
      const activeScopes = listActiveCompensationScopes(identity, directory)
      const immediate = collectImmediateCompensationSessions({
        directory,
        activeScopes,
        viewedSessions,
        busyOrRetrySessionIDs: input.getBusyOrRetrySessionIDs(directory),
      })
      for (const ref of immediate) {
        immediateKeys.add(flightKey(ref.directory, ref.sessionID))
      }
    }
    for (const entry of canonical) {
      const key = flightKey(entry.scope.directory, entry.scope.sessionID)
      if (!immediateKeys.has(key) && !entry.active) {
        markStale(entry.scope.directory, entry.scope.sessionID)
      }
    }
  }

  const applyReconcilePage = (
    scope: TranscriptScope,
    page: SessionTranscriptReconcilePage,
    capturedLiveRevision: number,
  ) => {
    const liveRevision = repository.getTranscript(scope).liveRevision
    return repository.apply(scope, {
      type: "http-page",
      purpose: "reconcile-page",
      page: {
        records: page.records.map((record) => ({
          info: record.info,
          parts: record.parts,
        })),
        // Host complete ends a reconcile round — never history exhausted.
        complete: false,
        cursor: undefined,
        turnCount: 0,
      },
      capturedLiveRevision,
      liveRevision,
    })
  }

  const runDestructiveTail = async (
    scope: TranscriptScope,
    cacheScope: TranscriptCacheScope,
    epoch: number,
  ) => {
    assertRuntimeCurrent(
      { transport: cacheScope.transport, generation: cacheScope.generation },
      input,
    )
    if (epoch !== controllerEpoch) throw new SessionMessageRuntimeStaleError()

    writeTranscriptRecoveryCheckpoint(
      client,
      withTranscriptRecoveryCheckpointState(
        readTranscriptRecoveryCheckpoint(client, cacheScope)
          ?? createTranscriptRecoveryCheckpoint({
            transport: cacheScope.transport,
            generation: cacheScope.generation,
            directory: cacheScope.directory,
            sessionID: cacheScope.sessionID,
            transcript: repository.getTranscript(scope),
            lastEventID: null,
          }),
        { state: "reset-required", continuation: null },
      ),
    )

    try {
      await repository.destructiveReset(scope)
      assertRuntimeCurrent(
        { transport: cacheScope.transport, generation: cacheScope.generation },
        input,
      )
      if (epoch !== controllerEpoch) throw new SessionMessageRuntimeStaleError()
      clearTranscriptRecoveryCheckpoint(client, cacheScope)
      clearStale(cacheScope.directory, cacheScope.sessionID)
    } catch (error) {
      // Ensure failure must propagate; leave empty/failed (destructiveReset contract).
      writeTranscriptRecoveryCheckpoint(
        client,
        withTranscriptRecoveryCheckpointState(
          readTranscriptRecoveryCheckpoint(client, cacheScope)
            ?? createTranscriptRecoveryCheckpoint({
              transport: cacheScope.transport,
              generation: cacheScope.generation,
              directory: cacheScope.directory,
              sessionID: cacheScope.sessionID,
              transcript: repository.getTranscript(scope),
              lastEventID: null,
            }),
          { state: "reset-required" },
        ),
      )
      throw error
    }
  }

  /**
   * Anchorless / unknown-gap path: refresh via ensureInitial without purging.
   * Subagent transcripts often lack authored-user anchors (subtask/synthetic);
   * destructiveReset would blank the Context Panel on focus/reconnect recovery.
   */
  const runEnsureTail = async (
    scope: TranscriptScope,
    cacheScope: TranscriptCacheScope,
    epoch: number,
  ) => {
    assertRuntimeCurrent(
      { transport: cacheScope.transport, generation: cacheScope.generation },
      input,
    )
    if (epoch !== controllerEpoch) throw new SessionMessageRuntimeStaleError()

    writeTranscriptRecoveryCheckpoint(
      client,
      withTranscriptRecoveryCheckpointState(
        readTranscriptRecoveryCheckpoint(client, cacheScope)
          ?? createTranscriptRecoveryCheckpoint({
            transport: cacheScope.transport,
            generation: cacheScope.generation,
            directory: cacheScope.directory,
            sessionID: cacheScope.sessionID,
            transcript: repository.getTranscript(scope),
            lastEventID: null,
          }),
        { state: "reconciling", continuation: null },
      ),
    )

    try {
      await repository.ensureInitial(scope)
      assertRuntimeCurrent(
        { transport: cacheScope.transport, generation: cacheScope.generation },
        input,
      )
      if (epoch !== controllerEpoch) throw new SessionMessageRuntimeStaleError()
      clearTranscriptRecoveryCheckpoint(client, cacheScope)
      clearStale(cacheScope.directory, cacheScope.sessionID)
    } catch (error) {
      // Preserve prior authoritative transcript; leave checkpoint pending for retry.
      writeTranscriptRecoveryCheckpoint(
        client,
        withTranscriptRecoveryCheckpointState(
          readTranscriptRecoveryCheckpoint(client, cacheScope)
            ?? createTranscriptRecoveryCheckpoint({
              transport: cacheScope.transport,
              generation: cacheScope.generation,
              directory: cacheScope.directory,
              sessionID: cacheScope.sessionID,
              transcript: repository.getTranscript(scope),
              lastEventID: null,
            }),
          { state: "pending" },
        ),
      )
      throw error
    }
  }

  const runSessionReconcile = async (
    ref: CompensationSessionRef,
    identity: { transport: string; generation: number },
    epoch: number,
    signal: AbortSignal,
  ) => {
    const scope = toTranscriptScope(ref, identity)
    const cacheScope = toCacheScope(ref, identity)
    const taskKey = sessionTranscriptReconcileTaskQueryKey(
      {
        directory: cacheScope.directory,
        sessionID: cacheScope.sessionID,
        checkpoint: String(readTranscriptRecoveryCheckpoint(client, cacheScope)?.capturedAt ?? now()),
      },
      cacheScope.transport,
      cacheScope.generation,
    )
    // Mark task query as running (status only — no message bodies).
    client.setQueryData(taskKey, { status: "running", startedAt: now() })

    try {
      assertRuntimeCurrent(identity, input)
      if (epoch !== controllerEpoch || signal.aborted) {
        throw new SessionMessageRuntimeStaleError()
      }

      let checkpoint = readTranscriptRecoveryCheckpoint(client, cacheScope)
      if (!checkpoint) {
        // Capture was missed (e.g. session appeared after disconnect) — build now.
        checkpoint = createTranscriptRecoveryCheckpoint({
          transport: identity.transport,
          generation: identity.generation,
          directory: ref.directory,
          sessionID: ref.sessionID,
          transcript: repository.getTranscript(scope),
          lastEventID: null,
          capturedAt: now(),
        })
        writeTranscriptRecoveryCheckpoint(client, checkpoint)
      }

      if (!checkpoint.anchorMessageID) {
        await runEnsureTail(scope, cacheScope, epoch)
        client.setQueryData(taskKey, { status: "ensure", finishedAt: now() })
        return
      }

      checkpoint = withTranscriptRecoveryCheckpointState(checkpoint, {
        state: "reconciling",
      })
      writeTranscriptRecoveryCheckpoint(client, checkpoint)

      // Multi-round chase: each round fixes capturedHead from the first page.
      let roundAnchor = checkpoint.anchorMessageID
      let rounds = 0
      const maxRounds = 32

      while (rounds < maxRounds) {
        rounds += 1
        assertRuntimeCurrent(identity, input)
        if (epoch !== controllerEpoch || signal.aborted) {
          throw new SessionMessageRuntimeStaleError()
        }

        let continuation: string | null = null
        let roundCapturedHead: string | null = null
        let roundLatestHead: string | null = null
        let pageIndex = 0

        // Serial continuation pages within one round.
        for (;;) {
          pageIndex += 1
          assertRuntimeCurrent(identity, input)
          if (epoch !== controllerEpoch || signal.aborted) {
            throw new SessionMessageRuntimeStaleError()
          }

          const capturedLiveRevision = repository.getTranscript(scope).liveRevision
          if (!continuation && !roundAnchor) {
            await runEnsureTail(scope, cacheScope, epoch)
            client.setQueryData(taskKey, { status: "ensure", finishedAt: now() })
            return
          }
          const page = await fetchReconcile({
            sessionID: ref.sessionID,
            directory: ref.directory.trim(),
            ...(continuation
              ? { continuation }
              : { anchor: roundAnchor as string }),
            signal,
          })

          assertRuntimeCurrent(identity, input)
          if (epoch !== controllerEpoch || signal.aborted) {
            throw new SessionMessageRuntimeStaleError()
          }

          if (page.resetRequired) {
            await runDestructiveTail(scope, cacheScope, epoch)
            client.setQueryData(taskKey, { status: "reset", finishedAt: now() })
            return
          }

          if (pageIndex === 1) {
            roundCapturedHead = page.capturedHeadMessageID
          }
          roundLatestHead = page.latestHeadMessageID ?? roundLatestHead

          if (page.records.length > 0) {
            applyReconcilePage(scope, page, capturedLiveRevision)
          }

          checkpoint = withTranscriptRecoveryCheckpointState(
            readTranscriptRecoveryCheckpoint(client, cacheScope) ?? checkpoint,
            {
              state: "reconciling",
              capturedHeadMessageID: roundCapturedHead,
              latestHeadMessageID: roundLatestHead,
              continuation: page.continuation,
            },
          )
          writeTranscriptRecoveryCheckpoint(client, checkpoint)

          if (page.complete || !page.continuation) {
            break
          }
          continuation = page.continuation
        }

        // Round complete: chase latest head if it advanced past captured head.
        const stableCaptured = roundCapturedHead
        const latest = roundLatestHead
        if (
          stableCaptured
          && latest
          && latest !== stableCaptured
        ) {
          // Next round uses this round's captured head as the new anchor.
          roundAnchor = stableCaptured
          checkpoint = withTranscriptRecoveryCheckpointState(
            readTranscriptRecoveryCheckpoint(client, cacheScope) ?? checkpoint,
            {
              state: "reconciling",
              anchorMessageID: stableCaptured,
              continuation: null,
              capturedHeadMessageID: null,
            },
          )
          writeTranscriptRecoveryCheckpoint(client, checkpoint)
          continue
        }

        // Stable: mark complete.
        checkpoint = withTranscriptRecoveryCheckpointState(
          readTranscriptRecoveryCheckpoint(client, cacheScope) ?? checkpoint,
          {
            state: "complete",
            continuation: null,
            capturedHeadMessageID: stableCaptured,
            latestHeadMessageID: latest,
          },
        )
        writeTranscriptRecoveryCheckpoint(client, checkpoint)
        clearStale(ref.directory, ref.sessionID)
        client.setQueryData(taskKey, { status: "complete", finishedAt: now() })
        return
      }

      // Budget of rounds exceeded → destructive tail.
      await runDestructiveTail(scope, cacheScope, epoch)
      client.setQueryData(taskKey, { status: "reset", finishedAt: now() })
    } catch (error) {
      if (
        error instanceof SessionMessageRuntimeStaleError
        || (error instanceof Error && error.name === "AbortError")
      ) {
        client.setQueryData(taskKey, { status: "cancelled", finishedAt: now() })
        return
      }
      input.onError?.(error, {
        directory: ref.directory,
        sessionID: ref.sessionID,
        phase: "reconcile",
      })
      client.setQueryData(taskKey, {
        status: "error",
        finishedAt: now(),
        // Non-sensitive code only
        code: error instanceof Error ? error.name : "error",
      })
      throw error
    }
  }

  const pumpDirectory = (directory: string) => {
    const normalized = directory.trim()
    const active = directoryActive.get(normalized) ?? 0
    if (active >= directoryConcurrency) return
    const queue = directoryQueues.get(normalized)
    if (!queue || queue.length === 0) return

    const ref = queue.shift()!
    directoryActive.set(normalized, active + 1)

    const key = flightKey(ref.directory, ref.sessionID)
    if (sessionFlights.has(key)) {
      directoryActive.set(normalized, (directoryActive.get(normalized) ?? 1) - 1)
      pumpDirectory(normalized)
      return
    }

    const identity = resolveIdentity(input)
    const epoch = controllerEpoch
    const abort = new AbortController()
    sessionAborts.set(key, abort)

    const flight = (async () => {
      try {
        await runSessionReconcile(ref, identity, epoch, abort.signal)
      } catch {
        // Errors already recorded on task query; do not rethrow into queue.
      } finally {
        sessionAborts.delete(key)
        sessionFlights.delete(key)
        directoryActive.set(
          normalized,
          Math.max(0, (directoryActive.get(normalized) ?? 1) - 1),
        )
        pumpDirectory(normalized)
      }
    })()
    sessionFlights.set(key, flight)
  }

  const enqueueSession = (ref: CompensationSessionRef) => {
    const directory = ref.directory.trim()
    const key = flightKey(directory, ref.sessionID)
    if (sessionFlights.has(key)) return
    let queue = directoryQueues.get(directory)
    if (!queue) {
      queue = []
      directoryQueues.set(directory, queue)
    }
    if (queue.some((item) => item.sessionID === ref.sessionID)) return
    queue.push({ directory, sessionID: ref.sessionID })
    pumpDirectory(directory)
  }

  const scheduleImmediateCompensation = (identity: {
    transport: string
    generation: number
  }) => {
    const viewedSessions = resolveViewedSessions()
    // Same universe as captureCheckpoints so busy/retry under
    // canonical-only directories is not skipped.
    const directories = listCompensationDirectories(identity, viewedSessions)

    for (const directory of directories) {
      // Includes listRetained scopes that have no canonical query entry yet.
      const activeScopes = listActiveCompensationScopes(identity, directory)

      const immediate = collectImmediateCompensationSessions({
        directory,
        activeScopes,
        viewedSessions,
        busyOrRetrySessionIDs: input.getBusyOrRetrySessionIDs(directory),
      })
      for (const ref of immediate) {
        enqueueSession(ref)
      }

      // Mark non-immediate cached sessions stale for observe-time ensure.
      for (const entry of cacheBudget.listCanonical({
        transport: identity.transport,
        generation: identity.generation,
        directory,
      })) {
        const key = flightKey(entry.scope.directory, entry.scope.sessionID)
        if (!immediate.some((r) => flightKey(r.directory, r.sessionID) === key)) {
          markStale(entry.scope.directory, entry.scope.sessionID)
        }
      }
    }
  }

  const onCompensation = (trigger: EventPipelineCompensationTrigger) => {
    if (destroyed) return
    // First ready / clean barrier: no disconnect gap → skip gap compensation.
    // Upstream ready edges that keep the socket open may still publish with
    // isReconnect:false; keep that lightweight no-op policy explicit.
    if (!trigger.isReconnect) {
      return
    }

    // Prefer probe (tests / pinned runtime) then live transport identity.
    const identity = {
      transport: (input.probe?.getTransport ?? getRuntimeTransportIdentity)(),
      generation: trigger.runtimeGeneration,
    }
    // Reject if generation already switched past the disconnect snapshot.
    const currentGen = (input.probe?.getGeneration ?? getRuntimeGeneration)()
    const currentTransport = (input.probe?.getTransport ?? getRuntimeTransportIdentity)()
    if (
      currentGen !== identity.generation
      || currentTransport !== identity.transport
    ) {
      cancelAll("generation_mismatch")
      return
    }

    scheduleImmediateCompensation(identity)
  }

  const scheduleObserveHeadCheck = (scope: TranscriptScope): void => {
    if (destroyed) return
    const directory = scope.directory.trim()
    const identity = resolveIdentity(input, scope)
    const transcriptScope = toTranscriptScope(
      { directory, sessionID: scope.sessionID },
      identity,
    )
    const cacheScope = toCacheScope(
      { directory, sessionID: scope.sessionID },
      identity,
    )
    const key = transcriptCacheScopeKey(cacheScope)
    const previous = observeHeadCheckedAt.get(key)
    if (previous && now() - previous.checkedAt < OBSERVE_HEAD_CHECK_TTL_MS) {
      return
    }
    if (observeHeadInFlight.has(key)) return
    if (sessionFlights.has(flightKey(directory, scope.sessionID))) return
    // Empty Query / no canonical: cold start already goes through network tail.
    if (!repository.hasSession?.(transcriptScope)) return
    const transcript = repository.getTranscript(transcriptScope)
    const tailMessageID = transcript.messageOrder[transcript.messageOrder.length - 1]
    if (!tailMessageID) return

    observeHeadInFlight.add(key)
    void (async () => {
      try {
        assertRuntimeCurrent(identity, input)
        if (destroyed) return
        const page = await fetchReconcile({
          sessionID: scope.sessionID,
          directory,
          anchor: tailMessageID,
        })
        assertRuntimeCurrent(identity, input)
        if (destroyed) return
        observeHeadCheckedAt.set(key, { checkedAt: now() })
        if (page.resetRequired) return
        if (page.complete && page.records.length === 0) return
        if (page.records.length === 0) return
        const capturedLiveRevision = repository.getTranscript(transcriptScope).liveRevision
        applyReconcilePage(transcriptScope, page, capturedLiveRevision)
      } catch {
        // Silent: never surface observe-time head-check failure as transcript error.
      } finally {
        observeHeadInFlight.delete(key)
      }
    })()
  }

  const ensureOnObserve = async (
    scope: TranscriptScope,
  ): Promise<TranscriptData | null> => {
    if (destroyed) return null
    const directory = scope.directory.trim()
    const key = flightKey(directory, scope.sessionID)
    if (!staleOnObserve.has(key)) {
      // Non-stale cached sessions still get a throttled reconcile head check.
      scheduleObserveHeadCheck(scope)
      return null
    }
    clearStale(directory, scope.sessionID)

    const identity = resolveIdentity(input, scope)
    const transcriptScope = toTranscriptScope(
      { directory, sessionID: scope.sessionID },
      identity,
    )
    const cacheScope = toCacheScope(
      { directory, sessionID: scope.sessionID },
      identity,
    )

    // Prefer full reconcile if we still have a pending checkpoint with anchor;
    // otherwise ensure authoritative tail.
    const checkpoint = readTranscriptRecoveryCheckpoint(client, cacheScope)
    if (checkpoint && checkpoint.state !== "complete" && checkpoint.anchorMessageID) {
      enqueueSession({ directory, sessionID: scope.sessionID })
      const flight = sessionFlights.get(key)
      if (flight) await flight
      return repository.getTranscript(transcriptScope)
    }

    try {
      assertRuntimeCurrent(identity, input)
      const data = await repository.ensureInitial(transcriptScope)
      clearTranscriptRecoveryCheckpoint(client, cacheScope)
      return data
    } catch (error) {
      input.onError?.(error, {
        directory,
        sessionID: scope.sessionID,
        phase: "ensure-on-observe",
      })
      throw error
    }
  }

  return {
    captureCheckpoints,
    onCompensation,
    ensureOnObserve,
    cancelAll,
    getCheckpoint: (scope) => {
      const identity = resolveIdentity(input, scope)
      return readTranscriptRecoveryCheckpoint(
        client,
        toCacheScope(
          { directory: scope.directory, sessionID: scope.sessionID },
          identity,
        ),
      )
    },
    isSessionInFlight: (directory, sessionID) =>
      sessionFlights.has(flightKey(directory, sessionID)),
    destroy: () => {
      destroyed = true
      cancelAll("destroy")
    },
  }
}

/** Re-export for tests that assert scope key identity. */
// transcriptCacheScopeKey stays internal to session-transcript-query-cache
// (Ticket 09: no re-export from compensation).
