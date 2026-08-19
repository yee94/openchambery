import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  abortCalls: [] as string[],
  writes: [] as Array<Record<string, unknown> | null>,
  currentGoal: null as Record<string, unknown> | null,
}))

vi.mock("@/sync/session-actions", () => ({
  abortCurrentOperation: (sessionId: string) => {
    mocks.abortCalls.push(sessionId)
  },
  patchSessionMetadata: async (
    _sessionId: string,
    _directory: string | undefined,
    updater: (metadata: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const next = updater({
      openchamber: mocks.currentGoal ? { goal: mocks.currentGoal } : {},
    })
    const namespace = next.openchamber as { goal?: Record<string, unknown> } | undefined
    mocks.currentGoal = namespace?.goal ?? null
    mocks.writes.push(mocks.currentGoal)
    return {}
  },
}))

vi.mock("@/sync/queue-abort-optimistic", () => ({
  promoteQueueHeadOnAbort: () => undefined,
}))

vi.mock("@/lib/smallModel", () => ({
  distillGoalObjective: async () => null,
}))

vi.mock("@/lib/i18n", () => ({
  formatMessage: () => "",
  useI18nStore: { getState: () => ({ dictionary: {} }) },
}))

vi.mock("@/components/ui", () => ({
  toast: { error: () => undefined },
}))

vi.mock("@/lib/runtime-fetch", () => ({
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
    mocks.abortCalls.length = 0
    mocks.writes.length = 0
    mocks.currentGoal = { ...activeGoal }
  })

  test("pauses an active goal without aborting the current turn", async () => {
    await pauseSessionGoalForQuestion("ses_a", "/repo")
    expect(mocks.currentGoal?.status).toBe("paused")
    expect(mocks.currentGoal?.statusReason).toBe("paused for question")
    expect(mocks.abortCalls).toEqual([])
  })

  test("is a no-op when there is no goal", async () => {
    mocks.currentGoal = null
    await pauseSessionGoalForQuestion("ses_a", "/repo")
    expect(mocks.currentGoal).toBeNull()
    expect(mocks.abortCalls).toEqual([])
  })

  test("is a no-op when the goal is already paused", async () => {
    mocks.currentGoal = { ...activeGoal, status: "paused", statusReason: "marked by user" }
    await pauseSessionGoalForQuestion("ses_a", "/repo")
    expect(mocks.currentGoal?.status).toBe("paused")
    expect(mocks.currentGoal?.statusReason).toBe("marked by user")
    expect(mocks.abortCalls).toEqual([])
  })
})

describe("setSessionGoalStatus", () => {
  beforeEach(() => {
    mocks.abortCalls.length = 0
    mocks.writes.length = 0
    mocks.currentGoal = { ...activeGoal }
  })

  test("manual pause still aborts the current operation", async () => {
    await setSessionGoalStatus("ses_a", "/repo", "paused")
    expect(mocks.abortCalls).toEqual(["ses_a"])
    expect(mocks.currentGoal?.status).toBe("paused")
  })
})
