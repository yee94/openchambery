import { beforeEach, describe, expect, test } from "bun:test"
import {
  clearDeferredIdleTranscriptSettle,
  deferIdleTranscriptSettle,
  planSessionIdleMaterialization,
  resetIdleTranscriptSettleForTests,
  takeDeferredIdleTranscriptSettle,
} from "./session-idle-materialization"

describe("planSessionIdleMaterialization", () => {
  test("materializes a viewed top-level idle immediately", () => {
    expect(planSessionIdleMaterialization({
      idleSessionID: "ses_a",
      directory: "/proj",
      activeSessionID: "ses_a",
      activeDirectory: "/proj",
    })).toEqual({ action: "materialize-now", sessionID: "ses_a" })
  })

  test("defers a background top-level idle until that session is viewed", () => {
    expect(planSessionIdleMaterialization({
      idleSessionID: "ses_a",
      directory: "/proj",
      activeSessionID: "ses_b",
      activeDirectory: "/proj",
    })).toEqual({ action: "defer-until-viewed", sessionID: "ses_a" })
  })

  test("still materializes the parent when a child session goes idle", () => {
    expect(planSessionIdleMaterialization({
      idleSessionID: "ses_child",
      directory: "/proj",
      parentID: "ses_parent",
      activeSessionID: "ses_b",
      activeDirectory: "/proj",
    })).toEqual({ action: "materialize-parent", sessionID: "ses_parent" })
  })

  test("ignores idle without a directory or session", () => {
    expect(planSessionIdleMaterialization({
      idleSessionID: "",
      directory: "/proj",
      activeSessionID: "ses_a",
      activeDirectory: "/proj",
    })).toEqual({ action: "none" })
    expect(planSessionIdleMaterialization({
      idleSessionID: "ses_a",
      directory: "global",
      activeSessionID: "ses_a",
      activeDirectory: "global",
    })).toEqual({ action: "none" })
  })
})

describe("deferred idle transcript settle", () => {
  beforeEach(() => {
    resetIdleTranscriptSettleForTests()
  })

  test("take is true once after a background idle, then false", () => {
    deferIdleTranscriptSettle("/proj", "ses_a")
    expect(takeDeferredIdleTranscriptSettle("/proj", "ses_a")).toBe(true)
    expect(takeDeferredIdleTranscriptSettle("/proj", "ses_a")).toBe(false)
  })

  test("does not consume a different session's deferred settle", () => {
    deferIdleTranscriptSettle("/proj", "ses_a")
    expect(takeDeferredIdleTranscriptSettle("/proj", "ses_b")).toBe(false)
    expect(takeDeferredIdleTranscriptSettle("/proj", "ses_a")).toBe(true)
  })

  test("clear drops every deferred settle", () => {
    deferIdleTranscriptSettle("/proj", "ses_a")
    clearDeferredIdleTranscriptSettle()
    expect(takeDeferredIdleTranscriptSettle("/proj", "ses_a")).toBe(false)
  })
})
