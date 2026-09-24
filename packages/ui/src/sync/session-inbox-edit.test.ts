import { beforeEach, expect, it, vi } from 'vitest'
import { editSessionInboxIntoDraft } from './session-inbox-edit'

const fixture = vi.hoisted(() => ({
  fetch: vi.fn(), cancel: vi.fn(), commit: vi.fn(), rollback: vi.fn(), forget: vi.fn(),
  current: true,
}))
vi.mock('./session-prompt-api', () => ({ fetchSessionInboxAuthority: fixture.fetch, cancelSessionInbox: fixture.cancel }))
vi.mock('./session-inbox-overlay', () => ({
  captureInboxRuntimeScope: () => ({ transportIdentity: 'test', generation: 1 }),
  isCurrentInboxRuntimeScope: () => fixture.current,
  forgetUnpromotedInbox: fixture.forget,
}))
vi.mock('./message-composer-restoration-cas', () => ({ commitComposerRestoration: fixture.commit, rollbackComposerRestoration: fixture.rollback }))

const input = {
  sessionID: 'ses_test', inboxID: 'msg_test', directory: '/repo',
  targetKey: { transportIdentity: 'test', owner: { kind: 'session' as const, ownerID: 'ses_test' } },
  expectedRevision: 2, runtimeGeneration: 1, isCurrent: () => true,
}
const item = { id: 'msg_test', delivery: 'queue', payload: { text: 'next task' } }
beforeEach(() => {
  vi.clearAllMocks()
  fixture.current = true
  fixture.fetch.mockResolvedValue({ current: true, items: [item] })
  fixture.cancel.mockResolvedValue(undefined)
  fixture.commit.mockResolvedValue({ status: 'committed', current: true, durable: true, result: { record: { revision: 3 } }, previous: { record: null, views: {}, expectedRevision: 2 } })
  fixture.rollback.mockResolvedValue({ status: 'rolled-back', current: true })
})
it('restores text durably before cancelling the exact inbox item', async () => {
  expect(await editSessionInboxIntoDraft(input)).toBe(true)
  expect(fixture.commit.mock.calls[0][0].payload.snapshot.text).toBe('next task')
  expect(fixture.commit.mock.invocationCallOrder[0]).toBeLessThan(fixture.cancel.mock.invocationCallOrder[0])
  expect(fixture.cancel).toHaveBeenCalledWith(input)
  expect(fixture.forget).toHaveBeenCalledWith('ses_test', 'msg_test', 'cancelled')
})
it('restores attachment URLs, agent mentions and skill references', async () => {
  fixture.fetch.mockResolvedValue({ current: true, items: [{ ...item, payload: {
    text: 'next task', files: [{ uri: 'file:///repo/image.png', name: 'image.png' }], agents: [{ name: 'review' }], skills: [{ id: 'audit' }],
  } }] })
  await editSessionInboxIntoDraft(input)
  const { snapshot, values } = fixture.commit.mock.calls[0][0].payload
  expect(snapshot.attachments).toEqual([expect.objectContaining({ filename: 'image.png', locator: { kind: 'url', url: 'file:///repo/image.png' } })])
  expect([...values.values()]).toContain('file:///repo/image.png')
  expect(snapshot.mentions).toEqual([expect.objectContaining({ kind: 'agent', value: 'review' })])
  expect(snapshot.composerReferences).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'skill', skillName: 'audit' })]))
})
it('does not cancel when draft persistence fails or conflicts', async () => {
  fixture.commit.mockResolvedValue({ status: 'conflict', current: true, durable: false })
  await expect(editSessionInboxIntoDraft(input)).rejects.toThrow('draft-not-committed')
  expect(fixture.cancel).not.toHaveBeenCalled()
})
it('does not restore an already consumed item or treat fetch failure as empty success', async () => {
  fixture.fetch.mockResolvedValueOnce({ current: true, items: [] })
  await expect(editSessionInboxIntoDraft(input)).rejects.toThrow('no-longer-queued')
  fixture.fetch.mockRejectedValueOnce(new Error('offline'))
  await expect(editSessionInboxIntoDraft(input)).rejects.toThrow('offline')
  expect(fixture.commit).not.toHaveBeenCalled()
  expect(fixture.cancel).not.toHaveBeenCalled()
})
it('rolls back through CAS on a definitive cancellation conflict', async () => {
  fixture.cancel.mockRejectedValueOnce(Object.assign(new Error('consumed'), { status: 409 }))
  await expect(editSessionInboxIntoDraft(input)).rejects.toThrow('consumed')
  expect(fixture.rollback).toHaveBeenCalledWith(expect.objectContaining({ restoredRevision: 3, key: input.targetKey }))
  expect(fixture.forget).not.toHaveBeenCalled()
})
it('retains the durable recovery draft when cancellation outcome is unknown', async () => {
  fixture.cancel.mockRejectedValueOnce(new Error('network lost'))
  await expect(editSessionInboxIntoDraft(input)).rejects.toThrow('network lost')
  expect(fixture.rollback).not.toHaveBeenCalled()
  expect(fixture.forget).not.toHaveBeenCalled()
})
it('fences runtime changes during authority fetch', async () => {
  fixture.fetch.mockImplementationOnce(async () => { fixture.current = false; return { current: true, items: [item] } })
  expect(await editSessionInboxIntoDraft(input)).toBe(false)
  expect(fixture.commit).not.toHaveBeenCalled()
})
it('rejects a chip from an older runtime generation before any request', async () => {
  expect(await editSessionInboxIntoDraft({ ...input, runtimeGeneration: 0 })).toBe(false)
  expect(fixture.fetch).not.toHaveBeenCalled()
})
it('does not update overlay or focus after a runtime switch during cancellation', async () => {
  fixture.cancel.mockImplementationOnce(async () => { fixture.current = false })
  expect(await editSessionInboxIntoDraft(input)).toBe(false)
  expect(fixture.forget).not.toHaveBeenCalled()
})
it('rolls back restoration and skips cancellation after a session switch', async () => {
  let current = true
  fixture.commit.mockImplementationOnce(async () => {
    current = false
    return { status: 'committed', current: true, durable: true, result: { record: { revision: 3 } }, previous: { record: null, views: {} } }
  })
  expect(await editSessionInboxIntoDraft({ ...input, isCurrent: () => current })).toBe(false)
  expect(fixture.rollback).toHaveBeenCalled()
  expect(fixture.cancel).not.toHaveBeenCalled()
})
it('never discards malformed attachments', async () => {
  fixture.fetch.mockResolvedValueOnce({ current: true, items: [{ ...item, payload: { text: 'next', files: [{}] } }] })
  await expect(editSessionInboxIntoDraft(input)).rejects.toThrow('invalid-file')
  expect(fixture.commit).not.toHaveBeenCalled()
  expect(fixture.cancel).not.toHaveBeenCalled()
})
