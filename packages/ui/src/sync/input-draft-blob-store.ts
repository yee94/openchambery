import { draftAttachmentRefID, isDurableURL, type DraftAttachmentOwner, type DraftAttachmentReference } from "./input-draft-types"

const DATABASE_NAME = "openchamber-input-drafts"
const DATABASE_VERSION = 1
const BLOBS_STORE = "blobs"
const BLOB_REFS_STORE = "blobRefs"
export type DraftBlobValue = Blob | string
export type DraftBlobErrorCode = "blob-id-conflict" | "database-unavailable" | "invalid-value" | "missing-blob" | "quota-exceeded" | "transaction-aborted" | "transaction-failed"
export type DraftBlobError = { code: DraftBlobErrorCode }
export type DraftBlobResult<T> = { ok: true; value: T } | { ok: false; error: DraftBlobError }
type BlobRow = { id: string; value: DraftBlobValue; refCount: number; fingerprint?: string }
type BlobRefRow = { id: string; blobID: string; transportIdentity?: string; ownerKind?: DraftAttachmentOwner["kind"]; ownerID?: string }
export type DraftBlobReferenceOwner = { transportIdentity: string; owner: DraftAttachmentOwner }
export type DraftBlobReconcileScope = { ownerKinds: readonly DraftAttachmentOwner["kind"][]; transportIdentities?: readonly string[] }
export type InputDraftBlobTransaction = { getBlob: (id: string) => Promise<BlobRow | undefined>; getAllBlobs: () => Promise<BlobRow[]>; putBlob: (row: BlobRow) => Promise<void>; deleteBlob: (id: string) => Promise<void>; getBlobRef: (id: string) => Promise<BlobRefRow | undefined>; getAllBlobRefs: () => Promise<BlobRefRow[]>; putBlobRef: (row: BlobRefRow) => Promise<void>; deleteBlobRef: (id: string) => Promise<void> }
export type InputDraftBlobDriver = { transaction: <T>(action: (transaction: InputDraftBlobTransaction) => Promise<T>) => Promise<T> }
export type DraftBlobReconcileResult = { released: string[]; repaired: string[]; missing: string[] }
export type InputDraftBlobStore = {
  put: (blobID: string, value: DraftBlobValue) => Promise<DraftBlobResult<void>>
  putAndRetain: (reference: DraftAttachmentReference, blobID: string, value: DraftBlobValue) => Promise<DraftBlobResult<void>>
  read: (blobID: string) => Promise<DraftBlobResult<DraftBlobValue>>
  readReference: (reference: DraftAttachmentReference) => Promise<DraftBlobResult<string | undefined>>
  retain: (reference: DraftAttachmentReference, blobID: string) => Promise<DraftBlobResult<void>>
  release: (reference: DraftAttachmentReference) => Promise<DraftBlobResult<boolean>>
  releaseIfMatches: (reference: DraftAttachmentReference, expectedBlobID: string) => Promise<DraftBlobResult<boolean>>
  reconcileReferences: (desiredRefs: ReadonlyMap<string, string>, scope?: DraftBlobReconcileScope) => Promise<DraftBlobResult<DraftBlobReconcileResult>>
  reconcileOwnerReferences: (owner: DraftBlobReferenceOwner, liveBlobIDsByOccurrence: ReadonlyMap<string, string>) => Promise<DraftBlobResult<number>>
  discardUnreferenced: (blobID: string) => Promise<DraftBlobResult<boolean>>
}

