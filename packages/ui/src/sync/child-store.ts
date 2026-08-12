import { create, type StoreApi } from "zustand"
import { normalizeDirectoryKey } from "@/lib/pathNormalization"
import type { DirState, State } from "./types"
import { INITIAL_STATE, MAX_DIR_STORES, DIR_IDLE_TTL_MS, EVICTION_GRACE_MS } from "./types"
import { pickDirectoriesToEvict, canDisposeDirectory, hasPendingBlockingRequests } from "./eviction"
import { clearLegacySessionCache, readDirCache, persistVcs, persistProjectMeta, persistIcon } from "./persist-cache"

export type DirectoryStore = State & {
  /** Apply a partial state update */
  patch: (partial: Partial<State>) => void
  /** Replace state wholesale (used during bootstrap) */
  replace: (next: State) => void
}

export type ChildStoreCapture = {
  directory: string
  generation: number
  store: StoreApi<DirectoryStore>
}

function createDirectoryStore(directory: string): StoreApi<DirectoryStore> {
  // Restore only non-session metadata from localStorage. Session summaries are
  // owned by the Electron SQLite index, not a second per-directory cache.
  const cached = readDirCache(directory)
  clearLegacySessionCache(directory)

  const store = create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    vcs: cached.vcs ?? INITIAL_STATE.vcs,
    projectMeta: cached.projectMeta ?? INITIAL_STATE.projectMeta,
    icon: cached.icon ?? INITIAL_STATE.icon,
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))

  // Subscribe to persist metadata changes back to localStorage
  store.subscribe((state, prev) => {
    if (state.vcs !== prev.vcs) persistVcs(directory, state.vcs)
    if (state.projectMeta !== prev.projectMeta) persistProjectMeta(directory, state.projectMeta)
    if (state.icon !== prev.icon) persistIcon(directory, state.icon)
  })

  return store
}

/**
 * One directory, one store — whatever spelling the caller happened to hold.
 *
 * Every key crossing this class is canonicalized here rather than at the call
 * sites. Callers receive directory strings from a dozen upstream sources (the
 * session record, worktree metadata, window config, the directory picker) and
 * on Windows those disagree on separators and drive-letter case. With exact
 * string keys, one differently-spelled lookup used to mint a second store that
 * took an HTTP status snapshot and then never received another live event —
 * leaving whatever read through it stuck on stale status forever.
 *
 * Canonicalizing at the boundary makes that unrepresentable regardless of which
 * caller is sloppy.
 */
export class ChildStoreManager {
  readonly children = new Map<string, StoreApi<DirectoryStore>>()
  private readonly lifecycle = new Map<string, DirState>()
  private readonly pins = new Map<string, number>()
  private readonly disposers = new Map<string, () => void>()
  private readonly registrySubscribers = new Set<() => void>()
  private readonly generations = new Map<string, number>()
  private evictionScheduled = false

  private onBootstrap?: (directory: string) => void
  private onDispose?: (directory: string) => void
  private isBooting?: (directory: string) => boolean
  private isLoadingSessions?: (directory: string) => boolean

  private notifyRegistrySubscribers() {
    for (const subscriber of this.registrySubscribers) {
      subscriber()
    }
  }

  configure(callbacks: {
    onBootstrap?: (directory: string) => void
    onDispose?: (directory: string) => void
    isBooting?: (directory: string) => boolean
    isLoadingSessions?: (directory: string) => boolean
  }) {
    this.onBootstrap = callbacks.onBootstrap
    this.onDispose = callbacks.onDispose
    this.isBooting = callbacks.isBooting
    this.isLoadingSessions = callbacks.isLoadingSessions
  }

  mark(rawDirectory: string) {
    const directory = normalizeDirectoryKey(rawDirectory)
    if (!directory) return
    this.lifecycle.set(directory, { lastAccessAt: Date.now() })
    this.scheduleEviction()
  }

  /**
   * Coalesce eviction into one pass per tick.
   *
   * `ensureChild` runs during render (once per sidebar row). Deferring the pass
   * lets a whole commit — and with it every pin effect — settle before overflow
   * decisions, which is what stops expand-many-worktrees thrash.
   */
  private scheduleEviction() {
    if (this.evictionScheduled) return
    this.evictionScheduled = true
    queueMicrotask(() => {
      this.evictionScheduled = false
      this.runEviction()
    })
  }

  pin(rawDirectory: string) {
    const directory = normalizeDirectoryKey(rawDirectory)
    if (!directory) return
    this.pins.set(directory, (this.pins.get(directory) ?? 0) + 1)
    this.mark(directory)
  }

  unpin(rawDirectory: string) {
    const directory = normalizeDirectoryKey(rawDirectory)
    if (!directory) return
    const next = (this.pins.get(directory) ?? 0) - 1
    if (next > 0) {
      this.pins.set(directory, next)
      return
    }
    this.pins.delete(directory)
    this.scheduleEviction()
  }

  pinned(rawDirectory: string) {
    return (this.pins.get(normalizeDirectoryKey(rawDirectory)) ?? 0) > 0
  }

  ensureChild(rawDirectory: string, options?: { bootstrap?: boolean }): StoreApi<DirectoryStore> {
    const directory = normalizeDirectoryKey(rawDirectory)
    if (!directory) throw new Error("No directory provided to ensureChild")

    let store = this.children.get(directory)
    if (!store) {
      store = createDirectoryStore(directory)
      this.children.set(directory, store)
      this.generations.set(directory, (this.generations.get(directory) ?? 0) + 1)
      this.notifyRegistrySubscribers()
    }

    this.mark(directory)

    const shouldBootstrap = options?.bootstrap ?? true
    if (shouldBootstrap && store.getState().status === "loading") {
      this.onBootstrap?.(directory)
    }

    return store
  }

