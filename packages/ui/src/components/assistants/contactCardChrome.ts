import type { KeyboardEvent } from 'react'

/** Shared Grok-Bot cover chrome. Whole card is the hit target. */
const CONTACT_CARD_CHROME_CLASS = [
  'cursor-pointer rounded-[1.35rem] bg-[var(--surface-elevated)] ring-1 ring-inset ring-[var(--surface-subtle)]',
  'px-3.5 py-3 text-left transition-[background-color,box-shadow,transform] duration-200 ease-out motion-reduce:transition-none',
  'hover:-translate-y-px hover:bg-interactive-hover/45 hover:shadow-sm active:translate-y-0 motion-reduce:hover:translate-y-0',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
].join(' ')

/** Assistant / schedule covers hug content. */
export const CONTACT_CARD_COVER_CLASS = `${CONTACT_CARD_CHROME_CLASS} w-fit min-w-0 max-w-[min(100%,15rem)]`

/** Session covers can be wider for denser metadata, but not a full-width strip. */
export const CONTACT_SESSION_CARD_COVER_CLASS = `${CONTACT_CARD_CHROME_CLASS} w-fit min-w-0 max-w-[min(100%,20rem)]`

export function activateContactCardOnKeyDown(
  event: KeyboardEvent<HTMLElement>,
  activate: () => void,
): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  activate()
}
