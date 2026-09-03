import React from 'react'
import { useEvent } from '@reactuses/core'
import { Icon } from '@/components/icon/Icon'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n'
import type { AssistantContactScheduleCardPart } from '@/queries/assistantQueries'
import { useUIStore } from '@/stores/useUIStore'

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
  const when = [card.kind, card.time, card.timezone].filter(Boolean).join(' ')
  const metadata = [when, card.prompt].filter((item) => typeof item === 'string' && item.trim())
  const openSchedule = useEvent(() => {
    useUIStore.getState().setActiveMainTab('schedule')
    useUIStore.getState().setScheduledTasksDialogOpen(true)
  })

  return (
    <article
      className="w-full max-w-md rounded-2xl border border-border/60 bg-[var(--surface-elevated)] px-3.5 py-3"
      aria-label={t('assistants.contact.card.schedule.aria', { name: title })}
      data-assistant-contact-card="schedule"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-muted)] text-foreground">
          <Icon name="calendar" className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="min-w-0 truncate typography-ui-label font-medium text-foreground">{title}</h3>
          {metadata.length > 0 ? (
            <p className="mt-1 truncate typography-micro text-muted-foreground">{metadata.join(' · ')}</p>
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={openSchedule}>
          {t('assistants.contact.card.schedule.open')}
        </Button>
      </div>
    </article>
  )
}
