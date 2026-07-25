import { describe, expect, test } from "bun:test"
import { runSessionHistoryMutation } from "./session-history-mutation-coordinator"

describe("session-history-mutation-coordinator", () => {
  const flushAsync = async (ticks = 20) => {
    for (let i = 0; i < ticks; i += 1) await Promise.resolve()
  }
  const waitUntil = async (predicate: () => boolean, ticks = 100) => {
    for (let i = 0; i < ticks; i += 1) {
      if (predicate()) return
      await Promise.resolve()
    }
  }

  test("same-session ops serialize; later marker waits for the first", async () => {
    let transport = "runtime-a"
    let generation = 1
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const order: string[] = []
    let firstStarted = false
    let secondStarted = false

    const first = runSessionHistoryMutation(
      "session-a",
      "/dir",
      async () => {
        firstStarted = true
        order.push("start:a")
        await firstGate
        order.push("end:a")
        return "a"
      },
      { getTransportIdentity: () => transport, getGeneration: () => generation },
    )
    await waitUntil(() => firstStarted)
    const second = runSessionHistoryMutation(
      "session-a",
      "/dir",
      async () => {
        secondStarted = true
        order.push("start:b")
        order.push("end:b")
        return "b"
      },
      { getTransportIdentity: () => transport, getGeneration: () => generation },
    )
    await flushAsync()
    expect(secondStarted).toBe(false)
    releaseFirst()
    expect(await Promise.all([first, second])).toEqual(["a", "b"])
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"])
  })

  test("first failure does not block the next same-session op", async () => {
    let transport = "runtime-a"
    let generation = 2
    const first = runSessionHistoryMutation(
      "session-a",
      "/dir",
      async () => {
        throw new Error("first-failed")
      },
      { getTransportIdentity: () => transport, getGeneration: () => generation },
    )
    await expect(first).rejects.toThrow("first-failed")
    const second = await runSessionHistoryMutation(
      "session-a",
      "/dir",
      async () => "ok",
      { getTransportIdentity: () => transport, getGeneration: () => generation },
    )
    expect(second).toBe("ok")
  })

  test("different sessions run in parallel", async () => {
    let transport = "runtime-a"
    let generation = 3
    let active = 0
    let maxActive = 0
    const gates: Array<() => void> = []

    const op = (label: string) =>
      runSessionHistoryMutation(
        label,
        "/dir",
        async () => {
          active += 1
          maxActive = Math.max(maxActive, active)
          await new Promise<void>((resolve) => { gates.push(resolve) })
          active -= 1
          return label
        },
        { getTransportIdentity: () => transport, getGeneration: () => generation },
      )

    const first = op("session-a")
    const second = op("session-b")
    await waitUntil(() => maxActive === 2)
    expect(maxActive).toBe(2)
    for (const release of gates) release()
    expect(await Promise.all([first, second])).toEqual(["session-a", "session-b"])
  })

  test("runtime switch aborts a queued op before it runs", async () => {
    let transport = "runtime-a"
    let generation = 4
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let secondRan = false

    const first = runSessionHistoryMutation(
      "session-a",
      "/dir",
      async () => {
        await firstGate
        return "first"
      },
      { getTransportIdentity: () => transport, getGeneration: () => generation },
    )
    await waitUntil(() => true)
    await flushAsync(5)
    const second = runSessionHistoryMutation(
      "session-a",
      "/dir",
      async () => {
        secondRan = true
        return "second"
      },
      { getTransportIdentity: () => transport, getGeneration: () => generation },
    )
    generation = 5
    releaseFirst()
    await first
    await expect(second).rejects.toThrow("Session history mutation aborted because the runtime changed")
    expect(secondRan).toBe(false)
  })
})
