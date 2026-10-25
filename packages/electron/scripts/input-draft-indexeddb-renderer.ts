import {
  createIndexedDBInputDraftBlobDriver,
  createInputDraftBlobStore,
} from "../../ui/src/sync/input-draft-blob-store"
import type { DraftAttachmentReference } from "../../ui/src/sync/input-draft-types"

type Evidence = { name: string }

const expect: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message)
}

const reference = (occurrence: string): DraftAttachmentReference => ({
  transportIdentity: "indexeddb-evidence-runtime",
  owner: { kind: "session", ownerID: "indexeddb-evidence-owner" },
  attachmentOccurrenceRefID: occurrence,
})

const deleteTestDatabase = (): Promise<void> => new Promise((resolve, reject) => {
  const request = indexedDB.deleteDatabase("yuri-input-drafts")
  request.onsuccess = () => resolve()
  request.onerror = () => reject(request.error ?? new DOMException("Database cleanup failed", "UnknownError"))
  request.onblocked = () => reject(new DOMException("Database cleanup blocked", "InvalidStateError"))
})

const run = async (): Promise<Evidence[]> => {
  const evidence: Evidence[] = []
  const store = createInputDraftBlobStore()

  const initialPut = await store.put("commit", "https://example.test/commit")
  expect(initialPut.ok, `normal put failed: ${initialPut.ok ? '' : JSON.stringify(initialPut.error)}`)
  const committed = await store.read("commit")
  expect(committed.ok && committed.value === "https://example.test/commit", "normal read returned an unexpected value")
  evidence.push({ name: "commit/read" })

  const atomicReference = reference("put-and-retain")
  expect((await store.putAndRetain(atomicReference, "atomic", "https://example.test/atomic")).ok, "putAndRetain failed")
  expect((await store.putAndRetain(atomicReference, "atomic", "https://example.test/atomic")).ok, "putAndRetain retry failed")
  const atomicValue = await store.read("atomic")
  expect(atomicValue.ok && atomicValue.value === "https://example.test/atomic", "putAndRetain overwrote immutable value")
  expect((await store.release(atomicReference)).ok, "putAndRetain cleanup failed")
  evidence.push({ name: "putAndRetain atomic idempotence" })

  const rollbackDriver = createIndexedDBInputDraftBlobDriver()
  try {
    await rollbackDriver.transaction(async (transaction) => {
      await transaction.putBlob({ id: "rollback-blob", value: "https://example.test/rollback", refCount: 1 })
      await transaction.putBlobRef({ id: "rollback-ref", blobID: "rollback-blob" })
      throw new Error("action failure")
    })
    throw new Error("action failure committed")
  } catch (error) {
    expect(error instanceof Error && error.message === "action failure", "action failure was not preserved")
  }
  await rollbackDriver.transaction(async (transaction) => {
    expect(await transaction.getBlob("rollback-blob") === undefined, "action failure retained a blob")
    expect(await transaction.getBlobRef("rollback-ref") === undefined, "action failure retained a blob ref")
  })
  evidence.push({ name: "action throw atomic rollback" })

  const cloneDriver = createIndexedDBInputDraftBlobDriver()
  try {
    await cloneDriver.transaction(async (transaction) => {
      await transaction.putBlob({ id: "clone-error", value: (() => undefined) as never, refCount: 0 })
    })
    throw new Error("DataCloneError transaction committed")
  } catch (error) {
    expect(error instanceof DOMException && error.name === "DataCloneError", "expected Chromium DataCloneError")
  }
  expect((await store.put("after-clone", "https://example.test/after-clone")).ok, "transaction after DataCloneError failed")
  const afterClone = await store.read("after-clone")
  expect(afterClone.ok && afterClone.value === "https://example.test/after-clone", "transaction after DataCloneError did not commit")
  evidence.push({ name: "DataCloneError abort and recovery" })

  expect((await store.put("retain-a", "https://example.test/a")).ok, "retain A setup failed")
  expect((await store.put("retain-b", "https://example.test/b")).ok, "retain B setup failed")
  const retainedReference = reference("retain-switch")
  expect((await store.retain(retainedReference, "retain-a")).ok, "retain A failed")
  const retainConflict = await store.retain(retainedReference, "retain-b")
  expect(!retainConflict.ok && retainConflict.error.code === "blob-id-conflict", "retain conflict was not reported")
  expect((await store.read("retain-a")).ok, "retain conflict removed A")
  expect((await store.read("retain-b")).ok, "retain conflict removed B")
  const switchedRelease = await store.release(retainedReference)
  expect(switchedRelease.ok && switchedRelease.value === true, "retain switch release failed")
  expect(!(await store.read("retain-a")).ok, "retain release preserved A")
  evidence.push({ name: "retain conflicting binding" })

  expect((await store.put("release", "https://example.test/release")).ok, "release setup failed")
  const releaseReference = reference("repeat-release")
  expect((await store.retain(releaseReference, "release")).ok, "release retain failed")
  const firstRelease = await store.release(releaseReference)
  const secondRelease = await store.release(releaseReference)
  expect(firstRelease.ok && firstRelease.value === true, "first release did not report success")
  expect(secondRelease.ok && secondRelease.value === false, "second release did not report idempotence")
  evidence.push({ name: "repeated release" })

  expect((await store.putAndRetain(reference("conditional-release"), "conditional", "https://example.test/conditional")).ok, "conditional release setup failed")
  const conditionalRelease = await store.releaseIfMatches(reference("conditional-release"), "other")
  expect(conditionalRelease.ok && conditionalRelease.value === false, "conditional release removed a different binding")
  evidence.push({ name: "conditional release binding" })

  const serialDriver = createIndexedDBInputDraftBlobDriver()
  let secondTransactionValue: string | undefined
  await Promise.all([
    serialDriver.transaction(async (transaction) => {
      await transaction.putBlob({ id: "serialized", value: "https://example.test/serialized", refCount: 0 })
    }),
    serialDriver.transaction(async (transaction) => {
      secondTransactionValue = (await transaction.getBlob("serialized"))?.value as string | undefined
    }),
  ])
  expect(secondTransactionValue === "https://example.test/serialized", "concurrent readwrite transactions did not serialize")
  evidence.push({ name: "concurrent readwrite serialization" })

  const reconcileOwner = { transportIdentity: "indexeddb-evidence-runtime", owner: { kind: "session" as const, ownerID: "reconcile-owner" } }
  const reconcileLive = { ...reconcileOwner, attachmentOccurrenceRefID: "live" }
  const reconcileOrphan = { ...reconcileOwner, attachmentOccurrenceRefID: "orphan" }
  expect((await store.put("reconcile-live", "https://example.test/reconcile-live")).ok, "reconcile live setup failed")
  expect((await store.put("reconcile-orphan", "https://example.test/reconcile-orphan")).ok, "reconcile orphan setup failed")
  expect((await store.retain(reconcileLive, "reconcile-live")).ok, "reconcile live retain failed")
  expect((await store.retain(reconcileOrphan, "reconcile-orphan")).ok, "reconcile orphan retain failed")
  const reconciled = await store.reconcileOwnerReferences(reconcileOwner, new Map([["live", "reconcile-live"]]))
  expect(reconciled.ok && reconciled.value === 1, "reconcile did not release exactly one orphan")
  expect((await store.read("reconcile-live")).ok, "reconcile released a live blob")
  expect(!(await store.read("reconcile-orphan")).ok, "reconcile retained an orphan blob")
  evidence.push({ name: "owner reference reconciliation" })

  return evidence
}

declare global {
  interface Window {
    __YURI_INPUT_DRAFT_INDEXEDDB_EVIDENCE__?: Promise<{ ok: true; evidence: Evidence[] } | { ok: false; error: string }>
  }
}

window.__YURI_INPUT_DRAFT_INDEXEDDB_EVIDENCE__ = run()
  .then(async (evidence) => {
    await deleteTestDatabase()
    return { ok: true as const, evidence }
  })
  .catch(async (error) => {
    try { await deleteTestDatabase() } catch { /* Cleanup failure is reported with the test failure. */ }
    return { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
  })
