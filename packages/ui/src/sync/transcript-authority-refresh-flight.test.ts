import { describe, expect, test } from "bun:test"

import {
  beginTranscriptAuthorityRefresh,
  endTranscriptAuthorityRefresh,
  isTranscriptAuthorityRefreshInFlight,
  subscribeTranscriptAuthorityRefresh,
} from "./transcript-authority-refresh-flight"

describe("transcript-authority-refresh-flight", () => {
  test("tracks one scoped refresh and notifies subscribers", () => {
    let notified = 0
    const unsubscribe = subscribeTranscriptAuthorityRefresh(() => {
      notified += 1
    })

    expect(isTranscriptAuthorityRefreshInFlight("ses_1", "/ws")).toBe(false)
    beginTranscriptAuthorityRefresh("/ws", "ses_1")
    expect(isTranscriptAuthorityRefreshInFlight("ses_1", "/ws")).toBe(true)
    expect(isTranscriptAuthorityRefreshInFlight("ses_1")).toBe(true)
    expect(isTranscriptAuthorityRefreshInFlight("ses_1", "/other")).toBe(false)
    expect(isTranscriptAuthorityRefreshInFlight("ses_2", "/ws")).toBe(false)
    expect(notified).toBe(1)

    endTranscriptAuthorityRefresh("/ws", "ses_1")
    expect(isTranscriptAuthorityRefreshInFlight("ses_1", "/ws")).toBe(false)
    expect(notified).toBe(2)

    endTranscriptAuthorityRefresh("/ws", "ses_1")
    expect(notified).toBe(2)
    unsubscribe()
  })
})
