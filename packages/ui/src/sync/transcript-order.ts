/**
 * Incoming transcript order is authoritative. Local-only rows stay before their
 * next surviving neighbor; a local tail stays after the last shared neighbor,
 * before newly fetched trailing rows. IDs identify, never rank.
 * Callers with disjoint windows must establish prepend/append placement first.
 */
export function mergeTranscriptOrder(previous: readonly string[], incoming: readonly string[]): string[] {
  const incomingIDs = new Set(incoming)
  const before = new Map<string, string[]>()
  let pending: string[] = []
  let lastShared: string | undefined
  for (const id of previous) {
    if (!incomingIDs.has(id)) {
      pending.push(id)
      continue
    }
    if (pending.length > 0) before.set(id, pending)
    pending = []
    lastShared = id
  }
  const order: string[] = []
  const seen = new Set<string>()
  const append = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    order.push(id)
  }
  for (const id of incoming) {
    for (const local of before.get(id) ?? []) append(local)
    append(id)
    if (id === lastShared) for (const local of pending) append(local)
  }
  if (!lastShared) for (const id of pending) append(id)
  return order
}
