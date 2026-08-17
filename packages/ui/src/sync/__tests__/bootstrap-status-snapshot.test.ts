import { describe, expect, test } from "bun:test"
import type { SessionStatus } from '@/lib/opencode/v2-types'

import { mergeSessionStatusSnapshot } from "../bootstrap"

const BUSY = { type: "busy" } as SessionStatus
const IDLE = { type: "idle" } as SessionStatus

describe("mergeSessionStatusSnapshot", () => {
  test("uses the authoritative snapshot for statuses unchanged during the request", () => {
    const before = { session: BUSY }
    expect(mergeSessionStatusSnapshot(before, before, {})).toEqual({})
  })

  test("preserves a busy event that arrived while the snapshot request was pending", () => {
    expect(mergeSessionStatusSnapshot({}, { session: BUSY }, {})).toEqual({ session: BUSY })
  })

  test("preserves an idle event that arrived while an older busy snapshot was pending", () => {
    expect(mergeSessionStatusSnapshot(
      { session: BUSY },
      { session: IDLE },
      { session: BUSY },
    )).toEqual({ session: IDLE })
  })

  test("preserves a status deletion that happened while the snapshot was pending", () => {
    expect(mergeSessionStatusSnapshot(
      { session: BUSY },
      {},
      { session: BUSY },
    )).toEqual({})
  })
})
