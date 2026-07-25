import type { DraftBlobError, DraftBlobValue, InputDraftBlobStore } from "./input-draft-blob-store"
import { parseInputDraftMetadataSnapshot, type InputDraftMetadataErrorCode, type InputDraftMetadataPersistenceCoordinator, type InputDraftMetadataSnapshot } from "./input-draft-metadata-store"
import { draftAttachmentRefID, draftKeyString, parseDraftRecord, type DraftAttachmentMetadata, type DraftAttachmentReference, type DraftKey, type DraftRecord } from "./input-draft-types"

type DurableState = Pick<InputDraftMetadataSnapshot, "drafts" | "tombstones" | "migration" | "legacy">
type BlobError = DraftBlobError | { code: "runtime-value-missing" | "reference-conflict" | "invalid-record" }

export type InputDraftDurabilityError = { phase: "blob"; error: BlobError; reference?: DraftAttachmentReference } | { phase: "metadata"; error: { code: InputDraftMetadataErrorCode } }
export type InputDraftDurabilityResult = {
  status: "committed" | "stale" | "failed" | "unseeded" | "disabled"
  keys: string[]
  errors: InputDraftDurabilityError[]
  cleanupErrors: InputDraftDurabilityError[]
}

export type InputDraftDurabilityCommit = {
  /** Complete proposed durable maps. They are merged into the coordinator's durable baseline. */
  drafts?: ReadonlyMap<string, DraftRecord> | Readonly<Record<string, DraftRecord>>
  tombstones?: ReadonlyMap<string, number> | Readonly<Record<string, number>>
  /** Keys removed by this transaction, including a move source. */
  delete?: readonly (DraftKey | string)[]
  migration?: InputDraftMetadataSnapshot["migration"]
  legacy?: InputDraftMetadataSnapshot["legacy"]
  /** Revalidates memory revisions, epochs, destination absence, and runtime ownership immediately before persistence. */
  isCurrent: () => boolean | Promise<boolean>
  /** Supplies an in-memory value only when a blob locator needs materialization. */
  resolveBlobValue?: (reference: DraftAttachmentReference, attachment: DraftAttachmentMetadata) => DraftBlobValue | undefined | Promise<DraftBlobValue | undefined>
}

export type InputDraftDurabilityCoordinator = {
  seed: (snapshot: InputDraftMetadataSnapshot | null | undefined) => Promise<InputDraftDurabilityResult>
  commit: (candidate: InputDraftDurabilityCommit) => Promise<InputDraftDurabilityResult>
  reconcile: (legacyOwners?: readonly { transportIdentity: string; owner: DraftKey["owner"] }[]) => Promise<InputDraftDurabilityResult>
  retryCleanup: () => Promise<InputDraftDurabilityResult>
  flush: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
}

