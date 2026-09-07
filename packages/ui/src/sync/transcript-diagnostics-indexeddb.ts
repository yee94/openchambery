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

type PendingItem = {
  seq: number
  event: TranscriptDiagnosticsEvent
  resolve: () => void
  reject: (error: unknown) => void
}

const readRequestError = (request: { error: DOMException | null }, fallback: string): Error => {
  try {
    return request.error ?? new Error(fallback)
  } catch {
    // Some engines throw InvalidStateError when reading .error while still pending.
    return new Error(fallback)
  }
}

const wrapRequest = <V>(request: IDBRequest<V>, transaction?: IDBTransaction): Promise<V> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      try {
        reject(request.error ?? transaction?.error ?? new Error("IndexedDB request failed"))
      } catch {
        reject(transaction?.error ?? new Error("IndexedDB request failed"))
      }
    }
  })

const openDatabaseOnce = (name: string): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error("IndexedDB unavailable"))
      return
    }
    const request = indexedDB.open(name, DATABASE_VERSION)
    let settled = false
    const fail = (): void => {
      if (settled) return
      settled = true
      reject(readRequestError(request, "IndexedDB open failed"))
    }
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { autoIncrement: true })
      }
    }
    request.onsuccess = () => {
      const database = request.result
      if (settled) {
        // Late success after blocked/error: never leak the handle.
        try {
          database.close()
        } catch {
          // Already closing.
        }
        return
      }
      settled = true
      resolve(database)
    }
    request.onerror = fail
    // Blocked is not the same as error; do not touch request.error while pending.
    request.onblocked = fail
  })

/**
 * IndexedDB ring-buffer driver with connection reuse and coalesced appends.
 *
 * - One live connection, single-flight open, versionchange/close recovery
 * - Append batches share one readwrite transaction (add + trim to limit)
 * - Single in-flight/scheduled flush merges many appends (no per-append chain node)
 * - Each flush captures one batch at the exclusive boundary (no while-drain of
 *   post-read/clear appends in the same turn)
 * - Pending queue is bounded to `limit` (same last-N semantics as the store)
 * - read/clear use call-time seq barriers so later appends are kept and reads
 *   only observe data accepted at or before the call
 * - clear drops pre-barrier pending and failed re-queues (no resurrection)
 * - Failures invalidate the connection; IDB abort rolls the whole transaction back
 */
