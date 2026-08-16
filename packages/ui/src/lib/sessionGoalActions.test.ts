import { beforeEach, describe, expect, mock, test } from "bun:test"

const abortCalls: string[] = []
let currentGoal: Record<string, unknown> | null = null
const writes: Array<Record<string, unknown> | null> = []

mock.module("@/sync/session-actions", () => ({
  abortCurrentOperation: (sessionId: string) => {
    abortCalls.push(sessionId)
  },
  patchSessionMetadata: async (
    _sessionId: string,
    _directory: string | undefined,
    updater: (metadata: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const next = updater({
      openchamber: currentGoal ? { goal: currentGoal } : {},
    })
    const namespace = next.openchamber as { goal?: Record<string, unknown> } | undefined
    currentGoal = namespace?.goal ?? null
    writes.push(currentGoal)
    return {}
  },
}))

mock.module("@/lib/smallModel", () => ({
  distillGoalObjective: async () => null,
}))

mock.module("@/lib/i18n", () => ({
  formatMessage: () => "",
  useI18nStore: { getState: () => ({ dictionary: {} }) },
}))

mock.module("@/components/ui", () => ({
  toast: { error: () => undefined },
}))

mock.module("@/lib/runtime-fetch", () => ({
  runtimeFetch: async () => ({ ok: true, json: async () => ({}) }),
}))

import { pauseSessionGoalForQuestion, setSessionGoalStatus } from "./sessionGoalActions"

const activeGoal = {
  id: "goal_1",
  objective: "Ship it",
  objectiveFile: false,
  status: "active",
  statusReason: "",
}

describe("pauseSessionGoalForQuestion", () => {
  beforeEach(() => {
    abortCalls.length = 0
    writes.length = 0
    currentGoal = { ...activeGoal }
  })

  test("pauses an active goal without aborting the current turn", async () => {
    await pauseSessionGoalForQuestion("ses_a", "/repo")
    expect(currentGoal?.status).toBe("paused")
    expect(currentGoal?.statusReason).toBe("paused for question")
    expect(abortCalls).toEqual([])
  })

  test("is a no-op when there is no goal", async () => {
    currentGoal = null
    await pauseSessionGoalForQuestion("ses_a", "/repo")
    expect(currentGoal).toBeNull()
    expect(abortCalls).toEqual([])
  })

  test("is a no-op when the goal is already paused", async () => {
    currentGoal = { ...activeGoal, status: "paused", statusReason: "marked by user" }
    await pauseSessionGoalForQuestion("ses_a", "/repo")
    expect(currentGoal?.status).toBe("paused")
    expect(currentGoal?.statusReason).toBe("marked by user")
    expect(abortCalls).toEqual([])
  })
})

describe("setSessionGoalStatus", () => {
  beforeEach(() => {
    abortCalls.length = 0
    writes.length = 0
    currentGoal = { ...activeGoal }
  })

  test("manual pause still aborts the current operation", async () => {
    await setSessionGoalStatus("ses_a", "/repo", "paused")
    expect(abortCalls).toEqual(["ses_a"])
    expect(currentGoal?.status).toBe("paused")
  })
})
