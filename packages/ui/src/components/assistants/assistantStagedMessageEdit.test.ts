import { describe, expect, test } from "bun:test"
import {
  assistantStagedEditMatchesBinding,
  assistantStagedScopeKey,
  assistantStagedScopeOf,
  createAssistantStagedMessageEditRegistry,
  type AssistantStagedMessageEditIdentity,
  type AssistantStagedMessageEditRollback,
  type AssistantStagedMessageEditScope,
} from "./assistantStagedMessageEdit"

const identity = (
  overrides: Partial<AssistantStagedMessageEditIdentity> = {},
): AssistantStagedMessageEditIdentity => ({
  assistantID: "assistant-a",
  sessionID: "session-a",
  directory: "/workspace",
  sessionGeneration: 1,
  messageID: "msg_1",
  transport: "runtime-a",
  runtimeGeneration: 1,
  ...overrides,
})

const scopeOf = (
  overrides: Partial<AssistantStagedMessageEditIdentity> = {},
): AssistantStagedMessageEditScope => assistantStagedScopeOf(identity(overrides))

const binding = (overrides: Partial<AssistantStagedMessageEditIdentity> = {}) => {
  const full = identity(overrides)
  return {
    assistantID: full.assistantID,
    sessionID: full.sessionID,
    directory: full.directory,
    sessionGeneration: full.sessionGeneration,
    transport: full.transport,
    runtimeGeneration: full.runtimeGeneration,
  }
}

const noopRollback: AssistantStagedMessageEditRollback = async () => ({ status: "rolled-back" })

const rollbackOf = (
  status: "rolled-back" | "conflict" | "failed" | "skipped" | (() => Promise<{ status: "rolled-back" | "conflict" | "failed" | "skipped" }>),
): AssistantStagedMessageEditRollback => {
  if (typeof status === "function") return status
  return async () => ({ status })
}

