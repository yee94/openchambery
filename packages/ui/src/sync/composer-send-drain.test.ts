import { beforeEach, describe, expect, test } from "bun:test"
import {
  setMessageQueueMutationFence,
  useMessageQueueStore,
} from "@/stores/messageQueueStore"
import {
  drainEstablishingFollowUps,
  admitLegacyEstablishingFollowUp,
} from "./composer-send-drain"
import {
  resetComposerSendStoreForTests,
  useComposerSendStore,
} from "./composer-send-manager"

const reset = (): void => {
  setMessageQueueMutationFence("open")
  useMessageQueueStore.setState({ queuedMessages: {}, pendingAdmissions: {} })
  resetComposerSendStoreForTests()
}

describe("composer-send-drain", () => {
  beforeEach(reset)

  test("admitLegacyEstablishingFollowUp stages then confirms into the bound scope", () => {
    const store = useComposerSendStore.getState()
    store.beginEstablishing({ draftID: "draft-1", primaryMessageID: "msg_primary" })
    const item = store.enqueueEstablishingFollowUp({
      draftID: "draft-1",
      content: "follow-up",
      sendConfig: { providerID: "openai", modelID: "gpt", agent: "build" },
    })
    expect(item).toBeTruthy()

    const scope = {
      state: "bound" as const,
      transportIdentity: "runtime-a",
      directory: "/repo",
      sessionID: "session-a",
      deliveryTarget: { kind: "primary" as const },
      runtimeGeneration: 1,
    }
    expect(admitLegacyEstablishingFollowUp(scope, item!)).toBe(true)
    const queued = useMessageQueueStore.getState().getQueueForScope(scope)
    expect(queued).toHaveLength(1)
    expect(queued[0]?.content).toBe("follow-up")
    expect(queued[0]?.messageID).toBe(item!.messageID)
    expect(queued[0]?.sendConfig).toEqual({
      providerID: "openai",
      modelID: "gpt",
      agent: "build",
    })
  })

  test("drainEstablishingFollowUps takes pending and lands them in the session queue", async () => {
    const store = useComposerSendStore.getState()
    store.beginEstablishing({ draftID: "draft-1", primaryMessageID: "msg_primary" })
    store.enqueueEstablishingFollowUp({
      draftID: "draft-1",
      content: "second",
      sendConfig: { providerID: "p", modelID: "m" },
    })
    store.enqueueEstablishingFollowUp({
      draftID: "draft-1",
      content: "third",
      sendConfig: { providerID: "p", modelID: "m" },
    })

    const result = await drainEstablishingFollowUps({
      draftID: "draft-1",
      sessionID: "session-a",
      directory: "/repo",
      transportIdentity: "runtime-a",
      runtimeGeneration: 2,
    })
    expect(result).toEqual({ drained: 2, failed: 0 })
    expect(store.getEstablishing()).toBeNull()

    const scope = {
      state: "bound" as const,
      transportIdentity: "runtime-a",
      directory: "/repo",
      sessionID: "session-a",
      deliveryTarget: { kind: "primary" as const },
      runtimeGeneration: 2,
    }
    const queued = useMessageQueueStore.getState().getQueueForScope(scope)
    expect(queued.map((item) => item.content)).toEqual(["second", "third"])
  })

  test("drainEstablishingFollowUps prefers committed server admits and falls back on failure", async () => {
    const store = useComposerSendStore.getState()
    store.beginEstablishing({ draftID: "draft-1", primaryMessageID: "msg_primary" })
    store.enqueueEstablishingFollowUp({
      draftID: "draft-1",
      content: "server-ok",
      sendConfig: { providerID: "p", modelID: "m" },
    })
    store.enqueueEstablishingFollowUp({
      draftID: "draft-1",
      content: "server-fail",
      sendConfig: { providerID: "p", modelID: "m" },
    })

    const result = await drainEstablishingFollowUps({
      draftID: "draft-1",
      sessionID: "session-a",
      directory: "/repo",
      transportIdentity: "runtime-a",
      runtimeGeneration: 1,
      admitServer: async (item) => (
        item.content === "server-ok"
          ? { status: "committed" }
          : { status: "stale" }
      ),
    })
    expect(result).toEqual({ drained: 2, failed: 0 })
    const scope = {
      state: "bound" as const,
      transportIdentity: "runtime-a",
      directory: "/repo",
      sessionID: "session-a",
      deliveryTarget: { kind: "primary" as const },
      runtimeGeneration: 1,
    }
    // Only the failed server path falls back to legacy confirm.
    const queued = useMessageQueueStore.getState().getQueueForScope(scope)
    expect(queued.map((item) => item.content)).toEqual(["server-fail"])
  })
})
