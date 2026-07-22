import { describe, expect, test } from "bun:test"
import { createInputDraftMetadataRepository, createInputDraftMetadataStorageSink, type InputDraftMetadataPersistenceCoordinator } from "./input-draft-metadata-store"
import { draftKeyString, type DraftKey } from "./input-draft-types"
import { createInputDraftBlobStore, MemoryInputDraftBlobDriver, type InputDraftBlobDriver, type InputDraftBlobTransaction } from "./input-draft-blob-store"
import { createInputStore } from "./input-store"

class MemoryStorage {
  values = new Map<string, string>()
  quota = false
  get length() { return this.values.size }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { if (this.quota) throw new DOMException("quota", "QuotaExceededError"); this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

const key = (transportIdentity: string, ownerID = "session"): DraftKey => ({ transportIdentity, owner: { kind: "session", ownerID } })
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const blobStore = () => createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

describe("keyed input draft state", () => {
  test("isolates runtimes and applies monotonic CAS, mentions, and synthetic consumption", () => {
    const store = createInputStore({ persistenceEnabled: false })
    const first = key("one")
    const second = key("two")
    expect(store.getState().setDraftText(first, "@src/a.ts").revision).toBe(2)
    expect(store.getState().setDraftText(second, "other").revision).toBe(2)
    expect(store.getState().replaceDraft(first, 1, { text: "stale", attachments: [], syntheticParts: [], mentions: [] })).toBe(undefined)
    const mention = { kind: "file" as const, value: "src/a.ts", path: "src/a.ts", label: "src/a.ts", range: { start: 0, end: 9 } }
    expect(store.getState().addDraftMention(first, mention)?.revision).toBe(3)
    store.getState().setDraftSyntheticParts(first, [{ partID: "p", text: "context", attachments: [] }])
    expect(store.getState().consumeDraftSyntheticParts(first)).toEqual([{ partID: "p", text: "context", attachments: [] }])
    expect(store.getState().getDraft(second)?.text).toBe("other")
    store.getState().setPendingInputText("legacy", "append")
    expect(store.getState().consumePendingInputText()).toEqual({ text: "legacy", mode: "append" })
    expect(store.getState().draftPersistence).toEqual({})
  })

  test("retains selected synthetic parts while consuming the remaining parts atomically", () => {
    const store = createInputStore({ persistenceEnabled: false })
    const draft = key("runtime")
    store.getState().ensureDraft(draft)
    store.getState().setDraftSyntheticParts(draft, [
      { partID: "send", text: "context", attachments: [] },
      { partID: "mobile-share-handoff:share", text: "", attachments: [], synthetic: true },
    ])
    expect(store.getState().consumeDraftSyntheticParts(draft, (part) => part.partID?.startsWith("mobile-share-handoff:"))).toEqual([{ partID: "send", text: "context", attachments: [] }])
    expect(store.getState().getDraft(draft)?.syntheticParts).toEqual([{ partID: "mobile-share-handoff:share", text: "", attachments: [], synthetic: true }])
  })

  test("shares same-transport authoritative hydration and reports failed or stale barriers", async () => {
    const storage = new MemoryStorage()
    const sink = createInputDraftMetadataStorageSink(storage as unknown as Storage)
    const repository = createInputDraftMetadataRepository(sink)
    const migrate = repository.migrate
    const gate = deferred<void>()
    let migrations = 0
    repository.migrate = async (...args) => { migrations += 1; await gate.promise; return migrate(...args) }
    let capture = { transportIdentity: "runtime", generation: 1 }
    const store = createInputStore({ repository, blobStore: blobStore(), runtimeCapture: () => capture })
    const first = store.getState().hydrateDraftMetadata("runtime")
    const second = store.getState().hydrateDraftMetadata("runtime")
    expect(first).toBe(second)
    gate.resolve()
    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(migrations).toBe(1)

    const failedRepository = createInputDraftMetadataRepository(createInputDraftMetadataStorageSink(new MemoryStorage() as unknown as Storage))
    failedRepository.migrate = async () => ({ ok: false, error: { code: "unavailable" } })
    expect(await createInputStore({ repository: failedRepository, runtimeCapture: () => ({ transportIdentity: "runtime", generation: 1 }) }).getState().hydrateDraftMetadata("runtime")).toBe(false)

    const staleRepository = createInputDraftMetadataRepository(createInputDraftMetadataStorageSink(new MemoryStorage() as unknown as Storage))
    const staleMigrate = staleRepository.migrate
    const staleGate = deferred<void>()
    staleRepository.migrate = async (...args) => { await staleGate.promise; return staleMigrate(...args) }
    const staleStore = createInputStore({ repository: staleRepository, runtimeCapture: () => capture })
    const stale = staleStore.getState().hydrateDraftMetadata("runtime")
    capture = { transportIdentity: "other", generation: 2 }
    staleGate.resolve()
    expect(await stale).toBe(false)
  })

  test("preserves memory edits across slow hydration and keeps metadata for moves", async () => {
    const storage = new MemoryStorage()
    const sink = createInputDraftMetadataStorageSink(storage as unknown as Storage)
    const draft = { version: 1 as const, key: key("runtime"), revision: 1, text: "disk", attachments: [], syntheticParts: [], mentions: [] }
    storage.values.set("openchamber_input_draft_metadata_v1", JSON.stringify({ version: 1, drafts: { [draftKeyString(draft.key)]: draft }, tombstones: {}, migration: { complete: true, claimedTransportIdentity: "runtime", captured: true, markerCommitted: true, cleanupComplete: true }, legacy: { entries: {} } }))
    let release: (() => void) | undefined
    const originalRead = sink.read
    sink.read = async (name) => {
      if (name === "openchamber_input_draft_metadata_v1" && !release) await new Promise<void>((resolve) => { release = resolve })
      return originalRead(name)
    }
    const store = createInputStore({ sink })
    const loading = store.getState().hydrateDraftMetadata("runtime")
    await tick()
    store.getState().setDraftText(key("runtime"), "memory")
    release?.()
    await loading
    expect(store.getState().getDraft(key("runtime"))?.text).toBe("memory")
    const attachment = { attachmentID: "a", attachmentRefID: '["root","a"]', filename: "a", mimeType: "text/plain", size: 1, locator: { kind: "url" as const, url: "file:///a" }, source: "local" as const }
    store.getState().setDraftAttachments(key("runtime"), [attachment])
    const moved = store.getState().moveDraft(key("runtime"), key("runtime", "destination"))
    expect(moved?.attachments).toEqual([attachment])
    expect(store.getState().tombstones[draftKeyString(key("runtime"))]).toBe(moved?.revision)
  })

  test("retains editable memory on quota and ignores older persistence completion", async () => {
    const pending: Array<(value: { ok: true; value: undefined }) => void> = []
    const coordinator: InputDraftMetadataPersistenceCoordinator = { persist: async () => new Promise((resolve) => pending.push(resolve)) }
    const store = createInputStore({ coordinator, sink: createInputDraftMetadataStorageSink(new MemoryStorage() as unknown as Storage), blobStore: blobStore(), runtimeCapture: () => ({ transportIdentity: "runtime", generation: 1 }) })
    const hydrated = store.getState().hydrateDraftMetadata("runtime")
    await tick()
    pending.shift()?.({ ok: true, value: undefined })
    await hydrated
    store.getState().setDraftText(key("runtime"), "one")
    store.getState().setDraftText(key("runtime"), "two")
    const flushed = store.getState().flushDraftPersistence()
    await tick()
    pending[0]({ ok: true, value: undefined })
    await flushed
    expect(store.getState().draftPersistence[draftKeyString(key("runtime"))]?.status).toBe("saved")
    for (const resolve of pending.slice(1)) resolve({ ok: true, value: undefined })
    await store.getState().flushDraftPersistence()
    expect(store.getState().draftPersistence[draftKeyString(key("runtime"))]?.status).toBe("saved")

    const storage = new MemoryStorage()
    const quotaStore = createInputStore({ sink: createInputDraftMetadataStorageSink(storage as unknown as Storage), blobStore: blobStore(), runtimeCapture: () => ({ transportIdentity: "quota", generation: 1 }) })
    await quotaStore.getState().hydrateDraftMetadata("quota")
    storage.quota = true
    quotaStore.getState().setDraftText(key("quota"), "editable")
    await quotaStore.getState().flushDraftPersistence()
    expect(quotaStore.getState().getDraft(key("quota"))?.text).toBe("editable")
    expect(quotaStore.getState().draftPersistence[draftKeyString(key("quota"))]?.errorCode).toBe("quota")
  })

  test("imports legacy sessions once, stages new until claimed, and honors destination and tombstones", async () => {
    const storage = new MemoryStorage()
    storage.values.set("openchamber_chat_input_draft_session", "@src/a.ts hello")
    storage.values.set("openchamber_chat_confirmed_mentions_session", JSON.stringify(["src/a.ts"]))
    storage.values.set("openchamber_chat_input_draft_new", "new")
    storage.values.set("openchamber_chat_confirmed_mentions_new", "{")
    const store = createInputStore({ sink: createInputDraftMetadataStorageSink(storage as unknown as Storage), blobStore: blobStore(), runtimeCapture: () => ({ transportIdentity: "runtime", generation: 1 }) })
    await store.getState().hydrateDraftMetadata("runtime")
    const imported = store.getState().getDraft(key("runtime"))
    expect(imported?.mentions[0]).toEqual({ kind: "file", value: "src/a.ts", path: "src/a.ts", label: "src/a.ts", range: { start: 0, end: 9 } })
    expect(store.getState().legacyNewDraft?.text).toBe("new")
    expect((await store.getState().claimLegacyNewDraft(key("runtime", "new-draft")))?.text).toBe("new")
    expect((await store.getState().claimLegacyNewDraft(key("runtime", "new-draft")))?.text).toBe("new")
    expect(store.getState().deleteDraft(key("runtime"), imported?.revision)).toBe(true)
    await store.getState().hydrateDraftMetadata("runtime")
    expect(store.getState().getDraft(key("runtime"))).toBe(undefined)
  })

  test("stores parser clones, clears stale mentions, and rejects blob-backed moves", () => {
    const store = createInputStore({ persistenceEnabled: false })
    const draftKey = key("runtime")
    const mention = { kind: "file" as const, value: "src/a.ts", path: "src/a.ts", label: "src/a.ts", range: { start: 0, end: 9 } }
    const attachment = { attachmentID: "a", attachmentRefID: '["root","a"]', filename: "a", mimeType: "text/plain", size: 1, locator: { kind: "url" as const, url: "file:///a" }, source: "local" as const }
    store.getState().ensureDraft(draftKey)
    store.getState().replaceDraft(draftKey, 1, { text: "@src/a.ts", attachments: [attachment], syntheticParts: [], mentions: [mention] })
    attachment.locator.url = "file:///mutated"
    mention.range.start = 1
    expect(store.getState().getDraft(draftKey)?.attachments[0]?.locator).toEqual({ kind: "url", url: "file:///a" })
    expect(store.getState().getDraft(draftKey)?.mentions[0]?.range.start).toBe(0)
    store.getState().setDraftText(draftKey, "plain")
    expect(store.getState().getDraft(draftKey)?.mentions).toEqual([])
    const blob = { ...attachment, attachmentID: "blob", attachmentRefID: '["root","blob"]', locator: { kind: "blob" as const, blobID: "blob" } }
    store.getState().setDraftAttachments(draftKey, [blob])
    expect(store.getState().moveDraft(draftKey, key("runtime", "destination"))).toBe(undefined)
  })

  test("commits composer documents atomically, clears them for plain text, and preserves them through ownership finalization", async () => {
    const storage = new MemoryStorage()
    const store = createInputStore({ sink: createInputDraftMetadataStorageSink(storage as unknown as Storage), blobStore: blobStore(), runtimeCapture: () => ({ transportIdentity: "runtime", generation: 1 }) })
    await store.getState().hydrateDraftMetadata("runtime")
    const source = { transportIdentity: "runtime", owner: { kind: "draft" as const, ownerID: "new" } }
    const destination = key("runtime", "session")
    store.getState().ensureDraft(source)
    const committed = store.getState().setDraftComposerDocument(source, { text: "@Session", references: [{ id: "s", kind: "session", sessionId: "ses_1", start: 0, end: 8, display: "@Session" }] })
    expect(committed?.revision).toBe(2)
    expect(committed?.composerReferences).toHaveLength(1)
    const finalized = await store.getState().finalizeDraftOwnership({ source, destination, expectedSourceRevision: 2, disposition: "preserve", runtime: store.getState().captureDraftRuntime() })
    expect(finalized.destination?.composerReferences).toHaveLength(1)
    expect(store.getState().setDraftText(destination, "plain").composerReferences).toEqual([])
  })

  test("coalesces a 200k Paste document burst into one latest durable snapshot", async () => {
    const snapshots: unknown[] = []
    const coordinator: InputDraftMetadataPersistenceCoordinator = { persist: async (snapshot) => { snapshots.push(snapshot); return { ok: true, value: undefined } } }
    const store = createInputStore({ coordinator, sink: createInputDraftMetadataStorageSink(new MemoryStorage() as unknown as Storage), blobStore: blobStore(), runtimeCapture: () => ({ transportIdentity: "runtime", generation: 1 }) })
    await store.getState().hydrateDraftMetadata("runtime")
    const baseline = snapshots.length
    const payload = "x".repeat(100_000)
    const draft = key("runtime", "paste")
    for (let index = 0; index < 20; index += 1) {
      const first = "@Paste 1"
      const second = "@Paste 2"
      const text = `${first} ${second}${index}`
      store.getState().setDraftComposerState(draft, {
        document: {
          text,
          references: [
            { id: "first", kind: "paste", display: first, start: 0, end: first.length, text: payload, characterCount: payload.length, index: 1 },
            { id: "second", kind: "paste", display: second, start: first.length + 1, end: first.length + 1 + second.length, text: payload, characterCount: payload.length, index: 2 },
          ],
        },
        mentions: [],
      })
    }
    expect(snapshots).toHaveLength(baseline)
    await store.getState().flushDraftPersistence()
    expect(snapshots).toHaveLength(baseline + 1)
    expect(store.getState().getDraft(draft)?.text).toBe("@Paste 1 @Paste 219")
    expect(store.getState().getDraft(draft)?.composerReferences?.[1]).toEqual({ id: "second", kind: "paste", display: "@Paste 2", start: 9, end: 17, text: payload, characterCount: payload.length, index: 2 })
  })

  test("commits composer documents and file mentions in one revision", () => {
    const store = createInputStore({ persistenceEnabled: false })
    const draft = key("runtime")
    const mention = { kind: "file" as const, value: "src/a.ts", path: "src/a.ts", label: "src/a.ts", range: { start: 0, end: 9 } }
    const committed = store.getState().setDraftComposerState(draft, { document: { text: "@src/a.ts", references: [] }, mentions: [mention] })
    expect(committed?.revision).toBe(2)
    expect(committed?.mentions).toEqual([mention])
    expect(store.getState().setDraftComposerState(draft, { document: { text: "plain", references: [] }, mentions: [{ ...mention, range: { start: 0, end: 99 } }] })).toBe(undefined)
  })

  test("keeps composer sidecars in memory after persistence failure and isolates keys", async () => {
    const storage = new MemoryStorage()
    const store = createInputStore({ sink: createInputDraftMetadataStorageSink(storage as unknown as Storage), blobStore: blobStore(), runtimeCapture: () => ({ transportIdentity: "runtime-a", generation: 1 }) })
    await store.getState().hydrateDraftMetadata("runtime-a")
    storage.quota = true
    const first = key("runtime-a", "one")
    const second = key("runtime-a", "two")
    const firstDocument = { text: "@One", references: [{ id: "one", kind: "session" as const, sessionId: "ses_1", start: 0, end: 4, display: "@One" }] }
    const secondDocument = { text: "@Two", references: [{ id: "two", kind: "session" as const, sessionId: "ses_2", start: 0, end: 4, display: "@Two" }] }
    store.getState().setDraftComposerDocument(first, firstDocument)
    store.getState().setDraftComposerDocument(second, secondDocument)
    await store.getState().flushDraftPersistence()
    expect(store.getState().getDraft(first)?.composerReferences).toEqual(firstDocument.references)
    expect(store.getState().getDraft(second)?.composerReferences).toEqual(secondDocument.references)
    expect(store.getState().draftPersistence[draftKeyString(first)]?.status).toBe("error")
  })

  test("keeps local revision 2 edit ahead of a slow disk revision 100 hydrate", async () => {
    const storage = new MemoryStorage()
    const disk = { version: 1 as const, key: key("runtime"), revision: 100, text: "disk", attachments: [], syntheticParts: [], mentions: [] }
    storage.values.set("openchamber_input_draft_metadata_v1", JSON.stringify({ version: 1, drafts: { [draftKeyString(disk.key)]: disk }, tombstones: {}, migration: { complete: true, claimedTransportIdentity: "runtime", captured: true, markerCommitted: true, cleanupComplete: true }, legacy: { entries: {} } }))
    const sink = createInputDraftMetadataStorageSink(storage as unknown as Storage)
    const gate = deferred<void>()
    const read = sink.read
    sink.read = async (name) => { if (name === "openchamber_input_draft_metadata_v1") await gate.promise; return read(name) }
    const store = createInputStore({ sink, runtimeCapture: () => ({ transportIdentity: "runtime", generation: 1 }) })
    const loading = store.getState().hydrateDraftMetadata("runtime")
    await tick()
    store.getState().setDraftText(key("runtime"), "local")
    gate.resolve()
    await loading
    expect(store.getState().getDraft(key("runtime"))?.text).toBe("local")
    expect(store.getState().getDraft(key("runtime"))?.revision).toBe(2)
  })

  test("keeps a local delete ahead of a slow disk revision 100 hydrate", async () => {
    const storage = new MemoryStorage()
    const disk = { version: 1 as const, key: key("runtime"), revision: 100, text: "disk", attachments: [], syntheticParts: [], mentions: [] }
    storage.values.set("openchamber_input_draft_metadata_v1", JSON.stringify({ version: 1, drafts: { [draftKeyString(disk.key)]: disk }, tombstones: {}, migration: { complete: true, claimedTransportIdentity: "runtime", captured: true, markerCommitted: true, cleanupComplete: true }, legacy: { entries: {} } }))
    const sink = createInputDraftMetadataStorageSink(storage as unknown as Storage)
    const gate = deferred<void>()
    const read = sink.read
    sink.read = async (name) => { if (name === "openchamber_input_draft_metadata_v1") await gate.promise; return read(name) }
    const store = createInputStore({ sink, runtimeCapture: () => ({ transportIdentity: "runtime", generation: 1 }) })
    store.getState().setDraftText(key("runtime"), "local")
    const loading = store.getState().hydrateDraftMetadata("runtime")
    await tick()
    store.getState().deleteDraft(key("runtime"))
    gate.resolve()
    await loading
    expect(store.getState().getDraft(key("runtime"))).toBe(undefined)
    expect(store.getState().tombstones[draftKeyString(key("runtime"))]).toBe(3)
  })

  test("hydrates disabled persistence into memory, then seeds and persists after enabling", async () => {
    const storage = new MemoryStorage()
    const id = draftKeyString(key("runtime"))
    const durableKey = key("runtime", "durable")
    const durableID = draftKeyString(durableKey)
    const durableDraft = { version: 1 as const, key: durableKey, revision: 2, text: "durable", attachments: [], syntheticParts: [], mentions: [] }
    storage.values.set("openchamber_input_draft_metadata_v1", JSON.stringify({ version: 1, drafts: { [durableID]: durableDraft }, tombstones: { [id]: 100 }, migration: { complete: true, claimedTransportIdentity: "runtime", captured: true, markerCommitted: true, cleanupComplete: true }, legacy: { entries: {} } }))
    const base = new MemoryInputDraftBlobDriver()
    let transactions = 0
    const driver: InputDraftBlobDriver = { transaction: async <T>(action: (transaction: InputDraftBlobTransaction) => Promise<T>): Promise<T> => { transactions += 1; return base.transaction(action) } }
    const store = createInputStore({ sink: createInputDraftMetadataStorageSink(storage as unknown as Storage), blobStore: createInputDraftBlobStore(driver), persistenceEnabled: false, runtimeCapture: () => ({ transportIdentity: "runtime", generation: 1 }) })
    store.getState().ensureDraft(key("runtime"))
    await store.getState().hydrateDraftMetadata("runtime")
    expect(transactions).toBe(0)
    expect(store.getState().getDraft(key("runtime"))).toBe(undefined)
    expect(store.getState().tombstones[id]).toBe(100)
    expect(store.getState().getDraft(durableKey)?.text).toBe("durable")
    store.getState().setDraftText(durableKey, "memory")
    await store.getState().setDraftPersistenceEnabled(true)
    expect(transactions).toBeGreaterThan(0)
    const persisted = JSON.parse(storage.values.get("openchamber_input_draft_metadata_v1") ?? "{}")
    expect(persisted.drafts[durableID]?.text).toBe("memory")
    expect(persisted.tombstones[id]).toBe(100)
  })

  test("skips hydrate ownership and writeback for a non-active transport", async () => {
    const storage = new MemoryStorage()
    storage.values.set("openchamber_chat_input_draft_session", "legacy")
    const store = createInputStore({ sink: createInputDraftMetadataStorageSink(storage as unknown as Storage), blobStore: blobStore(), runtimeCapture: () => ({ transportIdentity: "active", generation: 1 }) })
    await store.getState().hydrateDraftMetadata("stale")
    expect(storage.values.has("openchamber_input_draft_metadata_v1")).toBe(false)
    expect(storage.values.has("openchamber_input_draft_metadata_migration_v1")).toBe(false)
  })

  test("claims legacy data once across transports and ignores an older same-transport completion", async () => {
    const storage = new MemoryStorage()
    storage.values.set("openchamber_chat_input_draft_session", "legacy")
    let capture = { transportIdentity: "one", generation: 1 }
    const store = createInputStore({ sink: createInputDraftMetadataStorageSink(storage as unknown as Storage), blobStore: blobStore(), runtimeCapture: () => capture })
    const first = store.getState().hydrateDraftMetadata("one")
    capture = { transportIdentity: "two", generation: 2 }
    await store.getState().hydrateDraftMetadata("two")
    await first
    expect(store.getState().migration.claimedTransportIdentity).toBe("one")
    expect(store.getState().getDraft(key("two"))).toBe(undefined)
  })

  test("does not revive staged legacy new after hydrate-time claim", async () => {
    const storage = new MemoryStorage()
    storage.values.set("openchamber_chat_input_draft_new", "legacy new")
    const store = createInputStore({ sink: createInputDraftMetadataStorageSink(storage as unknown as Storage), blobStore: blobStore(), runtimeCapture: () => ({ transportIdentity: "runtime", generation: 1 }) })
    await store.getState().hydrateDraftMetadata("runtime")
    await store.getState().claimLegacyNewDraft(key("runtime", "claimed"))
    await store.getState().hydrateDraftMetadata("runtime")
    expect(store.getState().legacyNewDraft).toBe(undefined)
    expect(store.getState().getDraft(key("runtime", "claimed"))?.text).toBe("legacy new")
  })

  test("runtime generation changes suppress persist completion writeback", async () => {
    const pending = deferred<{ ok: true; value: undefined }>()
    let capture = { transportIdentity: "runtime", generation: 1 }
    const coordinator: InputDraftMetadataPersistenceCoordinator = { persist: async () => pending.promise }
    const store = createInputStore({ coordinator, sink: createInputDraftMetadataStorageSink(new MemoryStorage() as unknown as Storage), blobStore: blobStore(), runtimeCapture: () => capture })
    store.getState().setDraftText(key("runtime"), "draft")
    capture = { transportIdentity: "runtime", generation: 2 }
    pending.resolve({ ok: true, value: undefined })
    await tick()
    expect(store.getState().draftPersistence[draftKeyString(key("runtime"))]?.status).toBe("saving")
  })

  test("limits slow persist status completion to its touched key", async () => {
    const pending: Array<ReturnType<typeof deferred<{ ok: true; value: undefined }>>> = []
    const coordinator: InputDraftMetadataPersistenceCoordinator = { persist: async () => { const next = deferred<{ ok: true; value: undefined }>(); pending.push(next); return next.promise } }
    const store = createInputStore({ coordinator, sink: createInputDraftMetadataStorageSink(new MemoryStorage() as unknown as Storage), blobStore: blobStore(), runtimeCapture: () => ({ transportIdentity: "runtime", generation: 1 }) })
    const hydrated = store.getState().hydrateDraftMetadata("runtime")
    await tick()
    pending.shift()!.resolve({ ok: true, value: undefined })
    await hydrated
    store.getState().ensureDraft(key("runtime", "A"))
    store.getState().ensureDraft(key("runtime", "B"))
    await tick()
    pending[0]!.resolve({ ok: true, value: undefined })
    await tick(); await tick()
    expect(store.getState().draftPersistence[draftKeyString(key("runtime", "A"))]?.status).toBe("saved")
    pending[1]!.resolve({ ok: true, value: undefined })
    await tick(); await tick(); await tick()
    expect(store.getState().draftPersistence[draftKeyString(key("runtime", "B"))]?.status).toBe("saved")
  })

  test("limits failed persist status completion to its touched key", async () => {
    const pending: Array<ReturnType<typeof deferred<{ ok: true; value: undefined } | { ok: false; error: { code: "quota" } }>>> = []
    const coordinator: InputDraftMetadataPersistenceCoordinator = { persist: async () => { const next = deferred<{ ok: true; value: undefined } | { ok: false; error: { code: "quota" } }>(); pending.push(next); return next.promise } }
    const store = createInputStore({ coordinator, sink: createInputDraftMetadataStorageSink(new MemoryStorage() as unknown as Storage), blobStore: blobStore(), runtimeCapture: () => ({ transportIdentity: "runtime", generation: 1 }) })
    const hydrated = store.getState().hydrateDraftMetadata("runtime")
    await tick()
    pending.shift()!.resolve({ ok: true, value: undefined })
    await hydrated
    store.getState().ensureDraft(key("runtime", "A"))
    store.getState().ensureDraft(key("runtime", "B"))
    await tick()
    pending[0]!.resolve({ ok: false, error: { code: "quota" } })
    await tick(); await tick()
    expect(store.getState().draftPersistence[draftKeyString(key("runtime", "A"))]?.status).toBe("error")
    pending[1]!.resolve({ ok: false, error: { code: "quota" } })
    await tick(); await tick(); await tick()
    expect(store.getState().draftPersistence[draftKeyString(key("runtime", "B"))]?.status).toBe("error")
  })

  test("disable waits for entered work and blocks stale completion state and later writes", async () => {
    const storage = new MemoryStorage()
    const sink = createInputDraftMetadataStorageSink(storage as unknown as Storage)
    const repository = createInputDraftMetadataRepository(sink)
    const pending = deferred<{ ok: true; value: undefined }>()
    const coordinator: InputDraftMetadataPersistenceCoordinator = { persist: async () => pending.promise, setEnabled: async () => {}, flush: async () => {} }
    const store = createInputStore({ repository, coordinator, runtimeCapture: () => ({ transportIdentity: "runtime", generation: 1 }) })
    store.getState().setDraftText(key("runtime"), "draft")
    const disabling = store.getState().setDraftPersistenceEnabled(false)
    pending.resolve({ ok: true, value: undefined })
    await disabling
    const storedKeys = storage.values.size
    store.getState().setDraftText(key("runtime"), "later")
    await tick()
    expect(store.getState().draftPersistence).toEqual({})
    expect(storage.values.size).toBe(storedKeys)
  })
})
