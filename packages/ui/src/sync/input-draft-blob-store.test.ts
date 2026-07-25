import { describe, expect, test } from "bun:test"
import { createInputDraftBlobStore, MemoryInputDraftBlobDriver, type InputDraftBlobDriver } from "./input-draft-blob-store"
import { draftAttachmentRefID, draftRootAttachmentOccurrenceRefID, type DraftAttachmentOwner, type DraftAttachmentReference } from "./input-draft-types"

const reference = (transportIdentity: string, ownerID: string, occurrence = "attachment-a", kind: DraftAttachmentOwner["kind"] = "session"): DraftAttachmentReference => ({ transportIdentity, owner: { kind, ownerID } as DraftAttachmentOwner, attachmentOccurrenceRefID: draftRootAttachmentOccurrenceRefID(occurrence) })

const failingWriteDriver = (write: "blob" | "ref"): InputDraftBlobDriver => {
  const driver = new MemoryInputDraftBlobDriver()
  return {
    transaction: (action) => driver.transaction((transaction) => action({
      ...transaction,
      putBlob: async (row) => {
        if (write === "blob") throw new Error("blob write failed")
        await transaction.putBlob(row)
      },
      putBlobRef: async (row) => {
        if (write === "ref") throw new Error("ref write failed")
        await transaction.putBlobRef(row)
      },
    })),
  }
}

