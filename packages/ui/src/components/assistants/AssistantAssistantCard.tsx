import React from 'react'
import { useEvent } from '@reactuses/core'
import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import { isIPadApp } from '@/lib/platform'
import { useMobileAppActions } from '@/apps/mobileAppContext'
import { useMobileNavigationStore } from '@/mobile/useMobileNavigationStore'
import type { AssistantContactAssistantCardPart } from '@/queries/assistantQueries'
import { openAssistant } from '@/stores/useAssistantUIStore'

type AssistantAssistantCardProps = {
  card: AssistantContactAssistantCardPart
}

/**
 * Assistant-emitted card for a newly created contact. Opens that assistant.
 * Not a slash command.
 */
export const AssistantAssistantCard: React.FC<AssistantAssistantCardProps> = ({ card }) => {
  const { t } = useI18n()
  const mobileActions = useMobileAppActions()
  const isPhoneShell = Boolean(mobileActions && !isIPadApp())
  const title = card.name
  const metadata = [`${card.providerID}/${card.modelID}`, card.mode].filter(Boolean)
  const openContact = useEvent(() => {
    if (isPhoneShell) {
      useMobileNavigationStore.getState().openAssistant(card.assistantID)
      return
    }
    openAssistant(card.assistantID)
  })

  const onActivateKeyDown = useEvent((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    openContact()
  })

  return (
    <article
      className="w-full max-w-md cursor-pointer rounded-2xl border border-border/60 bg-[var(--surface-elevated)] px-3.5 py-3 text-left transition-colors hover:border-border hover:bg-interactive-hover/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
      role="button"
      tabIndex={0}
      aria-label={t('assistants.contact.card.assistant.aria', { name: title })}
      data-assistant-contact-card="assistant"
      onClick={openContact}
      onKeyDown={onActivateKeyDown}
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-muted)] text-foreground">
          <Icon name="robot-2" className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="min-w-0 truncate typography-ui-label font-medium text-foreground">{title}</h3>
          {metadata.length > 0 ? (
            <p className="mt-1 truncate typography-micro text-muted-foreground">{metadata.join(' · ')}</p>
          ) : null}
        </div>
      </div>
    </article>
  )
}
