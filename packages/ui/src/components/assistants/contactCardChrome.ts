import type { KeyboardEvent } from 'react'

/** Compact clickable contact-card chrome. Whole card is the hit target. */
export const CONTACT_CARD_CHROME_CLASS = [
  'w-full max-w-md cursor-pointer rounded-xl border border-border/60 bg-[var(--surface-elevated)]',
  'px-3 py-2.5 text-left transition-colors',
  'hover:border-border hover:bg-interactive-hover/40',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
].join(' ')

export function activateContactCardOnKeyDown(
  event: KeyboardEvent<HTMLElement>,
  activate: () => void,
): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  activate()
}
