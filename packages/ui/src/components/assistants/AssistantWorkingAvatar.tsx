import React from 'react'
import { AgentAvatar } from '@/components/chat/AgentAvatar'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useAssistantContactWorkingStore } from './assistantWorking'

type AssistantWorkingAvatarProps = {
  name: string
  avatarSeed?: string
  size?: number
  label?: string
  working?: boolean
  showWorkingDot?: boolean
  className?: string
}

/**
 * Contact avatar with a Grok-Bot-style working dot. The wrapper is a fixed
 * square so the dot stays on the avatar's bottom-right corner — it must not
 * sit in a flex/text baseline and drift.
 */
export const AssistantWorkingAvatar: React.FC<AssistantWorkingAvatarProps> = ({
  name,
  avatarSeed,
  size = 24,
  label,
  working,
  showWorkingDot = true,
  className,
}) => {
  const { t } = useI18n()
  const localWorking = useAssistantContactWorkingStore((state) => working !== undefined && Boolean(state.workingByID[name]))
  const animated = Boolean(working || localWorking)
  const box = `calc(${size}px * var(--dpt-n, 1))`
  return (
    <span
      className={cn('relative inline-block shrink-0 align-middle leading-none', className)}
      style={{ width: box, minWidth: box, maxWidth: box, height: box, minHeight: box, maxHeight: box }}
      data-assistant-working-avatar=""
    >
      <AgentAvatar kind="assistant" animated={animated} name={avatarSeed ?? name} size={size} label={label} shape="rounded" className="rounded-[0.5rem]" />
      {working && showWorkingDot ? (
        <span
          className="pointer-events-none absolute right-0 bottom-0 size-2.5 translate-x-0.5 translate-y-0.5 rounded-full bg-[var(--status-success)] ring-2 ring-background"
          data-assistant-working-dot=""
          aria-label={t('assistants.contact.working')}
        />
      ) : null}
    </span>
  )
}
