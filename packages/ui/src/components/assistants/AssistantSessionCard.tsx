import React from 'react'
import { useEvent } from '@reactuses/core'
import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import {
  formatSessionChangeCounts,
  readSessionBranchLabel,
  readSessionChangeSummary,
  readSessionModelLabel,
} from '@/lib/sessionChangeSummary'
import { cn } from '@/lib/utils'
import { findSessionById } from '@/router/sessionLookup'
import type { AssistantContactSessionCardPart } from '@/queries/assistantQueries'
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useMobileAppActions } from '@/apps/mobileAppContext'
import { isIPadApp } from '@/lib/platform'
import { useGlobalSessionStatus } from '@/sync/sync-context'
import { openSessionWithFeedback } from '@/sync/openSessionWithFeedback'
import { CONTACT_SESSION_CARD_COVER_CLASS, activateContactCardOnKeyDown } from './contactCardChrome'

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
 * Compact assistant-emitted session cover: short title, project, status,
 * optional model/branch/changes. The card itself opens the session.
 */
export const AssistantSessionCard: React.FC<AssistantSessionCardProps> = ({ card }) => {
  const { t } = useI18n()
  const mobileActions = useMobileAppActions()
  const isPhoneShell = Boolean(mobileActions && !isIPadApp())
  const liveSession = useGlobalSessionsStore((state) => (
    state.activeSessions.find((item) => item.id === card.sessionID)
    ?? state.archivedSessions.find((item) => item.id === card.sessionID)
    ?? null
  ))
  const liveStatus = useGlobalSessionStatus(card.sessionID)
  const liveTitle = typeof liveSession?.title === 'string' && liveSession.title.trim()
    ? liveSession.title.trim()
    : null
  const title = liveTitle || card.title || t('assistants.contact.card.session.untitled')
  const status = displayStatus(liveStatus?.type, card.status)
  const statusLabelKey = statusKey(status)
  const working = status === 'busy' || status === 'retry'
  const directory = (typeof liveSession?.directory === 'string' && liveSession.directory.trim())
    ? liveSession.directory.trim()
    : card.directory
  const project = directoryName(directory)
  const branch = readSessionBranchLabel(liveSession) || card.branch
  const model = readSessionModelLabel(liveSession)
  const changes = readSessionChangeSummary(liveSession)
  const changeCounts = formatSessionChangeCounts(changes)
  const metaLine = [project, model, branch].filter((item): item is string => Boolean(item && item.trim()))
  const openSession = useEvent(() => {
    const live = findSessionById(card.sessionID)
    const nextDirectory = live?.directory || card.directory
    openSessionWithFeedback(card.sessionID, nextDirectory, {
      phoneShell: isPhoneShell,
      switchToChat: true,
    })
    if (!isPhoneShell) {
      useUIStore.getState().setActiveMainTab('chat')
    }
  })
  const onActivateKeyDown = useEvent((event: React.KeyboardEvent<HTMLElement>) => {
    activateContactCardOnKeyDown(event, openSession)
  })

  return (
    <article
      className={CONTACT_SESSION_CARD_COVER_CLASS}
      role="button"
      tabIndex={0}
      aria-label={t('assistants.contact.card.session.aria', { title })}
      data-assistant-contact-card="session"
      onClick={openSession}
      onKeyDown={onActivateKeyDown}
    >
      <div className="flex items-start gap-2">
        <span className="relative inline-block size-6 shrink-0 leading-none">
          <span className="flex size-6 items-center justify-center rounded-md bg-[var(--surface-muted)] text-foreground">
            <Icon name="chat-3" className="size-3" />
          </span>
          {working ? (
            <span
              className="pointer-events-none absolute right-0 bottom-0 size-2 translate-x-1/4 translate-y-1/4 rounded-full bg-[var(--status-success)] ring-2 ring-[var(--surface-elevated)]"
              data-assistant-working-dot=""
              aria-hidden
            />
          ) : null}
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-1.5">
            <h3 className="min-w-0 flex-1 truncate typography-ui-label font-medium text-foreground">{title}</h3>
            {statusLabelKey ? (
              <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 typography-micro leading-none', statusChipClass(status))}>
                {t(statusLabelKey)}
              </span>
            ) : null}
          </div>
          {metaLine.length > 0 ? (
            <p className="truncate typography-micro text-muted-foreground">{metaLine.join(' · ')}</p>
          ) : null}
          {changeCounts || (changes?.files !== undefined && changes.files > 0) ? (
            <p className="flex flex-wrap items-baseline gap-x-1.5 typography-micro tabular-nums">
              {changes?.additions !== undefined ? (
                <span className="text-[var(--status-success)]">+{changes.additions}</span>
              ) : null}
              {changes?.deletions !== undefined ? (
                <span className="text-[var(--status-error)]">−{changes.deletions}</span>
              ) : null}
              {changes?.files !== undefined ? (
                <span className="text-muted-foreground">
                  {changes.files === 1
                    ? t('assistants.contact.card.session.changes.filesSingle', { count: changes.files })
                    : t('assistants.contact.card.session.changes.filesPlural', { count: changes.files })}
                </span>
              ) : null}
            </p>
          ) : null}
        </div>
      </div>
    </article>
  )
}
