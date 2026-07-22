/**
 * Input Store — pending input text, synthetic parts, and attached files.
 * Extracted from session-ui-store for subscription isolation.
 */

import { create } from "zustand"
import type { AttachedFile } from "@/stores/types/sessionTypes"
import { getRuntimeGeneration, getRuntimeTransportIdentity } from "@/lib/runtime-switch"
import { createUuid } from "@/lib/uuid"
import { createDefaultInputDraftMetadataSink, createInputDraftMetadataPersistenceCoordinator, createInputDraftMetadataRepository, type InputDraftMetadataErrorCode, type InputDraftMetadataMigration, type InputDraftMetadataPersistenceCoordinator, type InputDraftMetadataRepository, type InputDraftMetadataSink, type LegacyInputDraft } from "./input-draft-metadata-store"
import { createInputDraftBlobStore, type DraftBlobErrorCode, type InputDraftBlobStore } from "./input-draft-blob-store"
import { createInputDraftDurabilityCoordinator, type InputDraftDurabilityCoordinator, type InputDraftDurabilityResult } from "./input-draft-durability-coordinator"
import { cloneDraftRecord, draftKeyString, draftRootAttachmentOccurrenceRefID, draftSyntheticPartAttachmentOccurrenceRefID, isDurableURL, parseDraftRecord, type DraftAttachmentMetadata, type DraftComposerDocument, type DraftKey, type DraftMention, type DraftRecord, type DraftSyntheticPart } from "./input-draft-types"
import { parseLegacyDraftComposerDocument } from "./input-draft-composer-parser"

const FILE_URI_PREFIX = "file://"
const encodeFilePath = (filepath: string): string => {
  let normalized = filepath.replace(/\\/g, "/")
  if (/^[A-Za-z]:/.test(normalized)) {
    normalized = `/${normalized}`
  }
  return normalized
    .split("/")
    .map((segment, index) => {
      if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment
      return encodeURIComponent(segment)
    })
    .join("/")
}

const toFileUrl = (filepath: string): string => {
  const normalized = filepath.replace(/\\/g, "/").trim()
  if (normalized.toLowerCase().startsWith(FILE_URI_PREFIX)) {
    return normalized
  }
  return `${FILE_URI_PREFIX}${encodeFilePath(normalized)}`
}

const getVSCodeSelectionKey = (path: string, filename: string): string => `${path}\u0000${filename}`

const readFileAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(reader.result as string)
  reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"))
  reader.onabort = () => reject(new Error("File read aborted"))
  reader.readAsDataURL(file)
})

const getDataUrlByteSize = (url: string): number => {
  if (!url.startsWith("data:")) return 0
  const commaIndex = url.indexOf(",")
  if (commaIndex < 0) return 0
  const metadata = url.slice(0, commaIndex).toLowerCase()
  const payload = url.slice(commaIndex + 1)
  if (!metadata.endsWith(";base64")) return 0
  let padding = 0
  if (payload.endsWith("==")) {
    padding = 2
  } else if (payload.endsWith("=")) {
    padding = 1
  }
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
}

const isSameVSCodeActiveEditorFile = (a: VSCodeActiveEditorFile | null, b: VSCodeActiveEditorFile | null): boolean => {
  if (a === b) return true
  if (!a || !b) return false
  return a.filePath === b.filePath
    && a.fileName === b.fileName
    && a.relativePath === b.relativePath
    && a.fileSize === b.fileSize
    && a.selection?.startLine === b.selection?.startLine
    && a.selection?.endLine === b.selection?.endLine
    && a.selection?.text === b.selection?.text
}

export type SyntheticContextPart = {
  partID?: string
  text: string
  attachments?: AttachedFile[]
  synthetic?: boolean
}

export type VSCodeActiveEditorFile = {
  filePath: string
  fileName: string
  relativePath: string
  fileSize: number | null
  selection: { startLine: number; endLine: number; text: string } | null
}

export type DraftHydrationStatus = "idle" | "loading" | "ready" | "degraded" | "error"
export type DraftPersistenceStatus = "idle" | "saving" | "saved" | "error"
export type DraftPersistenceState = { status: DraftPersistenceStatus; revision: number; errorCode?: InputDraftMetadataErrorCode | DraftBlobErrorCode }
export type DraftAttachmentPersistenceState = DraftPersistenceState
export type InputDraftRuntimeCapture = { transportIdentity: string; generation: number }
export type DraftCommitStatus = "committed" | "conflict" | "stale" | "failed" | "disabled" | "unseeded"
export type DraftCommitResult = {
  status: DraftCommitStatus
  record?: DraftRecord
  errors: InputDraftDurabilityResult["errors"]
  cleanupErrors: InputDraftDurabilityResult["cleanupErrors"]
  /** True when this operation published into the current memory epoch. */
  current: boolean
  /** True after metadata persistence has established the coordinator baseline. */
  durable: boolean
}
export type DraftOwnershipCommitResult = Omit<DraftCommitResult, "record"> & { source?: DraftRecord; destination?: DraftRecord }
export type DraftSnapshot = Pick<DraftRecord, "text" | "attachments" | "syntheticParts" | "mentions" | "composerReferences">
export type DraftCommitInput = { key: DraftKey; expectedRevision: number | "absent"; snapshot: DraftSnapshot; values?: ReadonlyMap<string, Blob | string>; runtime: InputDraftRuntimeCapture }
export type InputDraftServices = {
  sink?: InputDraftMetadataSink
  repository?: InputDraftMetadataRepository
  coordinator?: InputDraftMetadataPersistenceCoordinator
  blobStore?: InputDraftBlobStore
  /** Owns every durable blob/reference/metadata transaction. */
  durability?: InputDraftDurabilityCoordinator
  /** Supplies independent IDs for attachment identity and blob locators. */
  createID?: () => string
  persistenceEnabled?: boolean
  /** Returns the active transport lifetime identity for stale-work rejection. */
  runtimeCapture?: () => InputDraftRuntimeCapture
}

const emptyDraft = (key: DraftKey): DraftRecord => ({ version: 1, key, revision: 1, text: "", attachments: [], syntheticParts: [], mentions: [] })
const legacyMentions = (text: string, paths: string[]): DraftMention[] => paths.flatMap((path) => {
  const token = `@${path}`
  const mentions: DraftMention[] = []
  let start = text.indexOf(token)
  while (start >= 0) {
    mentions.push({ kind: "file", value: path, path, label: path, range: { start, end: start + token.length } })
    start = text.indexOf(token, start + token.length)
  }
  return mentions
})

