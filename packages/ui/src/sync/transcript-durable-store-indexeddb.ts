import type { Message, Part } from "@opencode-ai/sdk/v2"

import type {
  TranscriptDurableGeneration,
  TranscriptDurableRecord,
  TranscriptDurableRow,
  TranscriptDurableScope,
  TranscriptDurableStore,
  TranscriptEvictToBytesOptions,
  TranscriptPartCompleteness,
  TranscriptRecordCompleteness,
  TranscriptSortKey,
  TranscriptUpsertResult,
} from "./transcript-durable-store"
import {
  cloneTranscriptScope,
  cloneTranscriptValue,
  compareTranscriptSortKey,
  createTranscriptMonotonicClock,
  decideTranscriptUpsertSettled,
  fingerprintTranscriptContent,
  sessionFromTranscriptRows,
  snapshotTranscriptDurableRecord,
  transcriptDurableGenerationKey,
  transcriptDurableIdentityKey,
  transcriptDurableScopeKey,
  transcriptPartCompleteness,
  transcriptRecordCompleteness,
  transcriptSortKeyOf,
} from "./transcript-durable-store"

const DATABASE_NAME = "openchamber-transcript-durable"
const DATABASE_VERSION = 1
const INDEX_STORE = "transcriptIndex"
const CONTENT_STORE = "transcriptContent"

/**
 * Light index: identity, sort key, hash, slim/full marks, byte size, LRU time.
 * Content lives in the sibling store so eviction can rank rows without loading parts.
 */
export type TranscriptIndexRow = {
  id: string
  scope: TranscriptDurableScope
  scopeKey: string
  generationKey: string
  messageID: string
  sortKey: TranscriptSortKey
  contentHash: string
  completeness: TranscriptRecordCompleteness
  partCompleteness: TranscriptPartCompleteness[]
  byteSize: number
  lastAccessedAt: number
}

/** Content table: identity → info + parts. Never used as a sort or eviction key. */
export type TranscriptContentRow = {
  id: string
  info: Message
  parts: Part[]
}

export type TranscriptDurableStoreTransaction = {
  getIndex: (id: string) => Promise<TranscriptIndexRow | undefined>
  getAllIndexes: () => Promise<TranscriptIndexRow[]>
  getIndexesByScope: (scopeKey: string) => Promise<TranscriptIndexRow[]>
  getIndexesByGeneration: (generationKey: string) => Promise<TranscriptIndexRow[]>
  putIndex: (row: TranscriptIndexRow) => Promise<void>
  deleteIndex: (id: string) => Promise<void>
  getContent: (id: string) => Promise<TranscriptContentRow | undefined>
  putContent: (row: TranscriptContentRow) => Promise<void>
  deleteContent: (id: string) => Promise<void>
  /** Drop every index + content row in this transaction. */
  clearAll: () => Promise<void>
}

export type TranscriptDurableStoreDriver = {
  transaction: <T>(action: (transaction: TranscriptDurableStoreTransaction) => Promise<T>) => Promise<T>
  destroy: () => Promise<void>
}

export type IndexedDBTranscriptDurableStoreOptions = {
  databaseName?: string
  now?: () => number
  driver?: TranscriptDurableStoreDriver
}

class Failure extends Error {
  constructor(readonly code: "database-unavailable") {
    super(code)
  }
}

const toIndexRow = (row: TranscriptDurableRow): TranscriptIndexRow => ({
  id: transcriptDurableIdentityKey(row.scope, row.messageID),
  scope: cloneTranscriptScope(row.scope),
  scopeKey: transcriptDurableScopeKey(row.scope),
  generationKey: transcriptDurableGenerationKey(row.scope),
  messageID: row.messageID,
  sortKey: { created: row.sortKey.created, messageID: row.sortKey.messageID },
  contentHash: row.contentHash,
  completeness: row.completeness,
  partCompleteness: row.partCompleteness.slice(),
  byteSize: row.byteSize,
  lastAccessedAt: row.lastAccessedAt,
})

const joinRow = (index: TranscriptIndexRow, content: TranscriptContentRow): TranscriptDurableRow => ({
  scope: cloneTranscriptScope(index.scope),
  messageID: index.messageID,
  info: cloneTranscriptValue(content.info),
  parts: cloneTranscriptValue(content.parts),
  partCompleteness: index.partCompleteness.slice(),
  completeness: index.completeness,
  contentHash: index.contentHash,
  byteSize: index.byteSize,
  lastAccessedAt: index.lastAccessedAt,
  sortKey: { created: index.sortKey.created, messageID: index.sortKey.messageID },
})

