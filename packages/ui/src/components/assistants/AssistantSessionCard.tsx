import React from 'react'
import { useEvent } from '@reactuses/core'
import { Icon } from '@/components/icon/Icon'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { findSessionById } from '@/router/sessionLookup'
import type { AssistantContactSessionCardPart } from '@/queries/assistantQueries'
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useMobileAppActions } from '@/apps/mobileAppContext'
import { isIPadApp } from '@/lib/platform'
import { useGlobalSessionStatus } from '@/sync/sync-context'
import { openSessionWithFeedback } from '@/sync/openSessionWithFeedback'

type AssistantSessionCardProps = {
  card: AssistantContactSessionCardPart
}

const displayStatus = (liveType: string | undefined, persisted: string | null | undefined) => {
  if (liveType === 'busy' || liveType === 'retry') return liveType
  if (persisted === 'error' || persisted === 'question' || persisted === 'complete') return persisted
  if (liveType === 'idle') return 'complete'
  if (persisted === 'busy' || persisted === 'retry' || persisted === 'idle') return persisted
  return persisted || 'busy'
}

const statusKey = (status: string | null | undefined) => {
  if (status === 'busy') return 'assistants.contact.card.session.status.busy' as const
  if (status === 'retry') return 'assistants.contact.card.session.status.retry' as const
  if (status === 'idle') return 'assistants.contact.card.session.status.idle' as const
  if (status === 'complete') return 'assistants.contact.card.session.status.complete' as const
  if (status === 'error') return 'assistants.contact.card.session.status.error' as const
  if (status === 'question') return 'assistants.contact.card.session.status.question' as const
  return null
}

const statusChipClass = (status: string | null | undefined) => {
  if (status === 'busy') return 'bg-[var(--status-info)]/10 text-[var(--status-info)]'
  if (status === 'retry' || status === 'question') return 'bg-[var(--status-warning)]/10 text-[var(--status-warning)]'
  if (status === 'error') return 'bg-[var(--status-error)]/10 text-[var(--status-error)]'
  if (status === 'idle' || status === 'complete') return 'bg-[var(--status-success)]/10 text-[var(--status-success)]'
  return 'bg-[var(--surface-muted)] text-muted-foreground'
}

const directoryName = (directory: string) => {
  const parts = directory.split(/[/\\]/u).filter(Boolean)
  return parts.at(-1) || directory
}

/**
 * Assistant-emitted in-transcript session card (Grok-Bot style): title,
 * status chip, metadata, primary open action. Not a slash command, not
 * Activity/tool UI.
 */
export const AssistantSessionCard: React.FC<AssistantSessionCardProps> = ({ card }) => {
  const { t } = useI18n()
  const mobileActions = useMobileAppActions()
  const isPhoneShell = Boolean(mobileActions && !isIPadApp())
  const liveTitle = useGlobalSessionsStore((state) => {
    const session = state.activeSessions.find((item) => item.id === card.sessionID)
      ?? state.archivedSessions.find((item) => item.id === card.sessionID)
    return typeof session?.title === 'string' && session.title.trim() ? session.title : null
  })
  const liveStatus = useGlobalSessionStatus(card.sessionID)
  const title = liveTitle || card.title || t('assistants.contact.card.session.untitled')
  const status = displayStatus(liveStatus?.type, card.status)
  const statusLabelKey = statusKey(status)
  const metadata = [card.branch, card.sessionID, directoryName(card.directory)].filter(Boolean)
  const openSession = useEvent(() => {
    const live = findSessionById(card.sessionID)
    const directory = live?.directory || card.directory
    openSessionWithFeedback(card.sessionID, directory, {
      phoneShell: isPhoneShell,
      switchToChat: true,
    })
    if (!isPhoneShell) {
      useUIStore.getState().setActiveMainTab('chat')
    }
  })

  return (
    <article
      className="w-full max-w-md rounded-2xl border border-border/60 bg-[var(--surface-elevated)] px-3.5 py-3"
      aria-label={t('assistants.contact.card.session.aria', { title })}
      data-assistant-contact-card="session"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-muted)] text-foreground">
          <Icon name="chat-3" className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <h3 className="min-w-0 flex-1 truncate typography-ui-label font-medium text-foreground">{title}</h3>
            {statusLabelKey ? (
              <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 typography-micro leading-none', statusChipClass(status))}>
                {t(statusLabelKey)}
              </span>
            ) : null}
          </div>
          {metadata.length > 0 ? (
            <p className="mt-1 truncate typography-micro text-muted-foreground">{metadata.join(' · ')}</p>
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={openSession}>
          {t('assistants.contact.card.session.open')}
        </Button>
      </div>
    </article>
  )
}
