import { beforeEach, describe, expect, test, vi } from "vitest"
import { mergeMetadataPatch } from "../../../web/server/lib/session-metadata/session-metadata-store.js"

const mocks = vi.hoisted(() => ({
  abortCalls: [] as string[],
  writes: [] as Array<Record<string, unknown> | null>,
  currentGoal: null as Record<string, unknown> | null,
  writeError: null as Error | null,
  objectiveExists: true,
  neighbor: { note: "keep unrelated metadata" },
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
    if (mocks.writeError) throw mocks.writeError
    const current = { openchamber: { goal: mocks.currentGoal, assistant: mocks.neighbor } }
    const next = mergeMetadataPatch(current, updater(current))
    const namespace = next.openchamber as { goal?: Record<string, unknown> } | undefined
    mocks.currentGoal = namespace?.goal ?? null
    mocks.writes.push(mocks.currentGoal)
    expect(next).toMatchObject({ openchamber: { assistant: mocks.neighbor } })
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
  runtimeFetch: async (_url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") mocks.objectiveExists = false
    return { ok: true, json: async () => ({}) }
  },
}))

import { clearSessionGoal, pauseSessionGoalForQuestion, setSessionGoalStatus } from "./sessionGoalActions"

const activeGoal = {
  id: "goal_1",
  objective: "Ship it",
  objectiveFile: false,
  status: "active",
  statusReason: "",
}

describe("clearSessionGoal", () => {
  beforeEach(() => {
    mocks.currentGoal = { ...activeGoal, objective: "", objectiveFile: true }
    mocks.abortCalls.length = 0
    mocks.writeError = null
    mocks.objectiveExists = true
  })

  test("removes the persisted goal before cleaning up its objective and stopping the turn", async () => {
    await clearSessionGoal("ses_a", "/repo")
    expect(mocks.currentGoal).toBeNull()
    expect(mocks.objectiveExists).toBe(false)
    expect(mocks.abortCalls).toEqual(["ses_a"])
  })

  test("preserves the objective and goal when metadata persistence fails, allowing retry", async () => {
    mocks.writeError = new Error("metadata unavailable")
    await expect(clearSessionGoal("ses_a", "/repo")).rejects.toThrow("metadata unavailable")
    expect(mocks.currentGoal?.status).toBe("active")
    expect(mocks.objectiveExists).toBe(true)
    expect(mocks.abortCalls).toEqual([])
    mocks.writeError = null
    await clearSessionGoal("ses_a", "/repo")
    expect(mocks.currentGoal).toBeNull()
    expect(mocks.objectiveExists).toBe(false)
  })
})

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
