/**
 * Per-assistant continuous staged sent-message edit registry.
 * Composite identity: assistantID + session binding + runtime. No React.
 *
 * Scope (Map key): transport + assistantID. Entry identity still carries
 * runtimeGeneration / message / session / directory so same assistant on a
 * different transport keeps independent cleanup state, and returning to an old
 * transport re-enters best-effort binding rollback for that entry.
 *
 * Entries pair identity with a CAS rollback adapter so binding invalidation
 * can clean the restored edit body while preserving concurrent draft changes.
 *
 * Same-scope mutations serialize via runExclusive so continuous stage cannot
 * overwrite an unretired entry while cleanup is in flight.
 * Binding-changing clear paths use clearExclusive; ordinary send uses immediate
 * clear so restoration coordination stays outside delivery.
 */

export type AssistantStagedMessageEditIdentity = {
  assistantID: string
  sessionID: string
  directory: string
  sessionGeneration: number
  messageID: string
  transport: string
  runtimeGeneration: number
}

/** Adapter over StageMessageEditHandle.rollback (CAS restore of pre-stage draft/absence). */
export type AssistantStagedMessageEditRollback = () => Promise<{
  status: "rolled-back" | "conflict" | "failed" | "skipped"
}>

export type AssistantStagedMessageEditScope = {
  transport: string
  assistantID: string
}

type AssistantStagedMessageEditEntry = {
  identity: AssistantStagedMessageEditIdentity
  rollback: AssistantStagedMessageEditRollback
  /** Monotonic token for this scope; rollback cleanup compares token and identity. */
  token: number
}

type AssistantStagedBinding = {
  assistantID: string
  sessionID: string
  directory: string
  sessionGeneration: number
  transport: string
  runtimeGeneration: number
}

type AssistantStagedRollbackClearResult =
  | { kind: "none" }
  | { kind: "match" }
  /** Concurrent register replaced this entry; old rollback must not clear the new one. */
  | { kind: "superseded" }
  | { kind: "cleared"; status: "rolled-back" | "conflict" }
  | { kind: "rollback_failed"; retained: true; status: "failed" | "skipped" }

/** Outcome of retiring the previous same-scope entry before a new stage. */
type AssistantStagedRetireResult =
  | { kind: "none" }
  | { kind: "cleared"; status: "rolled-back" | "conflict" }
  | { kind: "blocked"; status: "failed" | "skipped" }
  | { kind: "superseded" }

export const assistantStagedScopeKey = (
  scope: AssistantStagedMessageEditScope,
): string => `${scope.transport}\u0000${scope.assistantID}`

export const assistantStagedScopeOf = (
  identity: Pick<AssistantStagedMessageEditIdentity, "transport" | "assistantID">,
): AssistantStagedMessageEditScope => ({
  transport: identity.transport,
  assistantID: identity.assistantID,
})

export const assistantStagedEditMatchesBinding = (
  staged: AssistantStagedMessageEditIdentity,
  binding: AssistantStagedBinding,
): boolean => (
  staged.assistantID === binding.assistantID
  && staged.sessionID === binding.sessionID
  && staged.directory === binding.directory
  && staged.sessionGeneration === binding.sessionGeneration
  && staged.transport === binding.transport
  && staged.runtimeGeneration === binding.runtimeGeneration
)

const assistantStagedIdentityEquals = (
  a: AssistantStagedMessageEditIdentity,
  b: AssistantStagedMessageEditIdentity,
): boolean => (
  a.assistantID === b.assistantID
  && a.sessionID === b.sessionID
  && a.directory === b.directory
  && a.sessionGeneration === b.sessionGeneration
  && a.messageID === b.messageID
  && a.transport === b.transport
  && a.runtimeGeneration === b.runtimeGeneration
)

