import { draftKeyString, parseDraftRecord, type DraftRecord } from "./input-draft-types"

export const INPUT_DRAFT_METADATA_SNAPSHOT_KEY = "openchamber_input_draft_metadata_v1"
export const INPUT_DRAFT_METADATA_MIGRATION_MARKER_KEY = "openchamber_input_draft_metadata_migration_v1"
const LEGACY_DRAFT_PREFIX = "openchamber_chat_input_draft_"
const LEGACY_MENTIONS_PREFIX = "openchamber_chat_confirmed_mentions_"

export type InputDraftMetadataErrorCode = "unavailable" | "quota" | "corrupt" | "serialization" | "cancelled"
export type InputDraftMetadataResult<T> = { ok: true; value: T } | { ok: false; error: { code: InputDraftMetadataErrorCode } }
export type InputDraftMetadataSink = {
  read: (key: string) => Promise<InputDraftMetadataResult<string | null>>
  write: (key: string, value: string) => Promise<InputDraftMetadataResult<void>>
  remove: (key: string) => Promise<InputDraftMetadataResult<void>>
  keys: () => Promise<InputDraftMetadataResult<string[]>>
}

export type LegacyInputDraft = { suffix: string; text: string; mentions: string[]; keys: string[] }
export type InputDraftMetadataMigration = {
  complete: boolean
  claimedTransportIdentity: string
  captured?: boolean
  markerCommitted?: boolean
  cleanupComplete?: boolean
}
export type InputDraftMetadataSnapshot = {
  version: 1
  drafts: Record<string, DraftRecord>
  tombstones: Record<string, number>
  migration: InputDraftMetadataMigration
  legacy: { new?: LegacyInputDraft; entries: Record<string, LegacyInputDraft> }
}

const unavailable = <T>(): InputDraftMetadataResult<T> => ({ ok: false, error: { code: "unavailable" } })
const cancelled = <T>(): InputDraftMetadataResult<T> => ({ ok: false, error: { code: "cancelled" } })
const classifyStorageError = <T>(error: unknown): InputDraftMetadataResult<T> => ({ ok: false, error: { code: error instanceof DOMException && error.name === "QuotaExceededError" ? "quota" : "unavailable" } })
const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key))
const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0

export const createInputDraftMetadataStorageSink = (storage: Storage | null | undefined): InputDraftMetadataSink => ({
  read: async (key) => {
    if (!storage) return unavailable()
    try { return { ok: true, value: storage.getItem(key) } } catch (error) { return classifyStorageError(error) }
  },
  write: async (key, value) => {
    if (!storage) return unavailable()
    try { storage.setItem(key, value); return { ok: true, value: undefined } } catch (error) { return classifyStorageError(error) }
  },
  remove: async (key) => {
    if (!storage) return unavailable()
    try { storage.removeItem(key); return { ok: true, value: undefined } } catch (error) { return classifyStorageError(error) }
  },
  keys: async () => {
    if (!storage) return unavailable()
    try {
      const keys: string[] = []
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index)
        if (key !== null) keys.push(key)
      }
      return { ok: true, value: keys }
    } catch (error) { return classifyStorageError(error) }
  },
})

export const createDefaultInputDraftMetadataSink = (): InputDraftMetadataSink => {
  try { return createInputDraftMetadataStorageSink(typeof window === "undefined" ? null : window.localStorage) } catch { return createInputDraftMetadataStorageSink(null) }
}

const parseLegacyDraft = (suffix: string, text: string | null, mentionsRaw: string | null, keys: string[]): LegacyInputDraft => {
  let mentions: string[] = []
  try {
    const parsed: unknown = mentionsRaw === null ? [] : JSON.parse(mentionsRaw)
    if (Array.isArray(parsed)) mentions = parsed.filter((value): value is string => typeof value === "string")
  } catch { /* Corrupt legacy mentions safely become an empty list. */ }
  return { suffix, text: text ?? "", mentions, keys }
}