export type InputState = {
  drafts: Record<string, DraftRecord>
  tombstones: Record<string, number>
  draftHydration: Record<string, DraftHydrationStatus>
  draftPersistence: Record<string, DraftPersistenceState>
  /** Ephemeral File-backed views; DraftRecord remains serializable metadata. */
  draftAttachmentViews: Record<string, Record<string, AttachedFile>>
  draftMissingAttachmentRefIDs: Record<string, string[]>
  draftAttachmentPersistence: Record<string, DraftAttachmentPersistenceState>
  persistenceEnabled: boolean
  legacyNewDraft?: LegacyInputDraft
  legacyDraftEntries: Record<string, LegacyInputDraft>
  migration: InputDraftMetadataMigration
  captureDraftRuntime: () => InputDraftRuntimeCapture
  commitDraftSnapshot: (input: DraftCommitInput) => Promise<DraftCommitResult>
  finalizeDraftOwnership: (input: { source: DraftKey; destination: DraftKey; expectedSourceRevision: number; disposition: "preserve" | "consume"; runtime: InputDraftRuntimeCapture }) => Promise<DraftOwnershipCommitResult>
  ensureDraft: (key: DraftKey) => DraftRecord
  getDraft: (key: DraftKey) => DraftRecord | undefined
  setDraftText: (key: DraftKey, text: string) => DraftRecord
  setDraftComposerState: (key: DraftKey, state: { document: DraftComposerDocument; mentions: DraftMention[] }) => DraftRecord | undefined
  setDraftComposerDocument: (key: DraftKey, document: DraftComposerDocument) => DraftRecord | undefined
  replaceDraft: (key: DraftKey, expectedRevision: number, record: Omit<DraftRecord, "key" | "revision" | "version">) => DraftRecord | undefined
  setDraftMentions: (key: DraftKey, mentions: DraftMention[]) => DraftRecord | undefined
  addDraftMention: (key: DraftKey, mention: DraftMention) => DraftRecord | undefined
  removeDraftMention: (key: DraftKey, value: string) => DraftRecord | undefined
  setDraftSyntheticParts: (key: DraftKey, parts: DraftSyntheticPart[]) => DraftRecord | undefined
  consumeDraftSyntheticParts: (key: DraftKey, retain?: (part: DraftSyntheticPart) => boolean) => DraftSyntheticPart[] | null
  setDraftAttachments: (key: DraftKey, attachments: DraftAttachmentMetadata[]) => DraftRecord | undefined
  addDraftLocalAttachment: (key: DraftKey, file: File | Blob, options?: { attachmentID?: string; filename?: string; source?: "local" | "vscode"; vscodePath?: string; vscodeSource?: "selection"; partID?: string }) => Promise<DraftAttachmentMetadata | undefined>
  addDraftDurableAttachment: (key: DraftKey, attachment: Omit<DraftAttachmentMetadata, "attachmentID" | "attachmentRefID" | "locator"> & { attachmentID?: string; url: string; partID?: string }) => DraftAttachmentMetadata | undefined
  hydrateDraftAttachments: (key: DraftKey) => Promise<void>
  getDraftAttachmentViews: (key: DraftKey) => AttachedFile[]
  retryDraftAttachmentPersistence: (key: DraftKey) => Promise<void>
  removeDraftAttachment: (key: DraftKey, attachmentRefID: string) => Promise<boolean>
  replaceDraftAttachment: (key: DraftKey, attachmentRefID: string, file: File | Blob, options?: { filename?: string; source?: "local" | "vscode"; vscodePath?: string; vscodeSource?: "selection" }) => Promise<DraftAttachmentMetadata | undefined>
  deleteDraft: (key: DraftKey, expectedRevision?: number) => boolean
  moveDraft: (source: DraftKey, destination: DraftKey, expectedRevision?: number) => DraftRecord | undefined
  moveDraftWithAttachments: (source: DraftKey, destination: DraftKey, expectedRevision?: number) => Promise<DraftRecord | undefined>
  hydrateDraftMetadata: (transportIdentity: string) => Promise<boolean>
  claimLegacyNewDraft: (key: DraftKey) => Promise<DraftRecord | undefined>
  setDraftPersistenceEnabled: (enabled: boolean) => Promise<void>
  flushDraftPersistence: () => Promise<void>
  pendingInputText: string | null
  pendingInputMode: "replace" | "append" | "append-inline"
  pendingSyntheticParts: SyntheticContextPart[] | null
  /**
   * Text a draft preset chip asked to submit immediately. Set by surfaces that
   * render the chips outside ChatInput (e.g. under the welcome message on
   * narrow layouts); consumed by ChatInput, which owns the command-aware submit.
   */
  pendingPresetSubmit: string | null
  attachedFiles: AttachedFile[]
  /** Legacy composer attachment views scoped to the current durable draft owner. */
  attachmentBuckets: Record<string, AttachedFile[]>
  activeAttachmentDraft: DraftKey | null
  activeEditorFile: VSCodeActiveEditorFile | null

  setPendingInputText: (text: string | null, mode?: "replace" | "append" | "append-inline") => void
  consumePendingInputText: () => { text: string; mode: "replace" | "append" | "append-inline" } | null
  requestPresetSubmit: (text: string) => void
  consumePendingPresetSubmit: () => string | null
  setPendingSyntheticParts: (parts: SyntheticContextPart[] | null) => void
  consumePendingSyntheticParts: () => SyntheticContextPart[] | null
  setActiveAttachmentDraft: (key: DraftKey | null) => void
  addAttachedFile: (file: File) => Promise<void>
  removeAttachedFile: (id: string) => void
  setAttachedFiles: (files: AttachedFile[]) => void
  clearAttachedFiles: () => void
  addVSCodeFileAttachment: (path: string, name: string, fileSize: number | null) => void
  addVSCodeSelectionAttachment: (path: string, file: File) => Promise<void>
  addCodeSelectionAttachment: (path: string, label: string, text: string) => Promise<void>
  setActiveEditorFile: (file: VSCodeActiveEditorFile | null) => void
  /** Add attachments restored from a reverted message (file already on server) */
  addRestoredAttachment: (file: { url: string; mimeType: string; filename: string }) => void
}

