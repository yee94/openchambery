import {
  legacyQueueScope,
  useMessageQueueStore,
  type QueueScope,
} from "@/stores/messageQueueStore"
import type { ComposerSendEstablishingFollowUp } from "./composer-send-manager"
import { useComposerSendStore } from "./composer-send-manager"

export type DrainEstablishingFollowUpsInput = {
  draftID: string
  sessionID: string
  directory: string
  transportIdentity: string
  runtimeGeneration: number
  /**
   * When provided (server queue mode), each follow-up is admitted through the
   * server runtime. Otherwise follow-ups land in the local message queue store.
   */
  admitServer?: (item: ComposerSendEstablishingFollowUp) => Promise<{ status: string }>
}

const boundScope = (input: DrainEstablishingFollowUpsInput): Extract<QueueScope, { state: "bound" }> => ({
  state: "bound",
  transportIdentity: input.transportIdentity,
  directory: input.directory,
  sessionID: input.sessionID,
  deliveryTarget: { kind: "primary" },
  runtimeGeneration: input.runtimeGeneration,
})

export const admitLegacyEstablishingFollowUp = (
  scope: Extract<QueueScope, { state: "bound" }>,
  item: ComposerSendEstablishingFollowUp,
): boolean => {
  const store = useMessageQueueStore.getState()
  store.bindLegacyQueue(legacyQueueScope(scope.sessionID), scope)
  store.stageAdmission(scope, {
    requestID: item.requestID,
    queueItemID: item.queueItemID,
    operationID: item.operationID,
    messageID: item.messageID,
    content: item.content,
    createdAt: item.createdAt,
    attachmentCount: item.attachments.length,
    ...(item.composerDocument ? { composerDocument: item.composerDocument } : {}),
    ...(item.composerMentions ? { composerMentions: item.composerMentions } : {}),
  })
  const confirmed = store.confirmAdmission(scope, {
    requestID: item.requestID,
    sendConfig: item.sendConfig,
    attachments: item.attachments,
  })
  return confirmed.ok
}

/**
 * After createWithPrompt selects a real session, move client establishing
 * follow-ups into that session's queue so they keep the same chip continuum
 * ("Queuing…" → durable queued) without starting another session create.
 */
export const drainEstablishingFollowUps = async (
  input: DrainEstablishingFollowUpsInput,
): Promise<{ drained: number; failed: number }> => {
  const pending = useComposerSendStore.getState().takeEstablishingPending(input.draftID)
  if (pending.length === 0) return { drained: 0, failed: 0 }

  const scope = boundScope(input)
  let drained = 0
  let failed = 0

  for (const item of pending) {
    try {
      if (input.admitServer) {
        const result = await input.admitServer(item)
        if (result.status === "committed") {
          drained += 1
          continue
        }
      }
      if (admitLegacyEstablishingFollowUp(scope, item)) drained += 1
      else failed += 1
    } catch {
      try {
        if (admitLegacyEstablishingFollowUp(scope, item)) drained += 1
        else failed += 1
      } catch {
        failed += 1
      }
    }
  }

  return { drained, failed }
}