export const readLegacyInputDrafts = async (sink: InputDraftMetadataSink): Promise<InputDraftMetadataResult<LegacyInputDraft[]>> => {
  const keys = await sink.keys()
  if (!keys.ok) return keys
  const suffixes = new Set<string>()
  for (const key of keys.value) {
    if (key.startsWith(LEGACY_DRAFT_PREFIX)) suffixes.add(key.slice(LEGACY_DRAFT_PREFIX.length))
    if (key.startsWith(LEGACY_MENTIONS_PREFIX)) suffixes.add(key.slice(LEGACY_MENTIONS_PREFIX.length))
  }
  const drafts: LegacyInputDraft[] = []
  for (const suffix of suffixes) {
    const textKey = `${LEGACY_DRAFT_PREFIX}${suffix}`
    const mentionsKey = `${LEGACY_MENTIONS_PREFIX}${suffix}`
    const [text, mentions] = await Promise.all([sink.read(textKey), sink.read(mentionsKey)])
    if (!text.ok) return text
    if (!mentions.ok) return mentions
    drafts.push(parseLegacyDraft(suffix, text.value, mentions.value, [textKey, mentionsKey].filter((key) => keys.value.includes(key))))
  }
  return { ok: true, value: drafts }
}

const parseLegacyEntry = (value: unknown): LegacyInputDraft | undefined => {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["suffix", "text", "mentions", "keys"]) || typeof value.suffix !== "string" || typeof value.text !== "string" || !Array.isArray(value.mentions) || !value.mentions.every((mention) => typeof mention === "string") || !Array.isArray(value.keys) || !value.keys.every((key) => typeof key === "string")) return undefined
  return { suffix: value.suffix, text: value.text, mentions: [...value.mentions], keys: [...value.keys] }
}

const parseTombstoneKey = (value: string): boolean => {
  try {
    const tuple: unknown = JSON.parse(value)
    return Array.isArray(tuple) && tuple.length === 3 && nonEmptyString(tuple[0]) && (tuple[1] === "session" || tuple[1] === "draft") && nonEmptyString(tuple[2]) && value === JSON.stringify(tuple)
  } catch { return false }
}

const parseMigration = (value: unknown): InputDraftMetadataMigration | undefined => {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["complete", "claimedTransportIdentity", "captured", "markerCommitted", "cleanupComplete"]) || typeof value.complete !== "boolean" || typeof value.claimedTransportIdentity !== "string" || (value.captured !== undefined && typeof value.captured !== "boolean") || (value.markerCommitted !== undefined && typeof value.markerCommitted !== "boolean") || (value.cleanupComplete !== undefined && typeof value.cleanupComplete !== "boolean")) return undefined
  const cleanupComplete = value.cleanupComplete ?? value.complete
  const captured = value.captured ?? value.complete
  const markerCommitted = value.markerCommitted ?? value.complete
  if ((captured || markerCommitted || cleanupComplete) && !nonEmptyString(value.claimedTransportIdentity)) return undefined
  if (markerCommitted && !captured) return undefined
  if (cleanupComplete && (!captured || !markerCommitted)) return undefined
  return { complete: cleanupComplete, claimedTransportIdentity: value.claimedTransportIdentity, captured, markerCommitted, cleanupComplete }
}

