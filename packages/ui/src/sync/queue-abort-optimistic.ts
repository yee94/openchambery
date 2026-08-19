import React from 'react'
import { getQueueForScope, legacyQueueScope, useMessageQueueStore, type QueueItem, type QueueScope } from '@/stores/messageQueueStore'
import { getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch'
import { ascendingIdAfter } from '@/sync/message-id'
import { getSyncMessages } from '@/sync/sync-refs'
import {
  beginOptimisticSend,
  rollbackOptimisticSend,
  type OptimisticSendTicket,
} from '@/sync/session-actions'
import { useSessionUIStore } from '@/sync/session-ui-store'
import { getMessageQueueCutover } from '@/sync/message-queue-cutover'
import { getMessageQueueServerRuntime } from '@/sync/message-queue-server-runtime'
import type { MessageQueueItem } from '@/lib/message-queue-server'

export type QueueAbortOptimisticPresentation = {
  sessionID: string
  directory: string
  queueItemID: string
  operationID?: string
  messageID: string
  ticket: OptimisticSendTicket
  source: 'server' | 'legacy'
}

export type QueueAbortOptimisticItemSnapshot = {
  queueItemID: string
  status: string
} | null

export type QueueAbortOptimisticTranscript = {
  hasPinnedMessage: boolean
  hasLaterUserMessage: boolean
}

const WAITING = new Set(['queued', 'retrying'])
const IN_FLIGHT = new Set(['sending', 'reconciling'])
const FAILED = new Set(['failed', 'unresolved'])

const presentations = new Map<string, QueueAbortOptimisticPresentation>()
const listeners = new Set<() => void>()
let revision = 0

const notify = (): void => {
  revision += 1
  for (const listener of listeners) listener()
}

export const subscribeQueueAbortOptimistic = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const getQueueAbortOptimisticRevision = (): number => revision

export const getQueueAbortOptimisticPresentation = (sessionID: string): QueueAbortOptimisticPresentation | undefined => (
  presentations.get(sessionID)
)

export const isQueueItemHiddenByAbortOptimistic = (sessionID: string, queueItemID: string): boolean => (
  presentations.get(sessionID)?.queueItemID === queueItemID
)

const latestMessageID = (sessionID: string, directory: string): string | undefined => {
  let latest: string | undefined
  for (const message of getSyncMessages(sessionID, directory)) {
    const id = typeof message?.id === 'string' ? message.id : ''
    if (/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id) && (!latest || id > latest)) latest = id
  }
  return latest
}

const waitingHead = <T extends { status: string; deliveryTarget?: { kind?: string } }>(items: readonly T[] | undefined): T | undefined => {
  const head = items?.[0]
  if (!head || !WAITING.has(head.status)) return undefined
  if (head.deliveryTarget?.kind === 'assistant') return undefined
  return head
}

const legacyHead = (sessionID: string, directory: string): QueueItem | undefined => {
  const store = useMessageQueueStore.getState()
  const bound: QueueScope = {
    state: 'bound',
    transportIdentity: getRuntimeTransportIdentity(),
    directory,
    sessionID,
  }
  return waitingHead(store.getQueueForScope(bound) as QueueItem[])
    ?? waitingHead(store.getQueueForScope(legacyQueueScope(sessionID)) as QueueItem[])
}

const serverHead = (sessionID: string, directory: string): MessageQueueItem | undefined => {
  const ownership = getMessageQueueCutover().getSnapshot().ownership
  if (ownership !== 'server-active' && ownership !== 'server-paused') return undefined
  const scope = getMessageQueueServerRuntime().getScope({
    transportIdentity: getRuntimeTransportIdentity(),
    directory,
    sessionID,
  })
  return waitingHead(scope?.items)
}

const sendConfigOf = (item: { sendConfig?: { providerID?: string; modelID?: string; agent?: string } }) => {
  const providerID = item.sendConfig?.providerID
  const modelID = item.sendConfig?.modelID
  if (!providerID || !modelID) return null
  return { providerID, modelID, agent: item.sendConfig?.agent }
}

export const planQueueAbortOptimisticReconcile = (
  item: QueueAbortOptimisticItemSnapshot,
  transcript: QueueAbortOptimisticTranscript,
): 'keep' | 'confirm' | 'rollback' => {
  if (item && (WAITING.has(item.status) || IN_FLIGHT.has(item.status))) {
    return transcript.hasPinnedMessage ? 'confirm' : 'keep'
  }
  if (item && FAILED.has(item.status)) return 'rollback'
  if (transcript.hasPinnedMessage) return 'confirm'
  if (transcript.hasLaterUserMessage) return 'rollback'
  return 'keep'
}

const forget = (sessionID: string): QueueAbortOptimisticPresentation | undefined => {
  const current = presentations.get(sessionID)
  if (!current) return undefined
  presentations.delete(sessionID)
  notify()
  return current
}

export const rollbackQueueAbortOptimistic = (sessionID: string): void => {
  const current = forget(sessionID)
  if (!current) return
  rollbackOptimisticSend(current.ticket)
}

