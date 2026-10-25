import type { AssistantContactMessage } from '@/queries/assistantDTO'

const TIME_SEPARATOR_GAP = 5 * 60 * 1000

const sameLocalDay = (left: Date, right: Date) => (
  left.getFullYear() === right.getFullYear()
  && left.getMonth() === right.getMonth()
  && left.getDate() === right.getDate()
)

export function getContactTimeSeparators(messages: readonly AssistantContactMessage[]): Map<string, number> {
  const separators = new Map<string, number>()
  let previous: Date | null = null
  for (const message of messages) {
    const visible = message.status === 'error' || message.status === 'failed'
      || message.parts.some((part) => part.type !== 'text'
        || (part.text.trim() && !part.text.trim().startsWith('yuri.settle.') && !part.text.trim().startsWith('oc.settle.')))
    if (!visible) continue
    const date = new Date(message.createdAt)
    if (!Number.isFinite(date.getTime())) continue
    if (!previous || !sameLocalDay(previous, date) || date.getTime() - previous.getTime() > TIME_SEPARATOR_GAP) {
      separators.set(message.messageID, message.createdAt)
    }
    previous = date
  }
  return separators
}

export function createContactTimeFormatter(locale: string, todayLabel: string, now: Date) {
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const date = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' })
  const yearDate = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' })
  return (timestamp: number): string => {
    const value = new Date(timestamp)
    const day = sameLocalDay(value, now)
      ? todayLabel
      : (value.getFullYear() === now.getFullYear() ? date : yearDate).format(value)
    return `${day} ${time.format(value)}`
  }
}