const emptyState = (): DurableState => ({ drafts: {}, tombstones: {}, migration: { complete: false, claimedTransportIdentity: "", captured: false, markerCommitted: false, cleanupComplete: false }, legacy: { entries: {} } })
const snapshotFor = (state: DurableState): InputDraftMetadataSnapshot => ({ version: 1, drafts: state.drafts, tombstones: state.tombstones, migration: state.migration, legacy: state.legacy })
const cloneState = (state: DurableState): DurableState => {
  const parsed = snapshotFor(state)
  const valid = JSON.parse(JSON.stringify(parsed)) as unknown
  const snapshot = parseSnapshot(valid)
  return { drafts: snapshot.drafts, tombstones: snapshot.tombstones, migration: snapshot.migration, legacy: snapshot.legacy }
}
const parseSnapshot = (value: unknown): InputDraftMetadataSnapshot => {
  const snapshot = parseInputDraftMetadataSnapshot(value)
  if (!snapshot) throw new Error("invalid draft snapshot")
  return snapshot
}
const entries = <T>(value: ReadonlyMap<string, T> | Readonly<Record<string, T>> | undefined): Array<[string, T]> => value instanceof Map ? [...value.entries()] : Object.entries(value ?? {})
const keyString = (key: DraftKey | string): string => typeof key === "string" ? key : draftKeyString(key)
const durableOwnerKinds: DraftKey["owner"]["kind"][] = ["session", "draft", "surface"]
const cloneReference = (reference: DraftAttachmentReference): DraftAttachmentReference => ({ transportIdentity: reference.transportIdentity, owner: { kind: reference.owner.kind, ownerID: reference.owner.ownerID }, attachmentOccurrenceRefID: reference.attachmentOccurrenceRefID })
const cloneAttachment = (attachment: DraftAttachmentMetadata): DraftAttachmentMetadata => JSON.parse(JSON.stringify(attachment)) as DraftAttachmentMetadata
const cloneError = (error: InputDraftDurabilityError): InputDraftDurabilityError => error.phase === "metadata" ? { phase: "metadata", error: { code: error.error.code } } : { phase: "blob", error: { ...error.error }, ...(error.reference ? { reference: cloneReference(error.reference) } : {}) }
const detachResult = (result: InputDraftDurabilityResult): InputDraftDurabilityResult => ({ status: result.status, keys: [...result.keys], errors: result.errors.map(cloneError), cleanupErrors: result.cleanupErrors.map(cloneError) })
const positiveSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0
const validKey = (value: string): boolean => { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.length === 3 && typeof parsed[0] === "string" && durableOwnerKinds.includes(parsed[1] as DraftKey["owner"]["kind"]) && typeof parsed[2] === "string" && parsed[0].length > 0 && parsed[2].length > 0 } catch { return false } }
const attachmentReferences = (record: DraftRecord): Array<{ reference: DraftAttachmentReference; attachment: DraftAttachmentMetadata }> => {
  const attachments = [...record.attachments, ...record.syntheticParts.flatMap((part) => part.attachments)]
  return attachments.flatMap((attachment) => attachment.locator.kind === "blob" ? [{ reference: { transportIdentity: record.key.transportIdentity, owner: { kind: record.key.owner.kind, ownerID: record.key.owner.ownerID }, attachmentOccurrenceRefID: attachment.attachmentRefID }, attachment: cloneAttachment(attachment) }] : [])
}
const refMap = (drafts: Record<string, DraftRecord>): Map<string, { reference: DraftAttachmentReference; attachment: DraftAttachmentMetadata }> => {
  const refs = new Map<string, { reference: DraftAttachmentReference; attachment: DraftAttachmentMetadata }>()
  for (const record of Object.values(drafts)) for (const item of attachmentReferences(record)) refs.set(draftAttachmentRefID(item.reference), item)
  return refs
}
const blobError = (error: BlobError, reference?: DraftAttachmentReference): InputDraftDurabilityError => ({ phase: "blob", error: { ...error }, ...(reference ? { reference: cloneReference(reference) } : {}) })
const emptyResult = (status: InputDraftDurabilityResult["status"], keys: string[] = []): InputDraftDurabilityResult => ({ status, keys, errors: [], cleanupErrors: [] })
const itemBlobID = (item: { attachment: DraftAttachmentMetadata } | undefined): string => item?.attachment.locator.kind === "blob" ? item.attachment.locator.blobID : ""

