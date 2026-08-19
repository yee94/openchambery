import { describe, expect, test } from "bun:test"
import {
  getHistorySessionTurnLimit,
  getInitialSessionTurnLimit,
  getMessageRefetchLimit,
  getSendConfirmationRefetchLimit,
  resolveSessionMessageTurnLimit,
} from "./session-message-policy"

describe("product limit is turns — link tiered", () => {
  test("local / LAN: first paint stays under the prepend page; loadMore is 4 turns", () => {
    // A first packet is sized by turns, so it is deliberately smaller than a
    // prepend page: reaching further back is what drags inline attachments and
    // long tool turns onto the critical path.
    expect(getInitialSessionTurnLimit("local")).toBe(3)
    expect(getHistorySessionTurnLimit("local")).toBe(4)
    expect(resolveSessionMessageTurnLimit("initial", "local")).toBe(3)
    expect(resolveSessionMessageTurnLimit("materialize", "local")).toBe(3)
    expect(resolveSessionMessageTurnLimit("recovery", "local")).toBe(3)
    expect(resolveSessionMessageTurnLimit("prepend", "local")).toBe(4)
  })

  test("relay: first paint 2 turns; prepend/loadMore 4 turns", () => {
    expect(getInitialSessionTurnLimit("relay")).toBe(2)
    expect(getHistorySessionTurnLimit("relay")).toBe(4)
    expect(resolveSessionMessageTurnLimit("initial", "relay")).toBe(2)
    expect(resolveSessionMessageTurnLimit("prepend", "relay")).toBe(4)
  })

  test("local first paint is higher than relay; loadMore matches relay", () => {
    expect(getInitialSessionTurnLimit("local")).toBeGreaterThan(getInitialSessionTurnLimit("relay"))
    expect(getHistorySessionTurnLimit("local")).toBe(getHistorySessionTurnLimit("relay"))
  })
})

describe("SDK-only message windows (not product history limit)", () => {
  test("refetch and send-confirmation remain message-count utilities", () => {
    expect(getMessageRefetchLimit()).toBe(100)
    expect(getSendConfirmationRefetchLimit()).toBe(30)
  })
})
