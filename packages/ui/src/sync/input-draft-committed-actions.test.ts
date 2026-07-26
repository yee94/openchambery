import { describe, expect, test } from "bun:test"
import { createInputDraftBlobStore, MemoryInputDraftBlobDriver } from "./input-draft-blob-store"
import { createInputDraftMetadataPersistenceCoordinator, createInputDraftMetadataStorageSink, type InputDraftMetadataPersistenceCoordinator, type InputDraftMetadataSink } from "./input-draft-metadata-store"
import { draftKeyString, draftRootAttachmentOccurrenceRefID, draftSyntheticPartAttachmentOccurrenceRefID, newSessionDraftKey, sessionDraftKey, type DraftKey } from "./input-draft-types"
import { createInputStore } from "./input-store"

class TestFileReader {
  result: string | ArrayBuffer | null = "data:text/plain;base64,eA=="
  onload: ((event: ProgressEvent<FileReader>) => unknown) | null = null
  onerror: ((event: ProgressEvent<FileReader>) => unknown) | null = null
  onabort: ((event: ProgressEvent<FileReader>) => unknown) | null = null
  readAsDataURL() { queueMicrotask(() => this.onload?.({} as ProgressEvent<FileReader>)) }
}

globalThis.FileReader = TestFileReader as unknown as typeof FileReader

class MemoryStorage {
  values = new Map<string, string>()
  get length() { return this.values.size }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

const snapshot = (text = "draft") => ({ text, attachments: [], syntheticParts: [], mentions: [] })
const setup = async () => {
  let runtime = { transportIdentity: "runtime", generation: 1 }
  const blobs = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
  const store = createInputStore({ sink: createInputDraftMetadataStorageSink(new MemoryStorage() as unknown as Storage), blobStore: blobs, runtimeCapture: () => runtime })
  await store.getState().hydrateDraftMetadata("runtime")
  return { store, blobs, runtime: () => runtime, setRuntime: (next: typeof runtime) => { runtime = next } }
}

const deferredSetup = async () => {
  let runtime = { transportIdentity: "runtime", generation: 1 }
  const storage = new MemoryStorage()
  let release!: () => void
  let blocked = false
  let writes = 0
  let notifyWrite!: () => void
  let wrote = new Promise<void>((resolve) => { notifyWrite = resolve })
  const sink: InputDraftMetadataSink = {
    read: async (key) => ({ ok: true as const, value: storage.getItem(key) }),
    write: async (key, value) => {
      writes++
      notifyWrite()
      if (blocked) await new Promise<void>((resolve) => { release = resolve })
      storage.setItem(key, value)
      return { ok: true as const, value: undefined }
    },
    remove: async (key) => { storage.removeItem(key); return { ok: true as const, value: undefined } },
    keys: async () => ({ ok: true as const, value: [...storage.values.keys()] }),
  }
  const baseBlobs = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
  let blobCalls = 0
  const blobs = new Proxy(baseBlobs, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver)
    return typeof value === "function" ? (...args: unknown[]) => { blobCalls++; return value.apply(target, args) } : value
  } })
  const store = createInputStore({ sink, coordinator: createInputDraftMetadataPersistenceCoordinator(sink), blobStore: blobs, runtimeCapture: () => runtime })
  await store.getState().hydrateDraftMetadata("runtime")
  writes = 0
  blobCalls = 0
  wrote = new Promise<void>((resolve) => { notifyWrite = resolve })
  return { store, blobs, block: () => { blocked = true }, release: () => { blocked = false; release?.() }, resetWrite: () => { wrote = new Promise<void>((resolve) => { notifyWrite = resolve }) }, waitForWrite: () => wrote, writes: () => writes, blobCalls: () => blobCalls, setRuntime: (next: typeof runtime) => { runtime = next } }
}