export const createInputDraftDurabilityCoordinator = (blobStore: InputDraftBlobStore, metadata: InputDraftMetadataPersistenceCoordinator, options: { enabled?: boolean } = {}): InputDraftDurabilityCoordinator => {
  let durable = emptyState()
  let enabled = options.enabled ?? true
  let enabledGeneration = 0
  let seeded = false
  let tail = Promise.resolve()
  const cleanup = new Map<string, { reference: DraftAttachmentReference; expectedBlobID: string; generation: number; reason: string }>()
  const run = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work)
    tail = next.then(() => undefined, () => undefined)
    return next.then((value) => value && typeof value === "object" && "status" in value && "keys" in value && "errors" in value && "cleanupErrors" in value ? detachResult(value as InputDraftDurabilityResult) as T : value)
  }
  const cleanupPending = async (drafts = durable.drafts): Promise<InputDraftDurabilityError[]> => {
    const errors: InputDraftDurabilityError[] = []
    const desired = new Map([...refMap(drafts)].map(([id, item]) => [id, item.attachment.locator.kind === "blob" ? item.attachment.locator.blobID : ""]))
    for (const [id, entry] of cleanup) {
      if (desired.get(id) === entry.expectedBlobID) { cleanup.delete(id); continue }
      const result = await blobStore.releaseIfMatches(cloneReference(entry.reference), entry.expectedBlobID)
      if (result.ok) cleanup.delete(id)
      else errors.push(blobError(result.error, entry.reference))
    }
    return errors
  }
  const release = async (reference: DraftAttachmentReference, expectedBlobID: string, errors: InputDraftDurabilityError[], reason: string): Promise<void> => {
    const safeReference = cloneReference(reference)
    const result = await blobStore.releaseIfMatches(safeReference, expectedBlobID)
    if (result.ok) return
    cleanup.set(draftAttachmentRefID(safeReference), { reference: cloneReference(safeReference), expectedBlobID, generation: enabledGeneration, reason })
    errors.push(blobError(result.error, safeReference))
  }
  const ensure = async (item: { reference: DraftAttachmentReference; attachment: DraftAttachmentMetadata }, resolve: InputDraftDurabilityCommit["resolveBlobValue"]): Promise<{ acquired: boolean; error?: InputDraftDurabilityError }> => {
    const blobID = item.attachment.locator.kind === "blob" ? item.attachment.locator.blobID : ""
    const reference = cloneReference(item.reference)
    const attachment = cloneAttachment(item.attachment)
    const existing = await blobStore.readReference(reference)
    if (!existing.ok) return { acquired: false, error: blobError(existing.error, reference) }
    if (existing.value && existing.value !== blobID) return { acquired: false, error: blobError({ code: "reference-conflict" }, reference) }
    if (existing.value === blobID) {
      const present = await blobStore.read(blobID)
      if (present.ok) return { acquired: false }
      if (present.error.code !== "missing-blob") return { acquired: false, error: blobError(present.error, reference) }
      const value = await resolve?.(cloneReference(reference), cloneAttachment(attachment))
      if (value === undefined) return { acquired: false, error: blobError({ code: "runtime-value-missing" }, reference) }
      const repaired = await blobStore.putAndRetain(reference, blobID, value)
      return repaired.ok ? { acquired: true } : { acquired: false, error: blobError(repaired.error, reference) }
    }
    const present = await blobStore.read(blobID)
    if (present.ok) {
      const retained = await blobStore.retain(reference, blobID)
      return retained.ok ? { acquired: true } : { acquired: false, error: blobError(retained.error, reference) }
    }
    if (present.error.code !== "missing-blob") return { acquired: false, error: blobError(present.error, reference) }
    const value = await resolve?.(cloneReference(reference), cloneAttachment(attachment))
    if (value === undefined) return { acquired: false, error: blobError({ code: "runtime-value-missing" }, reference) }
    const put = await blobStore.putAndRetain(reference, blobID, value)
    return put.ok ? { acquired: true } : { acquired: false, error: blobError(put.error, reference) }
  }
  return {
    seed: (snapshot) => run(async () => {
      if (!enabled) return emptyResult("disabled")
      if (seeded) return { ...emptyResult("failed"), errors: [blobError({ code: "invalid-record" })] }
      let baseline: DurableState
      try {
        if (!snapshot) baseline = emptyState()
        else {
          const parsed = parseSnapshot(JSON.parse(JSON.stringify(snapshot)))
          baseline = { drafts: parsed.drafts, tombstones: parsed.tombstones, migration: parsed.migration, legacy: parsed.legacy }
        }
      } catch {
        return { ...emptyResult("failed"), errors: [blobError({ code: "invalid-record" })] }
      }
      const baselineRefs = refMap(baseline.drafts)
      const reconciled = await blobStore.reconcileReferences(new Map([...baselineRefs].map(([id, item]) => [id, itemBlobID(item)])), { ownerKinds: durableOwnerKinds })
      if (!reconciled.ok) return { ...emptyResult("failed"), errors: [blobError(reconciled.error)] }
      durable = baseline
      seeded = true
      return { ...emptyResult("committed"), errors: reconciled.value.missing.map((id) => blobError({ code: "missing-blob" }, baselineRefs.get(id)?.reference)) }
    }),
    commit: (candidate) => {
      const keys = [...entries(candidate.drafts).map(([key]) => key), ...(candidate.delete ?? []).map(keyString)]
      if (!enabled) return Promise.resolve(detachResult(emptyResult("disabled", keys)))
      return run(async () => {
        if (!seeded) return emptyResult("unseeded", keys)
        if (!enabled) return emptyResult("disabled", keys)
        const generation = enabledGeneration
        let cleanupErrors: InputDraftDurabilityError[] = []
        const next = cloneState(durable)
        const draftEntries = entries(candidate.drafts)
        const tombstoneEntries = entries(candidate.tombstones)
        const deleteKeys = (candidate.delete ?? []).map(keyString)
        if (draftEntries.some(([key, record]) => !validKey(key) || !positiveSafeInteger(record.revision))
          || tombstoneEntries.some(([key, revision]) => !validKey(key) || !positiveSafeInteger(revision))
          || deleteKeys.some((key) => !validKey(key))
          || new Set(draftEntries.map(([key]) => key)).size !== draftEntries.length
          || tombstoneEntries.some(([key]) => draftEntries.some(([draftKey]) => draftKey === key))) {
          return { ...emptyResult("failed", keys), errors: [blobError({ code: "invalid-record" })] }
        }
        try {
          for (const [key, record] of draftEntries) {
            const parsed = parseDraftRecord(record)
            if (!parsed || key !== draftKeyString(parsed.key)) throw new Error("invalid draft record")
            next.drafts[key] = parsed
            delete next.tombstones[key]
          }
          for (const key of deleteKeys) delete next.drafts[key]
          for (const [key, revision] of tombstoneEntries) next.tombstones[key] = revision
          if (candidate.migration) next.migration = candidate.migration
          if (candidate.legacy) next.legacy = candidate.legacy
          // Strictly clone the complete candidate before every cleanup, blob, or metadata operation.
          const parsed = parseSnapshot(snapshotFor(next))
          next.drafts = parsed.drafts
          next.tombstones = parsed.tombstones
          next.migration = parsed.migration
          next.legacy = parsed.legacy
        } catch {
          return { ...emptyResult("failed", keys), errors: [blobError({ code: "invalid-record" })], cleanupErrors }
        }
        if (!await candidate.isCurrent()) return emptyResult("stale", keys)
        const oldRefs = refMap(durable.drafts)
        const nextRefs = refMap(next.drafts)
        cleanupErrors = await cleanupPending(next.drafts)
        const acquired: DraftAttachmentReference[] = []
        for (const [id, item] of nextRefs) {
          const old = oldRefs.get(id)
          const oldBlobID = old?.attachment.locator.kind === "blob" ? old.attachment.locator.blobID : undefined
          const nextBlobID = item.attachment.locator.kind === "blob" ? item.attachment.locator.blobID : undefined
          if (oldBlobID === nextBlobID) continue
          const ensured = await ensure(item, candidate.resolveBlobValue)
          if (ensured.error) {
            for (const reference of acquired.reverse()) await release(reference, itemBlobID(nextRefs.get(draftAttachmentRefID(reference))), cleanupErrors, "acquire-failed")
            return { ...emptyResult("failed", keys), errors: [ensured.error], cleanupErrors }
          }
          if (ensured.acquired) acquired.push(item.reference)
        }
        if (!await candidate.isCurrent()) {
          for (const reference of acquired.reverse()) await release(reference, itemBlobID(nextRefs.get(draftAttachmentRefID(reference))), cleanupErrors, "stale")
          return { ...emptyResult("stale", keys), cleanupErrors }
        }
        if (!enabled || generation !== enabledGeneration) {
          for (const reference of acquired.reverse()) await release(reference, itemBlobID(nextRefs.get(draftAttachmentRefID(reference))), cleanupErrors, "disabled")
          return { ...emptyResult("disabled", keys), cleanupErrors }
        }
        const persisted = await metadata.persist(snapshotFor(next))
        if (!persisted.ok) {
          for (const reference of acquired.reverse()) await release(reference, itemBlobID(nextRefs.get(draftAttachmentRefID(reference))), cleanupErrors, "metadata-failed")
          return { ...emptyResult("failed", keys), errors: [{ phase: "metadata", error: persisted.error }], cleanupErrors }
        }
        durable = next
        for (const [id, old] of oldRefs) if (!nextRefs.has(id)) await release(old.reference, old.attachment.locator.kind === "blob" ? old.attachment.locator.blobID : "", cleanupErrors, "metadata-committed")
        return { ...emptyResult("committed", keys), cleanupErrors }
      })
    },
    reconcile: () => run(async () => {
      if (!seeded) return emptyResult("unseeded")
      if (!enabled) return emptyResult("disabled")
      const cleanupErrors = await cleanupPending()
      const desired = new Map([...refMap(durable.drafts)].map(([id, item]) => [id, item.attachment.locator.kind === "blob" ? item.attachment.locator.blobID : ""]))
      const result = await blobStore.reconcileReferences(desired, { ownerKinds: durableOwnerKinds })
      const errors = result.ok ? result.value.missing.map((id) => blobError({ code: "missing-blob" }, refMap(durable.drafts).get(id)?.reference)) : [blobError(result.error)]
      return { status: result.ok ? "committed" : "failed", keys: [], errors, cleanupErrors }
    }),
    retryCleanup: () => run(async () => ({ ...emptyResult("committed"), cleanupErrors: await cleanupPending() })),
    flush: () => tail,
    setEnabled: async (nextEnabled) => {
      if (!nextEnabled) { enabled = false; enabledGeneration += 1; metadata.cancelPending?.(); await metadata.setEnabled?.(false); await tail; await metadata.flush?.(); return }
      await metadata.setEnabled?.(true); enabled = true; enabledGeneration += 1
    },
  }
}
