/**
 * Per-assistant continuous staged sent-message edit registry.
 * Composite identity: assistantID + session binding + runtime. No React.
 *
 * Entries pair identity with a CAS rollback adapter so binding invalidation
 * never clears the registry while leaving a restored edit body in the surface
 * draft (which would admit as a plain new message on the next send).
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

export type AssistantStagedMessageEditEntry = {
  identity: AssistantStagedMessageEditIdentity
  rollback: AssistantStagedMessageEditRollback
}

type AssistantStagedBinding = {
  assistantID: string
  sessionID: string
  directory: string
  sessionGeneration: number
  transport: string
  runtimeGeneration: number
}

export type AssistantStagedCommitBeforeSendResult =
  | { kind: "none" }
  | { kind: "mismatch"; cleared: true }
  | { kind: "rollback_failed"; retained: true; status: "failed" | "skipped" }
  | { kind: "committed"; messageID: string; sessionID: string }
  | { kind: "commit_failed"; error: unknown; retained: true }

export type AssistantStagedRollbackClearResult =
  | { kind: "none" }
  | { kind: "match" }
  /** Concurrent register replaced this entry; old rollback must not clear the new one. */
  | { kind: "superseded" }
  | { kind: "cleared"; status: "rolled-back" | "conflict" }
  | { kind: "rollback_failed"; retained: true; status: "failed" | "skipped" }

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

export const assistantStagedIdentityEquals = (
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
  const byAssistant = new Map<string, AssistantStagedMessageEditEntry>()

  const register = (
    identity: AssistantStagedMessageEditIdentity,
    rollback: AssistantStagedMessageEditRollback,
  ): void => {
    byAssistant.set(identity.assistantID, { identity, rollback })
  }

  /** Public read returns identity only; use readEntry when the rollback handle is needed. */
  const read = (assistantID: string): AssistantStagedMessageEditIdentity | undefined =>
    byAssistant.get(assistantID)?.identity

  const readEntry = (assistantID: string): AssistantStagedMessageEditEntry | undefined =>
    byAssistant.get(assistantID)

  const clear = (assistantID: string): boolean => byAssistant.delete(assistantID)

  const clearAll = (): void => {
    byAssistant.clear()
  }

  /**
   * Clears only when the registered identity still matches the expected one
   * (same message/session). A newer stage for the same assistant is retained.
   */
  const clearIfMatches = (
    assistantID: string,
    expected: Pick<AssistantStagedMessageEditIdentity, "messageID" | "sessionID">,
  ): boolean => {
    const still = byAssistant.get(assistantID)
    if (!still) return false
    if (still.identity.messageID !== expected.messageID || still.identity.sessionID !== expected.sessionID) {
      return false
    }
    byAssistant.delete(assistantID)
    return true
  }

  /**
   * Clears identity only when live binding diverges (no draft rollback).
   * Prefer rollbackAndClearIfBindingMismatch for invalidation paths that must
   * not leave a restored edit body unprotected in the surface draft.
   */
  const clearIfBindingMismatch = (
    assistantID: string,
    live: AssistantStagedBinding,
  ): boolean => {
    const staged = byAssistant.get(assistantID)
    if (!staged) return false
    if (assistantStagedEditMatchesBinding(staged.identity, live)) return false
    byAssistant.delete(assistantID)
    return true
  }

  /**
   * When the registered entry no longer matches live binding/runtime:
   * invoke its CAS rollback, then clear only if the same identity is still
   * registered. rolled-back/conflict → safe clear; failed/skipped → retain.
   * Concurrent register of a newer identity is never cleared by an older rollback.
   */
  const rollbackAndClearIfBindingMismatch = async (
    assistantID: string,
    live: AssistantStagedBinding,
  ): Promise<AssistantStagedRollbackClearResult> => {
    const entry = byAssistant.get(assistantID)
    if (!entry) return { kind: "none" }
    if (assistantStagedEditMatchesBinding(entry.identity, live)) return { kind: "match" }

    const expected = entry.identity
    const rolled = await entry.rollback()

    const current = byAssistant.get(assistantID)
    if (!current || !assistantStagedIdentityEquals(current.identity, expected)) {
      return { kind: "superseded" }
    }

    if (rolled.status === "rolled-back" || rolled.status === "conflict") {
      byAssistant.delete(assistantID)
      return { kind: "cleared", status: rolled.status }
    }

    return { kind: "rollback_failed", retained: true, status: rolled.status }
  }

  /**
   * Best-effort rollback every entry, clearing only safe outcomes.
   * failed/skipped entries stay registered so send continues to block.
   */
  const rollbackAllBestEffort = async (): Promise<void> => {
    const snapshot = [...byAssistant.entries()]
    await Promise.all(snapshot.map(async ([assistantID, entry]) => {
      const expected = entry.identity
      try {
        const rolled = await entry.rollback()
        const current = byAssistant.get(assistantID)
        if (!current || !assistantStagedIdentityEquals(current.identity, expected)) return
        if (rolled.status === "rolled-back" || rolled.status === "conflict") {
          byAssistant.delete(assistantID)
        }
      } catch {
        // Retain entry on rejection so backend can keep blocking mismatch sends.
      }
    }))
  }

  /**
   * Commit-before-send coordination for continuous Assistant backend.send.
   * - no staged → none
   * - staged but binding mismatch → rollback then clear on safe status (mismatch);
   *   rollback failure retains entry (rollback_failed) so the next send cannot
   *   admit the restored body as a plain new message
   * - match → commit; on failure retain stage and surface error
   * - success → conditional clear of the committed identity
   */
  const commitBeforeSend = async (
    assistantID: string,
    live: AssistantStagedBinding,
    commit: (staged: AssistantStagedMessageEditIdentity) => Promise<void>,
    options?: { commitStagedMessageEdit?: boolean },
  ): Promise<AssistantStagedCommitBeforeSendResult> => {
    if (!options?.commitStagedMessageEdit) return { kind: "none" }
    const entry = byAssistant.get(assistantID)
    if (!entry) return { kind: "none" }
    if (!assistantStagedEditMatchesBinding(entry.identity, live)) {
      const rolled = await rollbackAndClearIfBindingMismatch(assistantID, live)
      if (rolled.kind === "rollback_failed") {
        return { kind: "rollback_failed", retained: true, status: rolled.status }
      }
      // cleared | none | superseded | match-after-race: block this send.
      // A concurrent re-stage can be committed on the next send attempt.
      return { kind: "mismatch", cleared: true }
    }
    const staged = entry.identity
    try {
      await commit(staged)
    } catch (error) {
      return { kind: "commit_failed", error, retained: true }
    }
    clearIfMatches(assistantID, { messageID: staged.messageID, sessionID: staged.sessionID })
    return { kind: "committed", messageID: staged.messageID, sessionID: staged.sessionID }
  }

  return {
    register,
    read,
    readEntry,
    clear,
    clearAll,
    clearIfMatches,
    clearIfBindingMismatch,
    rollbackAndClearIfBindingMismatch,
    rollbackAllBestEffort,
    commitBeforeSend,
  }
}
