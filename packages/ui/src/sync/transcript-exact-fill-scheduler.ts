/**
 * Shared exact `session.message` fill scheduler.
 *
 * Every background and UI-driven materialize path must enter through
 * `enqueueExactFill` so cold-start tails and virtualizer remounts cannot open
 * unbounded concurrent Host fetches. User-driven expands jump the queue ahead
 * of background work; same-key callers share one in-flight promise.
 */

export type ExactFillPriority = "user" | "background"

export type EnqueueExactFillOptions = {
  readonly priority?: ExactFillPriority
}

type ExactFillJob = {
  readonly key: string
  priority: ExactFillPriority
  readonly run: () => Promise<unknown>
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
}

/** Max concurrent exact Host fills across the whole UI runtime. */
export const EXACT_FILL_CONCURRENCY = 4

const queue: ExactFillJob[] = []
const pendingByKey = new Map<string, ExactFillJob>()
const sharedByKey = new Map<string, Promise<unknown>>()
let active = 0

const takeNextJob = (): ExactFillJob | undefined => {
  const userIndex = queue.findIndex((job) => job.priority === "user")
  if (userIndex >= 0) {
    const [job] = queue.splice(userIndex, 1)
    return job
  }
  return queue.shift()
}

const pump = (): void => {
  while (active < EXACT_FILL_CONCURRENCY) {
    const job = takeNextJob()
    if (!job) return
    pendingByKey.delete(job.key)
    active += 1
    void Promise.resolve()
      .then(() => job.run())
      .then(
        (value) => {
          job.resolve(value)
        },
        (error) => {
          job.reject(error)
        },
      )
      .finally(() => {
        active -= 1
        sharedByKey.delete(job.key)
        pump()
      })
  }
}

/**
 * Enqueue one exact-fill unit of work. Identical keys coalesce to the first
 * promise; a later `user` enqueue upgrades a still-queued `background` job.
 */
export function enqueueExactFill<T>(
  key: string,
  run: () => Promise<T>,
  options?: EnqueueExactFillOptions,
): Promise<T> {
  const priority = options?.priority ?? "background"
  const existing = sharedByKey.get(key)
  if (existing) {
    const pending = pendingByKey.get(key)
    if (pending && priority === "user" && pending.priority !== "user") {
      pending.priority = "user"
    }
    return existing as Promise<T>
  }

  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  const job: ExactFillJob = {
    key,
    priority,
    run: () => run(),
    resolve: (value) => {
      resolve(value as T)
    },
    reject,
  }
  queue.push(job)
  pendingByKey.set(key, job)
  sharedByKey.set(key, promise)
  pump()
  return promise
}

/** Test helper: drain queue state between cases. */
export function resetExactFillSchedulerForTests(): void {
  queue.length = 0
  pendingByKey.clear()
  sharedByKey.clear()
  active = 0
}

/** Test helper: observe scheduler pressure. */
export function getExactFillSchedulerStatsForTests(): {
  readonly active: number
  readonly queued: number
  readonly shared: number
} {
  return {
    active,
    queued: queue.length,
    shared: sharedByKey.size,
  }
}