export const confirmQueueAbortOptimistic = (sessionID: string): void => {
  const current = forget(sessionID)
  if (!current) return
  useSessionUIStore.getState().clearMessageSending?.(sessionID, current.messageID)
}

const snapshotFor = (presentation: QueueAbortOptimisticPresentation): QueueAbortOptimisticItemSnapshot => {
  if (presentation.source === 'server') {
    const scope = getMessageQueueServerRuntime().getScope({
      transportIdentity: getRuntimeTransportIdentity(),
      directory: presentation.directory,
      sessionID: presentation.sessionID,
    })
    const item = scope?.items.find((entry) => entry.queueItemID === presentation.queueItemID)
    return item ? { queueItemID: item.queueItemID, status: item.status } : null
  }
  const bound: QueueScope = {
    state: 'bound',
    transportIdentity: getRuntimeTransportIdentity(),
    directory: presentation.directory,
    sessionID: presentation.sessionID,
  }
  const item = (
    getQueueForScope(useMessageQueueStore.getState(), bound) as QueueItem[]
  ).find((entry) => entry.queueItemID === presentation.queueItemID)
    ?? (getQueueForScope(useMessageQueueStore.getState(), legacyQueueScope(presentation.sessionID)) as QueueItem[])
      .find((entry) => entry.queueItemID === presentation.queueItemID)
  return item ? { queueItemID: item.queueItemID, status: item.status } : null
}

const transcriptFor = (presentation: QueueAbortOptimisticPresentation): QueueAbortOptimisticTranscript => {
  const messages = getSyncMessages(presentation.sessionID, presentation.directory)
  let hasPinnedMessage = false
  let hasLaterUserMessage = false
  for (const message of messages) {
    const id = typeof message?.id === 'string' ? message.id : ''
    if (id === presentation.messageID) hasPinnedMessage = true
    if (message?.role === 'user' && id && id > presentation.messageID) hasLaterUserMessage = true
  }
  return { hasPinnedMessage, hasLaterUserMessage }
}

export const reconcileQueueAbortOptimistic = (sessionID?: string): void => {
  const targets = sessionID
    ? [presentations.get(sessionID)].filter((entry): entry is QueueAbortOptimisticPresentation => Boolean(entry))
    : [...presentations.values()]
  for (const presentation of targets) {
    const plan = planQueueAbortOptimisticReconcile(snapshotFor(presentation), transcriptFor(presentation))
    if (plan === 'confirm') confirmQueueAbortOptimistic(presentation.sessionID)
    else if (plan === 'rollback') rollbackQueueAbortOptimistic(presentation.sessionID)
  }
}

export const promoteQueueHeadOnAbort = (sessionID: string): QueueAbortOptimisticPresentation | null => {
  if (!sessionID || presentations.has(sessionID)) return presentations.get(sessionID) ?? null
  const directory = useSessionUIStore.getState().getDirectoryForSession(sessionID)
  if (!directory) return null
  const server = serverHead(sessionID, directory)
  const legacy = server ? undefined : legacyHead(sessionID, directory)
  const item = server ?? legacy
  if (!item) return null
  const config = sendConfigOf(item)
  if (!config) return null
  const content = typeof item.content === 'string' ? item.content : ''
  const messageID = ascendingIdAfter('msg', latestMessageID(sessionID, directory))
  try {
    const ticket = beginOptimisticSend({
      sessionId: sessionID,
      content,
      providerID: config.providerID,
      modelID: config.modelID,
      agent: config.agent,
      directory,
      messageID,
    })
    const presentation: QueueAbortOptimisticPresentation = {
      sessionID,
      directory,
      queueItemID: item.queueItemID,
      operationID: 'operationID' in item ? item.operationID : undefined,
      messageID: ticket.messageID,
      ticket,
      source: server ? 'server' : 'legacy',
    }
    presentations.set(sessionID, presentation)
    notify()
    return presentation
  } catch {
    return null
  }
}

export const resetQueueAbortOptimisticForTests = (): void => {
  presentations.clear()
  notify()
}

export function useQueueAbortOptimisticReconcile(): void {
  const gateRevision = React.useSyncExternalStore(
    subscribeQueueAbortOptimistic,
    getQueueAbortOptimisticRevision,
    getQueueAbortOptimisticRevision,
  )
  const queuedMessages = useMessageQueueStore((state) => state.queuedMessages)
  React.useEffect(() => {
    reconcileQueueAbortOptimistic()
  }, [gateRevision, queuedMessages])
  React.useEffect(() => {
    const runtime = getMessageQueueServerRuntime()
    const stopRuntime = runtime.subscribe(() => { reconcileQueueAbortOptimistic() })
    const stopTransport = subscribeRuntimeEndpointChanged(() => {
      for (const sessionID of [...presentations.keys()]) rollbackQueueAbortOptimistic(sessionID)
    })
    return () => {
      stopRuntime()
      stopTransport()
    }
  }, [])
}
