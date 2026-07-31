import { beforeEach, describe, expect, test } from "bun:test"
import {
  createComposerSendAdmissionIdentity,
  resetComposerSendStoreForTests,
  selectComposerFlightKind,
  selectEstablishingPendingDisplayItems,
  useComposerSendStore,
} from "./composer-send-manager"

const flightKind = (scopeKey: string) => (
  selectComposerFlightKind(scopeKey)(useComposerSendStore.getState())
)

describe("composer-send-manager", () => {
  beforeEach(() => {
    resetComposerSendStoreForTests()
  })

  test("beginFlight is single-flight per scope and endFlight releases it", () => {
    const store = useComposerSendStore.getState()
    expect(store.beginFlight("primary", "send")).toBe(true)
    expect(store.beginFlight("primary", "queue")).toBe(false)
    expect(store.beginFlight("secondary", "send")).toBe(true)
    expect(store.isInFlight("primary")).toBe(true)
    expect(flightKind("primary")).toBe("send")
    store.endFlight("primary")
    expect(store.isInFlight("primary")).toBe(false)
    expect(flightKind("primary")).toBeNull()
    expect(store.isInFlight("secondary")).toBe(true)
    expect(store.beginFlight("primary", "queue")).toBe(true)
    expect(flightKind("primary")).toBe("queue")
  })

  test("establishing can accept follow-ups while primary flight is still held", () => {
    const store = useComposerSendStore.getState()
    expect(store.beginFlight("primary", "send")).toBe(true)
    expect(store.beginEstablishing({ draftID: "draft-1", primaryMessageID: "msg_1" })).toBe(true)
    // Follow-ups must not require releasing the create+prompt flight.
    expect(store.isInFlight("primary")).toBe(true)
    expect(store.enqueueEstablishingFollowUp({
      draftID: "draft-1",
      content: "typed during create",
      sendConfig: { providerID: "p", modelID: "m" },
    })?.content).toBe("typed during create")
    expect(store.isEstablishing("draft-1")).toBe(true)
  })

  test("establishing display selector keeps a stable getSnapshot while pending is empty", () => {
    const store = useComposerSendStore.getState()
    store.beginEstablishing({ draftID: "draft-1", primaryMessageID: "msg_1" })
    const first = selectEstablishingPendingDisplayItems(useComposerSendStore.getState(), "draft-1")
    const second = selectEstablishingPendingDisplayItems(useComposerSendStore.getState(), "draft-1")
    expect(first).toEqual([])
    expect(second).toBe(first)
  })

  test("establishing display selector caches mapped rows for the same pending array", () => {
    const store = useComposerSendStore.getState()
    store.beginEstablishing({ draftID: "draft-1", primaryMessageID: "msg_1" })
    store.enqueueEstablishingFollowUp({
      draftID: "draft-1",
      content: "follow-up",
      sendConfig: { providerID: "p", modelID: "m" },
    })
    const first = selectEstablishingPendingDisplayItems(useComposerSendStore.getState(), "draft-1")
    const second = selectEstablishingPendingDisplayItems(useComposerSendStore.getState(), "draft-1")
    expect(first).toHaveLength(1)
    expect(second).toBe(first)
  })

  test("establishing follow-ups stage pending-admission chips for one draft", () => {
    const store = useComposerSendStore.getState()
    expect(store.beginEstablishing({ draftID: "draft-1", primaryMessageID: "msg_1" })).toBe(true)
    expect(store.shouldBlockNewSessionDraftOpen()).toBe(true)

    const first = store.enqueueEstablishingFollowUp({
      draftID: "draft-1",
      content: "second turn",
      sendConfig: { providerID: "p", modelID: "m", agent: "build" },
    })
    expect(first?.kind).toBe("pending-admission")
    expect(first?.phase).toBe("admitting")
    expect(first?.content).toBe("second turn")
    expect(first?.sendConfig).toEqual({ providerID: "p", modelID: "m", agent: "build" })

    expect(store.enqueueEstablishingFollowUp({
      draftID: "draft-other",
      content: "wrong draft",
      sendConfig: { providerID: "p", modelID: "m" },
    })).toBeNull()

    const display = selectEstablishingPendingDisplayItems(useComposerSendStore.getState(), "draft-1")
    expect(display).toHaveLength(1)
    expect(display[0]?.kind).toBe("pending-admission")
    expect(display[0]?.content).toBe("second turn")
    expect("sendConfig" in (display[0] as object)).toBe(false)
  })

  test("takeEstablishingPending drains and clears establishing state", () => {
    const store = useComposerSendStore.getState()
    store.beginEstablishing({ draftID: "draft-1", primaryMessageID: "msg_1" })
    const identity = createComposerSendAdmissionIdentity()
    store.enqueueEstablishingFollowUp({
      draftID: "draft-1",
      content: "queued while creating",
      sendConfig: { providerID: "p", modelID: "m" },
      attachments: [{
        id: "att-1",
        filename: "a.txt",
        mimeType: "text/plain",
        dataUrl: "data:text/plain;base64,YQ==",
        file: new File(["a"], "a.txt", { type: "text/plain" }),
        size: 1,
        source: "local",
      }],
      identity,
    })

    expect(store.takeEstablishingPending("draft-other")).toEqual([])
    const drained = store.takeEstablishingPending("draft-1")
    expect(drained).toHaveLength(1)
    expect(drained[0]?.requestID).toBe(identity.requestID)
    expect(drained[0]?.attachments).toHaveLength(1)
    expect(store.getEstablishing()).toBeNull()
    expect(store.shouldBlockNewSessionDraftOpen()).toBe(false)
  })

  test("removeEstablishingFollowUp restores one staged chip", () => {
    const store = useComposerSendStore.getState()
    store.beginEstablishing({ draftID: "draft-1", primaryMessageID: "msg_1" })
    const a = store.enqueueEstablishingFollowUp({
      draftID: "draft-1",
      content: "a",
      sendConfig: { providerID: "p", modelID: "m" },
    })
    const b = store.enqueueEstablishingFollowUp({
      draftID: "draft-1",
      content: "b",
      sendConfig: { providerID: "p", modelID: "m" },
    })
    expect(a && b).toBeTruthy()
    const removed = store.removeEstablishingFollowUp(a!.requestID)
    expect(removed?.content).toBe("a")
    expect(store.getEstablishing()?.pending.map((item) => item.content)).toEqual(["b"])
  })

  test("clearEstablishing drops pending on failed create", () => {
    const store = useComposerSendStore.getState()
    store.beginEstablishing({ draftID: "draft-1", primaryMessageID: "msg_1" })
    store.enqueueEstablishingFollowUp({
      draftID: "draft-1",
      content: "later",
      sendConfig: { providerID: "p", modelID: "m" },
    })
    const cleared = store.clearEstablishing("draft-1")
    expect(cleared).toHaveLength(1)
    expect(store.getEstablishing()).toBeNull()
  })
})