/**
 * Index and content must move together. A leftover half-row after a crash would
 * make `readSession` lie about a message that has no body (or a body with no
 * timeline slot). Drop the orphan in the same transaction that noticed it.
 */
const loadJoined = async (
  transaction: TranscriptDurableStoreTransaction,
  id: string,
): Promise<TranscriptDurableRow | undefined> => {
  const index = await transaction.getIndex(id)
  const content = await transaction.getContent(id)
  if (index && content) return joinRow(index, content)
  if (index) await transaction.deleteIndex(id)
  if (content) await transaction.deleteContent(id)
  return undefined
}

const deleteBoth = async (transaction: TranscriptDurableStoreTransaction, id: string): Promise<void> => {
  await transaction.deleteIndex(id)
  await transaction.deleteContent(id)
}

/**
 * Two-store Memory driver for bun contract tests.
 *
 * Same transaction shape as IndexedDB: copies both maps, commits only if the
 * action returns. Lets the adapter suite run without a Chromium IndexedDB.
 */
export class MemoryTranscriptDurableTwoStoreDriver implements TranscriptDurableStoreDriver {
  private indexes = new Map<string, TranscriptIndexRow>()
  private contents = new Map<string, TranscriptContentRow>()
  private tail = Promise.resolve()

  transaction<T>(action: (transaction: TranscriptDurableStoreTransaction) => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const indexes = new Map(this.indexes)
      const contents = new Map(this.contents)
      const transaction: TranscriptDurableStoreTransaction = {
        getIndex: async (id) => indexes.get(id),
        getAllIndexes: async () => [...indexes.values()],
        getIndexesByScope: async (scopeKey) => [...indexes.values()].filter((row) => row.scopeKey === scopeKey),
        getIndexesByGeneration: async (generationKey) => [...indexes.values()].filter((row) => row.generationKey === generationKey),
        putIndex: async (row) => {
          indexes.set(row.id, row)
        },
        deleteIndex: async (id) => {
          indexes.delete(id)
        },
        getContent: async (id) => contents.get(id),
        putContent: async (row) => {
          contents.set(row.id, row)
        },
        deleteContent: async (id) => {
          contents.delete(id)
        },
        clearAll: async () => {
          indexes.clear()
          contents.clear()
        },
      }
      const output = await action(transaction)
      this.indexes = indexes
      this.contents = contents
      return output
    })
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  async destroy(): Promise<void> {
    this.indexes.clear()
    this.contents.clear()
  }
}

const wrapRequest = <V>(request: IDBRequest<V>, transaction: IDBTransaction): Promise<V> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? transaction.error ?? new Error("IndexedDB request failed"))
  })

const openDatabase = (databaseName: string): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Failure("database-unavailable"))
      return
    }
    const request = indexedDB.open(databaseName, DATABASE_VERSION)
    let settled = false
    const fail = (): void => {
      if (!settled) {
        settled = true
        reject(new Failure("database-unavailable"))
      }
    }
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(INDEX_STORE)) {
        const index = database.createObjectStore(INDEX_STORE, { keyPath: "id" })
        index.createIndex("scopeKey", "scopeKey", { unique: false })
        index.createIndex("generationKey", "generationKey", { unique: false })
        index.createIndex("lastAccessedAt", "lastAccessedAt", { unique: false })
      }
      if (!database.objectStoreNames.contains(CONTENT_STORE)) {
        database.createObjectStore(CONTENT_STORE, { keyPath: "id" })
      }
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => database.close()
      if (settled) {
        database.close()
        return
      }
      settled = true
      resolve(database)
    }
    request.onerror = fail
    request.onblocked = fail
  })

const deleteDatabase = (databaseName: string): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      resolve()
      return
    }
    const request = indexedDB.deleteDatabase(databaseName)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Failure("database-unavailable"))
    // onsuccess still fires after blocked connections close; wait rather than fail.
    request.onblocked = () => undefined
  })

/**
 * IndexedDB driver. Open / transaction / abort / close matches
 * `createIndexedDBInputDraftBlobDriver`: one connection per action, both
 * object stores in the same readwrite transaction, close in `finally`.
 */
