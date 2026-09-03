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
 * Contact avatar with a Grok-Bot-style working dot. The wrapper is a fixed
 * square so the dot stays on the avatar's bottom-right corner — it must not
 * sit in a flex/text baseline and drift.
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
  const box = `calc(${size}px * var(--dpt-n, 1))`
  return (
    <span
      className={cn('relative inline-block shrink-0 align-middle leading-none', className)}
      style={{ width: box, height: box }}
      data-assistant-working-avatar=""
    >
      <AgentAvatar name={name} emoji={emoji} size={size} label={label} className="block" />
      {working ? (
        <span
          className="pointer-events-none absolute right-0 bottom-0 size-2 translate-x-1/4 translate-y-1/4 rounded-full bg-[var(--status-success)] ring-2 ring-background"
          data-assistant-working-dot=""
          aria-label={t('assistants.contact.working')}
        />
      ) : null}
    </span>
  )
}
