import { describe, expect, it } from 'vitest'
import { splitContactBubbles } from './bubbles.js'

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
