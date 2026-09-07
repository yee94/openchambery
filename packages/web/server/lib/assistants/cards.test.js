import { describe, expect, it } from 'vitest'
import { CONTACT_CARD_TYPES, createSessionCardPart, parseContactCard, parseContactPart } from './cards.js'

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
    expect(CONTACT_CARD_TYPES).toContain('assistant')
    expect(CONTACT_CARD_TYPES).toContain('schedule')
  })

  it('creates assistant and schedule cards in the same slot', () => {
    expect(parseContactCard({
      cardType: 'assistant',
      assistantID: 'asst_flow',
      name: 'FlowQA',
      providerID: 'opencode-go',
      modelID: 'deepseek-v4-flash',
    })).toEqual({
      type: 'card',
      cardType: 'assistant',
      assistantID: 'asst_flow',
      name: 'FlowQA',
      providerID: 'opencode-go',
      modelID: 'deepseek-v4-flash',
      mode: 'continuous',
    })
    expect(parseContactCard({
      cardType: 'schedule',
      taskID: 'task_1',
      projectID: 'proj_1',
      name: 'Daily ping',
      kind: 'daily',
      time: '18:00',
      timezone: 'Asia/Shanghai',
      prompt: 'ping',
    })).toMatchObject({
      type: 'card',
      cardType: 'schedule',
      taskID: 'task_1',
      projectID: 'proj_1',
      name: 'Daily ping',
      kind: 'daily',
      time: '18:00',
    })
  })

  it('rejects unknown card types so later types reuse this slot', () => {
    expect(parseContactCard({
      cardType: 'not-a-card',
      sessionID: 'ses_1',
      directory: '/tmp/project',
    })).toBeNull()
  })

  it('parses contact file parts with optional filename', () => {
    expect(parseContactPart({
      type: 'file',
      mime: 'image/png',
      url: 'data:image/png;base64,aa',
      filename: 'shot.png',
    })).toEqual({
      type: 'file',
      mime: 'image/png',
      url: 'data:image/png;base64,aa',
      filename: 'shot.png',
    })
    expect(parseContactPart({
      type: 'file',
      mime: 'text/plain',
      url: 'data:text/plain;base64,eA==',
    })).toEqual({
      type: 'file',
      mime: 'text/plain',
      url: 'data:text/plain;base64,eA==',
    })
    expect(parseContactPart({ type: 'file', mime: 'image/png' })).toBeNull()
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
