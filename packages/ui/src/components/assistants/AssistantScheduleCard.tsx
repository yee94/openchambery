import React from 'react'
import { useEvent } from '@reactuses/core'
import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import type { AssistantContactScheduleCardPart } from '@/queries/assistantQueries'
import { useUIStore } from '@/stores/useUIStore'
import { CONTACT_CARD_COVER_CLASS, activateContactCardOnKeyDown } from './contactCardChrome'

type AssistantScheduleCardProps = {
  card: AssistantContactScheduleCardPart
}

/**
 * Assistant-emitted card for a created scheduled task. Opens Scheduled Tasks.
 * Not a slash command.
 */
export const AssistantScheduleCard: React.FC<AssistantScheduleCardProps> = ({ card }) => {
  const { t } = useI18n()
  const title = card.name
  const kind = card.kind === 'daily' || card.kind === 'weekly' || card.kind === 'once' || card.kind === 'cron'
    ? t(`sessions.scheduledTasks.editor.scheduleType.${card.kind}`)
    : card.kind
  const when = [kind, card.time].filter(Boolean).join(' · ')
  const metadata = when.trim() || (typeof card.prompt === 'string' ? card.prompt.trim() : '')
  const openSchedule = useEvent(() => {
    useUIStore.getState().setActiveMainTab('schedule')
    useUIStore.getState().setScheduledTasksDialogOpen(true)
  })
  const onActivateKeyDown = useEvent((event: React.KeyboardEvent<HTMLElement>) => {
    activateContactCardOnKeyDown(event, openSchedule)
  })

  return (
    <article
      className={CONTACT_CARD_COVER_CLASS}
      role="button"
      tabIndex={0}
      aria-label={t('assistants.contact.card.schedule.aria', { name: title })}
      data-assistant-contact-card="schedule"
      onClick={openSchedule}
      onKeyDown={onActivateKeyDown}
    >
      <div className="flex items-center gap-3">
        <span className="relative inline-block size-10 shrink-0 leading-none" aria-hidden>
          <span className="flex size-10 items-center justify-center rounded-xl bg-[var(--surface-muted)] text-foreground">
            <Icon name="calendar" className="size-5" />
          </span>
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <h3 className="min-w-0 line-clamp-2 break-words typography-ui-label font-medium leading-5 text-foreground">{title}</h3>
          {metadata ? (
            <p className="truncate typography-micro font-normal leading-4 text-muted-foreground">{metadata}</p>
          ) : null}
        </div>
      </div>
    </article>
  )
}
