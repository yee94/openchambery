import { describe, expect, test } from "bun:test"
import {
  getInitialSessionMessageLimit,
  getMessageRefetchLimit,
  getSendConfirmationRefetchLimit,
  getSessionHistoryMessageLimit,
  getSessionMaterializationMessageLimit,
  getSessionRecoveryMessageLimit,
} from "./session-message-policy"

describe("getInitialSessionMessageLimit", () => {
  test("shared page size is 30 for every surface", () => {
    expect(getInitialSessionMessageLimit()).toBe(30)
  })
})

describe("getSessionHistoryMessageLimit", () => {
  test("history page size matches the shared initial page size", () => {
    expect(getSessionHistoryMessageLimit()).toBe(30)
    expect(getSessionHistoryMessageLimit()).toBe(getInitialSessionMessageLimit())
  })
})

describe("recovery and materialize limits track initial", () => {
  test("recovery limit equals initial", () => {
    expect(getSessionRecoveryMessageLimit()).toBe(getInitialSessionMessageLimit())
  })

  test("materialize limit equals initial", () => {
    expect(getSessionMaterializationMessageLimit()).toBe(getInitialSessionMessageLimit())
  })
})

describe("refetch limits", () => {
  test("message refetch limit is 100", () => {
    expect(getMessageRefetchLimit()).toBe(100)
  })

  test("send confirmation refetch limit is 30", () => {
    expect(getSendConfirmationRefetchLimit()).toBe(30)
  })
})