describe("input draft blob store", () => {
  test("conditionally releases only its expected occurrence binding", async () => {
    const store = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    const ref = reference("runtime-a", "owner")
    await store.putAndRetain(ref, "blob-a", "https://example.test/a")
    expect(await store.releaseIfMatches(ref, "blob-b")).toEqual({ ok: true, value: false })
    expect(await store.readReference(ref)).toEqual({ ok: true, value: "blob-a" })
  })
  test("keeps values immutable and classifies invalid values", async () => {
    const store = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    expect(await store.put("blob-a", "https://example.test/a")).toEqual({ ok: true, value: undefined })
    expect(await store.put("blob-a", "https://example.test/b")).toEqual({ ok: false, error: { code: "blob-id-conflict" } })
    expect(await store.read("blob-a")).toEqual({ ok: true, value: "https://example.test/a" })
    expect(await store.put("blob-file", "file:///tmp/a.txt")).toEqual({ ok: true, value: undefined })
    expect(await store.put("blob-b", "data:text/plain;base64,eA==")).toEqual({ ok: false, error: { code: "invalid-value" } })
  })

  test("atomically creates and retains immutable blobs with idempotent retries", async () => {
    const store = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    const ref = reference("runtime-a", "owner")
    expect(await store.putAndRetain(ref, "blob-a", "https://example.test/a")).toEqual({ ok: true, value: undefined })
    expect(await store.readReference(ref)).toEqual({ ok: true, value: "blob-a" })
    expect(await store.putAndRetain(ref, "blob-a", "https://example.test/retry")).toEqual({ ok: false, error: { code: "blob-id-conflict" } })
    expect(await store.read("blob-a")).toEqual({ ok: true, value: "https://example.test/a" })
    expect(await store.putAndRetain(reference("runtime-a", "other-owner", "other"), "blob-a", "https://example.test/a")).toEqual({ ok: true, value: undefined })
    expect(await store.putAndRetain(ref, "blob-b", "https://example.test/b")).toEqual({ ok: false, error: { code: "blob-id-conflict" } })
  })

  test("repairs a missing blob for an existing reference atomically", async () => {
    const driver = new MemoryInputDraftBlobDriver()
    const store = createInputDraftBlobStore(driver)
    const ref = reference("runtime-a", "owner")
    await driver.transaction(async (transaction) => { await transaction.putBlobRef({ id: draftAttachmentRefID(ref), blobID: "blob-a" }) })
    expect(await store.putAndRetain(ref, "blob-a", new Blob(["x"], { type: "text/plain" }))).toEqual({ ok: true, value: undefined })
    expect(await store.read("blob-a")).toEqual({ ok: true, value: new Blob(["x"], { type: "text/plain" }) })
    expect(await store.putAndRetain(ref, "blob-a", new Blob(["x"], { type: "application/octet-stream" }))).toEqual({ ok: false, error: { code: "blob-id-conflict" } })
  })

  test("treats equal Blob type, size, and content as idempotent while preserving immutable conflicts", async () => {
    const store = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    const ref = reference("runtime-a", "owner")
    const value = new Blob(["same"], { type: "text/plain" })
    expect(await store.putAndRetain(ref, "blob", value)).toEqual({ ok: true, value: undefined })
    expect(await store.putAndRetain(ref, "blob", new Blob(["same"], { type: "text/plain" }))).toEqual({ ok: true, value: undefined })
    expect(await store.putAndRetain(ref, "blob", new Blob(["same"], { type: "application/octet-stream" }))).toEqual({ ok: false, error: { code: "blob-id-conflict" } })
    expect(await store.putAndRetain(ref, "blob", new Blob(["other"], { type: "text/plain" }))).toEqual({ ok: false, error: { code: "blob-id-conflict" } })
  })

  test("keeps queue and send references outside managed draft reconciliation", async () => {
    const store = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    const queue = reference("runtime-a", "queue-a", "queue", "queue")
    const send = reference("runtime-a", "send-a", "send", "send")
    await store.put("shared", "https://example.test/shared")
    await store.retain(queue, "shared")
    await store.retain(send, "shared")
    expect(await store.reconcileReferences(new Map(), { ownerKinds: ["session", "draft"] })).toEqual({ ok: true, value: { released: [], repaired: [], missing: [] } })
    expect(await store.readReference(queue)).toEqual({ ok: true, value: "shared" })
    expect(await store.readReference(send)).toEqual({ ok: true, value: "shared" })
  })

  test("reconciles Assistant surface references as managed drafts", async () => {
    const store = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    const surface = reference("runtime-a", "assistant:first", "shared", "surface")
    await store.put("shared", "https://example.test/shared")
    const result = await store.reconcileReferences(
      new Map([[draftAttachmentRefID(surface), "shared"]]),
      { ownerKinds: ["session", "draft", "surface"] },
    )
    expect(result).toEqual({ ok: true, value: { released: [], repaired: [draftAttachmentRefID(surface)], missing: [] } })
    expect(await store.readReference(surface)).toEqual({ ok: true, value: "shared" })
  })

  test("calibrates corrupted reference counts during operations and reconciliation", async () => {
    const driver = new MemoryInputDraftBlobDriver()
    const store = createInputDraftBlobStore(driver)
    const first = reference("runtime-a", "owner", "first")
    const second = reference("runtime-a", "owner", "second")
    await driver.transaction(async (transaction) => {
      await transaction.putBlob({ id: "shared", value: "https://example.test/shared", refCount: 99 })
      await transaction.putBlobRef({ id: draftAttachmentRefID(first), blobID: "shared" })
    })
    await store.retain(second, "shared")
    await driver.transaction(async (transaction) => expect((await transaction.getBlob("shared"))?.refCount).toBe(2))
    await driver.transaction(async (transaction) => { await transaction.putBlob({ ...(await transaction.getBlob("shared"))!, refCount: 0 }) })
    await store.reconcileReferences(new Map([[draftAttachmentRefID(first), "shared"], [draftAttachmentRefID(second), "shared"]]))
    await driver.transaction(async (transaction) => expect((await transaction.getBlob("shared"))?.refCount).toBe(2))
  })

  test("rolls back put and retain write failures", async () => {
    for (const write of ["blob", "ref"] as const) {
      const store = createInputDraftBlobStore(failingWriteDriver(write))
      const ref = reference("runtime-a", `owner-${write}`)
      expect(await store.putAndRetain(ref, `blob-${write}`, "https://example.test/a")).toEqual({ ok: false, error: { code: "transaction-failed" } })
      expect(await store.read(`blob-${write}`)).toEqual({ ok: false, error: { code: "missing-blob" } })
      expect(await store.readReference(ref)).toEqual({ ok: true, value: undefined })
    }
  })

  test("isolates same owner and occurrence across transports", async () => {
    const store = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    await store.put("blob-a", "https://example.test/a")
    await store.put("blob-b", "https://example.test/b")
    await store.retain(reference("runtime-a", "same"), "blob-a")
    await store.retain(reference("runtime-b", "same"), "blob-b")
    expect(await store.release(reference("runtime-a", "same"))).toEqual({ ok: true, value: true })
    expect(await store.read("blob-a")).toEqual({ ok: false, error: { code: "missing-blob" } })
    expect(await store.read("blob-b")).toEqual({ ok: true, value: "https://example.test/b" })
  })

  test("moves A to B atomically and rolls back a failed commit", async () => {
    const driver = new MemoryInputDraftBlobDriver()
    const store = createInputDraftBlobStore(driver)
    await store.put("blob-a", "https://example.test/a")
    await store.put("blob-b", "https://example.test/b")
    await store.retain(reference("runtime-a", "owner"), "blob-a")
    expect(await store.retain(reference("runtime-a", "owner"), "blob-b")).toEqual({ ok: false, error: { code: "blob-id-conflict" } })
    expect(await store.read("blob-a")).toEqual({ ok: true, value: "https://example.test/a" })
    expect(await store.release(reference("runtime-a", "owner"))).toEqual({ ok: true, value: true })
  })

  test("releases occurrences progressively and serializes concurrent writes", async () => {
    const store = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    await store.put("blob-a", "https://example.test/a")
    await Promise.all([store.retain(reference("runtime-a", "owner", "one"), "blob-a"), store.retain(reference("runtime-a", "owner", "two"), "blob-a")])
    expect(await store.release(reference("runtime-a", "owner", "one"))).toEqual({ ok: true, value: true })
    expect(await store.read("blob-a")).toEqual({ ok: true, value: "https://example.test/a" })
    expect(await store.release(reference("runtime-a", "owner", "two"))).toEqual({ ok: true, value: true })
    expect(await store.release(reference("runtime-a", "owner", "two"))).toEqual({ ok: true, value: false })
    expect(await store.read("blob-a")).toEqual({ ok: false, error: { code: "missing-blob" } })
  })

  test("classifies quota failures", async () => {
    const quotaStore = createInputDraftBlobStore({ transaction: async () => { throw new DOMException("quota", "QuotaExceededError") } })
    expect(await quotaStore.put("blob-a", "https://example.test/a")).toEqual({ ok: false, error: { code: "quota-exceeded" } })
  })

  test("accepts queue and send attachment references", async () => {
    const store = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    await store.put("blob-a", "https://example.test/a")
    await Promise.all([
      store.retain(reference("runtime-a", "queue-a", "queue", "queue"), "blob-a"),
      store.retain(reference("runtime-a", "send-a", "send", "send"), "blob-a"),
    ])
    expect(await store.release(reference("runtime-a", "queue-a", "queue", "queue"))).toEqual({ ok: true, value: true })
    expect(await store.release(reference("runtime-a", "send-a", "send", "send"))).toEqual({ ok: true, value: true })
  })

  test("reconciles orphaned and changed owner references while retaining live occurrences", async () => {
    const store = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    const owner = { transportIdentity: "runtime-a", owner: { kind: "session" as const, ownerID: "owner" } }
    const live = reference("runtime-a", "owner", "live")
    const changed = reference("runtime-a", "owner", "changed")
    const orphan = reference("runtime-a", "owner", "orphan")
    const sharedOne = reference("runtime-a", "owner", "shared-one")
    const sharedTwo = reference("runtime-a", "owner", "shared-two")
    for (const [blobID, value] of [["live", "https://example.test/live"], ["old", "https://example.test/old"], ["orphan", "https://example.test/orphan"], ["shared", "https://example.test/shared"]] as const) await store.put(blobID, value)
    await Promise.all([store.retain(live, "live"), store.retain(changed, "old"), store.retain(orphan, "orphan"), store.retain(sharedOne, "shared"), store.retain(sharedTwo, "shared")])
    const result = await store.reconcileOwnerReferences(owner, new Map([[live.attachmentOccurrenceRefID, "live"], [changed.attachmentOccurrenceRefID, "new"], [sharedOne.attachmentOccurrenceRefID, "shared"], [sharedTwo.attachmentOccurrenceRefID, "shared"]]))
    expect(result).toEqual({ ok: true, value: 2 })
    expect(await store.readReference(live)).toEqual({ ok: true, value: "live" })
    expect(await store.readReference(changed)).toEqual({ ok: true, value: undefined })
    expect(await store.readReference(orphan)).toEqual({ ok: true, value: undefined })
    expect(await store.read("old")).toEqual({ ok: false, error: { code: "missing-blob" } })
    expect(await store.read("orphan")).toEqual({ ok: false, error: { code: "missing-blob" } })
    expect(await store.read("shared")).toEqual({ ok: true, value: "https://example.test/shared" })
  })

  test("reconciles only the exact transport and owner scope with rollback", async () => {
    const driver = new MemoryInputDraftBlobDriver()
    const store = createInputDraftBlobStore(driver)
    const session = reference("runtime-a", "same", "session", "session")
    const queue = reference("runtime-a", "same", "queue", "queue")
    const remote = reference("runtime-b", "same", "remote", "session")
    const legacy = reference("runtime-a", "same", "legacy", "session")
    for (const [blobID, value] of [["session", "https://example.test/session"], ["queue", "https://example.test/queue"], ["remote", "https://example.test/remote"]] as const) await store.put(blobID, value)
    await Promise.all([store.retain(session, "session"), store.retain(queue, "queue"), store.retain(remote, "remote")])
    await driver.transaction(async (transaction) => {
      await transaction.putBlob({ id: "legacy", value: "https://example.test/legacy", refCount: 1 })
      await transaction.putBlobRef({ id: draftAttachmentRefID(legacy), blobID: "legacy" })
    })
    driver.failNextCommit()
    expect(await store.reconcileOwnerReferences({ transportIdentity: "runtime-a", owner: { kind: "session", ownerID: "same" } }, new Map())).toEqual({ ok: false, error: { code: "transaction-failed" } })
    expect(await store.readReference(session)).toEqual({ ok: true, value: "session" })
    expect(await store.reconcileOwnerReferences({ transportIdentity: "runtime-a", owner: { kind: "session", ownerID: "same" } }, new Map())).toEqual({ ok: true, value: 1 })
    expect(await store.readReference(queue)).toEqual({ ok: true, value: "queue" })
    expect(await store.readReference(remote)).toEqual({ ok: true, value: "remote" })
    expect(await store.read("legacy")).toEqual({ ok: true, value: "https://example.test/legacy" })
  })

  test("discards only unreferenced blobs and serializes retain races", async () => {
    const store = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    await store.put("blob-a", "https://example.test/a")
    expect(await store.discardUnreferenced("blob-a")).toEqual({ ok: true, value: true })
    await store.put("blob-a", "https://example.test/a")
    const ref = reference("runtime-a", "owner")
    const [retained, discarded] = await Promise.all([store.retain(ref, "blob-a"), store.discardUnreferenced("blob-a")])
    expect(retained).toEqual({ ok: true, value: undefined })
    expect(discarded).toEqual({ ok: true, value: false })
    expect(await store.read("blob-a")).toEqual({ ok: true, value: "https://example.test/a" })
  })
})