class Failure extends Error { constructor(readonly code: DraftBlobErrorCode) { super(code) } }
const result = <T>(error: unknown): DraftBlobResult<T> => ({ ok: false, error: { code: error instanceof Failure ? error.code : error instanceof DOMException && error.name === "QuotaExceededError" ? "quota-exceeded" : error instanceof DOMException && error.name === "AbortError" ? "transaction-aborted" : "transaction-failed" } })
const assertValue = (value: DraftBlobValue): void => { if (!(value instanceof Blob) && !isDurableURL(value)) throw new Failure("invalid-value") }
const assertID = (id: string): void => { if (!id) throw new Failure("invalid-value") }
const rowFor = (reference: DraftAttachmentReference, blobID: string): BlobRefRow => ({ id: draftAttachmentRefID(reference), blobID, transportIdentity: reference.transportIdentity, ownerKind: reference.owner.kind, ownerID: reference.owner.ownerID })
const fingerprint = async (value: DraftBlobValue): Promise<string> => {
  if (typeof value === "string") return `url:${value}`
  const hash = await crypto.subtle.digest("SHA-256", await value.arrayBuffer())
  const digest = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return `blob:${value.type}:${value.size}:${digest}`
}
const sameBlob = async (row: BlobRow, hash: string): Promise<boolean> => (row.fingerprint ?? await fingerprint(row.value)) === hash
const normalize = async (tx: InputDraftBlobTransaction, prune = false): Promise<void> => {
  const refs = await tx.getAllBlobRefs()
  const blobs = await tx.getAllBlobs()
  const count = new Map<string, number>()
  for (const ref of refs) {
    if (await tx.getBlob(ref.blobID)) count.set(ref.blobID, (count.get(ref.blobID) ?? 0) + 1)
    else await tx.deleteBlobRef(ref.id)
  }
  for (const blob of blobs) {
    const refCount = count.get(blob.id) ?? 0
    if (refCount || !prune) await tx.putBlob({ ...blob, refCount })
    else await tx.deleteBlob(blob.id)
  }
}
const parseRefID = (id: string): { transportIdentity: string; ownerKind: DraftAttachmentOwner["kind"]; ownerID: string } | undefined => {
  try {
    const value: unknown = JSON.parse(id)
    if (!Array.isArray(value) || value.length !== 4 || typeof value[0] !== "string" || typeof value[2] !== "string" || (value[1] !== "session" && value[1] !== "draft" && value[1] !== "surface" && value[1] !== "queue" && value[1] !== "send")) return undefined
    return { transportIdentity: value[0], ownerKind: value[1], ownerID: value[2] }
  } catch { return undefined }
}
const inScope = (ref: BlobRefRow, scope: DraftBlobReconcileScope): boolean => {
  const parsed = parseRefID(ref.id)
  const ownerKind = ref.ownerKind ?? parsed?.ownerKind
  const transportIdentity = ref.transportIdentity ?? parsed?.transportIdentity
  return ownerKind !== undefined && scope.ownerKinds.includes(ownerKind) && (scope.transportIdentities === undefined || transportIdentity !== undefined && scope.transportIdentities.includes(transportIdentity))
}