export const parseInputDraftMetadataSnapshot = (value: unknown): InputDraftMetadataSnapshot | undefined => {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["version", "drafts", "tombstones", "migration", "legacy"]) || value.version !== 1 || !isPlainObject(value.drafts) || !isPlainObject(value.tombstones) || !isPlainObject(value.legacy) || !hasOnlyKeys(value.legacy, ["new", "entries"]) || !isPlainObject(value.legacy.entries)) return undefined
  const migration = parseMigration(value.migration)
  if (!migration) return undefined
  const drafts: Record<string, DraftRecord> = {}
  for (const [key, record] of Object.entries(value.drafts)) {
    const parsed = parseDraftRecord(record)
    if (!parsed || key !== draftKeyString(parsed.key)) return undefined
    drafts[key] = parsed
  }
  const tombstones: Record<string, number> = {}
  for (const [key, revision] of Object.entries(value.tombstones)) {
    if (!parseTombstoneKey(key) || !positiveInteger(revision)) return undefined
    tombstones[key] = revision
  }
  const entries: Record<string, LegacyInputDraft> = {}
  for (const [key, entry] of Object.entries(value.legacy.entries)) {
    const parsed = parseLegacyEntry(entry)
    if (!parsed || key !== parsed.suffix || key === "new") return undefined
    entries[key] = parsed
  }
  const newEntry = value.legacy.new === undefined ? undefined : parseLegacyEntry(value.legacy.new)
  if (value.legacy.new !== undefined && (!newEntry || newEntry.suffix !== "new")) return undefined
  return { version: 1, drafts, tombstones, migration, legacy: { ...(newEntry ? { new: newEntry } : {}), entries } }
}

const emptySnapshot = (claimedTransportIdentity = ""): InputDraftMetadataSnapshot => ({ version: 1, drafts: {}, tombstones: {}, migration: { complete: false, claimedTransportIdentity, captured: false, markerCommitted: false, cleanupComplete: false }, legacy: { entries: {} } })
const serialize = (value: unknown): InputDraftMetadataResult<string> => {
  try { return { ok: true, value: JSON.stringify(value) } } catch { return { ok: false, error: { code: "serialization" } } }
}

export const readInputDraftMetadataSnapshot = async (sink: InputDraftMetadataSink): Promise<InputDraftMetadataResult<InputDraftMetadataSnapshot | null>> => {
  const raw = await sink.read(INPUT_DRAFT_METADATA_SNAPSHOT_KEY)
  if (!raw.ok) return raw
  if (raw.value === null) return { ok: true, value: null }
  try {
    const snapshot = parseInputDraftMetadataSnapshot(JSON.parse(raw.value))
    return snapshot ? { ok: true, value: snapshot } : { ok: false, error: { code: "corrupt" } }
  } catch { return { ok: false, error: { code: "corrupt" } } }
}

export const writeInputDraftMetadataSnapshot = async (sink: InputDraftMetadataSink, snapshot: InputDraftMetadataSnapshot): Promise<InputDraftMetadataResult<void>> => {
  const parsed = parseInputDraftMetadataSnapshot(snapshot)
  if (!parsed) return { ok: false, error: { code: "corrupt" } }
  const encoded = serialize(parsed)
  return encoded.ok ? sink.write(INPUT_DRAFT_METADATA_SNAPSHOT_KEY, encoded.value) : encoded
}

type MigrationMarker = { version: 1; claimedTransportIdentity: string }
const parseMigrationMarker = (value: unknown): MigrationMarker | undefined => isPlainObject(value) && hasOnlyKeys(value, ["version", "claimedTransportIdentity"]) && value.version === 1 && nonEmptyString(value.claimedTransportIdentity) ? { version: 1, claimedTransportIdentity: value.claimedTransportIdentity } : undefined
const markerFor = (claimedTransportIdentity: string): InputDraftMetadataResult<string> => serialize({ version: 1, claimedTransportIdentity })
const stagingSnapshot = (snapshot: InputDraftMetadataSnapshot, legacy: LegacyInputDraft[], claimedTransportIdentity: string): InputDraftMetadataSnapshot => {
  const entries: Record<string, LegacyInputDraft> = {}
  let newEntry: LegacyInputDraft | undefined
  for (const entry of legacy) {
    if (entry.suffix === "new") newEntry = entry
    else entries[entry.suffix] = entry
  }
  return { ...snapshot, migration: { complete: false, claimedTransportIdentity, captured: true, markerCommitted: false, cleanupComplete: false }, legacy: { ...(newEntry ? { new: newEntry } : {}), entries } }
}
const legacyKeys = (snapshot: InputDraftMetadataSnapshot): string[] => [...new Set([snapshot.legacy.new, ...Object.values(snapshot.legacy.entries)].flatMap((entry) => entry?.keys ?? []))]