describe("input draft committed actions", () => {
  test("commits absent and numeric CAS snapshots while preserving untouched references", async () => {
    const { store } = await setup()
    const first = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    const other = sessionDraftKey({ transportIdentity: "runtime" }, "other")
    store.getState().setDraftText(other, "other")
    const untouched = store.getState().getDraft(other)
    const created = await store.getState().commitDraftSnapshot({ key: first, expectedRevision: "absent", snapshot: snapshot(), runtime: store.getState().captureDraftRuntime() })
    expect(created.status).toBe("committed")
    expect(created.record?.revision).toBe(1)
    expect((await store.getState().commitDraftSnapshot({ key: first, expectedRevision: "absent", snapshot: snapshot(), runtime: store.getState().captureDraftRuntime() })).status).toBe("conflict")
    expect((await store.getState().commitDraftSnapshot({ key: first, expectedRevision: 1, snapshot: snapshot("next"), runtime: store.getState().captureDraftRuntime() })).record?.revision).toBe(2)
    expect(store.getState().getDraft(other)).toBe(untouched)
  })

  test("retains supplied blob IDs and builds mixed URL and Blob views", async () => {
    const { store, blobs } = await setup()
    const key = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    const rootID = draftRootAttachmentOccurrenceRefID("blob")
    const urlID = draftRootAttachmentOccurrenceRefID("url")
    const result = await store.getState().commitDraftSnapshot({
      key, expectedRevision: "absent", runtime: store.getState().captureDraftRuntime(),
      snapshot: { text: "", mentions: [], syntheticParts: [], attachments: [
        { attachmentID: "blob", attachmentRefID: rootID, filename: "blob.txt", mimeType: "text/plain", size: 4, locator: { kind: "blob", blobID: "existing" }, source: "local" },
        { attachmentID: "url", attachmentRefID: urlID, filename: "url.txt", mimeType: "text/plain", size: 1, locator: { kind: "url", url: "https://example.test/url" }, source: "server", serverPath: "/url" },
      ] },
      values: new Map<string, Blob | string>([[rootID, new Blob(["blob"], { type: "text/plain" })], [urlID, "https://example.test/url"]]),
    })
    expect(result.status).toBe("committed")
    expect((await blobs.read("existing")).ok).toBe(true)
    expect(store.getState().getDraftAttachmentViews(key).map((view) => view.filename)).toEqual(["blob.txt", "url.txt"])
  })

  test("preserves existing attachment views when a later snapshot changes only metadata", async () => {
    const { store } = await setup()
    const key = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    const attachmentRefID = draftRootAttachmentOccurrenceRefID("shared")
    const attachment = { attachmentID: "shared", attachmentRefID, filename: "shared.png", mimeType: "image/png", size: 3, locator: { kind: "blob" as const, blobID: "shared" }, source: "local" as const }
    const created = await store.getState().commitDraftSnapshot({
      key,
      expectedRevision: "absent",
      runtime: store.getState().captureDraftRuntime(),
      snapshot: { text: "shared", attachments: [attachment], syntheticParts: [{ partID: "receipt", text: "", attachments: [], synthetic: true }], mentions: [] },
      values: new Map([[attachmentRefID, new Blob(["img"], { type: "image/png" })]]),
    })
    const cleared = await store.getState().commitDraftSnapshot({
      key,
      expectedRevision: created.record!.revision,
      runtime: store.getState().captureDraftRuntime(),
      snapshot: { text: "shared", attachments: [attachment], syntheticParts: [], mentions: [] },
      values: new Map(),
    })
    expect(cleared.status).toBe("committed")
    expect(store.getState().getDraftAttachmentViews(key).map((view) => view.filename)).toEqual(["shared.png"])
  })

  test("root replace preserves hydrated synthetic durable URL metadata and views", async () => {
    const { store } = await setup()
    const key = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    const syntheticRef = draftSyntheticPartAttachmentOccurrenceRefID("part", "syn-url")
    const durableUrl = "https://example.test/synthetic-durable"
    const syntheticAttachment = {
      attachmentID: "syn-url",
      attachmentRefID: syntheticRef,
      filename: "syn.txt",
      mimeType: "text/plain",
      size: 1,
      locator: { kind: "url" as const, url: durableUrl },
      source: "server" as const,
      serverPath: "/syn.txt",
    }
    const created = await store.getState().commitDraftSnapshot({
      key,
      expectedRevision: "absent",
      runtime: store.getState().captureDraftRuntime(),
      snapshot: {
        text: "with-syn",
        attachments: [],
        syntheticParts: [{ partID: "part", text: "ctx", attachments: [syntheticAttachment], synthetic: true }],
        mentions: [],
      },
      values: new Map([[syntheticRef, durableUrl]]),
    })
    expect(created.status).toBe("committed")
    const id = draftKeyString(key)
    // Simulate a bad existing view.file placeholder that must not override locator.url.
    store.setState((state) => ({
      draftAttachmentViews: {
        ...state.draftAttachmentViews,
        [id]: {
          ...state.draftAttachmentViews[id],
          [syntheticRef]: {
            id: "syn-url",
            file: new File(["placeholder"], "syn.txt", { type: "text/plain" }),
            dataUrl: "data:text/plain;base64,eA==",
            mimeType: "text/plain",
            filename: "syn.txt",
            size: 1,
            source: "server",
            serverPath: "/syn.txt",
          },
        },
      },
    }))
    const replaced = await store.getState().replaceDraftRootAttachments(key, [])
    expect(replaced.status).toBe("committed")
    const draft = store.getState().getDraft(key)
    expect(draft?.syntheticParts[0]?.attachments[0]?.locator).toEqual({ kind: "url", url: durableUrl })
    const view = store.getState().draftAttachmentViews[id]?.[syntheticRef]
    expect(view?.dataUrl).toBe(durableUrl)
    expect(view?.filename).toBe("syn.txt")
  })

  test("moves preserve and consume ownership through durable destination commits", async () => {
    const { store } = await setup()
    const source = newSessionDraftKey({ transportIdentity: "runtime" }, "new")
    const destination = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    const created = await store.getState().commitDraftSnapshot({ key: source, expectedRevision: "absent", snapshot: snapshot("preserve"), runtime: store.getState().captureDraftRuntime() })
    const preserved = await store.getState().finalizeDraftOwnership({ source, destination, expectedSourceRevision: created.record!.revision, disposition: "preserve", runtime: store.getState().captureDraftRuntime() })
    expect(preserved.status).toBe("committed")
    expect(store.getState().getDraft(destination)?.text).toBe("preserve")
    expect(store.getState().tombstones[draftKeyString(source)]).toBeGreaterThan(0)
    const second = newSessionDraftKey({ transportIdentity: "runtime" }, "new-2")
    const target = sessionDraftKey({ transportIdentity: "runtime" }, "session-2")
    const secondCreated = await store.getState().commitDraftSnapshot({ key: second, expectedRevision: "absent", snapshot: snapshot("sent"), runtime: store.getState().captureDraftRuntime() })
    const consumed = await store.getState().finalizeDraftOwnership({ source: second, destination: target, expectedSourceRevision: secondCreated.record!.revision, disposition: "consume", runtime: store.getState().captureDraftRuntime() })
    expect(consumed.status).toBe("committed")
    expect(store.getState().getDraft(target)?.text).toBe("")
  })

  test("returns conflicts for destination collisions and source revisions", async () => {
    const { store } = await setup()
    const source = newSessionDraftKey({ transportIdentity: "runtime" }, "new")
    const destination = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    const created = await store.getState().commitDraftSnapshot({ key: source, expectedRevision: "absent", snapshot: snapshot(), runtime: store.getState().captureDraftRuntime() })
    await store.getState().commitDraftSnapshot({ key: destination, expectedRevision: "absent", snapshot: snapshot(), runtime: store.getState().captureDraftRuntime() })
    expect((await store.getState().finalizeDraftOwnership({ source, destination, expectedSourceRevision: created.record!.revision, disposition: "preserve", runtime: store.getState().captureDraftRuntime() })).status).toBe("conflict")
    const cleanDestination: DraftKey = sessionDraftKey({ transportIdentity: "runtime" }, "clean")
    expect((await store.getState().finalizeDraftOwnership({ source, destination: cleanDestination, expectedSourceRevision: 99, disposition: "preserve", runtime: store.getState().captureDraftRuntime() })).status).toBe("conflict")
  })

  test("detaches committed, conflict, and ownership result records from store state", async () => {
    const { store } = await setup()
    const source = newSessionDraftKey({ transportIdentity: "runtime" }, "new")
    const destination = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    const committed = await store.getState().commitDraftSnapshot({ key: source, expectedRevision: "absent", snapshot: snapshot("original"), runtime: store.getState().captureDraftRuntime() })
    committed.record!.text = "mutated"
    expect(store.getState().getDraft(source)?.text).toBe("original")
    const conflict = await store.getState().commitDraftSnapshot({ key: source, expectedRevision: "absent", snapshot: snapshot(), runtime: store.getState().captureDraftRuntime() })
    conflict.record!.text = "mutated-conflict"
    expect(store.getState().getDraft(source)?.text).toBe("original")
    const ownership = await store.getState().finalizeDraftOwnership({ source, destination, expectedSourceRevision: 1, disposition: "preserve", runtime: store.getState().captureDraftRuntime() })
    ownership.source!.text = "mutated-source"
    ownership.destination!.text = "mutated-destination"
    expect(store.getState().getDraft(destination)?.text).toBe("original")
  })

  test("adopts a durable commit after metadata switches runtime and clears ephemeral state in one publication", async () => {
    const { store, block, release, resetWrite, waitForWrite, setRuntime } = await deferredSetup()
    const key = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    resetWrite()
    block()
    let publications = 0
    const unsubscribe = store.subscribe(() => { publications++ })
    const pending = store.getState().commitDraftSnapshot({ key, expectedRevision: "absent", snapshot: snapshot(), runtime: store.getState().captureDraftRuntime() })
    await waitForWrite()
    setRuntime({ transportIdentity: "next", generation: 2 })
    release()
    const result = await pending
    unsubscribe()
    expect({ status: result.status, current: result.current, durable: result.durable }).toEqual({ status: "stale", current: false, durable: true })
    expect(store.getState().getDraft(key)?.text).toBe("draft")
    expect(store.getState().draftAttachmentViews[draftKeyString(key)]).toBe(undefined)
    expect(store.getState().draftPersistence[draftKeyString(key)]).toBe(undefined)
    expect(publications).toBe(1)
  })

  test("keeps a newer text epoch when metadata completes an older commit", async () => {
    const { store, block, release, resetWrite, waitForWrite } = await deferredSetup()
    const key = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    resetWrite()
    block()
    const pending = store.getState().commitDraftSnapshot({ key, expectedRevision: "absent", snapshot: snapshot("old"), runtime: store.getState().captureDraftRuntime() })
    await waitForWrite()
    store.getState().setDraftText(key, "new")
    release()
    const result = await pending
    expect({ status: result.status, durable: result.durable, current: result.current }).toEqual({ status: "stale", durable: true, current: false })
    expect(store.getState().getDraft(key)?.text).toBe("new")
    await store.getState().flushDraftPersistence()
    expect(store.getState().draftPersistence[draftKeyString(key)]?.status).toBe("saved")
  })

  test("rejects a runtime switch before blob materialization without metadata writes", async () => {
    const { store, blobs, setRuntime, writes } = await deferredSetup()
    const key = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    const ref = draftRootAttachmentOccurrenceRefID("blob")
    setRuntime({ transportIdentity: "next", generation: 2 })
    const result = await store.getState().commitDraftSnapshot({ key, expectedRevision: "absent", snapshot: { ...snapshot(), attachments: [{ attachmentID: "blob", attachmentRefID: ref, filename: "a", mimeType: "text/plain", size: 1, locator: { kind: "blob", blobID: "blob" }, source: "local" }] }, values: new Map([[ref, new Blob(["a"])]]), runtime: { transportIdentity: "runtime", generation: 1 } })
    expect({ status: result.status, durable: result.durable }).toEqual({ status: "stale", durable: false })
    expect(writes()).toBe(0)
    expect(await blobs.read("blob")).toEqual({ ok: false, error: { code: "missing-blob" } })
  })

  test("rejects a queued blob snapshot after a runtime switch before blob or metadata admission", async () => {
    const { store, block, release, resetWrite, waitForWrite, writes, blobCalls, setRuntime } = await deferredSetup()
    const first = sessionDraftKey({ transportIdentity: "runtime" }, "first")
    const second = sessionDraftKey({ transportIdentity: "runtime" }, "second")
    const ref = draftRootAttachmentOccurrenceRefID("blob")
    resetWrite()
    block()
    const occupied = store.getState().commitDraftSnapshot({ key: first, expectedRevision: "absent", snapshot: snapshot("first"), runtime: store.getState().captureDraftRuntime() })
    await waitForWrite()
    const queued = store.getState().commitDraftSnapshot({
      key: second, expectedRevision: "absent", runtime: store.getState().captureDraftRuntime(),
      snapshot: { ...snapshot("second"), attachments: [{ attachmentID: "blob", attachmentRefID: ref, filename: "blob.txt", mimeType: "text/plain", size: 1, locator: { kind: "blob", blobID: "blob" }, source: "local" }] },
      values: new Map([[ref, new Blob(["blob"])]]),
    })
    setRuntime({ transportIdentity: "next", generation: 2 })
    release()
    await occupied
    const result = await queued
    expect({ status: result.status, durable: result.durable, current: result.current }).toEqual({ status: "stale", durable: false, current: false })
    expect(writes()).toBe(1)
    expect(blobCalls()).toBe(0)
  })

  test("preserve ownership tombstones the source and clears source ephemeral state", async () => {
    const { store } = await setup()
    const source = newSessionDraftKey({ transportIdentity: "runtime" }, "new")
    const destination = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    const created = await store.getState().commitDraftSnapshot({ key: source, expectedRevision: "absent", snapshot: snapshot("keep"), runtime: store.getState().captureDraftRuntime() })
    const result = await store.getState().finalizeDraftOwnership({ source, destination, expectedSourceRevision: created.record!.revision, disposition: "preserve", runtime: store.getState().captureDraftRuntime() })
    expect({ status: result.status, current: result.current, durable: result.durable }).toEqual({ status: "committed", current: true, durable: true })
    expect(store.getState().getDraft(source)).toBe(undefined)
    expect(store.getState().tombstones[draftKeyString(source)]).toBeGreaterThan(0)
    expect(store.getState().getDraft(destination)?.text).toBe("keep")
  })

  test("consume ownership creates an empty destination record", async () => {
    const { store } = await setup()
    const source = newSessionDraftKey({ transportIdentity: "runtime" }, "new")
    const destination = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    const created = await store.getState().commitDraftSnapshot({ key: source, expectedRevision: "absent", snapshot: snapshot("sent"), runtime: store.getState().captureDraftRuntime() })
    await store.getState().finalizeDraftOwnership({ source, destination, expectedSourceRevision: created.record!.revision, disposition: "consume", runtime: store.getState().captureDraftRuntime() })
    expect(store.getState().getDraft(destination)?.text).toBe("")
  })

  for (const value of ["http://example.test/blob", "https://example.test/blob", "file:///tmp/blob"]) test(`accepts durable ${value} blob values`, async () => {
    const { store } = await setup()
    const key = sessionDraftKey({ transportIdentity: "runtime" }, value)
    const ref = draftRootAttachmentOccurrenceRefID("blob")
    const result = await store.getState().commitDraftSnapshot({ key, expectedRevision: "absent", snapshot: { ...snapshot(), attachments: [{ attachmentID: "blob", attachmentRefID: ref, filename: "a", mimeType: "text/plain", size: 1, locator: { kind: "blob", blobID: "blob" }, source: "local" }] }, values: new Map([[ref, value]]), runtime: store.getState().captureDraftRuntime() })
    expect(result.status).toBe("committed")
  })

  for (const value of ["data:text/plain,x", "blob:https://example.test/id", "javascript:alert(1)"]) test(`rejects unsafe ${value} blob values`, async () => {
    const { store } = await setup()
    const key = sessionDraftKey({ transportIdentity: "runtime" }, value)
    const ref = draftRootAttachmentOccurrenceRefID("blob")
    const result = await store.getState().commitDraftSnapshot({ key, expectedRevision: "absent", snapshot: { ...snapshot(), attachments: [{ attachmentID: "blob", attachmentRefID: ref, filename: "a", mimeType: "text/plain", size: 1, locator: { kind: "blob", blobID: "blob" }, source: "local" }] }, values: new Map([[ref, value]]), runtime: store.getState().captureDraftRuntime() })
    expect(result.status).toBe("failed")
  })

  test("rejects a URL locator whose supplied value differs from its durable locator", async () => {
    const { store } = await setup()
    const key = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    const ref = draftRootAttachmentOccurrenceRefID("url")
    const result = await store.getState().commitDraftSnapshot({ key, expectedRevision: "absent", snapshot: { ...snapshot(), attachments: [{ attachmentID: "url", attachmentRefID: ref, filename: "a", mimeType: "text/plain", size: 1, locator: { kind: "url", url: "https://example.test/a" }, source: "server", serverPath: "/a" }] }, values: new Map([[ref, "https://example.test/b"]]), runtime: store.getState().captureDraftRuntime() })
    expect(result.status).toBe("failed")
  })

  test("returns fixed ownership source and destination result fields", async () => {
    const { store } = await setup()
    const source = newSessionDraftKey({ transportIdentity: "runtime" }, "new")
    const destination = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    const created = await store.getState().commitDraftSnapshot({ key: source, expectedRevision: "absent", snapshot: snapshot(), runtime: store.getState().captureDraftRuntime() })
    const result = await store.getState().finalizeDraftOwnership({ source, destination, expectedSourceRevision: created.record!.revision, disposition: "preserve", runtime: store.getState().captureDraftRuntime() })
    expect("record" in result).toBe(false)
    expect(result.source?.key).toEqual(source)
    expect(result.destination?.key).toEqual(destination)
  })

  test("returns ownership snapshots without record across conflict, failure, and runtime stale outcomes", async () => {
    const { store, setRuntime } = await setup()
    const source = newSessionDraftKey({ transportIdentity: "runtime" }, "new")
    const destination = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    const created = await store.getState().commitDraftSnapshot({ key: source, expectedRevision: "absent", snapshot: snapshot("source"), runtime: store.getState().captureDraftRuntime() })
    const failed = await store.getState().finalizeDraftOwnership({ source, destination, expectedSourceRevision: 0, disposition: "preserve", runtime: store.getState().captureDraftRuntime() })
    const conflict = await store.getState().finalizeDraftOwnership({ source, destination, expectedSourceRevision: created.record!.revision + 1, disposition: "preserve", runtime: store.getState().captureDraftRuntime() })
    setRuntime({ transportIdentity: "next", generation: 2 })
    const stale = await store.getState().finalizeDraftOwnership({ source, destination, expectedSourceRevision: created.record!.revision, disposition: "preserve", runtime: { transportIdentity: "runtime", generation: 1 } })
    for (const result of [failed, conflict, stale]) expect("record" in result).toBe(false)
    expect(failed.source?.text).toBe("source")
    expect(conflict.source?.text).toBe("source")
    expect(stale.source?.text).toBe("source")
    expect(stale.destination).toBe(undefined)
  })

  test("reports stale ownership after metadata persistence observes a runtime switch", async () => {
    let runtime = { transportIdentity: "runtime", generation: 1 }
    let switchAfterPersist = false
    const sink = createInputDraftMetadataStorageSink(new MemoryStorage() as unknown as Storage)
    const base = createInputDraftMetadataPersistenceCoordinator(sink)
    const coordinator: InputDraftMetadataPersistenceCoordinator = {
      ...base,
      persist: async (value) => {
        const result = await base.persist(value)
        if (switchAfterPersist) runtime = { transportIdentity: "next", generation: 2 }
        return result
      },
    }
    const store = createInputStore({ sink, coordinator, blobStore: createInputDraftBlobStore(new MemoryInputDraftBlobDriver()), runtimeCapture: () => runtime })
    await store.getState().hydrateDraftMetadata("runtime")
    const source = newSessionDraftKey({ transportIdentity: "runtime" }, "new")
    const destination = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    const created = await store.getState().commitDraftSnapshot({ key: source, expectedRevision: "absent", snapshot: snapshot("source"), runtime: store.getState().captureDraftRuntime() })
    switchAfterPersist = true
    const result = await store.getState().finalizeDraftOwnership({ source, destination, expectedSourceRevision: created.record!.revision, disposition: "preserve", runtime: store.getState().captureDraftRuntime() })
    expect({ status: result.status, current: result.current, durable: result.durable }).toEqual({ status: "stale", current: false, durable: true })
    expect("record" in result).toBe(false)
    expect(result.source?.text).toBe("source")
    expect(result.destination?.text).toBe("source")
  })

  test("adopts source and destination ownership keys independently after a source epoch changes", async () => {
    const { store, block, release, resetWrite, waitForWrite } = await deferredSetup()
    const source = newSessionDraftKey({ transportIdentity: "runtime" }, "new")
    const destination = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    const created = await store.getState().commitDraftSnapshot({ key: source, expectedRevision: "absent", snapshot: snapshot("source"), runtime: store.getState().captureDraftRuntime() })
    resetWrite()
    block()
    const pending = store.getState().finalizeDraftOwnership({ source, destination, expectedSourceRevision: created.record!.revision, disposition: "preserve", runtime: store.getState().captureDraftRuntime() })
    await waitForWrite()
    store.getState().setDraftText(source, "newer source")
    release()
    const result = await pending
    expect({ status: result.status, current: result.current, durable: result.durable }).toEqual({ status: "stale", current: false, durable: true })
    expect(store.getState().getDraft(source)?.text).toBe("newer source")
    expect(store.getState().getDraft(destination)?.text).toBe("source")
    result.source!.text = "mutated result"
    result.destination!.text = "mutated destination"
    expect(store.getState().getDraft(source)?.text).toBe("newer source")
    expect(store.getState().getDraft(destination)?.text).toBe("source")
  })

  test("clears all snapshot ephemeral state after simultaneous memory and runtime staleness in one completion publication", async () => {
    const { store, block, release, resetWrite, waitForWrite, setRuntime } = await deferredSetup()
    const key = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    resetWrite()
    block()
    const pending = store.getState().commitDraftSnapshot({ key, expectedRevision: "absent", snapshot: snapshot("durable"), runtime: store.getState().captureDraftRuntime() })
    await waitForWrite()
    store.getState().setDraftText(key, "newer")
    const id = draftKeyString(key)
    store.setState({
      draftAttachmentViews: { [id]: {} }, draftMissingAttachmentRefIDs: { [id]: ["missing"] }, draftHydration: { [id]: "ready" },
      draftPersistence: { [id]: { status: "saved", revision: 2 } }, draftAttachmentPersistence: { [id]: { status: "saved", revision: 2 } },
    })
    let publications = 0
    const unsubscribe = store.subscribe(() => { publications++ })
    setRuntime({ transportIdentity: "next", generation: 2 })
    release()
    const result = await pending
    unsubscribe()
    expect({ status: result.status, current: result.current, durable: result.durable }).toEqual({ status: "stale", current: false, durable: true })
    expect(store.getState().getDraft(key)?.text).toBe("newer")
    expect(store.getState().tombstones[id]).toBe(undefined)
    expect(store.getState().draftAttachmentViews[id]).toBe(undefined)
    expect(store.getState().draftMissingAttachmentRefIDs[id]).toBe(undefined)
    expect(store.getState().draftHydration[id]).toBe(undefined)
    expect(store.getState().draftPersistence[id]).toBe(undefined)
    expect(store.getState().draftAttachmentPersistence[id]).toBe(undefined)
    expect(publications).toBe(1)
  })

  test("clears both ownership ephemeral maps while preserving newer source and destination epochs", async () => {
    const { store, block, release, resetWrite, waitForWrite, setRuntime } = await deferredSetup()
    const source = newSessionDraftKey({ transportIdentity: "runtime" }, "new")
    const destination = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    const created = await store.getState().commitDraftSnapshot({ key: source, expectedRevision: "absent", snapshot: snapshot("source"), runtime: store.getState().captureDraftRuntime() })
    resetWrite()
    block()
    const pending = store.getState().finalizeDraftOwnership({ source, destination, expectedSourceRevision: created.record!.revision, disposition: "preserve", runtime: store.getState().captureDraftRuntime() })
    await waitForWrite()
    store.getState().setDraftText(source, "newer source")
    store.getState().setDraftText(destination, "newer destination")
    const sourceID = draftKeyString(source)
    const destinationID = draftKeyString(destination)
    store.setState({
      draftAttachmentViews: { [sourceID]: {}, [destinationID]: {} }, draftMissingAttachmentRefIDs: { [sourceID]: ["source"], [destinationID]: ["destination"] },
      draftHydration: { [sourceID]: "ready", [destinationID]: "ready" }, draftPersistence: { [sourceID]: { status: "saved", revision: 2 }, [destinationID]: { status: "saved", revision: 2 } },
      draftAttachmentPersistence: { [sourceID]: { status: "saved", revision: 2 }, [destinationID]: { status: "saved", revision: 2 } },
    })
    let publications = 0
    const unsubscribe = store.subscribe(() => { publications++ })
    setRuntime({ transportIdentity: "next", generation: 2 })
    release()
    const result = await pending
    unsubscribe()
    expect({ status: result.status, current: result.current, durable: result.durable }).toEqual({ status: "stale", current: false, durable: true })
    expect(store.getState().getDraft(source)?.text).toBe("newer source")
    expect(store.getState().getDraft(destination)?.text).toBe("newer destination")
    for (const values of [store.getState().draftAttachmentViews, store.getState().draftMissingAttachmentRefIDs, store.getState().draftHydration, store.getState().draftPersistence, store.getState().draftAttachmentPersistence]) {
      expect(values[sourceID]).toBe(undefined)
      expect(values[destinationID]).toBe(undefined)
    }
    expect(publications).toBe(1)
  })

  test("keeps newer ownership epochs and their ephemeral state after a current runtime completion", async () => {
    const { store, block, release, resetWrite, waitForWrite } = await deferredSetup()
    const source = newSessionDraftKey({ transportIdentity: "runtime" }, "new")
    const destination = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    const created = await store.getState().commitDraftSnapshot({ key: source, expectedRevision: "absent", snapshot: snapshot("source"), runtime: store.getState().captureDraftRuntime() })
    resetWrite()
    block()
    const pending = store.getState().finalizeDraftOwnership({ source, destination, expectedSourceRevision: created.record!.revision, disposition: "preserve", runtime: store.getState().captureDraftRuntime() })
    await waitForWrite()
    store.getState().setDraftText(source, "newer source")
    store.getState().setDraftText(destination, "newer destination")
    const sourceID = draftKeyString(source)
    const destinationID = draftKeyString(destination)
    const draftAttachmentViews = { [sourceID]: {}, [destinationID]: {} }
    const draftMissingAttachmentRefIDs = { [sourceID]: ["source"], [destinationID]: ["destination"] }
    const draftHydration = { [sourceID]: "ready" as const, [destinationID]: "ready" as const }
    const draftPersistence = { [sourceID]: { status: "saved" as const, revision: 2 }, [destinationID]: { status: "saved" as const, revision: 2 } }
    const draftAttachmentPersistence = { [sourceID]: { status: "saved" as const, revision: 2 }, [destinationID]: { status: "saved" as const, revision: 2 } }
    store.setState({ draftAttachmentViews, draftMissingAttachmentRefIDs, draftHydration, draftPersistence, draftAttachmentPersistence })
    let publications = 0
    const unsubscribe = store.subscribe(() => { publications++ })
    release()
    const result = await pending
    unsubscribe()
    expect({ status: result.status, current: result.current, durable: result.durable }).toEqual({ status: "stale", current: false, durable: true })
    expect(store.getState().getDraft(source)?.text).toBe("newer source")
    expect(store.getState().getDraft(destination)?.text).toBe("newer destination")
    expect(store.getState().draftAttachmentViews).toBe(draftAttachmentViews)
    expect(store.getState().draftMissingAttachmentRefIDs).toBe(draftMissingAttachmentRefIDs)
    expect(store.getState().draftHydration).toBe(draftHydration)
    expect(store.getState().draftPersistence).toBe(draftPersistence)
    expect(store.getState().draftAttachmentPersistence).toBe(draftAttachmentPersistence)
    expect(publications).toBe(0)
  })

  test("adopts the durable source tombstone while retaining a newer destination epoch after runtime staleness", async () => {
    const { store, block, release, resetWrite, waitForWrite, setRuntime } = await deferredSetup()
    const source = newSessionDraftKey({ transportIdentity: "runtime" }, "new")
    const destination = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    const created = await store.getState().commitDraftSnapshot({ key: source, expectedRevision: "absent", snapshot: snapshot("source"), runtime: store.getState().captureDraftRuntime() })
    resetWrite()
    block()
    const pending = store.getState().finalizeDraftOwnership({ source, destination, expectedSourceRevision: created.record!.revision, disposition: "preserve", runtime: store.getState().captureDraftRuntime() })
    await waitForWrite()
    store.getState().setDraftText(destination, "newer destination")
    let publications = 0
    const unsubscribe = store.subscribe(() => { publications++ })
    setRuntime({ transportIdentity: "next", generation: 2 })
    release()
    const result = await pending
    unsubscribe()
    expect({ status: result.status, current: result.current, durable: result.durable }).toEqual({ status: "stale", current: false, durable: true })
    expect(store.getState().getDraft(source)).toBe(undefined)
    expect(store.getState().tombstones[draftKeyString(source)]).toBeGreaterThan(0)
    expect(store.getState().getDraft(destination)?.text).toBe("newer destination")
    expect(publications).toBe(1)
  })

  test("uses explicit state injection to isolate MAX_SAFE_INTEGER delete overflow from durability I/O", async () => {
    const { store, writes, blobCalls } = await deferredSetup()
    const key = sessionDraftKey({ transportIdentity: "runtime" }, "maximum")
    const id = draftKeyString(key)
    const record = { version: 1 as const, key, revision: Number.MAX_SAFE_INTEGER, text: "maximum", attachments: [], syntheticParts: [], mentions: [] }
    store.setState({
      drafts: { [id]: record }, tombstones: { [id]: 1 }, draftAttachmentViews: { [id]: {} }, draftMissingAttachmentRefIDs: { [id]: ["missing"] },
      draftHydration: { [id]: "ready" }, draftPersistence: { [id]: { status: "saved", revision: Number.MAX_SAFE_INTEGER } },
      draftAttachmentPersistence: { [id]: { status: "saved", revision: Number.MAX_SAFE_INTEGER } },
    })
    expect(store.getState().deleteDraft(key)).toBe(false)
    expect(store.getState().drafts[id]).toBe(record)
    expect(store.getState().tombstones[id]).toBe(1)
    expect(store.getState().draftAttachmentViews[id]).toEqual({})
    expect(store.getState().draftMissingAttachmentRefIDs[id]).toEqual(["missing"])
    expect(store.getState().draftHydration[id]).toBe("ready")
    expect(store.getState().draftPersistence[id]?.revision).toBe(Number.MAX_SAFE_INTEGER)
    expect(store.getState().draftAttachmentPersistence[id]?.revision).toBe(Number.MAX_SAFE_INTEGER)
    expect(writes()).toBe(0)
    expect(blobCalls()).toBe(0)
  })

  test("deleteDraftSnapshot commits durable absence and clears attachment ephemeral state", async () => {
    const { store, blobs } = await setup()
    const key = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    const ref = draftRootAttachmentOccurrenceRefID("blob")
    const created = await store.getState().commitDraftSnapshot({
      key,
      expectedRevision: "absent",
      runtime: store.getState().captureDraftRuntime(),
      snapshot: {
        text: "gone",
        mentions: [],
        syntheticParts: [],
        attachments: [{ attachmentID: "blob", attachmentRefID: ref, filename: "a.txt", mimeType: "text/plain", size: 1, locator: { kind: "blob", blobID: "blob" }, source: "local" }],
      },
      values: new Map([[ref, new Blob(["a"])]]),
    })
    expect(created.status).toBe("committed")
    expect(store.getState().getDraftAttachmentViews(key)).toHaveLength(1)
    const deleted = await store.getState().deleteDraftSnapshot({
      key,
      expectedRevision: created.record!.revision,
      runtime: store.getState().captureDraftRuntime(),
    })
    expect({ status: deleted.status, current: deleted.current, durable: deleted.durable }).toEqual({ status: "committed", current: true, durable: true })
    expect("record" in deleted && deleted.record).toBeFalsy()
    expect(store.getState().getDraft(key)).toBe(undefined)
    expect(store.getState().tombstones[draftKeyString(key)]).toBe(created.record!.revision + 1)
    expect(store.getState().draftAttachmentViews[draftKeyString(key)]).toBe(undefined)
    expect(store.getState().draftMissingAttachmentRefIDs[draftKeyString(key)]).toBe(undefined)
    expect(store.getState().draftHydration[draftKeyString(key)]).toBe(undefined)
    expect(store.getState().draftPersistence[draftKeyString(key)]).toBe(undefined)
    expect(store.getState().draftAttachmentPersistence[draftKeyString(key)]).toBe(undefined)
    expect((await blobs.read("blob")).ok).toBe(false)
  })

  test("deleteDraftSnapshot returns revision conflict and runtime stale without mutating", async () => {
    const { store, setRuntime } = await setup()
    const key = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    const created = await store.getState().commitDraftSnapshot({ key, expectedRevision: "absent", snapshot: snapshot("keep"), runtime: store.getState().captureDraftRuntime() })
    const conflict = await store.getState().deleteDraftSnapshot({ key, expectedRevision: 99, runtime: store.getState().captureDraftRuntime() })
    expect(conflict.status).toBe("conflict")
    expect(store.getState().getDraft(key)?.text).toBe("keep")
    setRuntime({ transportIdentity: "next", generation: 2 })
    const stale = await store.getState().deleteDraftSnapshot({
      key,
      expectedRevision: created.record!.revision,
      runtime: { transportIdentity: "runtime", generation: 1 },
    })
    expect({ status: stale.status, durable: stale.durable, current: stale.current }).toEqual({ status: "stale", durable: false, current: false })
    expect(store.getState().getDraft(key)?.text).toBe("keep")
  })

  test("deleteDraftSnapshot reports durable stale when memory changes after metadata commit", async () => {
    const { store, block, release, resetWrite, waitForWrite } = await deferredSetup()
    const key = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    const created = await store.getState().commitDraftSnapshot({ key, expectedRevision: "absent", snapshot: snapshot("old"), runtime: store.getState().captureDraftRuntime() })
    resetWrite()
    block()
    const pending = store.getState().deleteDraftSnapshot({ key, expectedRevision: created.record!.revision, runtime: store.getState().captureDraftRuntime() })
    await waitForWrite()
    store.getState().setDraftText(key, "newer")
    release()
    const result = await pending
    expect({ status: result.status, durable: result.durable, current: result.current }).toEqual({ status: "stale", durable: true, current: false })
    expect(store.getState().getDraft(key)?.text).toBe("newer")
  })

  test("deleteDraftSnapshot clears ephemeral state after simultaneous memory and runtime staleness", async () => {
    const { store, block, release, resetWrite, waitForWrite, setRuntime } = await deferredSetup()
    const key = sessionDraftKey({ transportIdentity: "runtime" }, "session")
    const created = await store.getState().commitDraftSnapshot({ key, expectedRevision: "absent", snapshot: snapshot("old"), runtime: store.getState().captureDraftRuntime() })
    resetWrite()
    block()
    const pending = store.getState().deleteDraftSnapshot({ key, expectedRevision: created.record!.revision, runtime: store.getState().captureDraftRuntime() })
    await waitForWrite()
    store.getState().setDraftText(key, "newer")
    const id = draftKeyString(key)
    store.setState({
      draftAttachmentViews: { [id]: {} }, draftMissingAttachmentRefIDs: { [id]: ["missing"] }, draftHydration: { [id]: "ready" },
      draftPersistence: { [id]: { status: "saved", revision: 2 } }, draftAttachmentPersistence: { [id]: { status: "saved", revision: 2 } },
    })
    setRuntime({ transportIdentity: "next", generation: 2 })
    release()
    const result = await pending
    expect({ status: result.status, durable: result.durable, current: result.current }).toEqual({ status: "stale", durable: true, current: false })
    expect(store.getState().getDraft(key)?.text).toBe("newer")
    expect(store.getState().draftAttachmentViews[id]).toBe(undefined)
    expect(store.getState().draftMissingAttachmentRefIDs[id]).toBe(undefined)
    expect(store.getState().draftHydration[id]).toBe(undefined)
    expect(store.getState().draftPersistence[id]).toBe(undefined)
    expect(store.getState().draftAttachmentPersistence[id]).toBe(undefined)
  })
})