export const createIndexedDBTranscriptDiagnosticsDriver = (
  databaseName = DATABASE_NAME,
): TranscriptDiagnosticsDriver => {
  let database: IDBDatabase | null = null
  let openFlight: Promise<IDBDatabase> | null = null
  let chain: Promise<void> = Promise.resolve()
  let pending: PendingItem[] = []
  let pendingLimit = TRANSCRIPT_DIAGNOSTICS_LIMIT
  let nextSeq = 0
  /** Coalesced flush: at most one scheduled/in-flight exclusive flush task. */
  let flushFlight: Promise<void> | null = null
  /**
   * Call-time clear/read barriers still waiting on the exclusive chain. A flush
   * that runs before those ops may only write seq <= barrier; later appends stay
   * queued so clear cannot wipe after-clear data and read cannot observe them.
   */
  let pendingOpBarriers: number[] = []

  const invalidateConnection = (): void => {
    const current = database
    database = null
    openFlight = null
    if (current) {
      try {
        current.onversionchange = null
        current.onclose = null
        current.close()
      } catch {
        // Connection may already be closing.
      }
    }
  }

  const bindDatabase = (next: IDBDatabase): IDBDatabase => {
    next.onversionchange = () => {
      invalidateConnection()
    }
    next.onclose = () => {
      if (database === next) {
        database = null
        openFlight = null
      }
    }
    database = next
    return next
  }

  const ensureDatabase = (): Promise<IDBDatabase> => {
    if (database) return Promise.resolve(database)
    if (openFlight) return openFlight
    openFlight = openDatabaseOnce(databaseName)
      .then((opened) => {
        openFlight = null
        return bindDatabase(opened)
      })
      .catch((error) => {
        openFlight = null
        throw error
      })
    return openFlight
  }

  const runExclusive = <T>(action: () => Promise<T>): Promise<T> => {
    const run = chain.then(action, action)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const withStore = async <T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> => {
    const db = await ensureDatabase()
    let transaction: IDBTransaction
    try {
      transaction = db.transaction(STORE_NAME, mode)
    } catch (error) {
      // Closed/closing connections throw InvalidStateError before try/action.
      invalidateConnection()
      throw error
    }
    const store = transaction.objectStore(STORE_NAME)
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onabort = () =>
        reject(transaction.error ?? new DOMException("aborted", "AbortError"))
      transaction.onerror = () => {
        // Terminal state arrives via onabort/oncomplete; keep noise low.
      }
    })
    let actionError: unknown
    try {
      const output = await action(store)
      await done
      return output
    } catch (error) {
      actionError = error
      try {
        transaction.abort()
      } catch {
        // Transaction already terminal.
      }
      try {
        await done
      } catch (terminalError) {
        if (actionError === undefined) actionError = terminalError
      }
      invalidateConnection()
      throw actionError
    }
  }

  const settleResolve = (items: PendingItem[]): void => {
    for (const item of items) item.resolve()
  }

  const settleReject = (items: PendingItem[], error: unknown): void => {
    for (const item of items) item.reject(error)
  }

  const trimPending = (limit: number): void => {
    if (pending.length <= limit) return
    const dropped = pending.splice(0, pending.length - limit)
    // Ring-dropped before durable write: still accepted then bounded.
    settleResolve(dropped)
  }

  const writeEvents = async (
    events: readonly TranscriptDiagnosticsEvent[],
    limit: number,
  ): Promise<void> => {
    if (events.length === 0) return
    await withStore("readwrite", async (store) => {
      for (const event of events) {
        await wrapRequest(store.add(event), store.transaction)
      }
      const keys = await wrapRequest(store.getAllKeys(), store.transaction)
      const overflow = keys.length - limit
      if (overflow > 0) {
        for (const key of keys.slice(0, overflow)) {
          await wrapRequest(store.delete(key), store.transaction)
        }
      }
    })
  }

  const activeWriteCeiling = (): number => {
    if (pendingOpBarriers.length === 0) return Number.POSITIVE_INFINITY
    return Math.min(...pendingOpBarriers)
  }

  /**
   * Capture one batch at this exclusive boundary. When a read/clear is already
   * queued, only seq <= that barrier is written; later appends remain pending.
   * No while-drain — follow-up appends schedule a new coalesced flight.
   */
  /** @returns whether any events were written (false if idle or blocked by op barrier). */
  const flushCapturedPending = async (): Promise<boolean> => {
    if (pending.length === 0) return false
    const ceiling = activeWriteCeiling()
    const batch = pending.filter((item) => item.seq <= ceiling)
    if (batch.length === 0) return false
    pending = pending.filter((item) => item.seq > ceiling)
    const limit = pendingLimit
    try {
      await writeEvents(
        batch.map((item) => item.event),
        limit,
      )
      settleResolve(batch)
      return true
    } catch (error) {
      // Preserve last-N + FIFO: re-queue events ahead of newer pending.
      // Original waiters reject; a later op retries durable write without new waiters.
      // Full transaction abort rolls back every add (no half-commit / duplicate key).
      const retry: PendingItem[] = batch.map((item) => ({
        seq: item.seq,
        event: item.event,
        resolve: () => {},
        reject: () => {},
      }))
      pending = retry.concat(pending)
      trimPending(limit)
      settleReject(batch, error)
      throw error
    }
  }

  /**
   * Flush only items accepted at or before `barrier` (call-time seq).
   * Later appends stay queued for a subsequent operation.
   */
  const flushUpToBarrier = async (barrier: number): Promise<void> => {
    if (pending.length === 0) return
    const batch = pending.filter((item) => item.seq <= barrier)
    if (batch.length === 0) return
    pending = pending.filter((item) => item.seq > barrier)
    const limit = pendingLimit
    try {
      await writeEvents(
        batch.map((item) => item.event),
        limit,
      )
      settleResolve(batch)
    } catch (error) {
      const retry: PendingItem[] = batch.map((item) => ({
        seq: item.seq,
        event: item.event,
        resolve: () => {},
        reject: () => {},
      }))
      pending = retry.concat(pending)
      trimPending(limit)
      settleReject(batch, error)
      throw error
    }
  }

  const scheduleFlush = (): void => {
    if (flushFlight) return
    flushFlight = runExclusive(async () => {
      let wrote = false
      try {
        wrote = await flushCapturedPending()
      } finally {
        flushFlight = null
      }
      // Follow-up only when this turn wrote and newer appends remain.
      // If a read/clear barrier blocked the batch, that op's finally kicks flush.
      // Failed re-queues wait for the next explicit append/read (no tight retry loop).
      if (wrote && pending.length > 0) scheduleFlush()
    }).then(
      () => undefined,
      () => {
        flushFlight = null
      },
    )
  }

  return {
    append(event, limit) {
      pendingLimit = limit
      return new Promise<void>((resolve, reject) => {
        pending.push({ seq: ++nextSeq, event, resolve, reject })
        trimPending(limit)
        scheduleFlush()
      })
    },
    read() {
      const barrier = nextSeq
      // Publish before enqueue so an earlier flush cannot commit post-read appends
      // into the snapshot this read will return.
      pendingOpBarriers.push(barrier)
      return runExclusive(async () => {
        try {
          await flushUpToBarrier(barrier)
          return await withStore("readonly", (store) =>
            wrapRequest(store.getAll(), store.transaction),
          )
        } finally {
          pendingOpBarriers = pendingOpBarriers.filter((value) => value !== barrier)
          if (pending.length > 0) scheduleFlush()
        }
      })
    },
    clear() {
      const barrier = nextSeq
      // Publish barrier before enqueue so an earlier-scheduled flush cannot write
      // after-clear appends into the store that this clear will wipe.
      pendingOpBarriers.push(barrier)
      return runExclusive(async () => {
        try {
          // Drop pre-barrier pending (including failed re-queues). Keep after-clear appends.
          const kept: PendingItem[] = []
          const dropped: PendingItem[] = []
          for (const item of pending) {
            if (item.seq <= barrier) dropped.push(item)
            else kept.push(item)
          }
          pending = kept
          settleResolve(dropped)
          await withStore("readwrite", async (store) => {
            await wrapRequest(store.clear(), store.transaction)
          })
        } finally {
          pendingOpBarriers = pendingOpBarriers.filter((value) => value !== barrier)
          // After-clear appends may still be pending; kick one coalesced flush.
          if (pending.length > 0) scheduleFlush()
        }
      })
    },
  }
}

export function createIndexedDBTranscriptDiagnosticsSink(
  options: {
    databaseName?: string
    limit?: number
    driver?: TranscriptDiagnosticsDriver
  } = {},
): TranscriptDiagnosticsSink {
  const driver = options.driver ?? createIndexedDBTranscriptDiagnosticsDriver(options.databaseName)
  const limit = options.limit ?? TRANSCRIPT_DIAGNOSTICS_LIMIT
  return {
    append: (event) => driver.append(event, limit),
    read: () => driver.read(),
    clear: () => driver.clear(),
  }
}