describe("assistantStagedMessageEdit", () => {
  test("isolates A and B staged identities by transport+assistant scope", () => {
    const registry = createAssistantStagedMessageEditRegistry()
    const a = identity({ assistantID: "assistant-a", messageID: "msg_a" })
    const b = identity({ assistantID: "assistant-b", messageID: "msg_b", sessionID: "session-b" })
    registry.register(a, noopRollback)
    registry.register(b, noopRollback)
    expect(registry.read(scopeOf({ assistantID: "assistant-a" }))).toEqual(a)
    expect(registry.read(scopeOf({ assistantID: "assistant-b" }))).toEqual(b)
    registry.clear(scopeOf({ assistantID: "assistant-a" }))
    expect(registry.read(scopeOf({ assistantID: "assistant-a" }))).toBe(undefined)
    expect(registry.read(scopeOf({ assistantID: "assistant-b" }))).toEqual(b)
  })

  test("same assistantID on different transports do not block each other", () => {
    const registry = createAssistantStagedMessageEditRegistry()
    const oldTransport = identity({ transport: "runtime-old", messageID: "msg_old", runtimeGeneration: 1 })
    const newTransport = identity({ transport: "runtime-new", messageID: "msg_new", runtimeGeneration: 2 })
    registry.register(oldTransport, rollbackOf("failed"))
    registry.register(newTransport, noopRollback)
    expect(registry.read(scopeOf({ transport: "runtime-old" }))).toEqual(oldTransport)
    expect(registry.read(scopeOf({ transport: "runtime-new" }))).toEqual(newTransport)
    // Scope state remains independent across transports.
    expect(assistantStagedScopeKey(assistantStagedScopeOf(oldTransport)))
      .not.toBe(assistantStagedScopeKey(assistantStagedScopeOf(newTransport)))
  })

  test("rollbackAndClearIfBindingMismatch clears after successful rollback", async () => {
    const registry = createAssistantStagedMessageEditRegistry()
    const calls: string[] = []
    registry.register(
      identity(),
      async () => {
        calls.push("rollback")
        return { status: "rolled-back" }
      },
    )
    const result = await registry.rollbackAndClearIfBindingMismatch(
      scopeOf(),
      binding({ directory: "/other" }),
    )
    expect(result).toEqual({ kind: "cleared", status: "rolled-back" })
    expect(calls).toEqual(["rollback"])
    expect(registry.read(scopeOf())).toBe(undefined)
  })

  test("rollbackAndClearIfBindingMismatch retains on failed/skipped", async () => {
    const registry = createAssistantStagedMessageEditRegistry()
    const staged = identity()
    registry.register(staged, rollbackOf("failed"))
    const failed = await registry.rollbackAndClearIfBindingMismatch(
      scopeOf(),
      binding({ directory: "/other" }),
    )
    expect(failed).toEqual({ kind: "rollback_failed", retained: true, status: "failed" })
    expect(registry.read(scopeOf())).toEqual(staged)

    registry.clear(scopeOf())
    registry.register(staged, rollbackOf("skipped"))
    const skipped = await registry.rollbackAndClearIfBindingMismatch(
      scopeOf(),
      binding({ directory: "/other" }),
    )
    expect(skipped).toEqual({ kind: "rollback_failed", retained: true, status: "skipped" })
    expect(registry.read(scopeOf())).toEqual(staged)
  })

  test("rollbackAndClearIfBindingMismatch does not clear a concurrent re-register", async () => {
    const registry = createAssistantStagedMessageEditRegistry()
    let releaseRollback!: () => void
    const rollbackGate = new Promise<void>((resolve) => {
      releaseRollback = resolve
    })
    const oldIdentity = identity({ messageID: "msg_old" })
    const newIdentity = identity({ messageID: "msg_new" })
    registry.register(
      oldIdentity,
      async () => {
        await rollbackGate
        return { status: "rolled-back" }
      },
    )
    const pending = registry.rollbackAndClearIfBindingMismatch(
      scopeOf(),
      binding({ directory: "/other" }),
    )
    // Wait until exclusive body has captured the old entry and entered rollback.
    for (let i = 0; i < 10; i++) await Promise.resolve()
    registry.register(newIdentity, noopRollback)
    releaseRollback()
    const result = await pending
    expect(result).toEqual({ kind: "superseded" })
    expect(registry.read(scopeOf())).toEqual(newIdentity)
  })

  test("rollbackAndClearIfBindingMismatch returns match when binding still equals", async () => {
    const registry = createAssistantStagedMessageEditRegistry()
    registry.register(identity(), async () => {
      throw new Error("should-not-rollback")
    })
    const result = await registry.rollbackAndClearIfBindingMismatch(scopeOf(), binding())
    expect(result).toEqual({ kind: "match" })
    expect(registry.read(scopeOf())).toBeDefined()
  })

  test("rollbackAllBestEffort clears safe entries and retains failed", async () => {
    const registry = createAssistantStagedMessageEditRegistry()
    registry.register(
      identity({ assistantID: "assistant-a", messageID: "msg_a" }),
      rollbackOf("rolled-back"),
    )
    registry.register(
      identity({ assistantID: "assistant-b", messageID: "msg_b", sessionID: "session-b" }),
      rollbackOf("failed"),
    )
    await registry.rollbackAllBestEffort()
    expect(registry.read(scopeOf({ assistantID: "assistant-a" }))).toBe(undefined)
    expect(registry.read(scopeOf({ assistantID: "assistant-b" }))?.messageID).toBe("msg_b")
  })

  test("rollbackAllBestEffort can exclude current transport", async () => {
    const registry = createAssistantStagedMessageEditRegistry()
    registry.register(
      identity({ transport: "runtime-current", messageID: "msg_current" }),
      rollbackOf("rolled-back"),
    )
    registry.register(
      identity({ transport: "runtime-old", messageID: "msg_old" }),
      rollbackOf("rolled-back"),
    )
    await registry.rollbackAllBestEffort({ excludeTransport: "runtime-current" })
    expect(registry.read(scopeOf({ transport: "runtime-current" }))?.messageID).toBe("msg_current")
    expect(registry.read(scopeOf({ transport: "runtime-old" }))).toBe(undefined)
  })

  test("returning to old transport re-enters rollback for retained entry", async () => {
    const registry = createAssistantStagedMessageEditRegistry()
    const oldIdentity = identity({ transport: "runtime-old", sessionGeneration: 1, messageID: "msg_old" })
    registry.register(oldIdentity, rollbackOf("failed"))
    // Switch away: exclude current (new) transport — old entry stays if rollback fails.
    await registry.rollbackAllBestEffort({ excludeTransport: "runtime-new" })
    // failed rollback on old: still retained (rollbackAllBestEffort only clears safe).
    // Register a failed entry that survives exclude path (no call to its rollback when exclude is old? 
    // excludeTransport excludes matching transport from rollback — old is NOT excluded so it was rolled).
    // Re-register failed for return path:
    registry.register(oldIdentity, rollbackOf("failed"))
    const liveMismatch = binding({ transport: "runtime-old", sessionGeneration: 2 })
    const result = await registry.rollbackAndClearIfBindingMismatch(
      scopeOf({ transport: "runtime-old" }),
      liveMismatch,
    )
    expect(result).toEqual({ kind: "rollback_failed", retained: true, status: "failed" })
    expect(registry.read(scopeOf({ transport: "runtime-old" }))).toEqual(oldIdentity)
  })

  test("assistantStagedEditMatchesBinding requires full composite equality", () => {
    const staged = identity()
    expect(assistantStagedEditMatchesBinding(staged, binding())).toBe(true)
    expect(assistantStagedEditMatchesBinding(staged, binding({ transport: "other" }))).toBe(false)
    expect(assistantStagedEditMatchesBinding(staged, binding({ runtimeGeneration: 9 }))).toBe(false)
  })

  test("stageExclusive retires prior entry before registering new", async () => {
    const registry = createAssistantStagedMessageEditRegistry()
    const rollbacks: string[] = []
    registry.register(
      identity({ messageID: "msg_old" }),
      async () => {
        rollbacks.push("old")
        return { status: "rolled-back" }
      },
    )
    const result = await registry.stageExclusive(scopeOf(), async () => ({
      identity: identity({ messageID: "msg_new" }),
      rollback: async () => {
        rollbacks.push("new")
        return { status: "rolled-back" as const }
      },
    }))
    expect(result.kind).toBe("registered")
    expect(rollbacks).toEqual(["old"])
    expect(registry.read(scopeOf())?.messageID).toBe("msg_new")
  })

  test("stageExclusive blocks when prior rollback fails", async () => {
    const registry = createAssistantStagedMessageEditRegistry()
    const prior = identity({ messageID: "msg_prior" })
    registry.register(prior, rollbackOf("failed"))
    let staged = false
    const result = await registry.stageExclusive(scopeOf(), async () => {
      staged = true
      return {
        identity: identity({ messageID: "msg_new" }),
        rollback: noopRollback,
      }
    })
    expect(result).toEqual({ kind: "blocked", status: "failed" })
    expect(staged).toBe(false)
    expect(registry.read(scopeOf())).toEqual(prior)
  })

  test("stageExclusive stale protect registers handle and returns stale_protected", async () => {
    const registry = createAssistantStagedMessageEditRegistry()
    const result = await registry.stageExclusive(scopeOf(), async () => ({
      identity: identity({ messageID: "msg_stale" }),
      rollback: rollbackOf("failed"),
      protectOnStale: true,
    }))
    expect(result.kind).toBe("stale_protected")
    expect(registry.read(scopeOf())?.messageID).toBe("msg_stale")
  })

  test("clearExclusive serializes with in-flight stageExclusive so final entry is cleared", async () => {
    const registry = createAssistantStagedMessageEditRegistry()
    const order: string[] = []
    let releaseStage!: () => void
    const stageGate = new Promise<void>((resolve) => {
      releaseStage = resolve
    })

    const stagePromise = registry.stageExclusive(scopeOf(), async () => {
      order.push("stage-start")
      await stageGate
      order.push("stage-end")
      return {
        identity: identity({ messageID: "msg_late" }),
        rollback: noopRollback,
      }
    })

    // Start clear while stage holds exclusive — must wait until stage registers then clear.
    const clearPromise = registry.clearExclusive(scopeOf())
    await Promise.resolve()
    await Promise.resolve()
    releaseStage()
    await stagePromise
    await clearPromise
    expect(order).toEqual(["stage-start", "stage-end"])
    expect(registry.read(scopeOf())).toBe(undefined)
  })

  test("concurrent stages on same scope have deterministic order via exclusive", async () => {
    const registry = createAssistantStagedMessageEditRegistry()
    const order: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = registry.stageExclusive(scopeOf(), async () => {
      order.push("first-start")
      await firstGate
      order.push("first-end")
      return {
        identity: identity({ messageID: "msg_first" }),
        rollback: async () => {
          order.push("first-rollback")
          return { status: "rolled-back" as const }
        },
      }
    })

    const second = registry.stageExclusive(scopeOf(), async () => {
      order.push("second-start")
      return {
        identity: identity({ messageID: "msg_second" }),
        rollback: noopRollback,
      }
    })

    await Promise.resolve()
    await Promise.resolve()
    releaseFirst()
    await first
    await second
    expect(order).toEqual(["first-start", "first-end", "first-rollback", "second-start"])
    expect(registry.read(scopeOf())?.messageID).toBe("msg_second")
  })

  test("rollbackAndClearIfBindingMismatch serializes with stageExclusive on same scope", async () => {
    const registry = createAssistantStagedMessageEditRegistry()
    const order: string[] = []
    let releaseRollback!: () => void
    const rollbackGate = new Promise<void>((resolve) => {
      releaseRollback = resolve
    })
    registry.register(
      identity({ messageID: "msg_old" }),
      async () => {
        order.push("rollback-start")
        await rollbackGate
        order.push("rollback-end")
        return { status: "rolled-back" as const }
      },
    )
    const rollbackPromise = registry.rollbackAndClearIfBindingMismatch(
      scopeOf(),
      binding({ directory: "/other" }),
    )
    const stagePromise = registry.stageExclusive(scopeOf(), async () => {
      order.push("stage")
      return {
        identity: identity({ messageID: "msg_new" }),
        rollback: noopRollback,
      }
    })
    await Promise.resolve()
    await Promise.resolve()
    releaseRollback()
    await rollbackPromise
    await stagePromise
    expect(order).toEqual(["rollback-start", "rollback-end", "stage"])
    expect(registry.read(scopeOf())?.messageID).toBe("msg_new")
  })

  test("rollbackAllBestEffort serializes with concurrent stage on same scope", async () => {
    const registry = createAssistantStagedMessageEditRegistry()
    const order: string[] = []
    let releaseRollback!: () => void
    const rollbackGate = new Promise<void>((resolve) => {
      releaseRollback = resolve
    })
    registry.register(
      identity({ messageID: "msg_old" }),
      async () => {
        order.push("all-rollback-start")
        await rollbackGate
        order.push("all-rollback-end")
        return { status: "rolled-back" as const }
      },
    )
    const allPromise = registry.rollbackAllBestEffort()
    const stagePromise = registry.stageExclusive(scopeOf(), async () => {
      order.push("stage-after-all")
      return {
        identity: identity({ messageID: "msg_after" }),
        rollback: noopRollback,
      }
    })
    await Promise.resolve()
    await Promise.resolve()
    releaseRollback()
    await allPromise
    await stagePromise
    expect(order).toEqual(["all-rollback-start", "all-rollback-end", "stage-after-all"])
    expect(registry.read(scopeOf())?.messageID).toBe("msg_after")
  })

})