export type InputDraftMetadataMigrationOptions = { persistenceEnabled?: boolean }
export type InputDraftMetadataRepository = {
  persist: (snapshot: InputDraftMetadataSnapshot) => Promise<InputDraftMetadataResult<void>>
  migrate: (claimedTransportIdentity: string, options?: InputDraftMetadataMigrationOptions) => Promise<InputDraftMetadataResult<InputDraftMetadataSnapshot>>
  flush: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
}

const repositories = new WeakMap<InputDraftMetadataSink, InputDraftMetadataRepository>()

export const createInputDraftMetadataRepository = (sink: InputDraftMetadataSink): InputDraftMetadataRepository => {
  const existing = repositories.get(sink)
  if (existing) return existing
  let tail = Promise.resolve()
  let migration: Promise<InputDraftMetadataResult<InputDraftMetadataSnapshot>> | undefined
  let enabled = true
  const run = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work)
    tail = next.then(() => undefined, () => undefined)
    return next
  }
  const repository: InputDraftMetadataRepository = {
    persist: (snapshot) => {
      const parsed = parseInputDraftMetadataSnapshot(snapshot)
      if (!parsed) return Promise.resolve({ ok: false, error: { code: "corrupt" } })
      if (!enabled) return Promise.resolve(unavailable())
      return run(async () => enabled ? writeInputDraftMetadataSnapshot(sink, parsed) : unavailable())
    },
    migrate: (claimedTransportIdentity, options = {}) => {
      if (migration) return migration
      const current = run(async (): Promise<InputDraftMetadataResult<InputDraftMetadataSnapshot>> => {
        const stored = await readInputDraftMetadataSnapshot(sink)
        if (!stored.ok) return stored
        let snapshot = stored.value ?? emptySnapshot()
        const writesEnabled = enabled && (options.persistenceEnabled ?? true)
        if (!snapshot.migration.captured) {
          const legacy = await readLegacyInputDrafts(sink)
          if (!legacy.ok) return legacy
          if (!writesEnabled) return { ok: true, value: stagingSnapshot(snapshot, legacy.value, "") }
          snapshot = stagingSnapshot(snapshot, legacy.value, claimedTransportIdentity)
          if (!enabled) return { ok: true, value: snapshot }
          const captured = await writeInputDraftMetadataSnapshot(sink, snapshot)
          if (!captured.ok) return captured
        }
        if (!enabled || !(options.persistenceEnabled ?? true)) {
          const legacy = await readLegacyInputDrafts(sink)
          if (!legacy.ok) return legacy
          return { ok: true, value: snapshot }
        }
        const markerRaw = await sink.read(INPUT_DRAFT_METADATA_MIGRATION_MARKER_KEY)
        if (!markerRaw.ok) return markerRaw
        if (markerRaw.value !== null) {
          try {
            const marker = parseMigrationMarker(JSON.parse(markerRaw.value))
            if (!marker) return { ok: false, error: { code: "corrupt" } }
            if (marker.claimedTransportIdentity !== snapshot.migration.claimedTransportIdentity) {
              const encoded = markerFor(snapshot.migration.claimedTransportIdentity)
              if (!encoded.ok) return encoded
              if (!enabled) return { ok: true, value: snapshot }
              const repaired = await sink.write(INPUT_DRAFT_METADATA_MIGRATION_MARKER_KEY, encoded.value)
              if (!repaired.ok) return repaired
            }
          } catch { return { ok: false, error: { code: "corrupt" } } }
        } else {
          const encoded = markerFor(snapshot.migration.claimedTransportIdentity)
          if (!encoded.ok) return encoded
          if (!enabled) return { ok: true, value: snapshot }
          const marked = await sink.write(INPUT_DRAFT_METADATA_MIGRATION_MARKER_KEY, encoded.value)
          if (!marked.ok) return marked
        }
        if (snapshot.migration.cleanupComplete) return { ok: true, value: snapshot }
        for (const key of legacyKeys(snapshot)) {
          if (!enabled) return { ok: true, value: snapshot }
          const removed = await sink.remove(key)
          if (!removed.ok) return removed
        }
        snapshot = { ...snapshot, migration: { complete: true, claimedTransportIdentity: snapshot.migration.claimedTransportIdentity, captured: true, markerCommitted: true, cleanupComplete: true } }
        if (!enabled) return { ok: true, value: snapshot }
        const completed = await writeInputDraftMetadataSnapshot(sink, snapshot)
        return completed.ok ? { ok: true, value: snapshot } : completed
      }).finally(() => { migration = undefined })
      migration = current
      return current
    },
    flush: () => tail,
    setEnabled: async (nextEnabled) => {
      enabled = nextEnabled
      if (!enabled) await tail
    },
  }
  repositories.set(sink, repository)
  return repository
}

