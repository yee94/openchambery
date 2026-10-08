import type { OpenCodeClient, SessionMessageInfo } from '@/lib/opencode/v2-types'

type Row = { id: string; type: string; finish?: string; status?: string }
const input = (row: Row) => row.type === 'user' || row.type === 'shell'

/** Native projection order is seq order. IDs are only lookup keys. */
export function resolveNativeForkBoundary(rows: readonly Row[], selected: string | undefined, live: boolean): string | undefined {
  if (!selected && !live) return undefined
  let index = selected ? rows.findIndex((row) => row.id === selected) : -1
  if (!selected) {
    let start = 0
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const candidate = rows[i]!
      if (candidate.type === 'idle') { start = i + 1; break }
      if (input(candidate)) { index = i; start = i + 1; break }
    }
    const row = rows[index]
    if (row?.type === 'shell' && row.status === 'running') return row.id
    // Context carriers attached to the prompt (skill/system/synthetic/selection)
    // must survive; the first executing step/checkpoint is the exclusive bound.
    const boundary = rows.slice(start).find((item) => item.type === 'assistant' || item.type === 'compaction' || item.type === 'idle' || input(item))?.id
    if (!boundary) throw new Error('Fork live boundary is not yet available')
    return boundary
  }
  if (index < 0) throw new Error('Fork boundary is not available in authoritative history')
  const row = rows[index]!
  if (row.type === 'user') return row.id
  if (row.type === 'shell') return rows[index + 1]?.id
  for (let next = index + 1; next < rows.length; next += 1) {
    const item = rows[next]!
    if (input(item)) return item.id
    // Native idle is the authoritative execution/turn separator. Include it,
    // but never include later maintenance/compaction from another execution.
    if (item.type === 'idle') return rows[next + 1]?.id
    if (item.type === 'compaction' && rows[next - 1]?.finish === 'stop') return item.id
  }
  if (live) throw new Error('Fork selected turn is still running')
  return undefined
}

/** Descend from the tail until the selected input/turn is covered, never guess from a UI window. */
export async function fetchForkBoundary(client: OpenCodeClient, sessionID: string, selected: string | undefined, live: boolean, isCurrent: () => boolean): Promise<string | undefined> {
  if (!selected && !live) return undefined
  let rows: SessionMessageInfo[] = []
  let cursor: string | undefined
  const seen = new Set<string>()
  const signal = AbortSignal.timeout(30_000)
  for (let pageNumber = 0; pageNumber < 1_000; pageNumber += 1) {
    const page = await client.message.list({ sessionID, limit: 100, ...(cursor ? { cursor } : { order: 'desc' as const }) }, { signal })
    if (!isCurrent()) throw new Error('Fork source changed while reading history')
    rows = [...page.data].reverse().concat(rows)
    const found = selected ? rows.some((row) => row.id === selected) : rows.some((row) => input(row) || row.type === 'idle')
    if (found) return resolveNativeForkBoundary(rows, selected, live)
    if (page.data.length < 100 || !page.cursor.next) {
      if (!selected && rows.length) return resolveNativeForkBoundary(rows, selected, live)
      break
    }
    if (seen.has(page.cursor.next)) throw new Error('Fork history cursor did not advance')
    cursor = page.cursor.next
    seen.add(cursor)
  }
  throw new Error('Fork boundary is not available in authoritative history')
}
