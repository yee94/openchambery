import { describe, expect, test } from "bun:test"
import {
  assistantStagedEditMatchesBinding,
  createAssistantStagedMessageEditRegistry,
  type AssistantStagedMessageEditIdentity,
  type AssistantStagedMessageEditRollback,
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
  test("isolates A and B staged identities", () => {
    const registry = createAssistantStagedMessageEditRegistry()
    const a = identity({ assistantID: "assistant-a", messageID: "msg_a" })
    const b = identity({ assistantID: "assistant-b", messageID: "msg_b", sessionID: "session-b" })
    registry.register(a, noopRollback)
    registry.register(b, noopRollback)
    expect(registry.read("assistant-a")).toEqual(a)
    expect(registry.read("assistant-b")).toEqual(b)
    expect(registry.readEntry("assistant-a")?.identity).toEqual(a)
    registry.clear("assistant-a")
    expect(registry.read("assistant-a")).toBe(undefined)
    expect(registry.read("assistant-b")).toEqual(b)
  })

  test("matching identity commits before send and clears the committed stage", async () => {
    const registry = createAssistantStagedMessageEditRegistry()
    const staged = identity()
    registry.register(staged, noopRollback)
    const order: string[] = []
    const result = await registry.commitBeforeSend(
      "assistant-a",
      binding(),
      async (entry) => {
        order.push(`commit:${entry.messageID}`)
      },
      { commitStagedMessageEdit: true },
    )
    order.push("after")
    expect(result).toEqual({ kind: "committed", messageID: "msg_1", sessionID: "session-a" })
    expect(order).toEqual(["commit:msg_1", "after"])
    expect(registry.read("assistant-a")).toBe(undefined)
  })

  test("commit failure retains stage and surfaces error without send side-effects", async () => {
    const registry = createAssistantStagedMessageEditRegistry()
    const staged = identity()
    registry.register(staged, noopRollback)
    let sendWouldRun = false
    const result = await registry.commitBeforeSend(
      "assistant-a",
      binding(),
      async () => {
        throw new Error("delete-failed")
      },
      { commitStagedMessageEdit: true },
    )
    if (result.kind === "committed") sendWouldRun = true
    expect(result.kind).toBe("commit_failed")
    if (result.kind === "commit_failed") {
      expect(result.retained).toBe(true)
      expect((result.error as Error).message).toBe("delete-failed")
    }
    expect(sendWouldRun).toBe(false)
    expect(registry.read("assistant-a")).toEqual(staged)
  })

  test("binding mismatch rolls back then clears on safe status and does not commit", async () => {
    const registry = createAssistantStagedMessageEditRegistry()
    const calls: string[] = []
    registry.register(
      identity({ sessionGeneration: 1 }),
      async () => {
        calls.push("rollback")
        return { status: "rolled-back" }
      },
    )
    let committed = false
    const result = await registry.commitBeforeSend(
      "assistant-a",
      binding({ sessionGeneration: 2 }),
      async () => {
        committed = true
      },
      { commitStagedMessageEdit: true },
    )
    expect(result).toEqual({ kind: "mismatch", cleared: true })
    expect(committed).toBe(false)
    expect(calls).toEqual(["rollback"])
    expect(registry.read("assistant-a")).toBe(undefined)
  })

  test("binding mismatch conflict is treated as safe clear", async () => {
    const registry = createAssistantStagedMessageEditRegistry()
    registry.register(identity({ sessionGeneration: 1 }), rollbackOf("conflict"))
    const result = await registry.commitBeforeSend(
      "assistant-a",
      binding({ sessionGeneration: 2 }),
      async () => {},
      { commitStagedMessageEdit: true },
    )
    expect(result).toEqual({ kind: "mismatch", cleared: true })
    expect(registry.read("assistant-a")).toBe(undefined)
  })

  test("binding mismatch rollback failure retains entry and blocks subsequent send", async () => {
    const registry = createAssistantStagedMessageEditRegistry()
    const staged = identity({ sessionGeneration: 1 })
    registry.register(staged, rollbackOf("failed"))
    const live = binding({ sessionGeneration: 2 })
    const first = await registry.commitBeforeSend(
      "assistant-a",
      live,
      async () => {},
      { commitStagedMessageEdit: true },
    )
    expect(first).toEqual({ kind: "rollback_failed", retained: true, status: "failed" })
    expect(registry.read("assistant-a")).toEqual(staged)

    const second = await registry.commitBeforeSend(
      "assistant-a",
      live,
      async () => {},
      { commitStagedMessageEdit: true },
    )
    expect(second).toEqual({ kind: "rollback_failed", retained: true, status: "failed" })
    expect(registry.read("assistant-a")).toEqual(staged)
  })

  test("without commitStagedMessageEdit flag, staged is neither committed nor cleared", async () => {
    const registry = createAssistantStagedMessageEditRegistry()
    const staged = identity()
    registry.register(staged, noopRollback)
    let committed = false
    const result = await registry.commitBeforeSend(
      "assistant-a",
      binding(),
      async () => {
        committed = true
      },
    )
    expect(result).toEqual({ kind: "none" })
    expect(committed).toBe(false)
    expect(registry.read("assistant-a")).toEqual(staged)
  })

  test("conditional clear does not remove a newer identity", () => {
    const registry = createAssistantStagedMessageEditRegistry()
    registry.register(identity({ messageID: "msg_old", sessionID: "session-a" }), noopRollback)
    registry.register(identity({ messageID: "msg_new", sessionID: "session-a" }), noopRollback)
    expect(registry.clearIfMatches("assistant-a", { messageID: "msg_old", sessionID: "session-a" })).toBe(false)
    expect(registry.read("assistant-a")?.messageID).toBe("msg_new")
    expect(registry.clearIfMatches("assistant-a", { messageID: "msg_new", sessionID: "session-a" })).toBe(true)
    expect(registry.read("assistant-a")).toBe(undefined)
  })

  test("clearIfBindingMismatch only removes when live binding diverges", () => {
    const registry = createAssistantStagedMessageEditRegistry()
    registry.register(identity(), noopRollback)
    expect(registry.clearIfBindingMismatch("assistant-a", binding())).toBe(false)
    expect(registry.read("assistant-a")).toBeDefined()
    expect(registry.clearIfBindingMismatch("assistant-a", binding({ directory: "/other" }))).toBe(true)
    expect(registry.read("assistant-a")).toBe(undefined)
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
      "assistant-a",
      binding({ directory: "/other" }),
    )
    expect(result).toEqual({ kind: "cleared", status: "rolled-back" })
    expect(calls).toEqual(["rollback"])
    expect(registry.read("assistant-a")).toBe(undefined)
  })

  test("rollbackAndClearIfBindingMismatch retains on failed/skipped", async () => {
    const registry = createAssistantStagedMessageEditRegistry()
    const staged = identity()
    registry.register(staged, rollbackOf("failed"))
    const failed = await registry.rollbackAndClearIfBindingMismatch(
      "assistant-a",
      binding({ directory: "/other" }),
    )
    expect(failed).toEqual({ kind: "rollback_failed", retained: true, status: "failed" })
    expect(registry.read("assistant-a")).toEqual(staged)

    registry.clear("assistant-a")
    registry.register(staged, rollbackOf("skipped"))
    const skipped = await registry.rollbackAndClearIfBindingMismatch(
      "assistant-a",
      binding({ directory: "/other" }),
    )
    expect(skipped).toEqual({ kind: "rollback_failed", retained: true, status: "skipped" })
    expect(registry.read("assistant-a")).toEqual(staged)
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
      "assistant-a",
      binding({ directory: "/other" }),
    )
    registry.register(newIdentity, noopRollback)
    releaseRollback()
    const result = await pending
    expect(result).toEqual({ kind: "superseded" })
    expect(registry.read("assistant-a")).toEqual(newIdentity)
  })

  test("rollbackAndClearIfBindingMismatch returns match when binding still equals", async () => {
    const registry = createAssistantStagedMessageEditRegistry()
    registry.register(identity(), async () => {
      throw new Error("should-not-rollback")
    })
    const result = await registry.rollbackAndClearIfBindingMismatch("assistant-a", binding())
    expect(result).toEqual({ kind: "match" })
    expect(registry.read("assistant-a")).toBeDefined()
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
    expect(registry.read("assistant-a")).toBe(undefined)
    expect(registry.read("assistant-b")?.messageID).toBe("msg_b")
  })

  test("assistantStagedEditMatchesBinding requires full composite equality", () => {
    const staged = identity()
    expect(assistantStagedEditMatchesBinding(staged, binding())).toBe(true)
    expect(assistantStagedEditMatchesBinding(staged, binding({ transport: "other" }))).toBe(false)
    expect(assistantStagedEditMatchesBinding(staged, binding({ runtimeGeneration: 9 }))).toBe(false)
  })
})