export const createInputDraftBlobStore = (driver: InputDraftBlobDriver = createIndexedDBInputDraftBlobDriver()): InputDraftBlobStore => {
  const release = async (reference: DraftAttachmentReference, expectedBlobID?: string): Promise<DraftBlobResult<boolean>> => {
    try {
      const value = await driver.transaction(async (tx) => {
        const ref = await tx.getBlobRef(draftAttachmentRefID(reference))
        if (!ref || expectedBlobID !== undefined && ref.blobID !== expectedBlobID) return false
        await tx.deleteBlobRef(ref.id)
        await normalize(tx)
        if (!(await tx.getAllBlobRefs()).some((entry) => entry.blobID === ref.blobID)) await tx.deleteBlob(ref.blobID)
        return true
      })
      return { ok: true, value }
    } catch (error) { return result(error) }
  }
  return {
    put: async (id, value) => {
      try {
        assertID(id); assertValue(value)
        const hash = await fingerprint(value)
        await driver.transaction(async (tx) => {
          const existing = await tx.getBlob(id)
          if (existing && !await sameBlob(existing, hash)) throw new Failure("blob-id-conflict")
          if (!existing) await tx.putBlob({ id, value, refCount: 0, fingerprint: hash })
        })
        return { ok: true, value: undefined }
      } catch (error) { return result(error) }
    },
    putAndRetain: async (reference, id, value) => {
      try {
        assertID(id); assertValue(value)
        const hash = await fingerprint(value)
        await driver.transaction(async (tx) => {
          const refID = draftAttachmentRefID(reference)
          const ref = await tx.getBlobRef(refID)
          if (ref && ref.blobID !== id) throw new Failure("blob-id-conflict")
          const blob = await tx.getBlob(id)
          if (blob && !await sameBlob(blob, hash)) throw new Failure("blob-id-conflict")
          if (!blob) await tx.putBlob({ id, value, refCount: 0, fingerprint: hash })
          if (!ref) await tx.putBlobRef(rowFor(reference, id))
          await normalize(tx)
        })
        return { ok: true, value: undefined }
      } catch (error) { return result(error) }
    },
    read: async (id) => { try { const blob = await driver.transaction((tx) => tx.getBlob(id)); return blob ? { ok: true, value: blob.value } : { ok: false, error: { code: "missing-blob" } } } catch (error) { return result(error) } },
    readReference: async (reference) => { try { const ref = await driver.transaction((tx) => tx.getBlobRef(draftAttachmentRefID(reference))); return { ok: true, value: ref?.blobID } } catch (error) { return result(error) } },
    retain: async (reference, id) => {
      try {
        assertID(id)
        await driver.transaction(async (tx) => {
          const ref = await tx.getBlobRef(draftAttachmentRefID(reference))
          if (ref && ref.blobID !== id) throw new Failure("blob-id-conflict")
          if (!await tx.getBlob(id)) throw new Failure("missing-blob")
          if (!ref) await tx.putBlobRef(rowFor(reference, id))
          await normalize(tx)
        })
        return { ok: true, value: undefined }
      } catch (error) { return result(error) }
    },
    release: (reference) => release(reference),
    releaseIfMatches: (reference, id) => release(reference, id),
    reconcileReferences: async (desired, scope = { ownerKinds: ["session", "draft"] }) => {
      try {
        const value = await driver.transaction(async (tx) => {
          const released: string[] = []
          const repaired: string[] = []
          const missing: string[] = []
          const current = new Map((await tx.getAllBlobRefs()).map((ref) => [ref.id, ref]))
          for (const [id, ref] of current) {
            if (inScope(ref, scope) && desired.get(id) !== ref.blobID) {
              await tx.deleteBlobRef(id)
              released.push(id)
            }
          }
          for (const [id, blobID] of desired) {
            const parsed = parseRefID(id)
            if (!parsed || !scope.ownerKinds.includes(parsed.ownerKind) || scope.transportIdentities !== undefined && !scope.transportIdentities.includes(parsed.transportIdentity)) {
              missing.push(id)
              continue
            }
            const ref = current.get(id)
            const blob = await tx.getBlob(blobID)
            if (!blob) { missing.push(id); continue }
            if (!ref || ref.blobID !== blobID) {
              await tx.putBlobRef({ id, blobID, ...parsed })
              repaired.push(id)
            }
          }
          await normalize(tx, true)
          return { released, repaired, missing }
        })
        return { ok: true, value }
      } catch (error) { return result(error) }
    },
    reconcileOwnerReferences: async (owner, live) => {
      const desired = new Map<string, string>()
      for (const [occurrence, blobID] of live) desired.set(draftAttachmentRefID({ transportIdentity: owner.transportIdentity, owner: owner.owner, attachmentOccurrenceRefID: occurrence }), blobID)
      try {
        const value = await driver.transaction(async (tx) => {
          let count = 0
          const removed = new Set<string>()
          for (const ref of await tx.getAllBlobRefs()) if (ref.transportIdentity === owner.transportIdentity && ref.ownerKind === owner.owner.kind && ref.ownerID === owner.owner.ownerID && desired.get(ref.id) !== ref.blobID) { await tx.deleteBlobRef(ref.id); removed.add(ref.blobID); count++ }
          await normalize(tx)
          const refs = await tx.getAllBlobRefs()
          for (const id of removed) if (!refs.some((ref) => ref.blobID === id)) await tx.deleteBlob(id)
          return count
        })
        return { ok: true, value }
      } catch (error) { return result(error) }
    },
    discardUnreferenced: async (id) => { try { const value = await driver.transaction(async (tx) => { const blob = await tx.getBlob(id); if (!blob || (await tx.getAllBlobRefs()).some((ref) => ref.blobID === id)) return false; await tx.deleteBlob(id); return true }); return { ok: true, value } } catch (error) { return result(error) } },
  }
}

