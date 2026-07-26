import { describe, expect, test } from "bun:test"
import { INPUT_DRAFT_METADATA_MIGRATION_MARKER_KEY, INPUT_DRAFT_METADATA_SNAPSHOT_KEY, createInputDraftMetadataPersistenceCoordinator, createInputDraftMetadataRepository, createInputDraftMetadataStorageSink, migrateLegacyInputDraftMetadata, readInputDraftMetadataSnapshot, readLegacyInputDrafts, writeInputDraftMetadataSnapshot, type InputDraftMetadataSnapshot } from "./input-draft-metadata-store"
import { draftKeyString, type DraftRecord } from "./input-draft-types"

class MemoryStorage {
  values = new Map<string, string>()
  failWrite = false
  failRemove = false
  writes: string[] = []
  removes: string[] = []
  get length(): number { return this.values.size }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.writes.push(key); if (this.failWrite) throw new DOMException("quota", "QuotaExceededError"); this.values.set(key, value) }
  removeItem(key: string): void { this.removes.push(key); if (this.failRemove) throw new DOMException("unavailable", "SecurityError"); this.values.delete(key) }
}

const record = (revision = 1): DraftRecord => ({ version: 1, key: { transportIdentity: "runtime", owner: { kind: "session", ownerID: "session" } }, revision, text: "draft", attachments: [], syntheticParts: [], mentions: [] })
const snapshot = (revision = 1): InputDraftMetadataSnapshot => ({ version: 1, drafts: { [draftKeyString(record(revision).key)]: record(revision) }, tombstones: {}, migration: { complete: false, claimedTransportIdentity: "runtime" }, legacy: { entries: {} } })
const sinkFor = (storage: MemoryStorage) => createInputDraftMetadataStorageSink(storage as unknown as Storage)