  getChild(rawDirectory: string): StoreApi<DirectoryStore> | undefined {
    return this.children.get(normalizeDirectoryKey(rawDirectory))
  }

  captureChild(rawDirectory: string, options?: { bootstrap?: boolean }): ChildStoreCapture {
    const directory = normalizeDirectoryKey(rawDirectory)
    const store = this.ensureChild(directory, options)
    return { directory, generation: this.generations.get(directory) ?? 0, store }
  }

  isCurrentChildCapture(capture: ChildStoreCapture): boolean {
    const directory = normalizeDirectoryKey(capture.directory)
    return this.children.get(directory) === capture.store
      && this.generations.get(directory) === capture.generation
  }

  disposeDirectory(rawDirectory: string): boolean {
    const directory = normalizeDirectoryKey(rawDirectory)
    if (
      !canDisposeDirectory({
        directory,
        hasStore: this.children.has(directory),
        pinned: this.pinned(directory),
        booting: this.isBooting?.(directory) ?? false,
        loadingSessions: this.isLoadingSessions?.(directory) ?? false,
        hasPendingBlockingRequests: this.hasPendingBlockingRequestsForDirectory(directory),
      })
    ) {
      return false
    }

    this.lifecycle.delete(directory)
    this.children.delete(directory)
    this.notifyRegistrySubscribers()
    const dispose = this.disposers.get(directory)
    if (dispose) {
      dispose()
      this.disposers.delete(directory)
    }
    this.onDispose?.(directory)
    return true
  }

  runEviction(skip?: string) {
    const stores = [...this.children.keys()]
    if (stores.length === 0) return
    const list = pickDirectoriesToEvict({
      stores,
      state: this.lifecycle,
      pins: new Set(stores.filter((d) => this.pinned(d))),
      max: MAX_DIR_STORES,
      ttl: DIR_IDLE_TTL_MS,
      graceMs: EVICTION_GRACE_MS,
      now: Date.now(),
      hasPendingBlockingRequests: (dir) => this.hasPendingBlockingRequestsForDirectory(dir),
    }).filter((d) => d !== skip)
    for (const directory of list) {
      this.disposeDirectory(directory)
    }
  }

  hasPendingBlockingRequestsForDirectory(rawDirectory: string): boolean {
    return hasPendingBlockingRequests(this.getChild(rawDirectory)?.getState())
  }

  /** Apply a state mutation to a directory's store */
  update(rawDirectory: string, fn: (state: State) => Partial<State>) {
    const store = this.getChild(rawDirectory)
    if (!store) return
    const current = store.getState()
    const patch = fn(current)
    store.setState(patch)
  }

  /** Get current state of a directory store (snapshot) */
  getState(rawDirectory: string): State | undefined {
    return this.getChild(rawDirectory)?.getState()
  }

  disposeAll() {
    for (const directory of [...this.children.keys()]) {
      this.children.delete(directory)
    }
    this.notifyRegistrySubscribers()
    this.lifecycle.clear()
    this.pins.clear()
    this.disposers.clear()
  }

  subscribeRegistry(listener: () => void): () => void {
    this.registrySubscribers.add(listener)
    return () => {
      this.registrySubscribers.delete(listener)
    }
  }

  subscribeAll(listener: () => void): () => void {
    const storeUnsubscribers = new Map<string, () => void>()

    const syncStoreSubscriptions = () => {
      const activeDirectories = new Set(this.children.keys())

      for (const [directory, unsubscribe] of storeUnsubscribers.entries()) {
        if (activeDirectories.has(directory)) {
          continue
        }
        unsubscribe()
        storeUnsubscribers.delete(directory)
      }

      for (const [directory, store] of this.children.entries()) {
        if (storeUnsubscribers.has(directory)) {
          continue
        }
        storeUnsubscribers.set(directory, store.subscribe(listener))
      }
    }

    syncStoreSubscriptions()
    const unsubscribeRegistry = this.subscribeRegistry(() => {
      syncStoreSubscriptions()
      listener()
    })

    return () => {
      unsubscribeRegistry()
      for (const unsubscribe of storeUnsubscribers.values()) {
        unsubscribe()
      }
      storeUnsubscribers.clear()
    }
  }

  subscribeAllSelected<T>(selector: (state: DirectoryStore) => T, listener: () => void): () => void {
    const storeUnsubscribers = new Map<string, () => void>()

    const syncStoreSubscriptions = () => {
      const activeDirectories = new Set(this.children.keys())

      for (const [directory, unsubscribe] of storeUnsubscribers.entries()) {
        if (activeDirectories.has(directory)) continue
        unsubscribe()
        storeUnsubscribers.delete(directory)
      }

      for (const [directory, store] of this.children.entries()) {
        if (storeUnsubscribers.has(directory)) continue
        storeUnsubscribers.set(directory, store.subscribe((state, previous) => {
          if (!Object.is(selector(state), selector(previous))) {
            listener()
          }
        }))
      }
    }

    syncStoreSubscriptions()
    const unsubscribeRegistry = this.subscribeRegistry(() => {
      syncStoreSubscriptions()
      listener()
    })

    return () => {
      unsubscribeRegistry()
      for (const unsubscribe of storeUnsubscribers.values()) {
        unsubscribe()
      }
      storeUnsubscribers.clear()
    }
  }
}
