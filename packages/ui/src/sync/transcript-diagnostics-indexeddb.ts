import {
  TRANSCRIPT_DIAGNOSTICS_LIMIT,
  type TranscriptDiagnosticsEvent,
  type TranscriptDiagnosticsSink,
} from "./transcript-diagnostics"

const DATABASE_NAME = "openchamber-transcript-diagnostics"
const STORE_NAME = "events"
const DATABASE_VERSION = 1

export type TranscriptDiagnosticsDriver = {
  append: (event: TranscriptDiagnosticsEvent, limit: number) => Promise<void>
  read: () => Promise<readonly TranscriptDiagnosticsEvent[]>
  clear: () => Promise<void>
}

const wrapRequest = <V>(request: IDBRequest<V>): Promise<V> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"))
  })

const openDatabase = (name: string): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error("IndexedDB unavailable"))
      return
    }
    const request = indexedDB.open(name, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { autoIncrement: true })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"))
  })

export const createIndexedDBTranscriptDiagnosticsDriver = (
  databaseName = DATABASE_NAME,
): TranscriptDiagnosticsDriver => ({
  async append(event, limit) {
    const database = await openDatabase(databaseName)
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite")
      const store = transaction.objectStore(STORE_NAME)
      await wrapRequest(store.add(event))
      const keys = await wrapRequest(store.getAllKeys())
      const overflow = keys.length - limit
      if (overflow > 0) {
        for (const key of keys.slice(0, overflow)) {
          await wrapRequest(store.delete(key))
        }
      }
    } finally {
      database.close()
    }
  },
  async read() {
    const database = await openDatabase(databaseName)
    try {
      const transaction = database.transaction(STORE_NAME, "readonly")
      const store = transaction.objectStore(STORE_NAME)
      return await wrapRequest(store.getAll())
    } finally {
      database.close()
    }
  },
  async clear() {
    const database = await openDatabase(databaseName)
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite")
      await wrapRequest(transaction.objectStore(STORE_NAME).clear())
    } finally {
      database.close()
    }
  },
})

export function createIndexedDBTranscriptDiagnosticsSink(
  options: { databaseName?: string; limit?: number; driver?: TranscriptDiagnosticsDriver } = {},
): TranscriptDiagnosticsSink {
  const driver = options.driver ?? createIndexedDBTranscriptDiagnosticsDriver(options.databaseName)
  const limit = options.limit ?? TRANSCRIPT_DIAGNOSTICS_LIMIT
  return {
    append: (event) => driver.append(event, limit),
    read: () => driver.read(),
    clear: () => driver.clear(),
  }
}
