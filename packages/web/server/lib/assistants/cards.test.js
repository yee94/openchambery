import { describe, expect, it } from 'vitest'
import { CONTACT_CARD_TYPES, createSessionCardPart, parseContactCard } from './cards.js'

describe('contact cards', () => {
  it('creates an extensible session card part', () => {
    const part = createSessionCardPart({
      sessionID: 'ses_1',
      directory: '/tmp/project',
      title: 'Fix login',
      status: 'idle',
      branch: 'feat-login',
    })
    expect(part).toEqual({
      type: 'card',
      cardType: 'session',
      sessionID: 'ses_1',
      directory: '/tmp/project',
      title: 'Fix login',
      status: 'idle',
      branch: 'feat-login',
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

  it('treats omitted branch as null so older persisted cards still parse', () => {
    expect(parseContactCard({
      cardType: 'session',
      sessionID: 'ses_1',
      directory: '/tmp/project',
      title: 'Fix login',
      status: 'idle',
    })).toEqual({
      type: 'card',
      cardType: 'session',
      sessionID: 'ses_1',
      directory: '/tmp/project',
      title: 'Fix login',
      status: 'idle',
      branch: null,
    })
  })
})