export const createAssistantStagedMessageEditRegistry = () => {
  const byScope = new Map<string, AssistantStagedMessageEditEntry>()
  /** Per-scope serial chain so stage and rollback share one order. */
  const exclusiveTails = new Map<string, Promise<unknown>>()
  let nextToken = 1

  const scopeKeyOf = (scope: AssistantStagedMessageEditScope): string =>
    assistantStagedScopeKey(scope)

  const runExclusive = async <T>(
    scope: AssistantStagedMessageEditScope,
    fn: () => Promise<T> | T,
  ): Promise<T> => {
    const key = scopeKeyOf(scope)
    const previous = exclusiveTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.catch(() => undefined).then(() => gate)
    exclusiveTails.set(key, tail)
    await previous.catch(() => undefined)
    try {
      return await fn()
    } finally {
      release()
      if (exclusiveTails.get(key) === tail) exclusiveTails.delete(key)
    }
  }

  /**
   * Unconditional register for the scope (overwrites Map slot).
   * Continuous stage paths use stageExclusive.
   */
  const register = (
    identity: AssistantStagedMessageEditIdentity,
    rollback: AssistantStagedMessageEditRollback,
  ): number => {
    const key = scopeKeyOf(assistantStagedScopeOf(identity))
    const token = nextToken++
    byScope.set(key, { identity, rollback, token })
    return token
  }

  /** Read the staged identity for diagnostics and coordination tests. */
  const read = (scope: AssistantStagedMessageEditScope): AssistantStagedMessageEditIdentity | undefined =>
    byScope.get(scopeKeyOf(scope))?.identity

  /**
   * Immediate marker clear used by ordinary send so cleanup cannot delay delivery.
   */
  const clear = (scope: AssistantStagedMessageEditScope): boolean =>
    byScope.delete(scopeKeyOf(scope))

  /**
   * Production clear: run under the scope exclusive lane so an in-flight stage
   * cannot complete and re-register after this clear returns.
   */
  const clearExclusive = async (scope: AssistantStagedMessageEditScope): Promise<boolean> =>
    runExclusive(scope, () => clear(scope))
  /**
   * Safely retire the current same-scope entry before a new stage.
   * rolled-back/conflict → clear; failed/skipped → retain and block new stage.
   */
  const retireCurrent = async (
    scope: AssistantStagedMessageEditScope,
  ): Promise<AssistantStagedRetireResult> => {
    const key = scopeKeyOf(scope)
    const entry = byScope.get(key)
    if (!entry) return { kind: "none" }

    const expectedToken = entry.token
    const expectedIdentity = entry.identity
    let rolled: { status: "rolled-back" | "conflict" | "failed" | "skipped" }
    try {
      rolled = await entry.rollback()
    } catch {
      return { kind: "blocked", status: "failed" }
    }

    const current = byScope.get(key)
    if (!current || current.token !== expectedToken || !assistantStagedIdentityEquals(current.identity, expectedIdentity)) {
      return { kind: "superseded" }
    }

    if (rolled.status === "rolled-back" || rolled.status === "conflict") {
      byScope.delete(key)
      return { kind: "cleared", status: rolled.status }
    }

    return { kind: "blocked", status: rolled.status }
  }

  /**
   * Unlocked body for binding-mismatch rollback+clear (must run under runExclusive
   * for the scope.
   */
  const rollbackAndClearIfBindingMismatchUnlocked = async (
    scope: AssistantStagedMessageEditScope,
    live: AssistantStagedBinding,
  ): Promise<AssistantStagedRollbackClearResult> => {
    const key = scopeKeyOf(scope)
    const entry = byScope.get(key)
    if (!entry) return { kind: "none" }
    if (assistantStagedEditMatchesBinding(entry.identity, live)) return { kind: "match" }

    const expectedToken = entry.token
    const expected = entry.identity
    const rolled = await entry.rollback()

    const current = byScope.get(key)
    if (
      !current
      || current.token !== expectedToken
      || !assistantStagedIdentityEquals(current.identity, expected)
    ) {
      return { kind: "superseded" }
    }

    if (rolled.status === "rolled-back" || rolled.status === "conflict") {
      byScope.delete(key)
      return { kind: "cleared", status: rolled.status }
    }

    return { kind: "rollback_failed", retained: true, status: rolled.status }
  }

  /**
   * When the registered entry no longer matches live binding/runtime:
   * invoke its CAS rollback, then clear only if the same identity/token is still
   * registered. rolled-back/conflict → safe clear; failed/skipped → retain.
   * Concurrent register of a newer identity is never cleared by an older rollback.
   * Serialized per scope with stage.
   */
  const rollbackAndClearIfBindingMismatch = async (
    scope: AssistantStagedMessageEditScope,
    live: AssistantStagedBinding,
  ): Promise<AssistantStagedRollbackClearResult> => (
    runExclusive(scope, () => rollbackAndClearIfBindingMismatchUnlocked(scope, live))
  )

  /**
   * Best-effort rollback every entry, clearing only safe outcomes.
   * failed/skipped entries stay registered for later best-effort cleanup.
   * Optional transport filter: runtime switch may pass all transports;
   * callers that only care about foreign transports can filter.
   * Each entry runs under that scope's exclusive lane.
   */
  const rollbackAllBestEffort = async (
    options?: { excludeTransport?: string },
  ): Promise<void> => {
    const snapshot = [...byScope.entries()]
    await Promise.all(snapshot.map(async ([, entry]) => {
      if (options?.excludeTransport !== undefined && entry.identity.transport === options.excludeTransport) {
        return
      }
      const scope = assistantStagedScopeOf(entry.identity)
      await runExclusive(scope, async () => {
        const key = scopeKeyOf(scope)
        const live = byScope.get(key)
        if (!live || live.token !== entry.token) return
        const expectedToken = live.token
        const expected = live.identity
        try {
          const rolled = await live.rollback()
          const current = byScope.get(key)
          if (
            !current
            || current.token !== expectedToken
            || !assistantStagedIdentityEquals(current.identity, expected)
          ) {
            return
          }
          if (rolled.status === "rolled-back" || rolled.status === "conflict") {
            byScope.delete(key)
          }
        } catch {
          // Retain entry for a later best-effort cleanup attempt.
        }
      })
    }))
  }

  /**
   * Continuous stage path: exclusive per scope, retire prior entry safely, then
   * run stageFn and register the new handle. failed/skipped prior blocks new stage.
   */
  const stageExclusive = async (
    scope: AssistantStagedMessageEditScope,
    stageFn: () => Promise<{
      identity: AssistantStagedMessageEditIdentity
      rollback: AssistantStagedMessageEditRollback
      /** When true, register even if live binding is stale (protect restored body). */
      protectOnStale?: boolean
    } | null>,
  ): Promise<
    | { kind: "registered"; token: number; identity: AssistantStagedMessageEditIdentity }
    | { kind: "blocked"; status: "failed" | "skipped" }
    | { kind: "skipped" }
    | { kind: "stale_protected"; token: number; identity: AssistantStagedMessageEditIdentity }
  > => {
    return runExclusive(scope, async () => {
      const retired = await retireCurrent(scope)
      if (retired.kind === "blocked") {
        return { kind: "blocked" as const, status: retired.status }
      }

      const staged = await stageFn()
      if (!staged) return { kind: "skipped" as const }

      const token = register(staged.identity, staged.rollback)
      if (staged.protectOnStale) {
        return {
          kind: "stale_protected" as const,
          token,
          identity: staged.identity,
        }
      }
      return {
        kind: "registered" as const,
        token,
        identity: staged.identity,
      }
    })
  }

  return {
    register,
    read,
    clear,
    clearExclusive,
    retireCurrent,
    rollbackAndClearIfBindingMismatch,
    rollbackAllBestEffort,
    stageExclusive,
  }
}
