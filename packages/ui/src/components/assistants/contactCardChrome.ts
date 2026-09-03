import type { KeyboardEvent } from 'react'

/** Shared Grok-Bot cover chrome. Whole card is the hit target. */
const CONTACT_CARD_CHROME_CLASS = [
  'cursor-pointer rounded-2xl border border-border/50 bg-[var(--surface-elevated)]',
  'px-2.5 py-2 text-left transition-colors',
  'hover:border-border hover:bg-interactive-hover/40',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
].join(' ')

/** Assistant / schedule covers hug content. */
export const CONTACT_CARD_COVER_CLASS = `${CONTACT_CARD_CHROME_CLASS} w-fit max-w-[15rem]`

/** Session covers can be wider for denser metadata, but not a full-width strip. */
export const CONTACT_SESSION_CARD_COVER_CLASS = `${CONTACT_CARD_CHROME_CLASS} w-fit max-w-[20rem]`

export function activateContactCardOnKeyDown(
  event: KeyboardEvent<HTMLElement>,
  activate: () => void,
): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  activate()
}
