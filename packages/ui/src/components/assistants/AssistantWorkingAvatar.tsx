import React from 'react'
import { AgentAvatar } from '@/components/chat/AgentAvatar'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

type AssistantWorkingAvatarProps = {
  name: string
  emoji?: string
  size?: number
  label?: string
  working?: boolean
  className?: string
}

/**
 * Contact avatar with a Grok-Bot-style working dot. The dot is a status
 * indicator, not Activity chrome.
 */
export const AssistantWorkingAvatar: React.FC<AssistantWorkingAvatarProps> = ({
  name,
  emoji,
  size = 24,
  label,
  working = false,
  className,
}) => {
  const { t } = useI18n()
  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      <AgentAvatar name={name} emoji={emoji} size={size} label={label} />
      {working ? (
        <span
          className="pointer-events-none absolute right-0 bottom-0 size-2 rounded-full bg-[var(--status-success)] ring-2 ring-background"
          data-assistant-working-dot=""
          aria-label={t('assistants.contact.working')}
        />
      ) : null}
    </span>
  )
}
