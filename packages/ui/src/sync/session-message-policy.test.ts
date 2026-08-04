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
  test("history value 100 is Host upstream scan chunk only — not a client message return size", () => {
    // initial remains the client bootstrap page size.
    expect(getInitialSessionMessageLimit()).toBe(30)
    // 100 is the Host-side scanLimit for turn-page upstream chunking.
    // It must not be interpreted as "return 100 client messages per history page".
    expect(getSessionHistoryMessageLimit()).toBe(100)
    expect(getSessionHistoryMessageLimit()).not.toBe(getInitialSessionMessageLimit())
  })

  test("documents scanLimit contract vs initial client page", () => {
    // Client first paint / SDK initial page.
    expect(getInitialSessionMessageLimit()).toBe(30)
    // Host scan chunk bound used by turn-page (turns=3, scanLimit=history).
    // Prepend/loadMore returns turn-bounded records, not a fixed 100-message page.
    expect(getSessionHistoryMessageLimit()).toBe(100)
  })
})

describe("recovery and materialize limits track initial", () => {
  test("recovery limit equals initial (30)", () => {
    expect(getSessionRecoveryMessageLimit()).toBe(30)
    expect(getSessionRecoveryMessageLimit()).toBe(getInitialSessionMessageLimit())
  })

  test("materialize limit equals initial (30)", () => {
    expect(getSessionMaterializationMessageLimit()).toBe(30)
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