export const createIndexedDBTranscriptDurableDriver = (
  databaseName = DATABASE_NAME,
): TranscriptDurableStoreDriver => ({
  transaction: async <T>(action: (transaction: TranscriptDurableStoreTransaction) => Promise<T>) => {
    const database = await openDatabase(databaseName)
    const transaction = database.transaction([INDEX_STORE, CONTENT_STORE], "readwrite")
    const indexes = transaction.objectStore(INDEX_STORE)
    const contents = transaction.objectStore(CONTENT_STORE)
    const wrap = <V>(request: IDBRequest<V>): Promise<V> => wrapRequest(request, transaction)
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new DOMException("aborted", "AbortError"))
      transaction.onerror = () => {
        console.error("Transcript durable IndexedDB transaction error", transaction.error)
      }
    })
    let actionError: unknown
    try {
      const output = await action({
        getIndex: (id) => wrap<TranscriptIndexRow | undefined>(indexes.get(id)),
        getAllIndexes: () => wrap<TranscriptIndexRow[]>(indexes.getAll()),
        getIndexesByScope: (scopeKey) => wrap<TranscriptIndexRow[]>(indexes.index("scopeKey").getAll(scopeKey)),
        getIndexesByGeneration: (generationKey) =>
          wrap<TranscriptIndexRow[]>(indexes.index("generationKey").getAll(generationKey)),
        putIndex: async (row) => {
          await wrap(indexes.put(row))
        },
        deleteIndex: async (id) => {
          await wrap(indexes.delete(id))
        },
        getContent: (id) => wrap<TranscriptContentRow | undefined>(contents.get(id)),
        putContent: async (row) => {
          await wrap(contents.put(row))
        },
        deleteContent: async (id) => {
          await wrap(contents.delete(id))
        },
        clearAll: async () => {
          await wrap(indexes.clear())
          await wrap(contents.clear())
        },
      })
      await done
      return output
    } catch (error) {
      actionError = error
      try {
        transaction.abort()
      } catch {
        /* The transaction has reached a terminal state. */
      }
      try {
        await done
      } catch (terminalError) {
        if (actionError === undefined) actionError = terminalError
      }
      throw actionError
    } finally {
      database.close()
    }
  },
  destroy: () => deleteDatabase(databaseName),
})

/**
 * Store logic over the two-store driver. IndexedDB and the bun Memory driver
 * share this so contract behavior cannot fork from the Chromium adapter.
 *
 * `fingerprintTranscriptContent` runs *before* the transaction: `crypto.subtle`
 * is not an IDB request, and awaiting it inside a transaction would let
 * Chromium auto-commit the pair of stores.
 */
