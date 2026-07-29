import { describe, expect, test } from "bun:test"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"

import { resolveGlobalSessionStatus } from "./sync-context"

describe("resolveGlobalSessionStatus", () => {
  test("uses the global busy status when no directory store is subscribed", () => {
    expect(resolveGlobalSessionStatus(undefined, "busy")).toEqual({ type: "busy" })
  })

  test("keeps the directory store's richer retry status", () => {
    const liveStatus = { type: "retry", attempt: 2, message: "rate limited", next: 10 } as SessionStatus

    expect(resolveGlobalSessionStatus(liveStatus, "busy")).toBe(liveStatus)
  })

  test("live idle wins over sticky global fallback busy", () => {
    // Home used to paint fallback busy while list (live-only) already showed idle.
    expect(resolveGlobalSessionStatus({ type: "idle" }, "busy")).toEqual({ type: "idle" })
  })

  test("returns undefined when neither live nor fallback is active", () => {
    expect(resolveGlobalSessionStatus(undefined, undefined)).toBe(undefined)
  })
})
