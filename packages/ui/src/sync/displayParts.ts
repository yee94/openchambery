import type { Message, Part } from "@opencode-ai/sdk/v2"

/**
 * Snapshot message still mid-turn: completion metadata is absent. Laggy HTTP
 * pages for open assistant turns commonly omit tools the live SSE stream
 * already admitted; those local parts must be retained until the turn settles.
 */
export function isMessageSnapshotOpen(info: Message): boolean {
  const completed = (info as { time?: { completed?: unknown } }).time?.completed
  if (typeof completed === "number") return false
  const finish = (info as { finish?: unknown }).finish
  if (typeof finish === "string" && finish.length > 0) return false
  return true
}

function getPartId(part: Part): string | undefined {
  const id = (part as { id?: unknown }).id
  return typeof id === "string" && id.length > 0 ? id : undefined
}

function getMessageRole(info: Message): string {
  const role = (info as { clientRole?: unknown; role?: unknown }).clientRole ?? info.role
  return typeof role === "string" ? role : ""
}

/**
 * Whether display parts for this message may shrink.
 *
 * Only two shrinks are authoritative: a settled assistant snapshot (the server
 * page is the truth once `finish`/`time.completed` landed), and any
 * non-assistant row. User rows own optimistic insert/replace and must follow
 * the store exactly, or a replaced optimistic part would paint twice.
 */
export function allowsAuthoritativeShrink(info: Message): boolean {
  if (getMessageRole(info) !== "assistant") return true
  return !isMessageSnapshotOpen(info)
}

/**
 * Monotonic display parts for one message.
 *
 * While an assistant turn is open, store frames can regress mid
 * materialize/merge: a lagging HTTP page omits tools SSE already admitted, or a
 * part map is briefly empty between commits. Those frames are unioned onto the
 * parts the UI last painted, keyed by part id and keeping the previous relative
 * position, so no row the user already saw disappears for a frame.
 *
 * This is the single owner of that invariant. Views must not re-derive it: a
 * render-time hold cannot tell a lagging page from a real delete, and holding
 * across renders makes a transient regression permanent.
 *
 * Trade-off, explicit: a genuine `message.part.removed` on a still-open
 * assistant is held until the turn settles. Aborts and errors stamp
 * `finish`/`error` on the message, which flips `allowsAuthoritativeShrink` and
 * releases the hold on the next commit.
 */
export function mergePartsForDisplay(
  previous: Part[] | undefined,
  incoming: Part[],
  info: Message,
): Part[] {
  if (!previous || previous.length === 0) return incoming
  if (allowsAuthoritativeShrink(info)) return incoming

  const incomingIds = new Set<string>()
  for (const part of incoming) {
    const id = getPartId(part)
    if (id) incomingIds.add(id)
  }

  // Parts the UI painted that this frame no longer carries. Unidentifiable
  // parts (UI-synthesized text without an id) cannot be matched, so they follow
  // the incoming frame.
  const heldAfterId = new Map<string, Part[]>()
  const heldAtHead: Part[] = []
  let lastRetainedId: string | undefined
  let heldCount = 0

  for (const part of previous) {
    const id = getPartId(part)
    if (id && incomingIds.has(id)) {
      lastRetainedId = id
      continue
    }
    if (!id) continue

    heldCount += 1
    if (!lastRetainedId) {
      heldAtHead.push(part)
      continue
    }
    const bucket = heldAfterId.get(lastRetainedId)
    if (bucket) {
      bucket.push(part)
      continue
    }
    heldAfterId.set(lastRetainedId, [part])
  }

  if (heldCount === 0) return incoming

  const merged: Part[] = [...heldAtHead]
  for (const part of incoming) {
    merged.push(part)
    const id = getPartId(part)
    if (!id) continue
    const held = heldAfterId.get(id)
    if (held) merged.push(...held)
  }

  // Steady state while a page keeps lagging: the merge reproduces what the UI
  // already holds. Return the previous array so snapshot consumers keep their
  // reference and no turn projection rebuilds.
  if (merged.length === previous.length && merged.every((part, index) => part === previous[index])) {
    return previous
  }

  return merged
}
