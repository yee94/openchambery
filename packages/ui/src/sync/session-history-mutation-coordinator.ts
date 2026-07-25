/**
 * Serialize session history mutations (revert / unrevert) per session so concurrent
 * HTTP cannot invert the server's final marker order.
 *
 * Key: [transportIdentity, generation, directory, sessionId].
 * Same-session ops run in call order; different sessions stay parallel.
 * Failures never block the next queued op (tail releases in finally).
 * Runtime capture is re-checked after the queue wait; stale runtimes must not publish.
 */
import { getRuntimeGeneration, getRuntimeTransportIdentity } from "@/lib/runtime-switch"

export type SessionHistoryMutationCapture = {
  transportIdentity: string
  generation: number
  isCurrent: () => boolean
}

type SessionHistoryMutationKey = string

const sessionHistoryMutationTails = new Map<SessionHistoryMutationKey, Promise<unknown>>()

function sessionHistoryMutationKey(
  sessionId: string,
  directory: string | undefined,
  transportIdentity: string,
  generation: number,
): SessionHistoryMutationKey {
  return `${transportIdentity}\0${generation}\0${directory ?? ""}\0${sessionId}`
}

export async function runSessionHistoryMutation<T>(
  sessionId: string,
  directory: string | undefined,
  operation: (capture: SessionHistoryMutationCapture) => Promise<T>,
  runtime: {
    getTransportIdentity?: () => string
    getGeneration?: () => number
  } = {},
): Promise<T> {
  const getTransportIdentity = runtime.getTransportIdentity ?? getRuntimeTransportIdentity
  const getGeneration = runtime.getGeneration ?? getRuntimeGeneration
  const transportIdentity = getTransportIdentity()
  const generation = getGeneration()
  const key = sessionHistoryMutationKey(sessionId, directory, transportIdentity, generation)
  const isCurrent = () =>
    getTransportIdentity() === transportIdentity && getGeneration() === generation

  const previous = sessionHistoryMutationTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => gate)
  sessionHistoryMutationTails.set(key, tail)

  try {
    await previous.catch(() => undefined)
    if (!isCurrent()) {
      throw new Error("Session history mutation aborted because the runtime changed")
    }
    return await operation({ transportIdentity, generation, isCurrent })
  } finally {
    release()
    if (sessionHistoryMutationTails.get(key) === tail) {
      sessionHistoryMutationTails.delete(key)
    }
  }
}
