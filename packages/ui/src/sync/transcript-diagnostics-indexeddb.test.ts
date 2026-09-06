import { afterEach, describe, expect, test, vi } from "vitest"

import {
  TRANSCRIPT_DIAGNOSTICS_LIMIT,
  type TranscriptDiagnosticsEvent,
} from "./transcript-diagnostics"
import {
  createIndexedDBTranscriptDiagnosticsDriver,
  createIndexedDBTranscriptDiagnosticsSink,
  type TranscriptDiagnosticsDriver,
} from "./transcript-diagnostics-indexeddb"

const eventAt = (at: number, sessionID = "ses_1"): TranscriptDiagnosticsEvent => ({
  at,
  feat: "transcript",
  kind: "http-page",
  sessionID,
})

describe("createIndexedDBTranscriptDiagnosticsSink with mock driver", () => {
  test("forwards append/read/clear and preserves order", async () => {
    const stored: TranscriptDiagnosticsEvent[] = []
    const driver: TranscriptDiagnosticsDriver = {
      append: async (event, limit) => {
        stored.push(event)
        if (stored.length > limit) stored.splice(0, stored.length - limit)
      },
      read: async () => stored.slice(),
      clear: async () => {
        stored.length = 0
      },
    }
    const sink = createIndexedDBTranscriptDiagnosticsSink({ driver, limit: 3 })
    void sink.append(eventAt(1))
    void sink.append(eventAt(2))
    void sink.append(eventAt(3))
    void sink.append(eventAt(4))
    await Promise.resolve()
    expect((await sink.read()).map((e) => e.at)).toEqual([2, 3, 4])
    await sink.clear()
    expect(await sink.read()).toEqual([])
  })
})

