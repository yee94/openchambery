import type { Message, Part } from "@opencode-ai/sdk/v2/client"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function sortParts(parts: Part[]) {
  return parts.filter((part) => !!part?.id).sort((a, b) => cmp(a.id, b.id))
}

export type OptimisticItem = {
  message: Message
  parts: Part[]
}

export type MessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  cursor?: string
  complete: boolean
}

export function mergeOptimisticPage(page: MessagePage, items: OptimisticItem[]) {
  if (items.length === 0) return { ...page, confirmed: [] as string[] }

  const session = [...page.session]
  const part = new Map(page.part.map((item) => [item.id, sortParts(item.part)]))
  const confirmed: string[] = []

  for (const item of items) {
    const index = session.findIndex((message) => message.id === item.message.id)
    if (index < 0) {
      // Not on the server yet — keep the optimistic message at the conversation
      // tail. Id-insert drops a mid-turn-minted messageID into history.
      session.push(item.message)
      part.set(item.message.id, sortParts(item.parts))
      continue
    }

    const current = part.get(item.message.id)
    // Server already owns this message. Prefer its parts and drop the shadow
    // entry. Optimistic file/text parts use client-generated IDs, so merging by
    // id alone would keep both the optimistic and server file parts and render
    // duplicate attachment thumbnails for a single citation.
    if (current && current.length > 0) {
      confirmed.push(item.message.id)
      continue
    }

    // Message shell arrived without parts yet — keep optimistic placeholders.
    part.set(item.message.id, sortParts(item.parts))
  }

  return {
    cursor: page.cursor,
    complete: page.complete,
    session,
    part: [...part.entries()]
      .sort((a, b) => cmp(a[0], b[0]))
      .map(([id, part]) => ({ id, part })),
    confirmed,
  }
}

/** Merge two sorted message arrays by id, deduplicating.
 *  Preserves references from `a` for items that already exist — avoids
 *  unnecessary React re-renders when prepending older history. */
export function mergeMessages<T extends { id: string }>(a: readonly T[], b: readonly T[]) {
  const existing = new Map(a.map((item) => [item.id, item] as const))
  let changed = false
  for (const item of b) {
    if (!existing.has(item.id)) {
      existing.set(item.id, item)
      changed = true
    }
  }
  if (!changed) return a as T[]
  return [...existing.values()].sort((x, y) => cmp(x.id, y.id))
}
