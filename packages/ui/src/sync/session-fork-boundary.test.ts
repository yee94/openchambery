import { expect, it, vi } from 'vitest'
import { fetchForkBoundary, resolveNativeForkBoundary } from './session-fork-boundary'
import type { OpenCodeClient, SessionMessageInfo } from '@/lib/opencode/v2-types'

const rows = [
  { id: 'msg_z', type: 'user' }, { id: 'msg_s', type: 'skill' },
  { id: 'msg_y', type: 'assistant' }, { id: 'msg_b', type: 'synthetic' },
  { id: 'msg_a', type: 'assistant' }, { id: 'msg_i', type: 'idle' },
  { id: 'msg_c', type: 'compaction' }, { id: 'msg_u', type: 'user' },
]
it('includes every step and context carrier in an explicit turn, excluding later compaction', () => {
  expect(resolveNativeForkBoundary(rows, 'msg_y', false)).toBe('msg_c')
  expect(resolveNativeForkBoundary(rows, 'msg_a', true)).toBe('msg_c')
  expect(resolveNativeForkBoundary(rows, 'msg_z', true)).toBe('msg_z')
})
it('live fork includes prompt and skill/system context, excludes executing steps; idle copies all', () => {
  expect(resolveNativeForkBoundary(rows.slice(0, 5), undefined, true)).toBe('msg_y')
  expect(resolveNativeForkBoundary(rows, undefined, false)).toBeUndefined()
  expect(resolveNativeForkBoundary([{ id: 'shell', type: 'shell', status: 'running' }], undefined, true)).toBe('shell')
  expect(resolveNativeForkBoundary([{ id: 'shell', type: 'shell' }, ...rows], 'shell', false)).toBe('msg_z')
  expect(() => resolveNativeForkBoundary(rows, 'missing', false)).toThrow('Fork boundary')
  expect(resolveNativeForkBoundary([...rows.slice(0, 6), { id: 'notice', type: 'synthetic' }, { id: 'continuation', type: 'assistant' }], undefined, true)).toBe('continuation')
})
it('fetches past a full filtered/carrier page to find the actual boundary', async () => {
  const list = vi.fn().mockResolvedValueOnce({ data: Array.from({ length: 100 }, (_, i) => ({ id: `msg_n${i}`, type: 'system' })), cursor: { next: 'older' } })
    .mockResolvedValueOnce({ data: [...rows].reverse(), cursor: {} })
  const client = { message: { list } } as unknown as OpenCodeClient
  await expect(fetchForkBoundary(client, 'ses_a', 'msg_y', false, () => true)).resolves.toBe('msg_c')
  expect(list.mock.calls[1]?.[0]).toEqual({ sessionID: 'ses_a', limit: 100, cursor: 'older' })
})
it('fails explicitly on missing history, transport error, stationary cursor and changed runtime', async () => {
  const list = vi.fn().mockResolvedValue({ data: [] as SessionMessageInfo[], cursor: {} })
  const client = { message: { list } } as unknown as OpenCodeClient
  await expect(fetchForkBoundary(client, 'ses_a', 'missing', true, () => true)).rejects.toThrow('Fork boundary')
  list.mockRejectedValueOnce(new Error('offline'))
  await expect(fetchForkBoundary(client, 'ses_a', 'missing', true, () => true)).rejects.toThrow('offline')
  list.mockResolvedValue({ data: Array.from({ length: 100 }, (_, i) => ({ id: `msg_${i}`, type: 'system' })), cursor: { next: 'same' } })
  await expect(fetchForkBoundary(client, 'ses_a', 'missing', true, () => true)).rejects.toThrow('cursor')
  await expect(fetchForkBoundary(client, 'ses_a', 'missing', true, () => false)).rejects.toThrow('source changed')
})
