import { describe, expect, test } from "bun:test"
import {
  getHistorySessionTurnLimit,
  getInitialSessionTurnLimit,
  getMessageRefetchLimit,
  getSendConfirmationRefetchLimit,
  resolveSessionMessageTurnLimit,
} from "./session-message-policy"

describe("product limit is turns — link tiered", () => {
  test("local / LAN: higher initial and history turn windows", () => {
    expect(getInitialSessionTurnLimit("local")).toBe(6)
    expect(getHistorySessionTurnLimit("local")).toBe(6)
    expect(resolveSessionMessageTurnLimit("initial", "local")).toBe(6)
    expect(resolveSessionMessageTurnLimit("materialize", "local")).toBe(6)
    expect(resolveSessionMessageTurnLimit("recovery", "local")).toBe(6)
    expect(resolveSessionMessageTurnLimit("prepend", "local")).toBe(6)
  })

  test("relay: fixed 2 turns for first paint and prepend", () => {
    expect(getInitialSessionTurnLimit("relay")).toBe(2)
    expect(getHistorySessionTurnLimit("relay")).toBe(2)
    expect(resolveSessionMessageTurnLimit("initial", "relay")).toBe(2)
    expect(resolveSessionMessageTurnLimit("prepend", "relay")).toBe(2)
  })

  test("local budgets are strictly higher than relay", () => {
    expect(getInitialSessionTurnLimit("local")).toBeGreaterThan(getInitialSessionTurnLimit("relay"))
    expect(getHistorySessionTurnLimit("local")).toBeGreaterThan(getHistorySessionTurnLimit("relay"))
  })
})

describe("SDK-only message windows (not product history limit)", () => {
  test("refetch and send-confirmation remain message-count utilities", () => {
    expect(getMessageRefetchLimit()).toBe(100)
    expect(getSendConfirmationRefetchLimit()).toBe(30)
  })
})
