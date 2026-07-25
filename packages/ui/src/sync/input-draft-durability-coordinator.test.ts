import { describe, expect, test } from "bun:test"
import { createInputDraftBlobStore, MemoryInputDraftBlobDriver, type InputDraftBlobStore } from "./input-draft-blob-store"
import { createInputDraftDurabilityCoordinator } from "./input-draft-durability-coordinator"
import type { InputDraftMetadataPersistenceCoordinator, InputDraftMetadataSnapshot } from "./input-draft-metadata-store"
import { draftAttachmentRefID, draftKeyString, draftRootAttachmentOccurrenceRefID, draftSyntheticPartAttachmentOccurrenceRefID, type DraftAttachmentMetadata, type DraftRecord } from "./input-draft-types"

const key = (ownerID = "owner", transportIdentity = "runtime") => ({ transportIdentity, owner: { kind: "session" as const, ownerID } })
const attachment = (id: string, blobID: string, partID?: string): DraftAttachmentMetadata => ({ attachmentID: id, attachmentRefID: partID ? draftSyntheticPartAttachmentOccurrenceRefID(partID, id) : draftRootAttachmentOccurrenceRefID(id), filename: `${id}.txt`, mimeType: "text/plain", size: 1, locator: { kind: "blob", blobID }, source: "local" })
const record = (revision = 1, ownerID = "owner", attachments: DraftAttachmentMetadata[] = [], syntheticParts: DraftRecord["syntheticParts"] = [], transportIdentity = "runtime"): DraftRecord => ({ version: 1, key: key(ownerID, transportIdentity), revision, text: "draft", attachments, syntheticParts, mentions: [] })
const snapshot = (records: DraftRecord[] = []): InputDraftMetadataSnapshot => ({ version: 1, drafts: Object.fromEntries(records.map((value) => [draftKeyString(value.key), value])), tombstones: {}, migration: { complete: false, claimedTransportIdentity: "", captured: false, markerCommitted: false, cleanupComplete: false }, legacy: { entries: {} } })

const metadata = () => {
  const snapshots: InputDraftMetadataSnapshot[] = []
  let fail = false
  let pending: (() => void) | undefined
  const coordinator: InputDraftMetadataPersistenceCoordinator = {
    persist: async (value) => {
      if (pending) await new Promise<void>((resolve) => { const release = pending; pending = () => { release?.(); resolve() } })
      if (fail) { fail = false; return { ok: false, error: { code: "quota" } } }
      snapshots.push(value)
      return { ok: true, value: undefined }
    },
  }
  return { coordinator, snapshots, failNext: () => { fail = true }, allow: () => pending?.(), block: () => { pending = () => {} } }
}
const commit = async (coordinator: ReturnType<typeof createInputDraftDurabilityCoordinator>, value: DraftRecord, options: Partial<Parameters<typeof coordinator.commit>[0]> = {}) => {
  const candidate = { drafts: { [draftKeyString(value.key)]: value }, isCurrent: () => true, resolveBlobValue: () => new Blob(["x"]), ...options }
  return coordinator.commit(candidate)
}

