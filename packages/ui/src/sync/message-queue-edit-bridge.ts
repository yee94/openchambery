import type { QueueAttachmentIssueDTO, QueueAttachmentRefDTO } from "@/stores/message-queue-ledger"
import { isDurableURL, type DraftAttachmentMetadata, type DraftKey } from "./input-draft-types"
import { type DraftCommitInput, type DraftCommitResult, type InputDraftRuntimeCapture, useInputStore } from "./input-store"
import { buildQueueComposerRestoration, commitComposerRestoration } from "./message-composer-restoration"
import { getMessageQueueRuntime } from "./message-queue-runtime"
import type { MessageQueueRemoveResult, MessageQueueRuntimeController, MessageQueueRuntimeResult, QueueRuntimeCapture, ScopedQueueIdentity } from "./message-queue-runtime-controller"

export type MaterializedEditInput = {
  identity: ScopedQueueIdentity
  queueRuntime: QueueRuntimeCapture
  targetKey: DraftKey
  expectedRevision: DraftCommitInput["expectedRevision"]
  inputRuntime: InputDraftRuntimeCapture
}

export type MessageQueueEditResult = {
  status: "materialize-failed" | "draft-rejected" | "queue-retained" | "committed"
  current: boolean
  draftDurable: boolean
  queueDurablyRemoved: boolean
  attachmentIssues: readonly QueueAttachmentIssueDTO[]
  diagnostics: readonly { stage: "identity" | "materialize" | "attachments" | "draft" | "remove" | "cleanup"; code: string }[]
}

export type MessageQueueEditBridge = { edit: (input: MaterializedEditInput) => Promise<MessageQueueEditResult> }
export type MessageQueueEditBridgeDependencies = {
  queue: Pick<MessageQueueRuntimeController, "materializeForEdit" | "releaseEditReservation" | "removeEditReservation">
  commitDraftSnapshot: (input: DraftCommitInput) => Promise<DraftCommitResult>
}
export type LazyMessageQueueEditBridgeDependencies = {
  getQueue: () => Pick<MessageQueueRuntimeController, "captureRuntime" | "materializeForEdit" | "releaseEditReservation" | "removeEditReservation">
  getInput: () => Pick<ReturnType<typeof useInputStore.getState>, "captureDraftRuntime" | "commitDraftSnapshot">
}
export type LazyMessageQueueEditBridge = { edit: (input: Pick<MaterializedEditInput, "identity" | "targetKey" | "expectedRevision">) => Promise<MessageQueueEditResult> }

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const rootOccurrence = (value: string, attachmentID: string): boolean => {
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.length === 2 && parsed[0] === "root" && parsed[1] === attachmentID } catch { return false }
}
const sameAttachment = (left: QueueAttachmentRefDTO, right: QueueAttachmentRefDTO): boolean => JSON.stringify(left) === JSON.stringify(right)
const result = (status: MessageQueueEditResult["status"], values: Omit<MessageQueueEditResult, "status">): MessageQueueEditResult => ({ status, ...values, attachmentIssues: clone(values.attachmentIssues), diagnostics: clone(values.diagnostics) })
const invalid = (diagnostics: MessageQueueEditResult["diagnostics"], issues: readonly QueueAttachmentIssueDTO[] = []): MessageQueueEditResult => result("materialize-failed", { current: false, draftDurable: false, queueDurablyRemoved: false, attachmentIssues: issues, diagnostics })
const withCleanup = async (outcome: MessageQueueEditResult, queue: MessageQueueEditBridgeDependencies["queue"], identity: ScopedQueueIdentity, token: NonNullable<MessageQueueRuntimeResult["token"]>, runtime: QueueRuntimeCapture): Promise<MessageQueueEditResult> => {
  let code: string | undefined
  try {
    const released = await queue.releaseEditReservation(identity, token, runtime)
    if (released.status !== "committed" || released.cleanupErrors.length) code = released.cleanupErrors.length ? "release-cleanup" : `release-${released.status}`
  } catch { code = "release-threw" }
  return code ? result(outcome.status, { current: outcome.current, draftDurable: outcome.draftDurable, queueDurablyRemoved: outcome.queueDurablyRemoved, attachmentIssues: outcome.attachmentIssues, diagnostics: [...outcome.diagnostics, { stage: "cleanup", code }] }) : outcome
}

