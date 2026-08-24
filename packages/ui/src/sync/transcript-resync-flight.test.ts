import { describe, expect, test } from "bun:test"

import {
  beginTranscriptResync,
  endTranscriptResync,
  isTranscriptResyncInFlight,
  subscribeTranscriptResync,
} from "./transcript-resync-flight"

describe("transcript-resync-flight", () => {
  test("tracks one scoped resync and notifies subscribers", () => {
    let notified = 0
    const unsubscribe = subscribeTranscriptResync(() => {
      notified += 1
    })

    expect(isTranscriptResyncInFlight("ses_1", "/ws")).toBe(false)
    beginTranscriptResync("/ws", "ses_1")
    expect(isTranscriptResyncInFlight("ses_1", "/ws")).toBe(true)
    expect(isTranscriptResyncInFlight("ses_1")).toBe(true)
    expect(isTranscriptResyncInFlight("ses_1", "/other")).toBe(false)
    expect(isTranscriptResyncInFlight("ses_2", "/ws")).toBe(false)
    expect(notified).toBe(1)

    endTranscriptResync("/ws", "ses_1")
    expect(isTranscriptResyncInFlight("ses_1", "/ws")).toBe(false)
    expect(notified).toBe(2)

    endTranscriptResync("/ws", "ses_1")
    expect(notified).toBe(2)
    unsubscribe()
  })

  test("overlapping paths reference-count; signal clears on the last end", () => {
    beginTranscriptResync("/ws", "ses_1")
    beginTranscriptResync("/ws", "ses_1")
    endTranscriptResync("/ws", "ses_1")
    expect(isTranscriptResyncInFlight("ses_1", "/ws")).toBe(true)
    endTranscriptResync("/ws", "ses_1")
    expect(isTranscriptResyncInFlight("ses_1", "/ws")).toBe(false)
  })

  test("listener fires on presence transitions only", () => {
    let notified = 0
    const unsubscribe = subscribeTranscriptResync(() => {
      notified += 1
    })
    beginTranscriptResync("/ws", "ses_1")
    beginTranscriptResync("/ws", "ses_1")
    endTranscriptResync("/ws", "ses_1")
    expect(notified).toBe(1)
    endTranscriptResync("/ws", "ses_1")
    expect(notified).toBe(2)
    unsubscribe()
  })

  test("empty identifiers are ignored", () => {
    beginTranscriptResync("", "ses_1")
    beginTranscriptResync("/ws", "")
    endTranscriptResync("", "ses_1")
    expect(isTranscriptResyncInFlight("ses_1")).toBe(false)
  })
})
