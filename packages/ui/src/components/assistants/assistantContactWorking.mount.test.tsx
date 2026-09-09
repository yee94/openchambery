/**
 * Real React mount: list green-dot + contact 3-dot recover from server authority
 * and clear when snapshot goes idle (missed SSE end). Not source-string asserts.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { AssistantWorkingAvatar } from './AssistantWorkingAvatar'
import {
  applyServerContactTurnAuthority,
  contactTurnPreviewWorking,
  mergeContactTranscript,
  EMPTY_CONTACT_MESSAGES,
} from './contactOptimisticTurns'
import { isAssistantWorking, useAssistantContactWorkingStore, useAssistantWorking } from './assistantWorking'

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

function ListDot({ assistantID, serverWorking }: { assistantID: string; serverWorking: boolean }) {
  const working = useAssistantWorking(assistantID, serverWorking)
  return <AssistantWorkingAvatar name={assistantID} size={24} label="Bot" working={working} />
}

function ProcessingDots({ visible }: { visible: boolean }) {
  if (!visible) return null
  return (
    <div
      role="status"
      aria-label="assistants.contact.processing"
      data-assistant-contact-processing=""
    >
      <span />
      <span />
      <span />
    </div>
  )
}

const mounted: Array<{ root: ReturnType<typeof createRoot>; host: HTMLDivElement }> = []

const mount = async (node: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  await act(async () => {
    root.render(node)
  })
  return host
}

describe('assistant contact working mount', () => {
  beforeEach(() => {
    useAssistantContactWorkingStore.setState({ workingByID: {} })
  })

  afterEach(() => {
    for (const entry of mounted.splice(0)) {
      act(() => {
        entry.root.unmount()
      })
      entry.host.remove()
    }
    useAssistantContactWorkingStore.setState({ workingByID: {} })
  })

  test('list green-dot mounts from serverWorking after APP-style remount', async () => {
    const host = await mount(<ListDot assistantID="asst_live" serverWorking />)
    expect(host.querySelector('[data-assistant-working-dot]')).toBeTruthy()
    expect(isAssistantWorking({ serverWorking: true })).toBe(true)

    await act(async () => {
      host.remove()
    })
    // Remount with same server snapshot authority (local store empty).
    useAssistantContactWorkingStore.setState({ workingByID: {} })
    const remount = await mount(<ListDot assistantID="asst_live" serverWorking />)
    expect(remount.querySelector('[data-assistant-working-dot]')).toBeTruthy()

    const idle = await mount(<ListDot assistantID="asst_idle" serverWorking={false} />)
    expect(idle.querySelector('[data-assistant-working-dot]')).toBeNull()
  })

  test('contact 3-dot appears for busy snapshot and disappears after idle authority (missed end)', async () => {
    let previews = applyServerContactTurnAuthority([], {
      assistantID: 'asst_1',
      activeContactTurn: { turnID: 'turn_1', admittedAt: 1 },
      serverWorking: true,
      snapshotRevision: 3,
    })
    expect(contactTurnPreviewWorking(previews)).toBe(true)
    const messages = EMPTY_CONTACT_MESSAGES
    const transcript = mergeContactTranscript(messages, [], 'asst_1', previews)
    const processing = transcript.some(
      (row) => row.status === 'admitted' && row.messageID.endsWith(':preview:admitted'),
    )
    expect(processing).toBe(true)

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    mounted.push({ root, host })
    await act(async () => {
      root.render(<ProcessingDots visible />)
    })
    expect(host.querySelector('[data-assistant-contact-processing]')).toBeTruthy()
    expect(host.querySelectorAll('[data-assistant-contact-processing] span')).toHaveLength(3)

    // Missed SSE end → poll/snapshot idle + covered admission revision.
    previews = applyServerContactTurnAuthority(previews, {
      assistantID: 'asst_1',
      activeContactTurn: null,
      serverWorking: false,
      snapshotRevision: 8,
      admissionRevisionByTurnID: new Map([['turn_1', 3]]),
      messages: [
        { role: 'assistant', turnID: 'turn_1', status: 'complete', text: 'done' },
      ],
    })
    expect(contactTurnPreviewWorking(previews)).toBe(false)
    await act(async () => {
      root.render(<ProcessingDots visible={false} />)
    })
    expect(host.querySelector('[data-assistant-contact-processing]')).toBeNull()
  })

  test('durable server error recovers failed processing without SSE', async () => {
    const previews = applyServerContactTurnAuthority(
      applyServerContactTurnAuthority([], {
        assistantID: 'asst_1',
        activeContactTurn: { turnID: 'turn_err', admittedAt: 1 },
        serverWorking: true,
        snapshotRevision: 2,
      }),
      {
        assistantID: 'asst_1',
        activeContactTurn: null,
        serverWorking: false,
        snapshotRevision: 5,
        admissionRevisionByTurnID: new Map([['turn_err', 2]]),
        messages: [
          { role: 'assistant', turnID: 'turn_err', status: 'error', text: 'No connected model' },
        ],
      },
    )
    expect(previews[0]?.status).toBe('failed')
    expect(contactTurnPreviewWorking(previews)).toBe(false)
    const host = await mount(<ListDot assistantID="asst_1" serverWorking={false} />)
    expect(host.querySelector('[data-assistant-working-dot]')).toBeNull()
  })
})