export const createInputStore = (services: InputDraftServices = {}) => {
  const sink = services.sink ?? createDefaultInputDraftMetadataSink()
  const repository = services.repository ?? createInputDraftMetadataRepository(sink)
  const coordinator = services.coordinator ?? createInputDraftMetadataPersistenceCoordinator(sink)
  const blobStore = services.blobStore ?? createInputDraftBlobStore()
  const durability = services.durability ?? createInputDraftDurabilityCoordinator(blobStore, coordinator, { enabled: services.persistenceEnabled ?? true })
  const keyEpoch = new Map<string, number>()
  const hydrateEpoch = new Map<string, number>()
  const attachmentHydrateEpoch = new Map<string, number>()
  const attachmentHydrationTasks = new Map<string, Promise<void>>()
  const draftMetadataHydrationTasks = new Map<string, Promise<boolean>>()
  const pendingPersists = new Set<Promise<InputDraftDurabilityResult>>()
  const deferredComposerPersistIDs = new Set<string>()
  let deferredComposerPersistTimer: ReturnType<typeof setTimeout> | undefined
  let deferredComposerPersistRuntime: InputDraftRuntimeCapture | undefined
  let persistenceGeneration = 0
  let legacyEpoch = 0
  let legacyNewClaimed = false
  let seeded = false
  let seedPromise: Promise<InputDraftDurabilityResult> | undefined
  const dirtyKeys = new Set<string>()
  const attachmentReadGeneration = new Map<string, number>()
  const pendingVSCodeSelectionKeys = new Set<string>()
  const store = create<InputState>()((set, get) => {
    const bump = (id: string) => keyEpoch.set(id, (keyEpoch.get(id) ?? 0) + 1)
    const invalidateAttachmentHydration = (...ids: string[]) => {
      for (const id of ids) {
        attachmentHydrateEpoch.set(id, (attachmentHydrateEpoch.get(id) ?? 0) + 1)
        attachmentHydrationTasks.delete(id)
      }
    }
    const valid = (value: unknown): DraftRecord | undefined => parseDraftRecord(value)
    const runtimeCapture = (): InputDraftRuntimeCapture => services.runtimeCapture?.() ?? { transportIdentity: getRuntimeTransportIdentity(), generation: getRuntimeGeneration() }
    const runtimeMatches = (capture: InputDraftRuntimeCapture): boolean => {
      const active = runtimeCapture()
      return active.transportIdentity === capture.transportIdentity && active.generation === capture.generation
    }
    const attachmentList = (record: DraftRecord) => [...record.attachments, ...record.syntheticParts.flatMap((part) => part.attachments)]
    const attachmentIDs = (record: DraftRecord): Set<string> => new Set(attachmentList(record).map((attachment) => attachment.attachmentRefID))
    const pruneAttachmentState = (state: InputState, id: string, record: DraftRecord) => {
      const live = attachmentIDs(record)
      return {
        draftAttachmentViews: { ...state.draftAttachmentViews, [id]: Object.fromEntries(Object.entries(state.draftAttachmentViews[id] ?? {}).filter(([ref]) => live.has(ref))) },
        draftMissingAttachmentRefIDs: { ...state.draftMissingAttachmentRefIDs, [id]: (state.draftMissingAttachmentRefIDs[id] ?? []).filter((ref) => live.has(ref)) },
      }
    }
    const createID = (): string => services.createID?.() ?? createUuid()
    const makeView = async (attachment: DraftAttachmentMetadata, value: Blob | string): Promise<AttachedFile> => {
      const file = value instanceof File ? value : new File([value], attachment.filename, { type: attachment.mimeType })
      return { id: attachment.attachmentID, file, dataUrl: typeof value === "string" ? value : await readFileAsDataUrl(file), mimeType: attachment.mimeType, filename: attachment.filename, size: attachment.size, source: attachment.source, ...(attachment.serverPath ? { serverPath: attachment.serverPath } : {}), ...(attachment.vscodePath ? { vscodePath: attachment.vscodePath } : {}), ...(attachment.vscodeSource ? { vscodeSource: attachment.vscodeSource } : {}) }
    }
    const persistenceErrorCode = (result: InputDraftDurabilityResult): InputDraftMetadataErrorCode | DraftBlobErrorCode => {
      const error = result.errors[0] ?? result.cleanupErrors[0]
      if (error?.phase === "metadata") return error.error.code
      return error?.phase === "blob" && ["blob-id-conflict", "database-unavailable", "invalid-value", "missing-blob", "quota-exceeded", "transaction-aborted", "transaction-failed"].includes(error.error.code) ? error.error.code as DraftBlobErrorCode : "unavailable"
    }
    const persist = (touchedIDs: Iterable<string>, capturedRuntime?: InputDraftRuntimeCapture): Promise<InputDraftDurabilityResult> => {
      const current = get()
      const generation = persistenceGeneration
      const runtime = capturedRuntime ?? runtimeCapture()
      const ids = [...new Set(touchedIDs)]
      ids.forEach((id) => deferredComposerPersistIDs.delete(id))
      if (deferredComposerPersistTimer && deferredComposerPersistIDs.size === 0) {
        clearTimeout(deferredComposerPersistTimer)
        deferredComposerPersistTimer = undefined
        deferredComposerPersistRuntime = undefined
      }
      if (!current.persistenceEnabled) {
        ids.forEach((id) => dirtyKeys.add(id))
        return Promise.resolve({ status: "disabled", keys: ids, errors: [], cleanupErrors: [] })
      }
      const epochs = new Map(ids.map((id) => [id, keyEpoch.get(id) ?? 0]))
      const revisions = new Map(ids.map((id) => [id, current.drafts[id]?.revision ?? current.tombstones[id] ?? 0]))
      const trackedIDs = ids.filter((id) => current.drafts[id])
      const saving = Object.fromEntries(trackedIDs.map((id) => [id, current.draftPersistence[id]?.status === "error" ? current.draftPersistence[id] : { status: "saving" as const, revision: revisions.get(id)! }]))
      const attachmentSaving = Object.fromEntries(trackedIDs.map((id) => [id, current.draftAttachmentPersistence[id]?.status === "error" ? current.draftAttachmentPersistence[id] : { status: "saving" as const, revision: revisions.get(id)! }]))
      set((state) => ({ draftPersistence: { ...state.draftPersistence, ...saving }, draftAttachmentPersistence: { ...state.draftAttachmentPersistence, ...attachmentSaving } }))
      if (!seeded) ids.forEach((id) => dirtyKeys.add(id))
      const run = async () => {
        const state = get()
        const result = await durability.commit({
          drafts: Object.fromEntries(ids.flatMap((id) => state.drafts[id] ? [[id, state.drafts[id]]] : [])),
          tombstones: Object.fromEntries(ids.flatMap((id) => state.tombstones[id] ? [[id, state.tombstones[id]]] : [])),
          delete: ids.filter((id) => !state.drafts[id]),
          migration: state.migration,
          legacy: { ...(state.legacyNewDraft ? { new: state.legacyNewDraft } : {}), entries: state.legacyDraftEntries },
          resolveBlobValue: (reference) => {
            for (const [id, record] of Object.entries(state.drafts)) if (record.key.transportIdentity === reference.transportIdentity && record.key.owner.kind === reference.owner.kind && record.key.owner.ownerID === reference.owner.ownerID) return state.draftAttachmentViews[id]?.[reference.attachmentOccurrenceRefID]?.file
            return undefined
          },
          isCurrent: () => persistenceGeneration === generation && get().persistenceEnabled && runtimeMatches(runtime) && ids.every((id) => (keyEpoch.get(id) ?? 0) === epochs.get(id) && (get().drafts[id]?.revision ?? get().tombstones[id] ?? 0) === revisions.get(id)),
        })
        const completionMatches = persistenceGeneration === generation && get().persistenceEnabled && runtimeMatches(runtime)
        if (!completionMatches || result.status === "unseeded" || result.status === "stale" || result.status === "disabled") ids.forEach((id) => dirtyKeys.add(id))
        if (!completionMatches) return result
        set((state) => {
          const draftPersistence = { ...state.draftPersistence }
          for (const id of trackedIDs) {
            if ((keyEpoch.get(id) ?? 0) !== epochs.get(id)) continue
            const revision = revisions.get(id)!
            if (result.status === "committed") draftPersistence[id] = { status: "saved", revision }
            else if (result.status === "unseeded" || result.status === "stale" || result.status === "disabled") continue
            else draftPersistence[id] = { status: "error", revision, errorCode: persistenceErrorCode(result) }
          }
          const attachmentPersistence = { ...state.draftAttachmentPersistence }
          for (const id of trackedIDs) {
            if ((keyEpoch.get(id) ?? 0) !== epochs.get(id)) continue
            const revision = revisions.get(id)!
            attachmentPersistence[id] = result.status === "committed" && result.cleanupErrors.length === 0
              ? { status: "saved", revision }
              : result.status === "failed" || result.cleanupErrors.length > 0
                ? { status: "error", revision, errorCode: persistenceErrorCode(result) }
                : attachmentPersistence[id] ?? { status: "idle", revision }
          }
          return { draftPersistence, draftAttachmentPersistence: attachmentPersistence }
        })
        return result
      }
      const task = run()
      pendingPersists.add(task)
      void task.then(() => pendingPersists.delete(task), () => pendingPersists.delete(task))
      return task
    }
    const markComposerPersistSaving = (ids: readonly string[]): void => {
      const state = get()
      const saving = Object.fromEntries(ids.flatMap((id) => {
        const record = state.drafts[id]
        return record ? [[id, { status: "saving" as const, revision: record.revision }]] : []
      }))
      if (Object.keys(saving).length) set((current) => ({ draftPersistence: { ...current.draftPersistence, ...saving } }))
    }
    const flushDeferredComposerPersists = (): Promise<void> => {
      if (deferredComposerPersistTimer) clearTimeout(deferredComposerPersistTimer)
      deferredComposerPersistTimer = undefined
      const ids = [...deferredComposerPersistIDs]
      deferredComposerPersistIDs.clear()
      const runtime = deferredComposerPersistRuntime
      deferredComposerPersistRuntime = undefined
      return ids.length ? persist(ids, runtime).then(() => undefined) : Promise.resolve()
    }
    const scheduleComposerPersist = (id: string): void => {
      if (!get().persistenceEnabled) {
        dirtyKeys.add(id)
        return
      }
      deferredComposerPersistIDs.add(id)
      markComposerPersistSaving([id])
      if (deferredComposerPersistTimer) return
      deferredComposerPersistRuntime = runtimeCapture()
      deferredComposerPersistTimer = setTimeout(() => { void flushDeferredComposerPersists() }, 40)
    }
    const persistImmediate = (ids: Iterable<string>): Promise<InputDraftDurabilityResult> => {
      const values = [...ids]
      values.forEach((id) => deferredComposerPersistIDs.delete(id))
      if (deferredComposerPersistTimer && deferredComposerPersistIDs.size === 0) {
        clearTimeout(deferredComposerPersistTimer)
        deferredComposerPersistTimer = undefined
        deferredComposerPersistRuntime = undefined
      }
      return persist(values)
    }
    const mutate = (key: DraftKey, change: (record: DraftRecord) => DraftRecord, expectedRevision?: number, persistence: "immediate" | "deferred" = "immediate"): DraftRecord | undefined => {
      const id = draftKeyString(key)
      const existing = get().drafts[id]
      if (!existing || (expectedRevision !== undefined && existing.revision !== expectedRevision)) return undefined
      const next = valid(change(existing))
      if (!next || draftKeyString(next.key) !== id) return undefined
      bump(id)
      set((state) => ({ drafts: { ...state.drafts, [id]: next }, ...pruneAttachmentState(state, id, next) }))
      if (persistence === "deferred") scheduleComposerPersist(id)
      else persistImmediate([id])
      return next
    }
    const cloneRecord = (record: DraftRecord | undefined): DraftRecord | undefined => record ? cloneDraftRecord(record) : undefined
    const cloneErrors = (errors: InputDraftDurabilityResult["errors"] = []): InputDraftDurabilityResult["errors"] => JSON.parse(JSON.stringify(errors)) as InputDraftDurabilityResult["errors"]
    const actionResult = (status: DraftCommitStatus, result: InputDraftDurabilityResult | undefined, record?: DraftRecord, current = false, durable = false): DraftCommitResult => ({ status, ...(cloneRecord(record) ? { record: cloneRecord(record)! } : {}), errors: cloneErrors(result?.errors), cleanupErrors: cloneErrors(result?.cleanupErrors), current, durable })
    const ownershipResult = (status: DraftCommitStatus, result: InputDraftDurabilityResult | undefined, source?: DraftRecord, destination?: DraftRecord, current = false, durable = false): DraftOwnershipCommitResult => ({ status, errors: cloneErrors(result?.errors), cleanupErrors: cloneErrors(result?.cleanupErrors), current, durable, source: cloneRecord(source), destination: cloneRecord(destination) })
    const actionStatus = (result: InputDraftDurabilityResult): DraftCommitStatus => result.status
    const positiveSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0
    const clearDraftEphemeralState = <T,>(values: Record<string, T>, ...ids: string[]): Record<string, T> => {
      const next = { ...values }
      for (const id of ids) delete next[id]
      return next
    }
    const snapshotViews = async (record: DraftRecord, values?: ReadonlyMap<string, Blob | string>): Promise<Record<string, AttachedFile> | undefined> => {
      const views: Record<string, AttachedFile> = {}
      for (const attachment of attachmentList(record)) {
        const value = values?.get(attachment.attachmentRefID) ?? (attachment.locator.kind === "url" ? attachment.locator.url : undefined)
        if (attachment.locator.kind === "url" && value !== undefined && (value !== attachment.locator.url || !isDurableURL(value))) return undefined
        if (attachment.locator.kind === "blob" && value !== undefined && !(value instanceof Blob) && !(typeof value === "string" && isDurableURL(value))) return undefined
        if (value !== undefined) views[attachment.attachmentRefID] = await makeView(attachment, value)
      }
      return views
    }
    const attachmentBucketID = (key: DraftKey | null): string => key ? draftKeyString(key) : "legacy-unowned"
    const attachmentReadEpoch = (id: string): number => attachmentReadGeneration.get(id) ?? 0
    const bumpAttachmentReadEpoch = (id: string): void => { attachmentReadGeneration.set(id, attachmentReadEpoch(id) + 1) }
    const updateAttachmentBucket = (id: string, change: (files: AttachedFile[]) => AttachedFile[], invalidateReads = false): void => {
      if (invalidateReads) bumpAttachmentReadEpoch(id)
      set((state) => {
        const files = change(state.attachmentBuckets[id] ?? [])
        const buckets = { ...state.attachmentBuckets, [id]: files }
        return { attachmentBuckets: buckets, ...(attachmentBucketID(state.activeAttachmentDraft) === id ? { attachedFiles: files } : {}) }
      })
    }
    return ({
  drafts: {},
  tombstones: {},
  draftHydration: {},
  draftPersistence: {},
  draftAttachmentViews: {},
  draftMissingAttachmentRefIDs: {},
  draftAttachmentPersistence: {},
  persistenceEnabled: services.persistenceEnabled ?? true,
  legacyDraftEntries: {},
  migration: { complete: false, claimedTransportIdentity: "" },
  captureDraftRuntime: () => runtimeCapture(),
  commitDraftSnapshot: async (input) => {
    const id = draftKeyString(input.key)
    const capture = input.runtime
    if (capture.transportIdentity !== input.key.transportIdentity || !runtimeMatches(capture)) return actionResult("stale", undefined)
    const state = get()
    const existing = state.drafts[id]
    const tombstone = state.tombstones[id] ?? 0
    if ((input.expectedRevision !== "absent" && !positiveSafeInteger(input.expectedRevision)) || !Number.isSafeInteger(tombstone) || tombstone < 0) return actionResult("failed", undefined)
    if (input.expectedRevision === "absent" ? !!existing : existing?.revision !== input.expectedRevision) return actionResult("conflict", undefined, existing)
    const revision = input.expectedRevision === "absent" ? tombstone + 1 : input.expectedRevision + 1
    if (!positiveSafeInteger(revision)) return actionResult("failed", undefined)
    const record = valid({ version: 1, key: input.key, revision, ...input.snapshot })
    if (!record) return actionResult("failed", undefined)
    const views = await snapshotViews(record, input.values)
    if (!views) return actionResult("failed", undefined)
    const epoch = keyEpoch.get(id) ?? 0
    const baselineRevision = existing?.revision ?? tombstone
    const result = await durability.commit({
      drafts: { [id]: record },
      isCurrent: () => runtimeMatches(capture)
        && (keyEpoch.get(id) ?? 0) === epoch
        && (get().drafts[id]?.revision ?? get().tombstones[id] ?? 0) === baselineRevision,
      resolveBlobValue: (reference) => input.values?.get(reference.attachmentOccurrenceRefID),
    })
    if (result.status !== "committed") return actionResult(actionStatus(result), result, existing)
    const memoryCurrent = (keyEpoch.get(id) ?? 0) === epoch && (get().drafts[id]?.revision ?? get().tombstones[id] ?? 0) === baselineRevision
    const runtimeCurrent = runtimeMatches(capture)
    if (!memoryCurrent) {
      if (!runtimeCurrent) set((currentState) => ({
        draftAttachmentViews: clearDraftEphemeralState(currentState.draftAttachmentViews, id),
        draftMissingAttachmentRefIDs: clearDraftEphemeralState(currentState.draftMissingAttachmentRefIDs, id),
        draftHydration: clearDraftEphemeralState(currentState.draftHydration, id),
        draftPersistence: clearDraftEphemeralState(currentState.draftPersistence, id),
        draftAttachmentPersistence: clearDraftEphemeralState(currentState.draftAttachmentPersistence, id),
      }))
      return actionResult("stale", result, record, false, true)
    }
    const cloned = cloneDraftRecord(record)
    if (!cloned) return actionResult("failed", result)
    bump(id)
    invalidateAttachmentHydration(id)
    set((currentState) => ({
      drafts: { ...currentState.drafts, [id]: cloned },
      tombstones: (() => { const tombstones = { ...currentState.tombstones }; delete tombstones[id]; return tombstones })(),
      draftAttachmentViews: runtimeCurrent ? { ...currentState.draftAttachmentViews, [id]: views } : clearDraftEphemeralState(currentState.draftAttachmentViews, id),
      draftMissingAttachmentRefIDs: runtimeCurrent ? { ...currentState.draftMissingAttachmentRefIDs, [id]: [] } : clearDraftEphemeralState(currentState.draftMissingAttachmentRefIDs, id),
      draftHydration: runtimeCurrent ? currentState.draftHydration : clearDraftEphemeralState(currentState.draftHydration, id),
      draftPersistence: runtimeCurrent ? { ...currentState.draftPersistence, [id]: { status: "saved", revision: cloned.revision } } : clearDraftEphemeralState(currentState.draftPersistence, id),
      draftAttachmentPersistence: runtimeCurrent ? { ...currentState.draftAttachmentPersistence, [id]: result.cleanupErrors.length ? { status: "error", revision: cloned.revision, errorCode: persistenceErrorCode(result) } : { status: "saved", revision: cloned.revision } } : clearDraftEphemeralState(currentState.draftAttachmentPersistence, id),
    }))
    return actionResult(runtimeCurrent ? "committed" : "stale", result, cloned, runtimeCurrent, true)
  },
  finalizeDraftOwnership: async (input) => {
    const sourceID = draftKeyString(input.source)
    const destinationID = draftKeyString(input.destination)
    const capture = input.runtime
    const state = get()
    const source = state.drafts[sourceID]
    const destination = state.drafts[destinationID]
    if (sourceID === destinationID || input.destination.owner.kind !== "session" || input.source.transportIdentity !== capture.transportIdentity || input.destination.transportIdentity !== capture.transportIdentity || !runtimeMatches(capture)) return ownershipResult("stale", undefined, source, destination)
    if (!positiveSafeInteger(input.expectedSourceRevision)) return ownershipResult("failed", undefined, source, destination)
    if (!source || source.revision !== input.expectedSourceRevision) return ownershipResult("conflict", undefined, source, destination)
    if (destination) return ownershipResult("conflict", undefined, source, destination)
    const sourceEpoch = keyEpoch.get(sourceID) ?? 0
    const destinationEpoch = keyEpoch.get(destinationID) ?? 0
    const sourceTombstone = state.tombstones[sourceID] ?? 0
    const destinationTombstone = state.tombstones[destinationID] ?? 0
    if (!Number.isSafeInteger(sourceTombstone) || sourceTombstone < 0 || !Number.isSafeInteger(destinationTombstone) || destinationTombstone < 0) return ownershipResult("failed", undefined, source, destination)
    const revision = Math.max(source.revision + 1, destinationTombstone + 1)
    if (!positiveSafeInteger(revision)) return ownershipResult("failed", undefined, source, destination)
    const destinationRecord = valid(input.disposition === "preserve"
      ? { ...source, key: input.destination, revision }
      : { ...emptyDraft(input.destination), revision })
    if (!destinationRecord) return ownershipResult("failed", undefined, source, destination)
    const result = await durability.commit({
      drafts: { [destinationID]: destinationRecord },
      tombstones: { [sourceID]: Math.max(sourceTombstone, revision) },
      delete: [sourceID],
      isCurrent: () => runtimeMatches(capture)
        && (keyEpoch.get(sourceID) ?? 0) === sourceEpoch
        && (keyEpoch.get(destinationID) ?? 0) === destinationEpoch
        && get().drafts[sourceID]?.revision === source.revision
        && !get().drafts[destinationID]
        && (get().tombstones[sourceID] ?? 0) === sourceTombstone
        && (get().tombstones[destinationID] ?? 0) === destinationTombstone,
      resolveBlobValue: (reference) => state.draftAttachmentViews[sourceID]?.[reference.attachmentOccurrenceRefID]?.file,
    })
    if (result.status !== "committed") return ownershipResult(actionStatus(result), result, source, destination)
    const sourceCurrent = (keyEpoch.get(sourceID) ?? 0) === sourceEpoch && get().drafts[sourceID]?.revision === source.revision && (get().tombstones[sourceID] ?? 0) === sourceTombstone
    const destinationCurrent = (keyEpoch.get(destinationID) ?? 0) === destinationEpoch && !get().drafts[destinationID] && (get().tombstones[destinationID] ?? 0) === destinationTombstone
    const runtimeCurrent = runtimeMatches(capture)
    const cloned = cloneDraftRecord(destinationRecord)
    if (!cloned) return ownershipResult("failed", result, source, destination)
    if (runtimeCurrent && !sourceCurrent && !destinationCurrent) return ownershipResult("stale", result, source, destinationRecord, false, true)
    if (sourceCurrent) { bump(sourceID); invalidateAttachmentHydration(sourceID) }
    if (destinationCurrent) { bump(destinationID); invalidateAttachmentHydration(destinationID) }
    set((currentState) => {
      let drafts = currentState.drafts
      let tombstones = currentState.tombstones
      if (sourceCurrent || destinationCurrent) drafts = { ...drafts }
      if (sourceCurrent || destinationCurrent) tombstones = { ...tombstones }
      if (sourceCurrent) { delete drafts[sourceID]; tombstones[sourceID] = Math.max(tombstones[sourceID] ?? 0, revision) }
      if (destinationCurrent) { drafts[destinationID] = cloned; delete tombstones[destinationID] }
      let draftHydration = currentState.draftHydration; let draftPersistence = currentState.draftPersistence; let draftAttachmentViews = currentState.draftAttachmentViews; let draftMissingAttachmentRefIDs = currentState.draftMissingAttachmentRefIDs; let draftAttachmentPersistence = currentState.draftAttachmentPersistence
      if (!runtimeCurrent) {
        draftHydration = clearDraftEphemeralState(draftHydration, sourceID, destinationID); draftPersistence = clearDraftEphemeralState(draftPersistence, sourceID, destinationID); draftAttachmentViews = clearDraftEphemeralState(draftAttachmentViews, sourceID, destinationID); draftMissingAttachmentRefIDs = clearDraftEphemeralState(draftMissingAttachmentRefIDs, sourceID, destinationID); draftAttachmentPersistence = clearDraftEphemeralState(draftAttachmentPersistence, sourceID, destinationID)
      } else {
        if (sourceCurrent) { draftHydration = clearDraftEphemeralState(draftHydration, sourceID); draftPersistence = clearDraftEphemeralState(draftPersistence, sourceID); draftAttachmentViews = clearDraftEphemeralState(draftAttachmentViews, sourceID); draftMissingAttachmentRefIDs = clearDraftEphemeralState(draftMissingAttachmentRefIDs, sourceID); draftAttachmentPersistence = clearDraftEphemeralState(draftAttachmentPersistence, sourceID) }
        if (destinationCurrent) {
          draftHydration = clearDraftEphemeralState(draftHydration, destinationID); draftPersistence = { ...clearDraftEphemeralState(draftPersistence, destinationID), [destinationID]: { status: "saved", revision: cloned.revision } }; draftAttachmentViews = clearDraftEphemeralState(draftAttachmentViews, destinationID); draftMissingAttachmentRefIDs = clearDraftEphemeralState(draftMissingAttachmentRefIDs, destinationID); draftAttachmentPersistence = { ...clearDraftEphemeralState(draftAttachmentPersistence, destinationID), [destinationID]: result.cleanupErrors.length ? { status: "error", revision: cloned.revision, errorCode: persistenceErrorCode(result) } : { status: "saved", revision: cloned.revision } }
        if (runtimeCurrent && sourceCurrent && input.disposition === "preserve") { draftAttachmentViews = { ...draftAttachmentViews, [destinationID]: currentState.draftAttachmentViews[sourceID] ?? {} }; draftMissingAttachmentRefIDs = { ...draftMissingAttachmentRefIDs, [destinationID]: currentState.draftMissingAttachmentRefIDs[sourceID] ?? [] } }
        }
      }
      return { drafts, tombstones, draftHydration, draftPersistence, draftAttachmentViews, draftMissingAttachmentRefIDs, draftAttachmentPersistence }
    })
    const committed = sourceCurrent && destinationCurrent && runtimeCurrent
    return ownershipResult(committed ? "committed" : "stale", result, source, destinationRecord, committed, true)
  },
  flushDraftPersistence: async () => {
    await flushDeferredComposerPersists()
    while (pendingPersists.size) await Promise.all([...pendingPersists])
    await durability.flush()
  },
  ensureDraft: (key) => {
    const id = draftKeyString(key)
    const existing = get().drafts[id]
    if (existing) return existing
    const record = valid({ ...emptyDraft(key), revision: (get().tombstones[id] ?? 0) + 1 })
    if (!record) throw new Error("Invalid empty draft")
    bump(id)
    set((state) => ({ drafts: { ...state.drafts, [id]: record } }))
    persistImmediate([id])
    return record
  },
  getDraft: (key) => get().drafts[draftKeyString(key)],
  setDraftText: (key, text) => {
    const current = get().getDraft(key) ?? get().ensureDraft(key)
    return mutate(key, (record) => ({ ...record, revision: record.revision + 1, text, mentions: record.mentions.filter((mention) => mention.range.end <= text.length && text.slice(mention.range.start, mention.range.end) === `@${mention.value}`), composerReferences: [] }), current.revision, "deferred") ?? current
  },
  setDraftComposerDocument: (key, document) => {
    const current = get().getDraft(key) ?? get().ensureDraft(key)
    return get().setDraftComposerState(key, { document, mentions: current.mentions })
  },
  setDraftComposerState: (key, state) => {
    const current = get().getDraft(key) ?? get().ensureDraft(key)
    return mutate(key, (record) => ({ ...record, revision: record.revision + 1, text: state.document.text, composerReferences: state.document.references, mentions: state.mentions }), current.revision, "deferred")
  },
  replaceDraft: (key, expectedRevision, record) => mutate(key, (current) => ({ version: 1, key: current.key, revision: current.revision + 1, text: record.text, attachments: record.attachments, syntheticParts: record.syntheticParts, mentions: record.mentions, ...(record.composerReferences === undefined ? {} : { composerReferences: record.composerReferences }) }), expectedRevision),
  setDraftMentions: (key, mentions) => mutate(key, (record) => ({ ...record, revision: record.revision + 1, mentions })),
  addDraftMention: (key, mention) => mutate(key, (record) => ({ ...record, revision: record.revision + 1, mentions: [...record.mentions, mention] })),
  removeDraftMention: (key, value) => mutate(key, (record) => ({ ...record, revision: record.revision + 1, mentions: record.mentions.filter((mention) => mention.value !== value) })),
  setDraftSyntheticParts: (key, syntheticParts) => mutate(key, (record) => ({ ...record, revision: record.revision + 1, syntheticParts })),
  consumeDraftSyntheticParts: (key, retain) => {
    const record = get().getDraft(key)
    if (!record) return null
    const parts = record.syntheticParts.filter((part) => !retain?.(part))
    const retained = record.syntheticParts.filter((part) => retain?.(part))
    return mutate(key, (current) => ({ ...current, revision: current.revision + 1, syntheticParts: retained }), record.revision) ? parts : null
  },
  setDraftAttachments: (key, attachments) => mutate(key, (record) => ({ ...record, revision: record.revision + 1, attachments })),
  addDraftLocalAttachment: async (key, file, options = {}) => {
    const current = get().getDraft(key)
    if (options.partID && !current?.syntheticParts.some((part) => part.partID === options.partID)) return undefined
    const id = draftKeyString(key)
    const startEpoch = keyEpoch.get(id) ?? 0
    const startTombstone = get().tombstones[id] ?? 0
    const runtime = runtimeCapture()
    const fileView = file instanceof File ? file : new File([file], options.filename ?? "attachment", { type: file.type })
    let dataUrl: string
    try {
      dataUrl = await readFileAsDataUrl(fileView)
    } catch {
      const latest = get().drafts[id]
      const sourceValid = runtimeMatches(runtime)
        && (get().tombstones[id] ?? 0) === startTombstone
        && (!latest ? (keyEpoch.get(id) ?? 0) === startEpoch : draftKeyString(latest.key) === id)
        && (!options.partID || latest?.syntheticParts.some((part) => part.partID === options.partID))
      if (sourceValid) {
        const revision = latest?.revision ?? get().tombstones[id] ?? 0
        set((state) => ({ draftAttachmentPersistence: { ...state.draftAttachmentPersistence, [id]: { status: "error", revision, errorCode: "transaction-failed" } } }))
      }
      return undefined
    }
    if (!runtimeMatches(runtime) || (get().tombstones[id] ?? 0) !== startTombstone) return undefined
    const latest = get().drafts[id]
    if (!latest && (keyEpoch.get(id) ?? 0) !== startEpoch) return undefined
    const record = latest ?? get().ensureDraft(key)
    if (draftKeyString(record.key) !== id || (options.partID && !record.syntheticParts.some((part) => part.partID === options.partID))) return undefined
    const attachmentID = options.attachmentID ?? createID()
    const attachmentRefID = options.partID ? draftSyntheticPartAttachmentOccurrenceRefID(options.partID, attachmentID) : draftRootAttachmentOccurrenceRefID(attachmentID)
    const blobID = createID()
    const attachment: DraftAttachmentMetadata = { attachmentID, attachmentRefID, filename: options.filename ?? (file instanceof File ? file.name : "attachment"), mimeType: file.type, size: file.size, locator: { kind: "blob", blobID }, source: options.source ?? "local", ...(options.vscodePath ? { vscodePath: options.vscodePath } : {}), ...(options.vscodeSource ? { vscodeSource: options.vscodeSource } : {}) }
    const next = options.partID ? { ...record, revision: record.revision + 1, syntheticParts: record.syntheticParts.map((part) => part.partID === options.partID ? { ...part, attachments: [...part.attachments, attachment] } : part) } : { ...record, revision: record.revision + 1, attachments: [...record.attachments, attachment] }
    const parsed = valid(next); if (!parsed) return undefined
    bump(id)
    const view: AttachedFile = { id: attachmentID, file: fileView, dataUrl, mimeType: attachment.mimeType, filename: attachment.filename, size: attachment.size, source: attachment.source, ...(options.vscodePath ? { vscodePath: options.vscodePath } : {}), ...(options.vscodeSource ? { vscodeSource: options.vscodeSource } : {}) }
    set((state) => ({ drafts: { ...state.drafts, [id]: parsed }, draftAttachmentViews: { ...state.draftAttachmentViews, [id]: { ...state.draftAttachmentViews[id], [attachmentRefID]: view } } }))
    await persist([id]); return attachment
  },
  addDraftDurableAttachment: (key, input) => {
    const record = get().getDraft(key) ?? get().ensureDraft(key); if (input.partID && !record.syntheticParts.some((part) => part.partID === input.partID)) return undefined; const attachmentID = input.attachmentID ?? createID(); const attachmentRefID = input.partID ? draftSyntheticPartAttachmentOccurrenceRefID(input.partID, attachmentID) : draftRootAttachmentOccurrenceRefID(attachmentID)
    const attachment: DraftAttachmentMetadata = { attachmentID, attachmentRefID, filename: input.filename, mimeType: input.mimeType, size: input.size, source: input.source, locator: { kind: "url", url: input.url }, ...(input.serverPath ? { serverPath: input.serverPath } : {}), ...(input.vscodePath ? { vscodePath: input.vscodePath } : {}), ...(input.vscodeSource ? { vscodeSource: input.vscodeSource } : {}) }; const next = input.partID ? { ...record, revision: record.revision + 1, syntheticParts: record.syntheticParts.map((part) => part.partID === input.partID ? { ...part, attachments: [...part.attachments, attachment] } : part) } : { ...record, revision: record.revision + 1, attachments: [...record.attachments, attachment] }; const parsed = valid(next); if (!parsed) return undefined
    const id = draftKeyString(key); bump(id); const view: AttachedFile = { id: attachmentID, file: new File([], attachment.filename, { type: attachment.mimeType }), dataUrl: input.url, mimeType: attachment.mimeType, filename: attachment.filename, size: attachment.size, source: attachment.source, ...(attachment.serverPath ? { serverPath: attachment.serverPath } : {}), ...(attachment.vscodePath ? { vscodePath: attachment.vscodePath } : {}), ...(attachment.vscodeSource ? { vscodeSource: attachment.vscodeSource } : {}) }; set((state) => ({ drafts: { ...state.drafts, [id]: parsed }, draftAttachmentViews: { ...state.draftAttachmentViews, [id]: { ...state.draftAttachmentViews[id], [attachmentRefID]: view } } })); persist([id]); return attachment
  },
  getDraftAttachmentViews: (key) => { const id = draftKeyString(key); const record = get().drafts[id]; const views = get().draftAttachmentViews[id] ?? {}; return record ? attachmentList(record).flatMap((attachment) => views[attachment.attachmentRefID] ? [views[attachment.attachmentRefID]] : []) : [] },
  retryDraftAttachmentPersistence: async (key) => { const id = draftKeyString(key); if (!get().persistenceEnabled || (!get().drafts[id] && !get().tombstones[id])) return; const cleanup = await durability.retryCleanup(); if (cleanup.cleanupErrors.length) set((state) => ({ draftAttachmentPersistence: { ...state.draftAttachmentPersistence, [id]: { status: "error", revision: state.drafts[id]?.revision ?? state.tombstones[id], errorCode: persistenceErrorCode(cleanup) } } })); await persist([id]) },
  hydrateDraftAttachments: async (key) => {
    const id = draftKeyString(key)
    const existing = attachmentHydrationTasks.get(id)
    if (existing) return existing
    const record = get().drafts[id]
    if (!record) return
    const epoch = (attachmentHydrateEpoch.get(id) ?? 0) + 1
    attachmentHydrateEpoch.set(id, epoch)
    const runtime = runtimeCapture()
    const generation = persistenceGeneration
    const task = (async () => {
      set((state) => ({ draftHydration: { ...state.draftHydration, [id]: "loading" } }))
      const settleStale = () => {
        if (attachmentHydrateEpoch.get(id) !== epoch) return
        const state = get()
        const views = state.draftAttachmentViews[id]
        const missing = state.draftMissingAttachmentRefIDs[id] ?? []
        set((current) => ({ draftHydration: { ...current.draftHydration, [id]: missing.length ? "degraded" : Object.keys(views ?? {}).length ? "ready" : "idle" } }))
      }
      const views: Record<string, AttachedFile> = {}
      const missing: string[] = []
      for (const attachment of attachmentList(record)) {
        const value = attachment.locator.kind === "url" ? { ok: true as const, value: attachment.locator.url } : await blobStore.read(attachment.locator.blobID)
        if (!value.ok) {
          if (value.error.code === "missing-blob") missing.push(attachment.attachmentRefID)
          else {
            if (attachmentHydrateEpoch.get(id) === epoch && persistenceGeneration === generation && runtimeMatches(runtime) && get().drafts[id] === record) set((state) => ({ draftHydration: { ...state.draftHydration, [id]: "error" } }))
            else settleStale()
            return
          }
          continue
        }
        try {
          views[attachment.attachmentRefID] = await makeView(attachment, value.value)
        } catch {
          if (attachmentHydrateEpoch.get(id) === epoch && persistenceGeneration === generation && runtimeMatches(runtime) && get().drafts[id] === record) set((state) => ({ draftHydration: { ...state.draftHydration, [id]: "error" } }))
          else settleStale()
          return
        }
      }
      const current = get()
      const currentRecord = current.drafts[id]
      const currentEpoch = attachmentHydrateEpoch.get(id)
      const currentRun = currentEpoch === epoch && persistenceGeneration === generation && runtimeMatches(runtime) && currentRecord === record
      if (currentRun) {
        set((state) => ({ draftAttachmentViews: { ...state.draftAttachmentViews, [id]: views }, draftMissingAttachmentRefIDs: { ...state.draftMissingAttachmentRefIDs, [id]: missing }, draftHydration: { ...state.draftHydration, [id]: missing.length ? "degraded" : "ready" } }))
      } else if (currentEpoch === epoch) {
        const oldViews = current.draftAttachmentViews[id]
        const oldMissing = current.draftMissingAttachmentRefIDs[id] ?? []
        set((state) => ({ draftHydration: { ...state.draftHydration, [id]: oldMissing.length ? "degraded" : Object.keys(oldViews ?? {}).length ? "ready" : "idle" } }))
      }
    })()
    attachmentHydrationTasks.set(id, task)
    try { await task } finally { if (attachmentHydrationTasks.get(id) === task) attachmentHydrationTasks.delete(id) }
  },
  removeDraftAttachment: async (key, attachmentRefID) => { const id = draftKeyString(key); const record = get().drafts[id]; const attachment = record && attachmentList(record).find((item) => item.attachmentRefID === attachmentRefID); if (!record || !attachment) return false; const next = valid({ ...record, revision: record.revision + 1, attachments: record.attachments.filter((item) => item.attachmentRefID !== attachmentRefID), syntheticParts: record.syntheticParts.map((part) => ({ ...part, attachments: part.attachments.filter((item) => item.attachmentRefID !== attachmentRefID) })) }); if (!next) return false; bump(id); set((state) => { const views = { ...state.draftAttachmentViews[id] }; delete views[attachmentRefID]; return { drafts: { ...state.drafts, [id]: next }, draftAttachmentViews: { ...state.draftAttachmentViews, [id]: views }, draftMissingAttachmentRefIDs: { ...state.draftMissingAttachmentRefIDs, [id]: (state.draftMissingAttachmentRefIDs[id] ?? []).filter((ref) => ref !== attachmentRefID) } } }); const result = await persist([id]); return result.status === "committed" },
  replaceDraftAttachment: async (key, attachmentRefID, file, options) => {
    const id = draftKeyString(key)
    const record = get().drafts[id]
    const previous = record && attachmentList(record).find((attachment) => attachment.attachmentRefID === attachmentRefID)
    if (!record || !previous) return undefined
    const runtime = runtimeCapture()
    const tombstone = get().tombstones[id] ?? 0
    const nextFile = file instanceof File ? file : new File([file], options?.filename ?? "attachment", { type: file.type })
    let dataUrl: string
    try { dataUrl = await readFileAsDataUrl(nextFile) } catch {
      const latest = get().drafts[id]
      const current = latest && attachmentList(latest).find((attachment) => attachment.attachmentRefID === attachmentRefID)
      const sourceValid = runtimeMatches(runtime)
        && (get().tombstones[id] ?? 0) === tombstone
        && !!latest
        && current?.attachmentID === previous.attachmentID
        && current.attachmentRefID === previous.attachmentRefID
        && draftKeyString(latest.key) === id
      if (sourceValid) set((state) => ({ draftAttachmentPersistence: { ...state.draftAttachmentPersistence, [id]: { status: "error", revision: latest.revision, errorCode: "transaction-failed" } } }))
      return undefined
    }
    const latest = get().drafts[id]
    const current = latest && attachmentList(latest).find((attachment) => attachment.attachmentRefID === attachmentRefID)
    if (!runtimeMatches(runtime) || (get().tombstones[id] ?? 0) !== tombstone || !latest || current?.attachmentID !== previous.attachmentID || current.attachmentRefID !== previous.attachmentRefID || draftKeyString(latest.key) !== id) return undefined
    const part = latest.syntheticParts.find((item) => item.attachments.some((attachment) => attachment.attachmentRefID === attachmentRefID))
    const attachmentID = createID()
    const replacement: DraftAttachmentMetadata = { attachmentID, attachmentRefID: part ? draftSyntheticPartAttachmentOccurrenceRefID(part.partID, attachmentID) : draftRootAttachmentOccurrenceRefID(attachmentID), filename: options?.filename ?? nextFile.name, mimeType: nextFile.type, size: nextFile.size, locator: { kind: "blob", blobID: createID() }, source: options?.source ?? "local", ...(options?.vscodePath ? { vscodePath: options.vscodePath } : {}), ...(options?.vscodeSource ? { vscodeSource: options.vscodeSource } : {}) }
    const next = valid({ ...latest, revision: latest.revision + 1, attachments: part ? latest.attachments : latest.attachments.map((attachment) => attachment.attachmentRefID === attachmentRefID ? replacement : attachment), syntheticParts: latest.syntheticParts.map((item) => item.partID === part?.partID ? { ...item, attachments: item.attachments.map((attachment) => attachment.attachmentRefID === attachmentRefID ? replacement : attachment) } : item) })
    if (!next) return undefined
    bump(id)
    const view: AttachedFile = { id: attachmentID, file: nextFile, dataUrl, mimeType: replacement.mimeType, filename: replacement.filename, size: replacement.size, source: replacement.source, ...(replacement.vscodePath ? { vscodePath: replacement.vscodePath } : {}), ...(replacement.vscodeSource ? { vscodeSource: replacement.vscodeSource } : {}) }
    set((state) => {
      const views = { ...state.draftAttachmentViews[id] }
      delete views[attachmentRefID]
      return { drafts: { ...state.drafts, [id]: next }, draftAttachmentViews: { ...state.draftAttachmentViews, [id]: { ...views, [replacement.attachmentRefID]: view } }, draftMissingAttachmentRefIDs: { ...state.draftMissingAttachmentRefIDs, [id]: (state.draftMissingAttachmentRefIDs[id] ?? []).filter((ref) => ref !== attachmentRefID) } }
    })
    const result = await persist([id])
    return result.status === "committed" ? replacement : undefined
  },
  deleteDraft: (key, expectedRevision) => {
    const id = draftKeyString(key)
    const record = get().drafts[id]
    if (!record || (expectedRevision !== undefined && record.revision !== expectedRevision)) return false
    const revision = record.revision + 1
    if (!positiveSafeInteger(revision)) return false
    bump(id)
    invalidateAttachmentHydration(id)
    set((state) => {
      const drafts = { ...state.drafts }
      delete drafts[id]
      const draftHydration = { ...state.draftHydration }; const draftPersistence = { ...state.draftPersistence }; const draftAttachmentViews = { ...state.draftAttachmentViews }; const draftMissingAttachmentRefIDs = { ...state.draftMissingAttachmentRefIDs }; const draftAttachmentPersistence = { ...state.draftAttachmentPersistence }; delete draftHydration[id]; delete draftPersistence[id]; delete draftAttachmentViews[id]; delete draftMissingAttachmentRefIDs[id]; delete draftAttachmentPersistence[id]; return { drafts, tombstones: { ...state.tombstones, [id]: Math.max(state.tombstones[id] ?? 0, revision) }, draftHydration, draftPersistence, draftAttachmentViews, draftMissingAttachmentRefIDs, draftAttachmentPersistence }
    })
    persist([id])
    return true
  },
  moveDraft: (source, destination, expectedRevision) => {
    const sourceID = draftKeyString(source)
    const destinationID = draftKeyString(destination)
    const record = get().drafts[sourceID]
    if (!record || sourceID === destinationID || (expectedRevision !== undefined && record.revision !== expectedRevision) || get().drafts[destinationID] || (get().tombstones[destinationID] ?? 0) >= record.revision + 1) return undefined
    if ([...record.attachments, ...record.syntheticParts.flatMap((part) => part.attachments)].some((attachment) => attachment.locator.kind === "blob")) return undefined
    const moved = valid({ ...record, key: destination, revision: record.revision + 1 })
    if (!moved) return undefined
    bump(sourceID)
    bump(destinationID)
    invalidateAttachmentHydration(sourceID, destinationID)
    set((state) => {
      const drafts = { ...state.drafts }
      delete drafts[sourceID]
      const tombstones = { ...state.tombstones, [sourceID]: Math.max(state.tombstones[sourceID] ?? 0, moved.revision) }
      if ((tombstones[destinationID] ?? 0) < moved.revision) delete tombstones[destinationID]
      const moveState = <T,>(sourceState: Record<string, T>): Record<string, T> => {
        const next = { ...sourceState }
        const value = next[sourceID]
        delete next[sourceID]
        delete next[destinationID]
        return value === undefined ? next : { ...next, [destinationID]: value }
      }
      return { drafts: { ...drafts, [destinationID]: moved }, tombstones, draftHydration: moveState(state.draftHydration), draftPersistence: moveState(state.draftPersistence), draftAttachmentViews: moveState(state.draftAttachmentViews), draftMissingAttachmentRefIDs: moveState(state.draftMissingAttachmentRefIDs), draftAttachmentPersistence: moveState(state.draftAttachmentPersistence) }
    })
    persist([sourceID, destinationID])
    return moved
  },
  moveDraftWithAttachments: async (source, destination, expectedRevision) => {
    const sourceID = draftKeyString(source); const destinationID = draftKeyString(destination); const record = get().drafts[sourceID]
    if (!record || sourceID === destinationID || (expectedRevision !== undefined && record.revision !== expectedRevision) || get().drafts[destinationID] || (get().tombstones[destinationID] ?? 0) >= record.revision + 1) return undefined
    const moved = valid({ ...record, key: destination, revision: record.revision + 1 }); if (!moved) return undefined
    bump(sourceID); bump(destinationID)
    invalidateAttachmentHydration(sourceID, destinationID)
    set((state) => {
      const drafts = { ...state.drafts }
      delete drafts[sourceID]
      const tombstones = { ...state.tombstones, [sourceID]: Math.max(state.tombstones[sourceID] ?? 0, moved.revision) }
      if ((tombstones[destinationID] ?? 0) < moved.revision) delete tombstones[destinationID]
      const moveState = <T,>(sourceState: Record<string, T>): Record<string, T> => {
        const next = { ...sourceState }
        const value = next[sourceID]
        delete next[sourceID]
        delete next[destinationID]
        return value === undefined ? next : { ...next, [destinationID]: value }
      }
      return { drafts: { ...drafts, [destinationID]: moved }, tombstones, draftHydration: moveState(state.draftHydration), draftPersistence: moveState(state.draftPersistence), draftAttachmentViews: moveState(state.draftAttachmentViews), draftMissingAttachmentRefIDs: moveState(state.draftMissingAttachmentRefIDs), draftAttachmentPersistence: moveState(state.draftAttachmentPersistence) }
    })
    const result = await persist([sourceID, destinationID])
    return result.status === "committed" ? moved : undefined
  },
  setDraftPersistenceEnabled: async (enabled) => {
    persistenceGeneration += 1
    if (!enabled) {
      if (deferredComposerPersistTimer) clearTimeout(deferredComposerPersistTimer)
      deferredComposerPersistTimer = undefined
      deferredComposerPersistIDs.clear()
      deferredComposerPersistRuntime = undefined
      set({ persistenceEnabled: false, draftPersistence: {} })
      await durability.setEnabled(false)
      await durability.flush()
      return
    }
    set({ persistenceEnabled: true })
    await durability.setEnabled(true)
    const runtime = runtimeCapture()
    if (!seeded) await get().hydrateDraftMetadata(runtime.transportIdentity)
    const ids = new Set([...Object.keys(get().drafts), ...Object.keys(get().tombstones), ...dirtyKeys])
    dirtyKeys.clear()
    await persist(ids)
    await durability.flush()
  },
  hydrateDraftMetadata: (transportIdentity) => {
    const active = draftMetadataHydrationTasks.get(transportIdentity)
    if (active) return active
    const task = (async (): Promise<boolean> => {
    const request = (hydrateEpoch.get(transportIdentity) ?? 0) + 1
    hydrateEpoch.set(transportIdentity, request)
    const runtime = runtimeCapture()
    if (runtime.transportIdentity !== transportIdentity) return false
    const generation = persistenceGeneration
    const startEpochs = new Map(keyEpoch)
    const startLegacyEpoch = legacyEpoch
    const knownIDs = Object.entries(get().drafts).filter(([, draft]) => draft.key.transportIdentity === transportIdentity).map(([id]) => id)
    set((state) => ({ draftHydration: { ...state.draftHydration, ...Object.fromEntries(knownIDs.map((id) => [id, "loading" as const])) } }))
    const enabledAtStart = get().persistenceEnabled
    let migrated: Awaited<ReturnType<typeof repository.migrate>>
    try {
      migrated = await repository.migrate(transportIdentity, { persistenceEnabled: enabledAtStart })
    } catch {
      return false
    }
    if (hydrateEpoch.get(transportIdentity) !== request || persistenceGeneration !== generation || !runtimeMatches(runtime)) return false
    if (!migrated.ok) {
      set((state) => ({ draftHydration: { ...state.draftHydration, ...Object.fromEntries(knownIDs.map((id) => [id, state.drafts[id] ? "degraded" as const : "error" as const])) } }))
      return false
    }
    const snapshot = migrated.value
    if (!seeded) {
      seedPromise ??= durability.seed(snapshot).finally(() => { seedPromise = undefined })
      let result: InputDraftDurabilityResult
      try {
        result = await seedPromise
      } catch {
        return false
      }
      if (hydrateEpoch.get(transportIdentity) !== request || persistenceGeneration !== generation || !runtimeMatches(runtime)) return false
      if (result.status !== "committed" && result.status !== "disabled") {
        set((state) => ({ draftHydration: { ...state.draftHydration, ...Object.fromEntries(knownIDs.map((id) => [id, "degraded" as const])) } }))
        return false
      }
      if (result.status === "committed") seeded = true
    }
    const state = get()
    const drafts = { ...state.drafts }
    const tombstones = { ...state.tombstones }
    const touched = new Set<string>()
    for (const [id, revision] of Object.entries(snapshot.tombstones)) {
      if ((keyEpoch.get(id) ?? 0) !== (startEpochs.get(id) ?? 0)) continue
      if (revision >= (tombstones[id] ?? 0)) {
        tombstones[id] = revision
        if ((drafts[id]?.revision ?? 0) <= revision) delete drafts[id]
      }
      touched.add(id)
    }
    for (const [id, incoming] of Object.entries(snapshot.drafts)) {
      if (incoming.key.transportIdentity !== transportIdentity || (keyEpoch.get(id) ?? 0) !== (startEpochs.get(id) ?? 0)) continue
      const current = drafts[id]
      const parsed = valid(incoming)
      if (parsed && (!current || current.revision < parsed.revision) && (tombstones[id] ?? 0) < parsed.revision) drafts[id] = parsed
      touched.add(id)
    }
    const entries = legacyEpoch === startLegacyEpoch ? { ...snapshot.legacy.entries } : { ...state.legacyDraftEntries }
    if (snapshot.migration.claimedTransportIdentity === transportIdentity && legacyEpoch === startLegacyEpoch) {
      for (const [suffix, entry] of Object.entries(entries)) {
        const key: DraftKey = { transportIdentity, owner: { kind: "session", ownerID: suffix } }
        const id = draftKeyString(key)
        const document = parseLegacyDraftComposerDocument(entry.text)
        const record = valid({ ...emptyDraft(key), text: document.text, composerReferences: document.references, mentions: legacyMentions(document.text, entry.mentions) })
        if (record && !drafts[id] && !tombstones[id] && (keyEpoch.get(id) ?? 0) === (startEpochs.get(id) ?? 0)) drafts[id] = record
        delete entries[suffix]
        touched.add(id)
      }
    }
    set((current) => ({ drafts, tombstones, legacyNewDraft: legacyEpoch === startLegacyEpoch && !legacyNewClaimed ? snapshot.legacy.new : current.legacyNewDraft, legacyDraftEntries: entries, migration: legacyEpoch === startLegacyEpoch ? snapshot.migration : current.migration, draftHydration: { ...current.draftHydration, ...Object.fromEntries([...touched].map((id) => [id, "ready" as const])) } }))
    const dirty = [...dirtyKeys]
    for (const id of dirty) touched.add(id)
    dirtyKeys.clear()
    try {
      await persist(touched)
      await durability.flush()
    } catch {
      return false
    }
    return hydrateEpoch.get(transportIdentity) === request && persistenceGeneration === generation && runtimeMatches(runtime)
    })()
    draftMetadataHydrationTasks.set(transportIdentity, task)
    void task.finally(() => {
      if (draftMetadataHydrationTasks.get(transportIdentity) === task) draftMetadataHydrationTasks.delete(transportIdentity)
    }).catch(() => undefined)
    return task
  },
  claimLegacyNewDraft: async (key) => {
    const entry = get().legacyNewDraft
    if (!entry) return get().getDraft(key)
    const id = draftKeyString(key)
    const current = get().drafts[id]
    legacyEpoch += 1
    legacyNewClaimed = true
    if (current || get().tombstones[id]) {
      set({ legacyNewDraft: undefined })
      persist([id])
      return current
    }
    const document = parseLegacyDraftComposerDocument(entry.text)
    const record = valid({ ...emptyDraft(key), text: document.text, composerReferences: document.references, mentions: legacyMentions(document.text, entry.mentions) })
    if (!record) return undefined
    bump(id)
    set((state) => ({ drafts: { ...state.drafts, [id]: record }, legacyNewDraft: undefined }))
    persist([id])
    return record
  },
  pendingInputText: null,
  pendingInputMode: "replace",
  pendingSyntheticParts: null,
  pendingPresetSubmit: null,
  attachedFiles: [],
  attachmentBuckets: { "legacy-unowned": [] },
  activeAttachmentDraft: null,
  activeEditorFile: null,

  setPendingInputText: (text, mode = "replace") =>
    set({ pendingInputText: text, pendingInputMode: mode }),

  consumePendingInputText: () => {
    const { pendingInputText, pendingInputMode } = get()
    if (pendingInputText === null) return null
    set({ pendingInputText: null, pendingInputMode: "replace" })
    return { text: pendingInputText, mode: pendingInputMode }
  },

  requestPresetSubmit: (text) => set({ pendingPresetSubmit: text }),

  consumePendingPresetSubmit: () => {
    const { pendingPresetSubmit } = get()
    if (pendingPresetSubmit === null) return null
    set({ pendingPresetSubmit: null })
    return pendingPresetSubmit
  },

  setPendingSyntheticParts: (parts) => set({ pendingSyntheticParts: parts }),

  consumePendingSyntheticParts: () => {
    const { pendingSyntheticParts } = get()
    if (pendingSyntheticParts !== null) {
      set({ pendingSyntheticParts: null })
    }
    return pendingSyntheticParts
  },

  setActiveAttachmentDraft: (key) => {
    const id = attachmentBucketID(key)
    set((state) => ({
      activeAttachmentDraft: key,
      attachedFiles: state.attachmentBuckets[id] ?? [],
      attachmentBuckets: state.attachmentBuckets[id] ? state.attachmentBuckets : { ...state.attachmentBuckets, [id]: [] },
    }))
  },

  addAttachedFile: async (file: File) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const bucketID = attachmentBucketID(get().activeAttachmentDraft)
    const generation = attachmentReadEpoch(bucketID)
    let dataUrl: string
    try {
      dataUrl = await readFileAsDataUrl(file)
    } catch {
      return
    }
    if (generation !== attachmentReadEpoch(bucketID)) return
    const attached: AttachedFile = {
      id,
      file,
      dataUrl,
      mimeType: file.type,
      filename: file.name,
      size: file.size,
      source: "local",
    }
    updateAttachmentBucket(bucketID, (files) => [...files, attached])
  },

  removeAttachedFile: (id) =>
    updateAttachmentBucket(attachmentBucketID(get().activeAttachmentDraft), (files) => files.filter((file) => file.id !== id)),

  setAttachedFiles: (files) => {
    updateAttachmentBucket(attachmentBucketID(get().activeAttachmentDraft), () => files, true)
  },

  clearAttachedFiles: () => {
    updateAttachmentBucket(attachmentBucketID(get().activeAttachmentDraft), () => [], true)
  },

  addVSCodeFileAttachment: (path: string, name: string, fileSize: number | null) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const bucketID = attachmentBucketID(get().activeAttachmentDraft)
    const isDuplicate = (get().attachmentBuckets[bucketID] ?? []).some(
      (f) => f.source === 'vscode' && f.vscodeSource === 'file' && (f.vscodePath || '') === path
    )
    if (isDuplicate) return
    const dataUrl = toFileUrl(path)
    // `file://` URLs are the same contract used by server-source attachments.
    // The submission path passes `dataUrl` as `url` directly to the OpenCode
    // server, which resolves `file://` paths natively. No base64 encoding needed.
    const attached: AttachedFile = {
      id,
      file: new File([], name, { type: 'text/plain' }),
      dataUrl,
      mimeType: 'text/plain',
      filename: name,
      size: fileSize || 0,
      source: 'vscode',
      vscodePath: path,
      vscodeSource: 'file',
    }
    updateAttachmentBucket(bucketID, (files) => [...files, attached])
  },

  addVSCodeSelectionAttachment: async (path: string, file: File) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const bucketID = attachmentBucketID(get().activeAttachmentDraft)
    const generation = attachmentReadEpoch(bucketID)
    const selectionKey = `${bucketID}\u0000${getVSCodeSelectionKey(path, file.name)}`
    const isDuplicate = (get().attachmentBuckets[bucketID] ?? []).some(
      (f) => f.source === 'vscode' && f.vscodeSource === 'selection' && f.filename === file.name && f.vscodePath === path
    )
    if (isDuplicate || pendingVSCodeSelectionKeys.has(selectionKey)) return
    pendingVSCodeSelectionKeys.add(selectionKey)
    let dataUrl: string
    try {
      dataUrl = await readFileAsDataUrl(file)
    } catch {
      return
    } finally {
      pendingVSCodeSelectionKeys.delete(selectionKey)
    }
    if (generation !== attachmentReadEpoch(bucketID)) return
    const attached: AttachedFile = {
      id,
      file,
      dataUrl,
      mimeType: file.type,
      filename: file.name,
      size: file.size,
      source: 'vscode',
      vscodePath: path,
      vscodeSource: 'selection',
    }
    updateAttachmentBucket(bucketID, (files) => [...files, attached])
  },

  addCodeSelectionAttachment: async (path, label, text) => {
    const file = new File([text], label, { type: 'text/plain' })
    await get().addVSCodeSelectionAttachment(path, file)
  },

  setActiveEditorFile: (file) => {
    if (isSameVSCodeActiveEditorFile(get().activeEditorFile, file)) return
    set({ activeEditorFile: file })
  },

  addRestoredAttachment: ({ url, mimeType, filename }) => {
    const id = `restored-${Date.now()}-${Math.random().toString(36).slice(2)}`
    // Use "local" source so the file renders in AttachedFilesList.
    // Set serverPath to the URL so ImagePreview can use it as the img src
    // when dataUrl is not a data: URL. sanitizeAttachmentsForSend leaves
    // dataUrl alone for non-server sources, so the URL stays intact on send.
    const attached: AttachedFile = {
      id,
      file: new File([], filename, { type: mimeType }),
      dataUrl: url,
      mimeType,
      filename,
      size: getDataUrlByteSize(url),
      source: "local",
      serverPath: url,
    }
    updateAttachmentBucket(attachmentBucketID(get().activeAttachmentDraft), (files) => [...files, attached])
  },
})
  })
  return store
}

export const useInputStore = createInputStore()
