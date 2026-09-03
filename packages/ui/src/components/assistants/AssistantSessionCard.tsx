import React from 'react'
import { useEvent } from '@reactuses/core'
import { Icon } from '@/components/icon/Icon'
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

const statusKey = (status: string | null | undefined) => {
  if (status === 'busy') return 'assistants.contact.card.session.status.busy' as const
  if (status === 'retry') return 'assistants.contact.card.session.status.retry' as const
  if (status === 'idle') return 'assistants.contact.card.session.status.idle' as const
  return null
}

/**
 * First-class in-transcript session card. Reuses existing session title/status
 * and `openSessionWithFeedback` — not a markdown link and not Activity/tool UI.
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
  const status = liveStatus?.type ?? card.status
  const statusLabelKey = statusKey(status)
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
    <button
      type="button"
      onClick={openSession}
      aria-label={t('assistants.contact.card.session.aria', { title })}
      className={cn(
        'flex w-full max-w-md items-center gap-3 rounded-2xl border border-border/60 bg-[var(--surface-elevated)] px-3 py-3 text-left outline-none transition-[background-color,border-color] duration-150 ease-out',
        'hover:bg-interactive-hover active:bg-interactive-active',
        'focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-muted)] text-foreground">
        <Icon name="chat-3" className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate typography-ui-label font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block truncate typography-micro text-muted-foreground">
          {statusLabelKey ? t(statusLabelKey) : t('assistants.contact.card.session.open')}
        </span>
      </span>
      <Icon name="arrow-right-s" className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}
