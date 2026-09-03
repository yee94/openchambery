import { describe, expect, it } from 'vitest'
import { CONTACT_CARD_TYPES, createSessionCardPart, parseContactCard } from './cards.js'

describe('contact cards', () => {
  it('creates an extensible session card part', () => {
    const part = createSessionCardPart({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      title: 'Fix login',
      status: 'idle',
    })
    expect(part).toEqual({
      type: 'card',
      cardType: 'session',
      sessionID: 'ses_1',
      directory: '/tmp/project',
      title: 'Fix login',
      status: 'idle',
    })
    expect(CONTACT_CARD_TYPES).toContain('session')
  })

  it('rejects unknown card types so later types reuse this slot', () => {
    expect(parseContactCard({
      cardType: 'not-a-card',
      sessionID: 'ses_1',
      directory: '/tmp/project',
    })).toBeNull()
  })

  it('requires a sessionID for session cards', () => {
    expect(() => createSessionCardPart({ directory: '/tmp/project' })).toThrow(/sessionID/)
  })
})