const draftAttachments = (attachments: readonly QueueAttachmentRefDTO[], values: NonNullable<MessageQueueRuntimeResult["values"]>): { payload?: { attachments: DraftAttachmentMetadata[]; values: ReadonlyMap<string, Blob | string> }; code?: string } => {
  if (values.length !== attachments.length || new Set(attachments.map((attachment) => attachment.occurrenceRefID)).size !== attachments.length) return { code: "root-occurrence-count" }
  const byOccurrence = new Map<string, NonNullable<MessageQueueRuntimeResult["values"]>[number]>()
  for (const entry of values) {
    if (byOccurrence.has(entry.attachment.occurrenceRefID) || !rootOccurrence(entry.attachment.occurrenceRefID, entry.attachment.attachmentID)) return { code: "invalid-root-occurrence" }
    const expected = attachments.find((attachment) => attachment.occurrenceRefID === entry.attachment.occurrenceRefID)
    if (!expected || !sameAttachment(expected, entry.attachment)) return { code: "attachment-mismatch" }
    if (expected.locator.kind === "url" ? entry.value !== expected.locator.url : !(entry.value instanceof Blob) && !isDurableURL(entry.value)) return { code: "attachment-value-mismatch" }
    byOccurrence.set(entry.attachment.occurrenceRefID, entry)
  }
  if (byOccurrence.size !== attachments.length) return { code: "root-occurrence-missing" }
  const mapped: DraftAttachmentMetadata[] = []
  const draftValues = new Map<string, Blob | string>()
  for (const attachment of attachments) {
    const entry = byOccurrence.get(attachment.occurrenceRefID)
    if (!entry) return { code: "root-occurrence-missing" }
    mapped.push({ attachmentID: attachment.attachmentID, attachmentRefID: attachment.occurrenceRefID, filename: attachment.filename, mimeType: attachment.mimeType, size: attachment.size, locator: clone(attachment.locator), source: attachment.source, ...(attachment.serverPath ? { serverPath: attachment.serverPath } : {}), ...(attachment.vscodePath ? { vscodePath: attachment.vscodePath } : {}), ...(attachment.vscodeSource ? { vscodeSource: attachment.vscodeSource } : {}) })
    draftValues.set(attachment.occurrenceRefID, entry.value)
  }
  return { payload: { attachments: mapped, values: draftValues } }
}

export const createMessageQueueEditBridge = ({ queue, commitDraftSnapshot }: MessageQueueEditBridgeDependencies): MessageQueueEditBridge => {
  const flights = new Map<string, Promise<MessageQueueEditResult>>()
  const edit = (input: MaterializedEditInput): Promise<MessageQueueEditResult> => {
    const { identity, queueRuntime, targetKey, expectedRevision, inputRuntime } = input
    const flight = [identity.scopeKey, identity.queueItemID, identity.operationID, identity.messageID].join("\u0000")
    const existing = flights.get(flight)
    if (existing) return existing
    if (queueRuntime.transportIdentity !== inputRuntime.transportIdentity || queueRuntime.generation !== inputRuntime.generation || targetKey.transportIdentity !== queueRuntime.transportIdentity) return Promise.resolve(invalid([{ stage: "identity", code: "runtime-mismatch" }]))
    const task = (async (): Promise<MessageQueueEditResult> => {
      let materialized: MessageQueueRuntimeResult
      try { materialized = await queue.materializeForEdit(identity, queueRuntime) } catch { return invalid([{ stage: "materialize", code: "threw" }]) }
      if (materialized.status !== "committed" || !materialized.item || !materialized.values || !materialized.token) return invalid([{ stage: "materialize", code: materialized.status === "committed" ? "missing-reservation" : materialized.status }])
      const issues = materialized.item.attachmentIssues
      if (issues.length) return withCleanup(invalid([{ stage: "attachments", code: "attachment-issues" }], issues), queue, identity, materialized.token, queueRuntime)
      try {
        const mapped = draftAttachments(materialized.item.attachments, materialized.values)
        if (!mapped.payload) return withCleanup(invalid([{ stage: "attachments", code: mapped.code ?? "invalid" }]), queue, identity, materialized.token, queueRuntime)
        let draft: DraftCommitResult
        try {
          const restoration = await buildQueueComposerRestoration({
            content: materialized.item.content,
            composerDocument: materialized.item.composerDocument,
            composerMentions: materialized.item.composerMentions,
            draftAttachments: mapped.payload.attachments,
            draftValues: mapped.payload.values,
          })
          const committed = await commitComposerRestoration({
            key: targetKey,
            expectedRevision,
            payload: restoration,
            runtime: inputRuntime,
            input: { captureDraftRuntime: () => inputRuntime, commitDraftSnapshot },
          })
          draft = committed.result ?? { status: committed.status, durable: committed.durable, current: committed.current, errors: [], cleanupErrors: [] }
          if (committed.status === "failed" && !committed.result) throw new Error("draft-threw")
        } catch { return withCleanup(result("draft-rejected", { current: false, draftDurable: false, queueDurablyRemoved: false, attachmentIssues: [], diagnostics: [{ stage: "draft", code: "threw" }] }), queue, identity, materialized.token, queueRuntime) }
        // Durable-before-remove: only remove queue item after draft.durable is true.
        if (!draft.durable) return withCleanup(result("draft-rejected", { current: false, draftDurable: false, queueDurablyRemoved: false, attachmentIssues: [], diagnostics: [{ stage: "draft", code: draft.status }] }), queue, identity, materialized.token, queueRuntime)
        let removal: MessageQueueRemoveResult
        try { removal = await queue.removeEditReservation(identity, materialized.token, queueRuntime) } catch { return withCleanup(result("queue-retained", { current: false, draftDurable: true, queueDurablyRemoved: false, attachmentIssues: [], diagnostics: [{ stage: "remove", code: "threw" }] }), queue, identity, materialized.token, queueRuntime) }
        if (!removal.durableRemoval) return withCleanup(result("queue-retained", { current: false, draftDurable: true, queueDurablyRemoved: false, attachmentIssues: [], diagnostics: [{ stage: "remove", code: removal.status }] }), queue, identity, materialized.token, queueRuntime)
        return result("committed", { current: draft.current && removal.current !== false, draftDurable: true, queueDurablyRemoved: true, attachmentIssues: [], diagnostics: removal.cleanupErrors.length ? [{ stage: "cleanup", code: "remove-cleanup" }] : [] })
      } catch { return withCleanup(result("draft-rejected", { current: false, draftDurable: false, queueDurablyRemoved: false, attachmentIssues: [], diagnostics: [{ stage: "draft", code: "threw" }] }), queue, identity, materialized.token, queueRuntime) }
    })()
    flights.set(flight, task)
    void task.finally(() => { if (flights.get(flight) === task) flights.delete(flight) })
    return task
  }
  return { edit }
}

