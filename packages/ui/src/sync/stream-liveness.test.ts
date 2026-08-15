import { afterEach, describe, expect, test } from "bun:test"

import {
  bindStreamReconnect,
  isStreamActivityStale,
  noteStreamActivity,
  requestStreamReconnect,
  resetStreamLivenessForTests,
  STREAM_STALE_MS,
} from "./stream-liveness"

afterEach(() => {
  resetStreamLivenessForTests()
})

describe("stream liveness", () => {
  test("unknown activity is not stale so first connect can send", () => {
    expect(isStreamActivityStale(Date.now())).toBe(false)
  })

  test("recent activity is live; aged activity is stale", () => {
    const now = 1_000_000
    noteStreamActivity(now)
    expect(isStreamActivityStale(now + STREAM_STALE_MS - 1)).toBe(false)
    expect(isStreamActivityStale(now + STREAM_STALE_MS)).toBe(true)
  })

  test("requestStreamReconnect reaches the bound pipeline", () => {
    const reasons: string[] = []
    const unbind = bindStreamReconnect((reason) => {
      reasons.push(reason ?? "")
    })
    requestStreamReconnect("send_stream_stale")
    expect(reasons).toEqual(["send_stream_stale"])
    unbind()
    requestStreamReconnect("after_unbind")
    expect(reasons).toEqual(["send_stream_stale"])
  })
})