describe("input draft metadata store", () => {
  test("round trips validated records and rejects corrupt snapshots and tombstone keys", async () => {
    const storage = new MemoryStorage()
    const sink = sinkFor(storage)
    expect(await writeInputDraftMetadataSnapshot(sink, snapshot())).toEqual({ ok: true, value: undefined })
    expect((await readInputDraftMetadataSnapshot(sink)).ok).toBe(true)
    storage.values.set(INPUT_DRAFT_METADATA_SNAPSHOT_KEY, JSON.stringify({ ...snapshot(), tombstones: { '["runtime","queue","session"]': 1 } }))
    expect(await readInputDraftMetadataSnapshot(sink)).toEqual({ ok: false, error: { code: "corrupt" } })
  })

  test("reads text-only, mentions-only, new, and malformed legacy entries", async () => {
    const storage = new MemoryStorage()
    storage.values.set("openchamber_chat_input_draft_session", "text")
    storage.values.set("openchamber_chat_confirmed_mentions_mentions", JSON.stringify(["one", 2]))
    storage.values.set("openchamber_chat_input_draft_new", "new text")
    storage.values.set("openchamber_chat_confirmed_mentions_new", "{")
    expect(await readLegacyInputDrafts(sinkFor(storage))).toEqual({ ok: true, value: [
      { suffix: "session", text: "text", mentions: [], keys: ["openchamber_chat_input_draft_session"] },
      { suffix: "mentions", text: "", mentions: ["one"], keys: ["openchamber_chat_confirmed_mentions_mentions"] },
      { suffix: "new", text: "new text", mentions: [], keys: ["openchamber_chat_input_draft_new", "openchamber_chat_confirmed_mentions_new"] },
    ] })
  })

  test("persists the captured clone after callers mutate the queued snapshot", async () => {
    const storage = new MemoryStorage()
    const sink = sinkFor(storage)
    const coordinator = createInputDraftMetadataPersistenceCoordinator(sink)
    const value = snapshot(1)
    const persisted = coordinator.persist(value)
    value.drafts[draftKeyString(record().key)]!.revision = 9
    expect(await persisted).toEqual({ ok: true, value: undefined })
    const stored = await readInputDraftMetadataSnapshot(sink)
    expect(stored.ok && stored.value?.drafts[draftKeyString(record().key)]?.revision).toBe(1)
  })

  test("gives each queued persist an independent result after a failed active write", async () => {
    const storage = new MemoryStorage()
    const sink = sinkFor(storage)
    let writes = 0
    const originalWrite = sink.write
    sink.write = async (key, value) => { if (key === INPUT_DRAFT_METADATA_SNAPSHOT_KEY && ++writes === 1) return { ok: false, error: { code: "quota" } }; return originalWrite(key, value) }
    const coordinator = createInputDraftMetadataPersistenceCoordinator(sink)
    expect(await Promise.all([coordinator.persist(snapshot(1)), coordinator.persist(snapshot(2))])).toEqual([{ ok: false, error: { code: "quota" } }, { ok: true, value: undefined }])
    const stored = await readInputDraftMetadataSnapshot(sink)
    expect(stored.ok && stored.value?.drafts[draftKeyString(record().key)]?.revision).toBe(2)
  })

  test("claims one transport across concurrent migrations and preserves durable staging", async () => {
    const storage = new MemoryStorage()
    storage.values.set("openchamber_chat_input_draft_session", "draft")
    const sink = sinkFor(storage)
    const [first, second] = await Promise.all([migrateLegacyInputDraftMetadata(sink, "one"), migrateLegacyInputDraftMetadata(sink, "two")])
    expect(first.ok && first.value.migration.claimedTransportIdentity).toBe("one")
    expect(second.ok && second.value.migration.claimedTransportIdentity).toBe("one")
    expect(first.ok && first.value.legacy.entries.session?.text).toBe("draft")
  })

  test("uses a matching marker without rewriting and retries partial cleanup", async () => {
    const storage = new MemoryStorage()
    storage.values.set("openchamber_chat_input_draft_session", "draft")
    const sink = sinkFor(storage)
    storage.failRemove = true
    expect(await migrateLegacyInputDraftMetadata(sink, "runtime")).toEqual({ ok: false, error: { code: "unavailable" } })
    const writesBeforeRetry = storage.writes.length
    storage.failRemove = false
    expect((await migrateLegacyInputDraftMetadata(sink, "runtime")).ok).toBe(true)
    expect(storage.writes.slice(writesBeforeRetry)).toEqual([INPUT_DRAFT_METADATA_SNAPSHOT_KEY])
    const removesAfterComplete = storage.removes.length
    const writesAfterComplete = storage.writes.length
    expect((await migrateLegacyInputDraftMetadata(sink, "runtime")).ok).toBe(true)
    expect(storage.removes.length).toBe(removesAfterComplete)
    expect(storage.writes.length).toBe(writesAfterComplete)
    expect(storage.values.get(INPUT_DRAFT_METADATA_MIGRATION_MARKER_KEY)).toBeDefined()
  })

  test("retains legacy keys when marker persistence fails", async () => {
    const storage = new MemoryStorage()
    storage.values.set("openchamber_chat_input_draft_session", "draft")
    const sink = sinkFor(storage)
    const originalWrite = sink.write
    sink.write = async (key, value) => key === INPUT_DRAFT_METADATA_MIGRATION_MARKER_KEY ? { ok: false, error: { code: "quota" } } : originalWrite(key, value)
    expect(await migrateLegacyInputDraftMetadata(sink, "runtime")).toEqual({ ok: false, error: { code: "quota" } })
    expect(storage.values.get("openchamber_chat_input_draft_session")).toBe("draft")
  })

  test("hydrates legacy staging read-only, then completes after persistence resumes", async () => {
    const storage = new MemoryStorage()
    storage.values.set("openchamber_chat_input_draft_session", "draft")
    const sink = sinkFor(storage)
    const readonly = await migrateLegacyInputDraftMetadata(sink, "runtime", { persistenceEnabled: false })
    expect(readonly.ok && readonly.value.legacy.entries.session?.text).toBe("draft")
    expect(storage.writes).toEqual([])
    expect(storage.removes).toEqual([])
    expect((await migrateLegacyInputDraftMetadata(sink, "runtime")).ok).toBe(true)
    expect(storage.values.has("openchamber_chat_input_draft_session")).toBe(false)
  })

  test("rejects corrupt migration markers", async () => {
    const storage = new MemoryStorage()
    const sink = sinkFor(storage)
    expect(await writeInputDraftMetadataSnapshot(sink, { ...snapshot(), migration: { complete: false, claimedTransportIdentity: "runtime", captured: true, markerCommitted: false, cleanupComplete: false } })).toEqual({ ok: true, value: undefined })
    storage.values.set(INPUT_DRAFT_METADATA_MIGRATION_MARKER_KEY, "{")
    expect(await migrateLegacyInputDraftMetadata(sink, "runtime")).toEqual({ ok: false, error: { code: "corrupt" } })
  })

  test("repairs a valid mismatched marker from the durable staged claim before cleanup", async () => {
    const storage = new MemoryStorage()
    const sink = sinkFor(storage)
    const staged = { ...snapshot(), migration: { complete: false, claimedTransportIdentity: "captured-runtime", captured: true, markerCommitted: false, cleanupComplete: false }, legacy: { entries: { session: { suffix: "session", text: "draft", mentions: [], keys: ["openchamber_chat_input_draft_session"] } } } }
    expect(await writeInputDraftMetadataSnapshot(sink, staged)).toEqual({ ok: true, value: undefined })
    storage.values.set(INPUT_DRAFT_METADATA_MIGRATION_MARKER_KEY, JSON.stringify({ version: 1, claimedTransportIdentity: "switched-runtime" }))
    storage.values.set("openchamber_chat_input_draft_session", "draft")

    const migrated = await migrateLegacyInputDraftMetadata(sink, "switched-runtime")

    expect(migrated.ok && migrated.value.migration).toEqual({ complete: true, claimedTransportIdentity: "captured-runtime", captured: true, markerCommitted: true, cleanupComplete: true })
    expect(JSON.parse(storage.values.get(INPUT_DRAFT_METADATA_MIGRATION_MARKER_KEY)!)).toEqual({ version: 1, claimedTransportIdentity: "captured-runtime" })
    expect(storage.values.has("openchamber_chat_input_draft_session")).toBe(false)
  })

  test("preserves staged legacy keys when mismatched marker repair fails", async () => {
    const storage = new MemoryStorage()
    const sink = sinkFor(storage)
    const staged = { ...snapshot(), migration: { complete: false, claimedTransportIdentity: "captured-runtime", captured: true, markerCommitted: false, cleanupComplete: false }, legacy: { entries: { session: { suffix: "session", text: "draft", mentions: [], keys: ["openchamber_chat_input_draft_session"] } } } }
    expect(await writeInputDraftMetadataSnapshot(sink, staged)).toEqual({ ok: true, value: undefined })
    storage.values.set(INPUT_DRAFT_METADATA_MIGRATION_MARKER_KEY, JSON.stringify({ version: 1, claimedTransportIdentity: "switched-runtime" }))
    storage.values.set("openchamber_chat_input_draft_session", "draft")
    storage.failWrite = true

    expect(await migrateLegacyInputDraftMetadata(sink, "switched-runtime")).toEqual({ ok: false, error: { code: "quota" } })
    expect(storage.values.get("openchamber_chat_input_draft_session")).toBe("draft")
  })

  test("quiesces entered work and keeps disabled migration read-only", async () => {
    const storage = new MemoryStorage()
    storage.values.set("openchamber_chat_input_draft_session", "draft")
    const sink = sinkFor(storage)
    let release: (() => void) | undefined
    const write = sink.write
    sink.write = async (key, value) => {
      if (key === INPUT_DRAFT_METADATA_SNAPSHOT_KEY && !release) await new Promise<void>((resolve) => { release = resolve })
      return write(key, value)
    }
    const repository = createInputDraftMetadataRepository(sink)
    const migration = repository.migrate("runtime")
    await new Promise((resolve) => setTimeout(resolve, 0))
    const disabling = repository.setEnabled(false)
    release?.()
    await Promise.all([migration, disabling])
    const writes = storage.writes.length
    const removes = storage.removes.length
    expect((await repository.persist(snapshot())).ok).toBe(false)
    expect((await repository.migrate("runtime")).ok).toBe(true)
    expect(storage.writes.length).toBe(writes)
    expect(storage.removes.length).toBe(removes)
  })
})