describe("input draft durability coordinator", () => {
  test("requires one successful seed before durable commits", async () => {
    const coordinator = createInputDraftDurabilityCoordinator(createInputDraftBlobStore(new MemoryInputDraftBlobDriver()), metadata().coordinator)
    expect((await coordinator.commit({ isCurrent: () => true })).status).toBe("unseeded")
    expect((await coordinator.seed(null)).status).toBe("committed")
    expect((await coordinator.seed(null)).status).toBe("failed")
  })
  test("keeps commits unseeded after reconciliation failure", async () => {
    const driver = new MemoryInputDraftBlobDriver()
    driver.failNextCommit()
    const coordinator = createInputDraftDurabilityCoordinator(createInputDraftBlobStore(driver), metadata().coordinator)
    expect((await coordinator.seed(null)).status).toBe("failed")
    expect((await coordinator.commit({ isCurrent: () => true })).status).toBe("unseeded")
  })
  test("waits for blob readiness and queues a later text snapshot behind it", async () => {
    const blobs = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    const writer = metadata()
    const coordinator = createInputDraftDurabilityCoordinator(blobs, writer.coordinator)
    await coordinator.seed(null)
    const first = record(1, "owner", [attachment("a", "blob-a")])
    const firstCommit = commit(coordinator, first, { resolveBlobValue: async () => new Promise((resolve) => setTimeout(() => resolve(new Blob(["a"])), 10)) })
    const secondCommit = commit(coordinator, { ...first, revision: 2, text: "later" })
    expect(writer.snapshots).toEqual([])
    expect((await firstCommit).status).toBe("committed")
    expect((await secondCommit).status).toBe("committed")
    expect(writer.snapshots[1]?.drafts[draftKeyString(first.key)]?.attachments[0]?.locator).toEqual({ kind: "blob", blobID: "blob-a" })
  })

  test("rolls back candidate references after metadata quota failure and supports retry", async () => {
    const blobs = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    const writer = metadata()
    const coordinator = createInputDraftDurabilityCoordinator(blobs, writer.coordinator)
    await coordinator.seed(null)
    const value = record(1, "owner", [attachment("a", "blob-a")])
    writer.failNext()
    expect((await commit(coordinator, value)).status).toBe("failed")
    const ref = { transportIdentity: "runtime", owner: key().owner, attachmentOccurrenceRefID: draftRootAttachmentOccurrenceRefID("a") }
    expect(await blobs.readReference(ref)).toEqual({ ok: true, value: undefined })
    expect((await commit(coordinator, value)).status).toBe("committed")
  })

  test("persists and restores Assistant surface attachments", async () => {
    const blobs = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    const coordinator = createInputDraftDurabilityCoordinator(blobs, metadata().coordinator)
    await coordinator.seed(null)
    const value: DraftRecord = {
      ...record(1, "assistant:first", [attachment("shared", "native-share")]),
      key: { transportIdentity: "runtime", owner: { kind: "surface", ownerID: "assistant:first" } },
    }
    expect((await commit(coordinator, value)).status).toBe("committed")
    const reference = { transportIdentity: "runtime", owner: value.key.owner, attachmentOccurrenceRefID: draftRootAttachmentOccurrenceRefID("shared") }
    expect(await blobs.readReference(reference)).toEqual({ ok: true, value: "native-share" })

    const restored = createInputDraftDurabilityCoordinator(blobs, metadata().coordinator)
    const seeded = await restored.seed(snapshot([value]))
    expect(seeded.status).toBe("committed")
    expect(seeded.errors).toEqual([])
    expect(await blobs.readReference(reference)).toEqual({ ok: true, value: "native-share" })
  })

  test("persists removal before releasing and retries failed release from the cleanup ledger", async () => {
    const base = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    let failRelease = false
    const events: string[] = []
    const blobs: InputDraftBlobStore = { ...base, releaseIfMatches: async (reference, blobID) => { events.push("release"); return failRelease ? { ok: false, error: { code: "transaction-failed" } } : base.releaseIfMatches(reference, blobID) } }
    const writer = metadata()
    const original = writer.coordinator.persist
    writer.coordinator.persist = async (value) => { events.push("metadata"); return original(value) }
    const coordinator = createInputDraftDurabilityCoordinator(blobs, writer.coordinator)
    await coordinator.seed(null)
    const value = record(1, "owner", [attachment("a", "blob-a")])
    await commit(coordinator, value)
    failRelease = true
    const removed = await coordinator.commit({ delete: [value.key], tombstones: { [draftKeyString(value.key)]: 2 }, isCurrent: () => true })
    expect(removed.status).toBe("committed")
    expect(events.slice(-2)).toEqual(["metadata", "release"])
    failRelease = false
    expect((await coordinator.retryCleanup()).cleanupErrors).toEqual([])
    expect(await base.read("blob-a")).toEqual({ ok: false, error: { code: "missing-blob" } })
  })

  test("moves source to destination in one snapshot across runtimes", async () => {
    const blobs = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    const writer = metadata()
    const coordinator = createInputDraftDurabilityCoordinator(blobs, writer.coordinator)
    await coordinator.seed(null)
    const source = record(1, "source", [attachment("a", "blob-a")], [], "runtime-a")
    await commit(coordinator, source)
    const destination = record(1, "destination", [attachment("a", "blob-a")], [], "runtime-b")
    const result = await coordinator.commit({ drafts: { [draftKeyString(destination.key)]: destination }, delete: [source.key], tombstones: { [draftKeyString(source.key)]: 2 }, isCurrent: () => true })
    expect(result.status).toBe("committed")
    expect(writer.snapshots.at(-1)?.drafts).toEqual({ [draftKeyString(destination.key)]: destination })
  })

  test("rolls back destination references when move metadata persistence fails across runtimes", async () => {
    const blobs = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    const writer = metadata()
    const coordinator = createInputDraftDurabilityCoordinator(blobs, writer.coordinator)
    await coordinator.seed(null)
    const source = record(1, "source", [attachment("a", "shared")], [], "runtime-a")
    await commit(coordinator, source)
    const destination = record(1, "destination", [attachment("a", "shared")], [], "runtime-b")
    writer.failNext()
    expect((await coordinator.commit({ drafts: { [draftKeyString(destination.key)]: destination }, delete: [source.key], isCurrent: () => true })).status).toBe("failed")
    const sourceRef = { transportIdentity: "runtime-a", owner: key("source", "runtime-a").owner, attachmentOccurrenceRefID: draftRootAttachmentOccurrenceRefID("a") }
    const destinationRef = { transportIdentity: "runtime-b", owner: key("destination", "runtime-b").owner, attachmentOccurrenceRefID: draftRootAttachmentOccurrenceRefID("a") }
    expect(await blobs.readReference(sourceRef)).toEqual({ ok: true, value: "shared" })
    expect(await blobs.readReference(destinationRef)).toEqual({ ok: true, value: undefined })
    expect((await blobs.read("shared")).ok).toBe(true)
  })

  test("commits moves with one shared blob and removes the source reference", async () => {
    const blobs = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    const coordinator = createInputDraftDurabilityCoordinator(blobs, metadata().coordinator)
    await coordinator.seed(null)
    const source = record(1, "source", [attachment("a", "shared")])
    await commit(coordinator, source)
    const destination = record(1, "destination", [attachment("a", "shared")])
    expect((await coordinator.commit({ drafts: { [draftKeyString(destination.key)]: destination }, delete: [source.key], isCurrent: () => true })).status).toBe("committed")
    expect(await blobs.readReference({ transportIdentity: "runtime", owner: key("source").owner, attachmentOccurrenceRefID: draftRootAttachmentOccurrenceRefID("a") })).toEqual({ ok: true, value: undefined })
    expect(await blobs.readReference({ transportIdentity: "runtime", owner: key("destination").owner, attachmentOccurrenceRefID: draftRootAttachmentOccurrenceRefID("a") })).toEqual({ ok: true, value: "shared" })
    expect((await blobs.read("shared")).ok).toBe(true)
  })

  test("rolls back every earlier retain when a later occurrence fails", async () => {
    const base = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    let retains = 0
    const blobs: InputDraftBlobStore = { ...base, retain: async (reference, blobID) => ++retains === 2 ? { ok: false, error: { code: "transaction-failed" } } : base.retain(reference, blobID) }
    const coordinator = createInputDraftDurabilityCoordinator(blobs, metadata().coordinator)
    await coordinator.seed(null)
    await base.put("one", "https://example.test/one")
    await base.put("two", "https://example.test/two")
    const value = record(1, "owner", [attachment("one", "one"), attachment("two", "two")])
    expect((await commit(coordinator, value)).status).toBe("failed")
    expect(await base.readReference({ transportIdentity: "runtime", owner: key().owner, attachmentOccurrenceRefID: draftRootAttachmentOccurrenceRefID("one") })).toEqual({ ok: true, value: undefined })
  })

  test("rolls back every acquired occurrence when acquire fails at each position", async () => {
    for (const failureAt of [1, 2, 3]) {
      const base = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
      let attempts = 0
      const blobs: InputDraftBlobStore = { ...base, retain: async (reference, blobID) => ++attempts === failureAt ? { ok: false, error: { code: "transaction-failed" } } : base.retain(reference, blobID) }
      const coordinator = createInputDraftDurabilityCoordinator(blobs, metadata().coordinator)
      await coordinator.seed(null)
      const value = record(1, "owner", [attachment("one", "one"), attachment("two", "two"), attachment("three", "three")])
      for (const id of ["one", "two", "three"]) await base.put(id, `https://example.test/${id}`)
      expect((await commit(coordinator, value)).status).toBe("failed")
      for (const id of ["one", "two", "three"]) expect(await base.readReference({ transportIdentity: "runtime", owner: key().owner, attachmentOccurrenceRefID: draftRootAttachmentOccurrenceRefID(id) })).toEqual({ ok: true, value: undefined })
    }
  })

  test("uses putAndRetain to repair a seeded existing reference whose blob is missing", async () => {
    const driver = new MemoryInputDraftBlobDriver()
    const base = createInputDraftBlobStore(driver)
    let repairs = 0
    const blobs: InputDraftBlobStore = { ...base, putAndRetain: async (reference, blobID, value) => { repairs++; return base.putAndRetain(reference, blobID, value) } }
    const coordinator = createInputDraftDurabilityCoordinator(blobs, metadata().coordinator)
    await coordinator.seed(null)
    const value = record(1, "owner", [attachment("a", "missing")])
    const ref = { transportIdentity: "runtime", owner: key().owner, attachmentOccurrenceRefID: draftRootAttachmentOccurrenceRefID("a") }
    await driver.transaction(async (transaction) => { await transaction.putBlobRef({ id: draftAttachmentRefID(ref), blobID: "missing" }) })
    expect((await commit(coordinator, value)).status).toBe("committed")
    expect(repairs).toBe(1)
    expect((await base.read("missing")).ok).toBe(true)
  })

  test("records rollback release failures in the ledger and clears them on retry", async () => {
    const base = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    let failRelease = true
    const blobs: InputDraftBlobStore = { ...base, releaseIfMatches: async (reference, blobID) => failRelease ? { ok: false, error: { code: "transaction-failed" } } : base.releaseIfMatches(reference, blobID) }
    const writer = metadata()
    const coordinator = createInputDraftDurabilityCoordinator(blobs, writer.coordinator)
    await coordinator.seed(null)
    writer.failNext()
    const result = await commit(coordinator, record(1, "owner", [attachment("a", "blob-a")]))
    expect(result.cleanupErrors).toHaveLength(1)
    failRelease = false
    expect((await coordinator.retryCleanup()).cleanupErrors).toEqual([])
    expect((await base.read("blob-a")).ok).toBe(false)
  })

  test("keeps the durable baseline on stale and metadata failures", async () => {
    const writer = metadata()
    const coordinator = createInputDraftDurabilityCoordinator(createInputDraftBlobStore(new MemoryInputDraftBlobDriver()), writer.coordinator)
    await coordinator.seed(null)
    const first = record()
    await commit(coordinator, first)
    expect((await commit(coordinator, { ...first, revision: 2 }, { isCurrent: () => false })).status).toBe("stale")
    writer.failNext()
    expect((await commit(coordinator, { ...first, revision: 3 })).status).toBe("failed")
    expect(writer.snapshots).toHaveLength(1)
  })

  test("rejects a stale complete blob candidate before every blob cleanup and metadata operation", async () => {
    const base = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    let blobCalls = 0
    const blobs: InputDraftBlobStore = new Proxy(base, { get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? (...args: unknown[]) => { blobCalls++; return value.apply(target, args) } : value
    } })
    const writer = metadata()
    let metadataCalls = 0
    const originalPersist = writer.coordinator.persist
    writer.coordinator.persist = async (value) => { metadataCalls++; return originalPersist(value) }
    const coordinator = createInputDraftDurabilityCoordinator(blobs, writer.coordinator)
    await coordinator.seed(null)
    blobCalls = 0
    metadataCalls = 0
    const value = record(1, "owner", [attachment("a", "blob-a")])
    expect((await commit(coordinator, value, { isCurrent: () => false })).status).toBe("stale")
    expect(blobCalls).toBe(0)
    expect(metadataCalls).toBe(0)
  })

  test("handles synthetic occurrences and reconciles crash orphans by transport and owner", async () => {
    const blobs = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    const coordinator = createInputDraftDurabilityCoordinator(blobs, metadata().coordinator)
    await coordinator.seed(null)
    const synthetic = attachment("a", "blob-a", "part-a")
    const value = record(1, "owner", [], [{ partID: "part-a", text: "part", attachments: [synthetic] }])
    await commit(coordinator, value)
    await blobs.put("orphan", "https://example.test/orphan")
    await blobs.retain({ transportIdentity: "runtime", owner: key().owner, attachmentOccurrenceRefID: draftRootAttachmentOccurrenceRefID("orphan") }, "orphan")
    expect((await coordinator.reconcile([{ transportIdentity: "runtime", owner: key().owner }])).status).toBe("committed")
    expect(await blobs.read("orphan")).toEqual({ ok: false, error: { code: "missing-blob" } })
  })

  test("moves root and synthetic occurrences while removing an unrelated root occurrence", async () => {
    const blobs = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    const coordinator = createInputDraftDurabilityCoordinator(blobs, metadata().coordinator)
    await coordinator.seed(null)
    const source = record(1, "source", [attachment("root", "root")], [{ partID: "part", text: "synthetic", attachments: [attachment("synthetic", "synthetic", "part")] }])
    await commit(coordinator, source)
    const destination = record(1, "destination", [attachment("root", "root")], [{ partID: "part", text: "synthetic", attachments: [attachment("synthetic", "synthetic", "part")] }])
    expect((await coordinator.commit({ drafts: { [draftKeyString(destination.key)]: destination }, delete: [source.key], isCurrent: () => true })).status).toBe("committed")
    const trimmed = { ...destination, revision: 2, attachments: [] }
    expect((await commit(coordinator, trimmed)).status).toBe("committed")
    expect((await blobs.read("root")).ok).toBe(false)
    expect((await blobs.read("synthetic")).ok).toBe(true)
  })

  test("seeds durable metadata and reconciles an owner with no remaining draft", async () => {
    const blobs = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    const coordinator = createInputDraftDurabilityCoordinator(blobs, metadata().coordinator)
    const seeded = record(1, "seeded", [attachment("a", "blob-a")])
    await coordinator.seed(snapshot([seeded]))
    await blobs.put("orphan", "https://example.test/orphan")
    const owner = { transportIdentity: "runtime", owner: key("gone").owner, attachmentOccurrenceRefID: draftRootAttachmentOccurrenceRefID("orphan") }
    await blobs.retain(owner, "orphan")
    expect((await coordinator.reconcile([{ transportIdentity: "runtime", owner: owner.owner }])).status).toBe("committed")
    expect(await blobs.read("orphan")).toEqual({ ok: false, error: { code: "missing-blob" } })
  })

  test("global seed reconciliation cleans a failed source release from a prior coordinator", async () => {
    const base = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    let failRelease = false
    const failing: InputDraftBlobStore = { ...base, releaseIfMatches: async (reference, blobID) => failRelease ? { ok: false, error: { code: "transaction-failed" } } : base.releaseIfMatches(reference, blobID) }
    const first = createInputDraftDurabilityCoordinator(failing, metadata().coordinator)
    await first.seed(null)
    const source = record(1, "source", [attachment("a", "shared")])
    await commit(first, source)
    const destination = record(1, "destination", [attachment("a", "shared")])
    failRelease = true
    await first.commit({ drafts: { [draftKeyString(destination.key)]: destination }, delete: [source.key], isCurrent: () => true })
    const restored = createInputDraftDurabilityCoordinator(base, metadata().coordinator)
    expect((await restored.seed(snapshot([destination]))).status).toBe("committed")
    expect(await base.readReference({ transportIdentity: "runtime", owner: key("source").owner, attachmentOccurrenceRefID: draftRootAttachmentOccurrenceRefID("a") })).toEqual({ ok: true, value: undefined })
    expect(await base.readReference({ transportIdentity: "runtime", owner: key("destination").owner, attachmentOccurrenceRefID: draftRootAttachmentOccurrenceRefID("a") })).toEqual({ ok: true, value: "shared" })
  })

  test("keeps a cleanup-ledger reference when a later candidate makes it live again", async () => {
    const base = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    let failRelease = false
    const blobs: InputDraftBlobStore = { ...base, releaseIfMatches: async (reference, blobID) => failRelease ? { ok: false, error: { code: "transaction-failed" } } : base.releaseIfMatches(reference, blobID) }
    const coordinator = createInputDraftDurabilityCoordinator(blobs, metadata().coordinator)
    await coordinator.seed(null)
    const value = record(1, "owner", [attachment("a", "blob-a")])
    await commit(coordinator, value)
    failRelease = true
    await coordinator.commit({ delete: [value.key], isCurrent: () => true })
    failRelease = false
    expect((await commit(coordinator, value)).status).toBe("committed")
    expect((await coordinator.retryCleanup()).cleanupErrors).toEqual([])
    expect((await base.read("blob-a")).ok).toBe(true)
  })

  test("closes persistence admission while blob resolution blocks and commits after re-enable", async () => {
    const blobs = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    const writer = metadata()
    const coordinator = createInputDraftDurabilityCoordinator(blobs, writer.coordinator)
    await coordinator.seed(null)
    let resolve!: (value: Blob) => void
    const pending = commit(coordinator, record(1, "owner", [attachment("a", "blob-a")]), { resolveBlobValue: () => new Promise((next) => { resolve = next }) })
    while (!resolve) await new Promise((next) => setTimeout(next, 0))
    const disabled = coordinator.setEnabled(false)
    resolve(new Blob(["a"]))
    expect((await pending).status).toBe("disabled")
    await disabled
    expect(writer.snapshots).toEqual([])
    expect(await blobs.readReference({ transportIdentity: "runtime", owner: key().owner, attachmentOccurrenceRefID: draftRootAttachmentOccurrenceRefID("a") })).toEqual({ ok: true, value: undefined })
    await coordinator.setEnabled(true)
    expect((await commit(coordinator, record(1, "owner", [attachment("a", "blob-a")]))).status).toBe("committed")
  })

  test("keeps disabled commits memory-only and quiesces admitted work", async () => {
    const writer = metadata()
    const coordinator = createInputDraftDurabilityCoordinator(createInputDraftBlobStore(new MemoryInputDraftBlobDriver()), writer.coordinator)
    await coordinator.seed(null)
    await coordinator.setEnabled(false)
    expect((await commit(coordinator, record(1, "owner", [attachment("a", "blob-a")]))).status).toBe("disabled")
    expect(writer.snapshots).toEqual([])
    await coordinator.flush()
  })

  test("rejects conflicting and invalid tombstone candidates before blob or metadata I/O", async () => {
    const base = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    let blobCalls = 0
    const blobs: InputDraftBlobStore = {
      ...base,
      readReference: async (...args) => { blobCalls++; return base.readReference(...args) },
      read: async (...args) => { blobCalls++; return base.read(...args) },
    }
    const writer = metadata()
    const coordinator = createInputDraftDurabilityCoordinator(blobs, writer.coordinator)
    await coordinator.seed(null)
    const value = record(1, "owner", [attachment("a", "blob-a")])
    const id = draftKeyString(value.key)
    expect((await coordinator.commit({ drafts: { [id]: value }, tombstones: { [id]: 2 }, isCurrent: () => true })).status).toBe("failed")
    for (const revision of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect((await coordinator.commit({ tombstones: { [id]: revision }, isCurrent: () => true })).status).toBe("failed")
    }
    expect(blobCalls).toBe(0)
    expect(writer.snapshots).toEqual([])
    expect((await coordinator.commit({ tombstones: { [id]: Number.MAX_SAFE_INTEGER }, isCurrent: () => true })).status).toBe("committed")
  })

  test("rejects invalid migration and legacy candidates before blob or metadata I/O", async () => {
    const base = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
    let blobCalls = 0
    const blobs: InputDraftBlobStore = new Proxy(base, { get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" && property !== "reconcileReferences" ? (...args: unknown[]) => { blobCalls++; return value.apply(target, args) } : value
    } })
    const writer = metadata()
    const coordinator = createInputDraftDurabilityCoordinator(blobs, writer.coordinator)
    await coordinator.seed(null)
    expect((await coordinator.commit({ migration: { complete: true, claimedTransportIdentity: 1 } as never, isCurrent: () => true })).status).toBe("failed")
    expect((await coordinator.commit({ legacy: { entries: { broken: { text: 1 } } } as never, isCurrent: () => true })).status).toBe("failed")
    expect(blobCalls).toBe(0)
    expect(writer.snapshots).toHaveLength(0)
  })

  test("persists a complete delete and tombstone candidate", async () => {
    const writer = metadata()
    const coordinator = createInputDraftDurabilityCoordinator(createInputDraftBlobStore(new MemoryInputDraftBlobDriver()), writer.coordinator)
    await coordinator.seed(null)
    const value = record()
    await commit(coordinator, value)
    const result = await coordinator.commit({ delete: [value.key], tombstones: { [draftKeyString(value.key)]: 2 }, isCurrent: () => true })
    expect(result.status).toBe("committed")
    expect(writer.snapshots.at(-1)?.drafts).toEqual({})
    expect(writer.snapshots.at(-1)?.tombstones).toEqual({ [draftKeyString(value.key)]: 2 })
  })
})
