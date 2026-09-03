import React from 'react'
import { useEvent } from '@reactuses/core'
import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import { isIPadApp } from '@/lib/platform'
import { useMobileAppActions } from '@/apps/mobileAppContext'
import { useMobileNavigationStore } from '@/mobile/useMobileNavigationStore'
import type { AssistantContactAssistantCardPart } from '@/queries/assistantQueries'
import { openAssistant } from '@/stores/useAssistantUIStore'
import { CONTACT_CARD_COVER_CLASS, activateContactCardOnKeyDown } from './contactCardChrome'

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
    activateContactCardOnKeyDown(event, openContact)
  })

  return (
    <article
      className={CONTACT_CARD_COVER_CLASS}
      role="button"
      tabIndex={0}
      aria-label={t('assistants.contact.card.assistant.aria', { name: title })}
      data-assistant-contact-card="assistant"
      onClick={openContact}
      onKeyDown={onActivateKeyDown}
    >
      <div className="flex items-center gap-2">
        <span className="relative inline-block size-6 shrink-0 leading-none">
          <span className="flex size-6 items-center justify-center rounded-md bg-[var(--surface-muted)] text-foreground">
            <Icon name="robot-2" className="size-3" />
          </span>
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <h3 className="min-w-0 truncate typography-ui-label font-medium text-foreground">{title}</h3>
          {metadata.length > 0 ? (
            <p className="truncate typography-micro text-muted-foreground">{metadata.join(' · ')}</p>
          ) : null}
        </div>
      </div>
    </article>
  )
}
