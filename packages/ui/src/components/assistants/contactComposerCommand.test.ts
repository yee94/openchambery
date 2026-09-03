import { describe, expect, test } from 'vitest'
import { parseContactComposerInput } from './contactComposerCommand'

describe('parseContactComposerInput', () => {
  test('treats ordinary text as a contact send', () => {
    expect(parseContactComposerInput('  hello there  ')).toEqual({
      kind: 'send',
      text: 'hello there',
    })
  })

  test('parses /card as a session-card insert for an existing sessionID', () => {
    expect(parseContactComposerInput('/card ses_abc Fix login')).toEqual({
      kind: 'session-card',
      sessionID: 'ses_abc',
      title: 'Fix login',
    })
    expect(parseContactComposerInput('/card ses_abc')).toEqual({
      kind: 'session-card',
      sessionID: 'ses_abc',
      title: null,
    })
  })

  test('parses /dm as a read-only peer delivery to another assistantID', () => {
    expect(parseContactComposerInput('/dm asst_b Can you watch login?')).toEqual({
      kind: 'peer-dm',
      toAssistantID: 'asst_b',
      text: 'Can you watch login?',
    })
  })

  test('returns null for blank input', () => {
    expect(parseContactComposerInput('   ')).toBeNull()
  })
})