export const createLazyMessageQueueEditBridge = ({ getQueue, getInput }: LazyMessageQueueEditBridgeDependencies): LazyMessageQueueEditBridge => {
  const flights = new Map<string, Promise<MessageQueueEditResult>>()
  return {
    edit: ({ identity, targetKey, expectedRevision }: Pick<MaterializedEditInput, "identity" | "targetKey" | "expectedRevision">) => {
      const key = [identity.scopeKey, identity.queueItemID, identity.operationID, identity.messageID].join("\u0000")
      const existing = flights.get(key)
      if (existing) return existing
      let queue: ReturnType<LazyMessageQueueEditBridgeDependencies["getQueue"]>
      let input: ReturnType<LazyMessageQueueEditBridgeDependencies["getInput"]>
      try { queue = getQueue() } catch { return Promise.resolve(invalid([{ stage: "identity", code: "queue-getter-threw" }])) }
      try { input = getInput() } catch { return Promise.resolve(invalid([{ stage: "identity", code: "input-getter-threw" }])) }
      let queueRuntime: QueueRuntimeCapture
      let inputRuntime: InputDraftRuntimeCapture
      try { queueRuntime = queue.captureRuntime() } catch { return Promise.resolve(invalid([{ stage: "identity", code: "queue-capture-threw" }])) }
      try { inputRuntime = input.captureDraftRuntime() } catch { return Promise.resolve(invalid([{ stage: "identity", code: "input-capture-threw" }])) }
      const bridge = createMessageQueueEditBridge({ queue, commitDraftSnapshot: (value) => input.commitDraftSnapshot(value) })
      const task = bridge.edit({ identity, targetKey, expectedRevision, queueRuntime, inputRuntime })
      flights.set(key, task)
      void task.finally(() => { if (flights.get(key) === task) flights.delete(key) })
      return task
    },
  }
}

const defaultBridge = createLazyMessageQueueEditBridge({ getQueue: getMessageQueueRuntime, getInput: () => useInputStore.getState() })
export const editQueuedMessageIntoDraft = (input: Pick<MaterializedEditInput, "identity" | "targetKey" | "expectedRevision">): Promise<MessageQueueEditResult> => defaultBridge.edit(input)
