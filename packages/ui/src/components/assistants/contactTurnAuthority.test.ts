import { describe, expect, test } from 'vitest'
import {
  admitContactTurnPreview,
  applyServerContactTurnAuthority,
  contactTurnPreviewWorking,
} from './contactOptimisticTurns'
import { isAssistantWorking as isWorkingDot } from './assistantWorking'

describe('contact turn authority (refresh / missed end / race)', () => {
  test('refresh while server busy restores 3-dot processing', () => {
    const emptyLocal: ReturnType<typeof admitContactTurnPreview> = []
    const afterRefresh = applyServerContactTurnAuthority(emptyLocal, {
      assistantID: 'asst_1',
      activeContactTurn: { turnID: 'turn_live', admittedAt: 42 },
      serverWorking: true,
      snapshotRevision: 9,
    })
    expect(contactTurnPreviewWorking(afterRefresh)).toBe(true)
    expect(afterRefresh[0]).toMatchObject({ turnID: 'turn_live', status: 'admitted' })
    expect(isWorkingDot({ serverWorking: true, processing: contactTurnPreviewWorking(afterRefresh) })).toBe(true)
  })

  test('missed contact-turn-end: idle snapshot clears green dot and 3-dot', () => {
    const local = admitContactTurnPreview([], 'asst_1', 'turn_missed', 1)
    const afterMissedEnd = applyServerContactTurnAuthority(local, {
      assistantID: 'asst_1',
      activeContactTurn: null,
      serverWorking: false,
      snapshotRevision: 20,
      admissionRevisionByTurnID: new Map([['turn_missed', 11]]),
      messages: [
        { role: 'assistant', turnID: 'turn_missed', status: 'complete', text: 'done' },
      ],
    })
    expect(contactTurnPreviewWorking(afterMissedEnd)).toBe(false)
    expect(isWorkingDot({
      serverWorking: false,
      processing: contactTurnPreviewWorking(afterMissedEnd),
      sending: false,
    })).toBe(false)
  })

  test('server failed recovery shows error without SSE and clears working', () => {
    const local = admitContactTurnPreview([], 'asst_1', 'turn_fail', 1)
    const recovered = applyServerContactTurnAuthority(local, {
      assistantID: 'asst_1',
      activeContactTurn: null,
      serverWorking: false,
      snapshotRevision: 15,
      admissionRevisionByTurnID: new Map([['turn_fail', 12]]),
      messages: [
        { role: 'assistant', turnID: 'turn_fail', status: 'error', text: 'No connected model' },
      ],
    })
    expect(recovered.find((preview) => preview.turnID === 'turn_fail')?.status).toBe('failed')
    expect(contactTurnPreviewWorking(recovered)).toBe(false)
  })

  test('old idle snapshot cannot wipe a newer local send', () => {
    const newer = admitContactTurnPreview([], 'asst_1', 'turn_new', 99)
    const kept = applyServerContactTurnAuthority(newer, {
      assistantID: 'asst_1',
      activeContactTurn: null,
      serverWorking: false,
      snapshotRevision: 10,
      admissionRevisionByTurnID: new Map([['turn_new', 14]]),
    })
    expect(contactTurnPreviewWorking(kept)).toBe(true)

    const pending = applyServerContactTurnAuthority(newer, {
      assistantID: 'asst_1',
      activeContactTurn: null,
      serverWorking: false,
      snapshotRevision: 99,
      pendingSendTurnIDs: new Set(['turn_new']),
    })
    expect(contactTurnPreviewWorking(pending)).toBe(true)
  })

  test('multi-turn: busy second turn keeps processing while first error settles', () => {
    let previews = admitContactTurnPreview([], 'asst_1', 'turn_1', 1)
    previews = admitContactTurnPreview(previews, 'asst_1', 'turn_2', 2)
    const next = applyServerContactTurnAuthority(previews, {
      assistantID: 'asst_1',
      activeContactTurn: { turnID: 'turn_2', admittedAt: 2 },
      serverWorking: true,
      snapshotRevision: 8,
      admissionRevisionByTurnID: new Map([['turn_1', 5], ['turn_2', 7]]),
      messages: [
        { role: 'assistant', turnID: 'turn_1', status: 'error', text: 'boom' },
      ],
    })
    expect(next.find((preview) => preview.turnID === 'turn_1')).toBeUndefined()
    expect(next.find((preview) => preview.turnID === 'turn_2')?.status).toBe('admitted')
    expect(contactTurnPreviewWorking(next)).toBe(true)
  })
})
