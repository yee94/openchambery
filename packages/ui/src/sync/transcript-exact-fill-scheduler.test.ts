import { afterEach, describe, expect, test } from "vitest"

import {
  enqueueExactFill,
  EXACT_FILL_CONCURRENCY,
  getExactFillSchedulerStatsForTests,
  resetExactFillSchedulerForTests,
} from "./transcript-exact-fill-scheduler"

afterEach(() => {
  resetExactFillSchedulerForTests()
})

describe("transcript exact-fill scheduler", () => {
  test("caps concurrent runs at EXACT_FILL_CONCURRENCY", async () => {
    let inFlight = 0
    let maxInFlight = 0
    const started: string[] = []
    const releases: Array<() => void> = []

    const jobs = Array.from({ length: 10 }, (_, i) => {
      const id = `m${i}`
      return enqueueExactFill(id, async () => {
        started.push(id)
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise<void>((resolve) => {
          releases.push(resolve)
        })
        inFlight -= 1
        return id
      })
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toHaveLength(EXACT_FILL_CONCURRENCY)
    expect(maxInFlight).toBe(EXACT_FILL_CONCURRENCY)
    expect(getExactFillSchedulerStatsForTests().queued).toBe(10 - EXACT_FILL_CONCURRENCY)

    while (releases.length > 0) {
      releases.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    await Promise.all(jobs)
    expect(maxInFlight).toBe(EXACT_FILL_CONCURRENCY)
    expect(started).toHaveLength(10)
  })

  test("coalesces identical keys to one run", async () => {
    let runs = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const run = () => enqueueExactFill("same", async () => {
      runs += 1
      await gate
      return "ok"
    })
    const first = run()
    const second = run()
    expect(second).toBe(first)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runs).toBe(1)
    release()
    await expect(first).resolves.toBe("ok")
    await expect(second).resolves.toBe("ok")
  })

  test("user priority jumps ahead of queued background work", async () => {
    const order: string[] = []
    const releases: Array<() => void> = []
    const block = () => new Promise<void>((resolve) => {
      releases.push(resolve)
    })

    // Saturate the pool with background jobs that hold slots.
    const blockers = Array.from({ length: EXACT_FILL_CONCURRENCY }, (_, i) =>
      enqueueExactFill(`block-${i}`, async () => {
        order.push(`block-${i}`)
        await block()
      }, { priority: "background" }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    const background = enqueueExactFill("bg-wait", async () => {
      order.push("bg-wait")
    }, { priority: "background" })
    let releaseUser!: () => void
    const user = enqueueExactFill("user-jump", async () => {
      order.push("user-jump")
      await new Promise<void>((resolve) => {
        releaseUser = resolve
      })
    }, { priority: "user" })

    // Free one slot — user job must claim it before the queued background job.
    releases.shift()?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order).toContain("user-jump")
    expect(order).not.toContain("bg-wait")

    releaseUser()
    while (releases.length > 0) {
      releases.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    await Promise.all([...blockers, background, user])
    expect(order.indexOf("user-jump")).toBeLessThan(order.indexOf("bg-wait"))
  })

  test("later user enqueue upgrades a still-queued background job", async () => {
    const order: string[] = []
    const releases: Array<() => void> = []
    const block = () => new Promise<void>((resolve) => {
      releases.push(resolve)
    })

    const blockers = Array.from({ length: EXACT_FILL_CONCURRENCY }, (_, i) =>
      enqueueExactFill(`hold-${i}`, async () => {
        await block()
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    const shared = enqueueExactFill("upgrade-me", async () => {
      order.push("upgrade-me")
    }, { priority: "background" })
    // Same key, higher priority — must not start a second run.
    const upgraded = enqueueExactFill("upgrade-me", async () => {
      order.push("should-not-run")
    }, { priority: "user" })
    expect(upgraded).toBe(shared)

    const otherBg = enqueueExactFill("other-bg", async () => {
      order.push("other-bg")
    }, { priority: "background" })

    releases.shift()?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order[0]).toBe("upgrade-me")

    while (releases.length > 0) {
      releases.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    await Promise.all([...blockers, shared, upgraded, otherBg])
    expect(order).toEqual(["upgrade-me", "other-bg"])
  })
})