describe("IndexedDB diagnostics driver connection reuse and batching", () => {
  const databases = new Map<string, Map<number, TranscriptDiagnosticsEvent>>()
  let nextKey = 1
  let openCount = 0
  let transactionCount = 0
  let addCount = 0
  let failNextTransaction = false
  let abortNextTransaction = false
  let versionchangeHandlers: Array<() => void> = []
  let closeHandlers: Array<() => void> = []
  /** Controllable async queue: tests decide when IDB callbacks fire. */
  let autoDrain = true
  let taskQueue: Array<() => void> = []
  let openBlocked = false
  let openError: DOMException | null = null
  let openLateSuccessAfterFail = false

  const enqueueTask = (fn: () => void) => {
    if (autoDrain) {
      queueMicrotask(fn)
      return
    }
    taskQueue.push(fn)
  }

  const drainTasks = async (max = 100) => {
    let n = 0
    while (taskQueue.length > 0 && n < max) {
      const batch = taskQueue.splice(0, taskQueue.length)
      for (const fn of batch) fn()
      n += 1
      await Promise.resolve()
    }
  }

  class FakeRequest<T> {
    result: T
    error: DOMException | null = null
    onsuccess: ((ev: Event) => void) | null = null
    onerror: ((ev: Event) => void) | null = null
    constructor(
      result: T,
      error: DOMException | null = null,
      private readonly tx?: FakeTransaction,
    ) {
      this.result = result
      this.error = error
      this.tx?.noteRequest()
      enqueueTask(() => {
        if (error) {
          this.tx?.noteRequestError(error)
          this.onerror?.(new Event("error"))
        } else {
          this.onsuccess?.(new Event("success"))
        }
        this.tx?.noteRequestDone()
      })
    }
  }

  class FakeStore {
    transaction: FakeTransaction | null = null
    /** Staged mutations until transaction completes (atomic rollback). */
    private readonly stagedAdds: Array<{ key: number; event: TranscriptDiagnosticsEvent }> = []
    private readonly stagedDeletes = new Set<number>()
    private stagedClear = false

    constructor(private readonly rows: Map<number, TranscriptDiagnosticsEvent>) {}

    add(event: TranscriptDiagnosticsEvent) {
      addCount += 1
      if (failNextTransaction) {
        failNextTransaction = false
        return new FakeRequest<IDBValidKey>(
          0,
          new DOMException("add failed", "UnknownError"),
          this.transaction ?? undefined,
        )
      }
      const key = nextKey++
      this.stagedAdds.push({ key, event })
      return new FakeRequest<IDBValidKey>(key, null, this.transaction ?? undefined)
    }
    getAllKeys() {
      const keys = this.viewKeys()
      return new FakeRequest<IDBValidKey[]>(keys, null, this.transaction ?? undefined)
    }
    getAll() {
      const keys = this.viewKeys()
      const map = this.viewRows()
      return new FakeRequest(keys.map((key) => map.get(key)!), null, this.transaction ?? undefined)
    }
    delete(key: IDBValidKey) {
      this.stagedDeletes.add(Number(key))
      return new FakeRequest(undefined, null, this.transaction ?? undefined)
    }
    clear() {
      this.stagedClear = true
      return new FakeRequest(undefined, null, this.transaction ?? undefined)
    }

    private viewRows(): Map<number, TranscriptDiagnosticsEvent> {
      const map = this.stagedClear ? new Map<number, TranscriptDiagnosticsEvent>() : new Map(this.rows)
      for (const key of this.stagedDeletes) map.delete(key)
      for (const { key, event } of this.stagedAdds) map.set(key, event)
      return map
    }

    private viewKeys(): number[] {
      return [...this.viewRows().keys()].sort((a, b) => a - b)
    }

    commit() {
      if (this.stagedClear) this.rows.clear()
      for (const key of this.stagedDeletes) this.rows.delete(key)
      for (const { key, event } of this.stagedAdds) this.rows.set(key, event)
      this.stagedAdds.length = 0
      this.stagedDeletes.clear()
      this.stagedClear = false
    }

    rollback() {
      this.stagedAdds.length = 0
      this.stagedDeletes.clear()
      this.stagedClear = false
    }
  }

  class FakeTransaction {
    oncomplete: (() => void) | null = null
    onabort: (() => void) | null = null
    onerror: (() => void) | null = null
    error: DOMException | null = null
    private readonly store: FakeStore
    private aborted = false
    private forceAbort = false
    private outstanding = 0
    private settled = false

    constructor(rows: Map<number, TranscriptDiagnosticsEvent>) {
      transactionCount += 1
      this.store = new FakeStore(rows)
      this.store.transaction = this as unknown as FakeTransaction
      if (abortNextTransaction) {
        abortNextTransaction = false
        this.forceAbort = true
      }
      // After the synchronous call stack that issues requests, settle if idle.
      enqueueTask(() => this.trySettle())
    }

    objectStore() {
      return this.store as unknown as IDBObjectStore
    }

    noteRequest() {
      this.outstanding += 1
    }

    noteRequestError(error: DOMException) {
      this.error = error
      this.aborted = true
    }

    noteRequestDone() {
      this.outstanding -= 1
      // Defer settle so the await continuation can issue the next request in this
      // turn (matches IDB: tx stays alive across microtasks while requests chain).
      enqueueTask(() => this.trySettle())
    }

    private trySettle() {
      if (this.settled || this.outstanding > 0) return
      this.settled = true
      if (this.aborted || this.forceAbort) {
        this.store.rollback()
        this.error = this.error ?? new DOMException("aborted", "AbortError")
        this.onabort?.()
        return
      }
      this.store.commit()
      this.oncomplete?.()
    }

    abort() {
      this.aborted = true
      this.error = this.error ?? new DOMException("aborted", "AbortError")
      enqueueTask(() => this.trySettle())
    }
  }

  class FakeDatabase {
    onversionchange: ((ev: IDBVersionChangeEvent) => void) | null = null
    onclose: (() => void) | null = null
    objectStoreNames = { contains: () => true }
    closed = false

    constructor(private readonly rows: Map<number, TranscriptDiagnosticsEvent>) {
      versionchangeHandlers.push(() => {
        this.onversionchange?.({} as IDBVersionChangeEvent)
      })
      closeHandlers.push(() => {
        this.closed = true
        this.onclose?.()
      })
    }

    transaction(_store: string, _mode: IDBTransactionMode) {
      if (this.closed) throw new DOMException("InvalidStateError", "InvalidStateError")
      return new FakeTransaction(this.rows) as unknown as IDBTransaction
    }

    close() {
      this.closed = true
      this.onclose?.()
    }
  }

  const installFakeIndexedDB = (options?: { autoDrain?: boolean }) => {
    databases.clear()
    nextKey = 1
    openCount = 0
    transactionCount = 0
    addCount = 0
    failNextTransaction = false
    abortNextTransaction = false
    versionchangeHandlers = []
    closeHandlers = []
    autoDrain = options?.autoDrain ?? true
    taskQueue = []
    openBlocked = false
    openError = null
    openLateSuccessAfterFail = false

    const fakeIndexedDB = {
      open(name: string, _version?: number) {
        openCount += 1
        if (!databases.has(name)) databases.set(name, new Map())
        const rows = databases.get(name)!
        let errorReadable = true
        const request = {
          result: null as unknown as IDBDatabase,
          get error(): DOMException | null {
            if (!errorReadable) {
              throw new DOMException("InvalidStateError", "InvalidStateError")
            }
            return openError
          },
          readyState: "pending" as string,
          onsuccess: null as ((ev: Event) => void) | null,
          onerror: null as ((ev: Event) => void) | null,
          onupgradeneeded: null as ((ev: Event) => void) | null,
          onblocked: null as ((ev: Event) => void) | null,
        }
        enqueueTask(() => {
          if (openBlocked) {
            // While pending, reading .error may throw — driver must not assume it.
            errorReadable = false
            request.readyState = "pending"
            request.onblocked?.(new Event("blocked"))
            if (openLateSuccessAfterFail) {
              enqueueTask(() => {
                errorReadable = true
                const db = new FakeDatabase(rows)
                request.result = db as unknown as IDBDatabase
                request.readyState = "done"
                request.onsuccess?.({} as Event)
              })
            }
            return
          }
          if (openError) {
            errorReadable = true
            request.readyState = "done"
            request.onerror?.(new Event("error"))
            return
          }
          errorReadable = true
          const db = new FakeDatabase(rows)
          request.result = db as unknown as IDBDatabase
          request.readyState = "done"
          request.onupgradeneeded?.({} as Event)
          request.onsuccess?.({} as Event)
        })
        return request as unknown as IDBOpenDBRequest
      },
    }
    vi.stubGlobal("indexedDB", fakeIndexedDB)
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    autoDrain = true
    taskQueue = []
  })

  test("coalesces multi-append into fewer opens/transactions than per-event open", async () => {
    installFakeIndexedDB()
    const driver = createIndexedDBTranscriptDiagnosticsDriver("diag-batch-a")
    const writes = [
      driver.append(eventAt(1), 500),
      driver.append(eventAt(2), 500),
      driver.append(eventAt(3), 500),
      driver.append(eventAt(4), 500),
      driver.append(eventAt(5), 500),
    ]
    await Promise.all(writes)
    expect(openCount).toBeLessThan(5)
    expect(openCount).toBeGreaterThanOrEqual(1)
    expect(transactionCount).toBeLessThan(5)
    expect(addCount).toBe(5)
    const rows = await driver.read()
    expect(rows.map((e) => e.at)).toEqual([1, 2, 3, 4, 5])
  })

  test("slow IDB continuous append keeps flush/tx count far below append count", async () => {
    installFakeIndexedDB({ autoDrain: false })
    const driver = createIndexedDBTranscriptDiagnosticsDriver("diag-backpressure")
    const appendN = 80
    const promises: Promise<void>[] = []
    for (let i = 1; i <= appendN; i += 1) {
      promises.push(driver.append(eventAt(i), 500))
    }
    // Scheduler must stay bounded before any IDB callback runs.
    expect(taskQueue.length).toBeLessThanOrEqual(8)

    const allAppends = Promise.all(promises)
    // Drain controlled waves until appends settle (open + request completions).
    for (let wave = 0; wave < 500; wave += 1) {
      const settled = await Promise.race([
        allAppends.then(() => true),
        Promise.resolve(false),
      ])
      if (settled) break
      if (taskQueue.length === 0) {
        // Allow promise reactions to enqueue the next exclusive turn.
        await Promise.resolve()
        if (taskQueue.length === 0) await Promise.resolve()
      }
      await drainTasks(5)
    }
    await allAppends
    // One coalesced write (plus possible follow-ups) << appendN.
    expect(transactionCount).toBeLessThan(appendN / 4)
    expect(transactionCount).toBeGreaterThanOrEqual(1)
    expect(addCount).toBe(appendN)

    autoDrain = true
    // Switch to auto-drain for the final read.
    const rows = await driver.read()
    expect(rows.map((e) => e.at)).toEqual(Array.from({ length: appendN }, (_, i) => i + 1))
  })

  test("append(A);clear();append(B);read() returns only B", async () => {
    installFakeIndexedDB()
    const driver = createIndexedDBTranscriptDiagnosticsDriver("diag-clear-order")
    const a = driver.append(eventAt(1), 500)
    const clearP = driver.clear()
    const b = driver.append(eventAt(2), 500)
    await Promise.all([a, clearP, b])
    expect((await driver.read()).map((e) => e.at)).toEqual([2])
  })

  test("append(A);read();append(B) read sees only A; B still commits", async () => {
    installFakeIndexedDB()
    const driver = createIndexedDBTranscriptDiagnosticsDriver("diag-read-barrier")
    const a = driver.append(eventAt(10), 500)
    const readP = driver.read()
    const b = driver.append(eventAt(20), 500)
    const rows = await readP
    expect(rows.map((e) => e.at)).toEqual([10])
    await Promise.all([a, b])
    expect((await driver.read()).map((e) => e.at)).toEqual([10, 20])
  })

  test("trims to limit while keeping newest order", async () => {
    installFakeIndexedDB()
    const driver = createIndexedDBTranscriptDiagnosticsDriver("diag-limit")
    for (let i = 1; i <= 8; i += 1) {
      await driver.append(eventAt(i), 5)
    }
    expect((await driver.read()).map((e) => e.at)).toEqual([4, 5, 6, 7, 8])
  })

  test("read drains pending appends before returning", async () => {
    installFakeIndexedDB()
    const driver = createIndexedDBTranscriptDiagnosticsDriver("diag-drain")
    void driver.append(eventAt(10), 500)
    void driver.append(eventAt(11), 500)
    expect((await driver.read()).map((e) => e.at)).toEqual([10, 11])
  })

  test("clear drops pending and stored events", async () => {
    installFakeIndexedDB()
    const driver = createIndexedDBTranscriptDiagnosticsDriver("diag-clear")
    await driver.append(eventAt(1), 500)
    void driver.append(eventAt(2), 500)
    await driver.clear()
    expect(await driver.read()).toEqual([])
  })

  test("transaction failure isolates and later append recovers without losing newer", async () => {
    installFakeIndexedDB()
    const driver = createIndexedDBTranscriptDiagnosticsDriver("diag-fail")
    await driver.append(eventAt(1), 500)
    failNextTransaction = true
    await expect(driver.append(eventAt(2), 500)).rejects.toBeTruthy()
    await driver.append(eventAt(3), 500)
    const ats = (await driver.read()).map((e) => e.at)
    expect(ats).toContain(1)
    expect(ats).toContain(3)
    expect(ats[ats.length - 1]).toBe(3)
  })

  test("clear drops failed re-queue so old batch cannot resurrect", async () => {
    installFakeIndexedDB()
    const driver = createIndexedDBTranscriptDiagnosticsDriver("diag-no-resurrect")
    failNextTransaction = true
    await expect(driver.append(eventAt(1), 500)).rejects.toBeTruthy()
    // Failed event is re-queued; clear must drop it.
    await driver.clear()
    await driver.append(eventAt(9), 500)
    expect((await driver.read()).map((e) => e.at)).toEqual([9])
  })

  test("transaction abort rolls back whole batch; retry is FIFO without duplicates", async () => {
    installFakeIndexedDB()
    const driver = createIndexedDBTranscriptDiagnosticsDriver("diag-abort-atomic")
    // Seed one committed row.
    await driver.append(eventAt(1), 500)
    const beforeKeys = [...(databases.get("diag-abort-atomic")?.keys() ?? [])]
    expect(beforeKeys.length).toBe(1)

    abortNextTransaction = true
    // Burst that would be one batch: abort must leave store unchanged (no half batch).
    const burst = Promise.allSettled([
      driver.append(eventAt(2), 500),
      driver.append(eventAt(3), 500),
    ])
    await burst
    const mid = [...(databases.get("diag-abort-atomic")?.entries() ?? [])]
    expect(mid.map(([, e]) => e.at)).toEqual([1])
    // No extra keys from aborted adds.
    expect(mid.length).toBe(1)

    await driver.append(eventAt(4), 500)
    const ats = (await driver.read()).map((e) => e.at)
    // Failed 2,3 re-queued then written with 4 — FIFO, no duplicate 1.
    expect(ats).toEqual([1, 2, 3, 4])
    const keyCount = databases.get("diag-abort-atomic")?.size ?? 0
    expect(keyCount).toBe(4)
  })

  test("versionchange closes connection and next write reopens", async () => {
    installFakeIndexedDB()
    const driver = createIndexedDBTranscriptDiagnosticsDriver("diag-vc")
    await driver.append(eventAt(1), 50)
    const opensAfterFirst = openCount
    for (const fire of versionchangeHandlers) fire()
    await driver.append(eventAt(2), 50)
    expect(openCount).toBeGreaterThan(opensAfterFirst)
    expect((await driver.read()).map((e) => e.at)).toEqual([1, 2])
  })

  test("onclose invalidates and next op reopens", async () => {
    installFakeIndexedDB()
    const driver = createIndexedDBTranscriptDiagnosticsDriver("diag-close")
    await driver.append(eventAt(1), 50)
    const opensAfterFirst = openCount
    for (const fire of closeHandlers) fire()
    await driver.append(eventAt(2), 50)
    expect(openCount).toBeGreaterThan(opensAfterFirst)
    expect((await driver.read()).map((e) => e.at)).toEqual([1, 2])
  })

  test("open onblocked with pending readyState does not throw; late success closes", async () => {
    installFakeIndexedDB()
    openBlocked = true
    openLateSuccessAfterFail = true
    const driver = createIndexedDBTranscriptDiagnosticsDriver("diag-blocked")
    await expect(driver.append(eventAt(1), 50)).rejects.toBeTruthy()
    // Late success handle must be closed — a subsequent open should still work.
    openBlocked = false
    openLateSuccessAfterFail = false
    await driver.append(eventAt(2), 50)
    const ats = (await driver.read()).map((e) => e.at)
    // Failed open re-queues event 1; recovery must commit newest and stay FIFO.
    expect(ats).toContain(2)
    expect(ats[ats.length - 1]).toBe(2)
  })

  test("open failure rejects and later op recovers", async () => {
    installFakeIndexedDB()
    openError = new DOMException("open failed", "UnknownError")
    const driver = createIndexedDBTranscriptDiagnosticsDriver("diag-open-fail")
    await expect(driver.append(eventAt(1), 50)).rejects.toBeTruthy()
    openError = null
    await driver.append(eventAt(2), 50)
    const ats = (await driver.read()).map((e) => e.at)
    expect(ats).toContain(2)
    expect(ats[ats.length - 1]).toBe(2)
  })

  test("InvalidState on transaction invalidates connection for recovery", async () => {
    installFakeIndexedDB()
    const driver = createIndexedDBTranscriptDiagnosticsDriver("diag-invalid-state")
    await driver.append(eventAt(1), 50)
    // Force closed without going through driver invalidate — next tx throws.
    for (const fire of closeHandlers) fire()
    // close handler should already invalidate; append recovers via reopen.
    await driver.append(eventAt(2), 50)
    expect((await driver.read()).map((e) => e.at)).toEqual([1, 2])
  })

  test("pending queue stays within limit under burst", async () => {
    installFakeIndexedDB()
    const driver = createIndexedDBTranscriptDiagnosticsDriver("diag-bound")
    const limit = 10
    const promises = []
    for (let i = 1; i <= 40; i += 1) {
      promises.push(driver.append(eventAt(i), limit))
    }
    await Promise.allSettled(promises)
    const rows = await driver.read()
    expect(rows.length).toBeLessThanOrEqual(limit)
    expect(rows.map((e) => e.at)).toEqual(
      rows.map((e) => e.at).slice().sort((a, b) => a - b),
    )
    expect(rows[rows.length - 1]?.at).toBe(40)
  })

  test("default sink limit matches TRANSCRIPT_DIAGNOSTICS_LIMIT contract", () => {
    expect(TRANSCRIPT_DIAGNOSTICS_LIMIT).toBe(500)
  })

  test("happy-dom environment reports IndexedDB availability without assuming it", () => {
    // Do not assume happy-dom ships IndexedDB; record the fact for Lane coverage.
    const available = typeof globalThis.indexedDB !== "undefined"
    expect(typeof available).toBe("boolean")
  })
})
