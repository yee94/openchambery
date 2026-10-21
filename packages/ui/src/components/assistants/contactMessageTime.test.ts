import { describe, expect, test } from 'vitest'
import type { AssistantContactMessage } from '@/queries/assistantDTO'
import { createContactTimeFormatter, getContactTimeSeparators } from './contactMessageTime'

const at = (day: number, hour: number, minute: number, year = 2026) => new Date(year, 9, day, hour, minute).getTime()
const message = (messageID: string, createdAt: number, patch: Partial<AssistantContactMessage> = {}): AssistantContactMessage => ({
  messageID, createdAt, assistantID: 'assistant', turnID: 'turn', role: 'assistant',
  bubbleIndex: 0, ordinal: 0, status: 'complete', fromAssistantID: null, fromAssistantName: null,
  parts: [{ type: 'text', text: 'hello' }], text: 'hello', cards: [], ...patch,
})

describe('contact time separators', () => {
  test('groups nearby messages but splits gaps over five minutes and local midnight', () => {
    const messages = [
      message('first', at(17, 23, 50)),
      message('five-minutes', at(17, 23, 55)),
      message('midnight', at(18, 0, 0)),
      message('gap', at(18, 0, 6)),
      message('reply', at(18, 0, 7)),
    ]
    expect([...getContactTimeSeparators(messages).keys()]).toEqual(['first', 'midnight', 'gap'])
  })

  test('hidden settle markers and processing previews do not consume a gap', () => {
    expect([...getContactTimeSeparators([
      message('first', at(18, 10, 0)),
      message('hidden', at(18, 10, 8), { parts: [{ type: 'text', text: 'oc.settle.complete' }] }),
      message('processing', at(18, 10, 9), { status: 'admitted', parts: [] }),
      message('reply', at(18, 10, 10)),
    ]).keys()]).toEqual(['first', 'reply'])
  })

  test('cards, files and errors participate; invalid timestamps never produce a separator', () => {
    expect([...getContactTimeSeparators([
      message('invalid', NaN),
      message('file', at(18, 10, 0), { parts: [{ type: 'file', url: 'https://example.com/image.png', mime: 'image/png' }] }),
      message('card', at(18, 10, 10), { parts: [{ type: 'card', cardType: 'schedule', taskID: 'task', projectID: 'project', name: 'Reminder', kind: 'daily', time: '10:00', timezone: null, prompt: '' }] }),
      message('error', at(18, 10, 20), { status: 'error', parts: [] }),
    ]).keys()]).toEqual(['file', 'card', 'error'])
  })

  test('prepending history recalculates the old first row without duplicate boundaries', () => {
    const latest = [message('latest', at(18, 10, 3)), message('reply', at(18, 10, 4))]
    expect([...getContactTimeSeparators(latest).keys()]).toEqual(['latest'])
    expect([...getContactTimeSeparators([message('older', at(18, 10, 0)), ...latest]).keys()]).toEqual(['older'])
  })

  test('uses local dates, localized labels, 24-hour time, and a year only across years', () => {
    const format = createContactTimeFormatter('zh-CN', '今天', new Date(at(21, 12, 0)))
    expect(format(at(21, 10, 59))).toBe('今天 10:59')
    expect(format(at(17, 21, 22))).toBe('10月17日 21:22')
    expect(format(at(17, 21, 22, 2025))).toBe('2025年10月17日 21:22')
    const english = createContactTimeFormatter('en', 'Today', new Date(at(21, 12, 0)))
    expect(english(at(21, 0, 5))).toBe('Today 00:05')
    expect(english(at(17, 21, 22))).toBe('October 17 21:22')
  })
})
