import { afterEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ revert: vi.fn(), toast: vi.fn() }))
vi.mock('./session-actions', async (importOriginal) => ({
  ...await importOriginal<typeof import('./session-actions')>(),
  revertToMessage: mocks.revert,
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toast } }))

import { useSessionUIStore } from './session-ui-store'
import { formatMessage, useI18nStore } from '@/lib/i18n'

afterEach(() => vi.clearAllMocks())

describe('revert failure feedback', () => {
  test.each([
    ['Error', 'HTTP 503: upstream unavailable', 'chat.revert.toast.failed'],
    ['SessionRevertMessageMissingRecoveredError', 'HTTP 404: message missing', 'chat.revert.toast.messageMissing'],
    ['MessageNotFoundError', 'HTTP 404: message missing', 'chat.revert.toast.failed'],
    ['SessionRevertBusyError', 'session_revert_busy', 'chat.revert.toast.busy'],
    ['AggregateError', 'HTTP 404: message missing\nauthority offline', 'chat.revert.toast.failed'],
  ] as const)('shows %s failures and preserves the rejection', async (name, message, key) => {
    const error = Object.assign(new Error(message), { name })
    mocks.revert.mockRejectedValueOnce(error)
    await expect(useSessionUIStore.getState().revertToMessage('session-a', 'msg-a')).rejects.toBe(error)
    expect(mocks.toast).toHaveBeenCalledOnce()
    expect(mocks.toast).toHaveBeenCalledWith(
      formatMessage(useI18nStore.getState().dictionary, key),
      { id: 'session-revert-error', description: message },
    )
  })
})
