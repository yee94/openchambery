import { describe, expect, it } from 'vitest'
import { isContactSpokenPreamble, splitContactBubbles } from './bubbles.js'

describe('splitContactBubbles', () => {
  it('splits on blank lines into short bubbles', () => {
    expect(splitContactBubbles('Hey.\n\nWant me to open the login session?')).toEqual([
      'Hey.',
      'Want me to open the login session?',
    ])
  })

  it('keeps a single paragraph together', () => {
    expect(splitContactBubbles('Just one bubble.')).toEqual(['Just one bubble.'])
  })

  it('returns an empty list for blank text', () => {
    expect(splitContactBubbles('   \n\n  ')).toEqual([])
  })
})

describe('isContactSpokenPreamble', () => {
  it('accepts a short spoken line', () => {
    expect(isContactSpokenPreamble('我去找一下')).toBe(true)
    expect(isContactSpokenPreamble('On it.')).toBe(true)
  })

  it('rejects chain-of-thought and tool narration', () => {
    expect(isContactSpokenPreamble('Let me think — I should match the project and call assign_session.')).toBe(false)
    expect(isContactSpokenPreamble('I need to list_projects first.')).toBe(false)
  })

  it('rejects long or multi-bubble text', () => {
    expect(isContactSpokenPreamble('a'.repeat(81))).toBe(false)
    expect(isContactSpokenPreamble('先找项目。\n\n再开会话。')).toBe(false)
  })
})