export class MemoryInputDraftBlobDriver implements InputDraftBlobDriver {
  private blobs = new Map<string, BlobRow>()
  private refs = new Map<string, BlobRefRow>()
  private failCommit = false
  private tail = Promise.resolve()
  failNextCommit(): void { this.failCommit = true }
  transaction<T>(action: (tx: InputDraftBlobTransaction) => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const blobs = new Map(this.blobs)
      const refs = new Map(this.refs)
      const tx: InputDraftBlobTransaction = { getBlob: async (id) => blobs.get(id), getAllBlobs: async () => [...blobs.values()], putBlob: async (row) => { blobs.set(row.id, row) }, deleteBlob: async (id) => { blobs.delete(id) }, getBlobRef: async (id) => refs.get(id), getAllBlobRefs: async () => [...refs.values()], putBlobRef: async (row) => { refs.set(row.id, row) }, deleteBlobRef: async (id) => { refs.delete(id) } }
      const output = await action(tx)
      if (this.failCommit) { this.failCommit = false; throw new Failure("transaction-failed") }
      this.blobs = blobs; this.refs = refs
      return output
    })
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }
}

export const createIndexedDBInputDraftBlobDriver = (): InputDraftBlobDriver => ({
  transaction: async <T>(action: (tx: InputDraftBlobTransaction) => Promise<T>) => {
    const database = await openDatabase()
    const transaction = database.transaction([BLOBS_STORE, BLOB_REFS_STORE], "readwrite")
    const blobs = transaction.objectStore(BLOBS_STORE)
    const refs = transaction.objectStore(BLOB_REFS_STORE)
    const wrap = <V>(request: IDBRequest<V>): Promise<V> => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? transaction.error ?? new Error("IndexedDB request failed")) })
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new DOMException("aborted", "AbortError"))
      transaction.onerror = () => { console.error("Input draft IndexedDB transaction error", transaction.error) }
    })
    let actionError: unknown
    try {
      const output = await action({ getBlob: (id) => wrap<BlobRow | undefined>(blobs.get(id)), getAllBlobs: () => wrap<BlobRow[]>(blobs.getAll()), putBlob: async (row) => { await wrap(blobs.put(row)) }, deleteBlob: async (id) => { await wrap(blobs.delete(id)) }, getBlobRef: (id) => wrap<BlobRefRow | undefined>(refs.get(id)), getAllBlobRefs: () => wrap<BlobRefRow[]>(refs.getAll()), putBlobRef: async (row) => { await wrap(refs.put(row)) }, deleteBlobRef: async (id) => { await wrap(refs.delete(id)) } })
      await done
      return output
    } catch (error) {
      actionError = error
      try { transaction.abort() } catch { /* The transaction has reached a terminal state. */ }
      try { await done } catch (terminalError) { if (actionError === undefined) actionError = terminalError }
      throw actionError
    } finally { database.close() }
  },
})

const openDatabase = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  if (!globalThis.indexedDB) { reject(new Failure("database-unavailable")); return }
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
  let settled = false
  const fail = (): void => { if (!settled) { settled = true; reject(new Failure("database-unavailable")) } }
  request.onupgradeneeded = () => {
    const database = request.result
    if (!database.objectStoreNames.contains(BLOBS_STORE)) database.createObjectStore(BLOBS_STORE, { keyPath: "id" })
    if (!database.objectStoreNames.contains(BLOB_REFS_STORE)) database.createObjectStore(BLOB_REFS_STORE, { keyPath: "id" })
  }
  request.onsuccess = () => {
    const database = request.result
    database.onversionchange = () => database.close()
    if (settled) { database.close(); return }
    settled = true
    resolve(database)
  }
  request.onerror = fail
  request.onblocked = fail
})