export const migrateLegacyInputDraftMetadata = (sink: InputDraftMetadataSink, claimedTransportIdentity: string, options?: InputDraftMetadataMigrationOptions): Promise<InputDraftMetadataResult<InputDraftMetadataSnapshot>> => createInputDraftMetadataRepository(sink).migrate(claimedTransportIdentity, options)

export type InputDraftMetadataPersistenceCoordinator = {
  persist: (snapshot: InputDraftMetadataSnapshot) => Promise<InputDraftMetadataResult<void>>
  cancelPending?: () => void
  flush?: () => Promise<void>
  setEnabled?: (enabled: boolean) => Promise<void>
}

export const createInputDraftMetadataPersistenceCoordinator = (sink: InputDraftMetadataSink): InputDraftMetadataPersistenceCoordinator => {
  const repository = createInputDraftMetadataRepository(sink)
  let enabled = true
  let running = false
  let pending: Array<{ snapshot: InputDraftMetadataSnapshot; resolve: (result: InputDraftMetadataResult<void>) => void }> = []
  let idleResolvers: Array<() => void> = []
  const settleIdle = () => {
    if (running || pending.length > 0) return
    const resolvers = idleResolvers
    idleResolvers = []
    resolvers.forEach((resolve) => resolve())
  }
  const drain = () => {
    if (running) return
    const next = pending.shift()
    if (!next) { settleIdle(); return }
    running = true
    void repository.persist(next.snapshot).then(next.resolve).finally(() => { running = false; drain() })
  }
  return {
    persist: (snapshot) => {
      const parsed = parseInputDraftMetadataSnapshot(snapshot)
      if (!parsed) return Promise.resolve({ ok: false, error: { code: "corrupt" } })
      if (!enabled) return Promise.resolve(unavailable())
      return new Promise((resolve) => { pending.push({ snapshot: parsed, resolve }); drain() })
    },
    cancelPending: () => {
      const cancelledPending = pending
      pending = []
      cancelledPending.forEach(({ resolve }) => resolve(cancelled()))
      settleIdle()
    },
    flush: () => running || pending.length > 0 ? new Promise((resolve) => idleResolvers.push(resolve)) : Promise.resolve(),
    setEnabled: async (nextEnabled) => {
      enabled = nextEnabled
      if (!enabled) {
        const cancelledPending = pending
        pending = []
        cancelledPending.forEach(({ resolve }) => resolve(cancelled()))
      }
      await (running || pending.length > 0 ? new Promise<void>((resolve) => idleResolvers.push(resolve)) : Promise.resolve())
      await repository.setEnabled(nextEnabled)
      await repository.flush()
    },
  }
}
