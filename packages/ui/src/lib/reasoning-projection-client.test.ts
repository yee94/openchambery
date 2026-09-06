import { afterEach, describe, expect, test } from "vitest"
import {
  getIncludeReasoningProjection,
  getReasoningProjectionRevision,
  resetReasoningProjectionClientForTests,
  setIncludeReasoningProjection,
  subscribeReasoningProjection,
} from "./reasoning-projection-client"

afterEach(() => {
  resetReasoningProjectionClientForTests()
})

describe("reasoning-projection-client", () => {
  test("defaults to include reasoning", () => {
    expect(getIncludeReasoningProjection()).toBe(true)
    expect(getReasoningProjectionRevision()).toBe(0)
  })

  test("bumps revision only on real changes and notifies subscribers", () => {
    const revisions: number[] = []
    const unsub = subscribeReasoningProjection(() => {
      revisions.push(getReasoningProjectionRevision())
    })

    setIncludeReasoningProjection(true)
    expect(getReasoningProjectionRevision()).toBe(0)
    expect(revisions).toEqual([])

    setIncludeReasoningProjection(false)
    expect(getIncludeReasoningProjection()).toBe(false)
    expect(getReasoningProjectionRevision()).toBe(1)

    setIncludeReasoningProjection(true)
    setIncludeReasoningProjection(false)
    expect(getIncludeReasoningProjection()).toBe(false)
    // off→on→off still advances generation so intermediate stale work is dropped
    expect(getReasoningProjectionRevision()).toBe(3)
    expect(revisions).toEqual([1, 2, 3])

    unsub()
    setIncludeReasoningProjection(true)
    expect(revisions).toEqual([1, 2, 3])
  })
})