export function createTranscriptDurableStoreFromDriver(
  driver: TranscriptDurableStoreDriver,
  options: Pick<IndexedDBTranscriptDurableStoreOptions, "now"> = {},
): TranscriptDurableStore {
  const now = createTranscriptMonotonicClock(options.now ?? Date.now)

  const persistTouch = async (
    transaction: TranscriptDurableStoreTransaction,
    row: TranscriptDurableRow,
  ): Promise<TranscriptDurableRecord> => {
    row.lastAccessedAt = now()
    await transaction.putIndex(toIndexRow(row))
    return snapshotTranscriptDurableRecord(row)
  }

  return {
    async readSession(scope) {
      return driver.transaction(async (transaction) => {
        const indexes = await transaction.getIndexesByScope(transcriptDurableScopeKey(scope))
        const rows: TranscriptDurableRow[] = []
        for (const index of indexes) {
          const content = await transaction.getContent(index.id)
          if (!content) {
            await transaction.deleteIndex(index.id)
            continue
          }
          const row = joinRow(index, content)
          row.lastAccessedAt = now()
          await transaction.putIndex(toIndexRow(row))
          rows.push(row)
        }
        return sessionFromTranscriptRows(scope, rows)
      })
    },

    async readMessage(scope, messageID) {
      return driver.transaction(async (transaction) => {
        const row = await loadJoined(transaction, transcriptDurableIdentityKey(scope, messageID))
        if (!row) return undefined
        return persistTouch(transaction, row)
      })
    },

    async upsertSettled(scope, info, parts) {
      const early = decideTranscriptUpsertSettled({
        info,
        incomingCompleteness: transcriptRecordCompleteness(parts),
      })
      if (early.status === "skipped" && early.reason === "not-settled") {
        return { status: "skipped", reason: "not-settled" }
      }

      const incomingParts = cloneTranscriptValue(parts.slice())
      const completeness = transcriptRecordCompleteness(incomingParts)
      const fingerprint = await fingerprintTranscriptContent(info, incomingParts)
      const identity = transcriptDurableIdentityKey(scope, info.id)

      return driver.transaction(async (transaction): Promise<TranscriptUpsertResult> => {
        const existing = await loadJoined(transaction, identity)
        const decision = decideTranscriptUpsertSettled({
          info,
          existing,
          incomingCompleteness: completeness,
          incomingHash: fingerprint.hash,
        })
        if (decision.status === "skipped") {
          if (decision.reason === "slim-downgrade" && existing) {
            return { status: "skipped", reason: "slim-downgrade", record: snapshotTranscriptDurableRecord(existing) }
          }
          if (decision.reason === "unchanged" && existing) {
            return { status: "skipped", reason: "unchanged", record: await persistTouch(transaction, existing) }
          }
          return { status: "skipped", reason: decision.reason }
        }

        const row: TranscriptDurableRow = {
          scope: cloneTranscriptScope(scope),
          messageID: info.id,
          info: cloneTranscriptValue(info),
          parts: incomingParts,
          partCompleteness: incomingParts.map(transcriptPartCompleteness),
          completeness,
          contentHash: fingerprint.hash,
          byteSize: fingerprint.byteSize,
          lastAccessedAt: now(),
          sortKey: transcriptSortKeyOf(info),
        }
        await transaction.putIndex(toIndexRow(row))
        await transaction.putContent({
          id: identity,
          info: cloneTranscriptValue(info),
          parts: incomingParts,
        })
        return { status: "written", record: snapshotTranscriptDurableRecord(row) }
      })
    },

    async removeMessage(scope, messageID) {
      await driver.transaction((transaction) => deleteBoth(transaction, transcriptDurableIdentityKey(scope, messageID)))
    },

    async clearSession(scope) {
      await driver.transaction(async (transaction) => {
        const indexes = await transaction.getIndexesByScope(transcriptDurableScopeKey(scope))
        for (const index of indexes) await deleteBoth(transaction, index.id)
      })
    },

    async clearGeneration(generation: TranscriptDurableGeneration) {
      await driver.transaction(async (transaction) => {
        const indexes = await transaction.getIndexesByGeneration(transcriptDurableGenerationKey(generation))
        for (const index of indexes) await deleteBoth(transaction, index.id)
      })
    },

    async evictToBytes(maxBytes, options?: TranscriptEvictToBytesOptions) {
      return driver.transaction(async (transaction) => {
        const budget = Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : 0
        const protectedKeys = new Set((options?.protect ?? []).map(transcriptDurableScopeKey))
        const indexes = await transaction.getAllIndexes()
        let remainingBytes = 0
        for (const index of indexes) remainingBytes += index.byteSize
        if (remainingBytes <= budget) {
          return { evicted: 0, freedBytes: 0, remainingBytes }
        }

        const candidates = indexes
          .filter((index) => !protectedKeys.has(index.scopeKey))
          .sort((left, right) => {
            if (left.lastAccessedAt !== right.lastAccessedAt) return left.lastAccessedAt - right.lastAccessedAt
            return compareTranscriptSortKey(left.sortKey, right.sortKey)
          })

        let evicted = 0
        let freedBytes = 0
        for (const index of candidates) {
          if (remainingBytes <= budget) break
          await deleteBoth(transaction, index.id)
          remainingBytes -= index.byteSize
          freedBytes += index.byteSize
          evicted += 1
        }
        return { evicted, freedBytes, remainingBytes }
      })
    },

    async clearAll() {
      await driver.transaction(async (transaction) => {
        await transaction.clearAll()
      })
    },

    async destroy() {
      await driver.destroy()
    },
  }
}

/**
 * Production IndexedDB adapter. Pass `databaseName` to isolate tests; omit it
 * for the shared `openchamber-transcript-durable` database.
 */
export function createIndexedDBTranscriptDurableStore(
  options: IndexedDBTranscriptDurableStoreOptions = {},
): TranscriptDurableStore {
  const driver = options.driver ?? createIndexedDBTranscriptDurableDriver(options.databaseName)
  return createTranscriptDurableStoreFromDriver(driver, options)
}
