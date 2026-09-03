import React from 'react'
import { useEvent } from '@reactuses/core'
import { AgentAvatar } from '@/components/chat/AgentAvatar'
import { Icon } from '@/components/icon/Icon'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/lib/i18n'
import { createUuid } from '@/lib/uuid'
import { cn } from '@/lib/utils'
import { donateNativeAssistantInteraction } from '@/apps/MobileShareBridge'
import { findSessionById } from '@/router/sessionLookup'
import {
  appendAssistantContactCard,
  deliverAssistantContactDm,
  sendAssistantContactMessage,
  useAssistantCapabilityQuery,
  useAssistantContactMessagesQuery,
  useAssistantSnapshotQuery,
  type AssistantDTO,
} from '@/queries/assistantQueries'
import { AssistantAPIError } from '@/queries/assistantDTO'
import { getAssistantPresentation } from './assistantPresentation'
import { AssistantSessionCard } from './AssistantSessionCard'
import { parseContactComposerInput } from './contactComposerCommand'

type AssistantConversationSurfaceProps = {
  assistant: AssistantDTO
  warning?: string | null
  active: boolean
}

/**
 * Grok-like contact transcript. Renders OpenChamber-owned bubbles and
 * first-class session cards — not ChatContainer, Activity, or markdown links.
 *
 * TODO(next-slice): worktree/branch assign, inbound unsolicited user pushes,
 * and full summon-to-work MUST use this transcript: cards for work, peer DMs
 * for read-only coordination. Do not invent a second inbox.
 */
export const AssistantConversationSurface: React.FC<AssistantConversationSurfaceProps> = ({
  assistant,
  warning,
  active,
}) => {
  const { t } = useI18n()
  const capabilityQuery = useAssistantCapabilityQuery()
  const snapshotQuery = useAssistantSnapshotQuery()
  const contactQuery = useAssistantContactMessagesQuery(assistant.id, active)
  const presentation = getAssistantPresentation(assistant.name)
  const displayName = presentation.displayName || assistant.name
  const peerName = (fromAssistantID: string | null, fromAssistantName: string | null) => {
    const live = fromAssistantID
      ? snapshotQuery.data?.assistants.find((item) => item.id === fromAssistantID)
      : undefined
    if (live) {
      const livePresentation = getAssistantPresentation(live.name)
      return livePresentation.displayName || live.name
    }
    return fromAssistantName || t('assistants.contact.peer.unknown')
  }
  const [draft, setDraft] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const [sendError, setSendError] = React.useState<string | null>(null)
  const scrollerRef = React.useRef<HTMLDivElement | null>(null)
  const messages = contactQuery.data?.messages ?? []

  React.useEffect(() => {
    const node = scrollerRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [messages.length, sending])

  const submit = useEvent(async () => {
    const command = parseContactComposerInput(draft)
    if (!command || sending) return
    setSending(true)
    setSendError(null)
    try {
      if (command.kind === 'session-card') {
        const live = findSessionById(command.sessionID)
        const directory = live?.directory || assistant.effectiveWorkspacePath
        const title = command.title || live?.session?.title || null
        await appendAssistantContactCard(assistant.id, {
          sessionID: command.sessionID,
          directory,
          title,
          status: null,
        })
      } else if (command.kind === 'peer-dm') {
        await deliverAssistantContactDm(assistant.id, {
          toAssistantID: command.toAssistantID,
          text: command.text,
        })
      } else {
        await sendAssistantContactMessage(assistant.id, `oc_contact_${createUuid()}`, command.text)
        if (capabilityQuery.data?.serverInstanceID) {
          void donateNativeAssistantInteraction({
            serverInstanceID: capabilityQuery.data.serverInstanceID,
            assistantID: assistant.id,
            name: displayName,
            avatarSeed: assistant.id,
            ...(presentation.avatarEmoji ? { avatarEmoji: presentation.avatarEmoji } : {}),
          }).catch(() => undefined)
        }
      }
      setDraft('')
    } catch (error) {
      const code = error instanceof AssistantAPIError ? error.code : ''
      setSendError(code === 'no_provider' ? t('assistants.contact.noProvider') : t('assistants.contact.sendFailed'))
    } finally {
      setSending(false)
    }
  })

  const onKeyDown = useEvent((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    }
  })

  const loadFailed = contactQuery.isError && messages.length === 0
  const empty = contactQuery.isSuccess && messages.length === 0

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6"
        data-assistant-contact-transcript=""
      >
        {warning ? (
          <p className="mb-3 typography-micro text-[var(--status-warning)]">{warning}</p>
        ) : null}
        {loadFailed ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center text-center">
            <Icon name="error-warning" className="size-6 text-muted-foreground" />
            <p className="mt-3 typography-ui text-muted-foreground">{t('assistants.contact.loadFailed')}</p>
          </div>
        ) : empty ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center text-center">
            <p className="typography-ui-header font-semibold">{t('assistants.conversation.emptyTitle', { name: displayName })}</p>
            <p className="mt-2 max-w-md typography-ui text-muted-foreground">{t('assistants.contact.empty')}</p>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-2">
            {messages.map((message) => {
              const isUser = message.role === 'user'
              const isPeer = message.role === 'peer'
              const senderName = isPeer ? peerName(message.fromAssistantID, message.fromAssistantName) : displayName
              const sender = isPeer && message.fromAssistantID
                ? snapshotQuery.data?.assistants.find((item) => item.id === message.fromAssistantID)
                : assistant
              const senderPresentation = sender ? getAssistantPresentation(sender.name) : null
              return (
                <div
                  key={message.messageID}
                  className={cn('flex w-full', isUser ? 'justify-end' : 'justify-start')}
                  data-assistant-contact-role={message.role}
                >
                  {!isUser ? (
                    <AgentAvatar
                      name={sender?.id || message.fromAssistantID || assistant.id}
                      emoji={senderPresentation?.avatarEmoji}
                      size={24}
                      label={senderName}
                      className="mt-1 mr-2 shrink-0"
                    />
                  ) : null}
                  <div className={cn('flex min-w-0 max-w-[min(100%,28rem)] flex-col gap-2', isUser && 'items-end')}>
                    {isPeer ? (
                      <span className="typography-micro text-muted-foreground">
                        {t('assistants.contact.peer.from', { name: senderName })}
                      </span>
                    ) : null}
                    {message.parts.map((part, index) => {
                      if (part.type === 'card' && part.cardType === 'session') {
                        return <AssistantSessionCard key={`${message.messageID}:card:${index}`} card={part} />
                      }
                      if (part.type === 'text' && part.text.trim()) {
                        return (
                          <div
                            key={`${message.messageID}:text:${index}`}
                            aria-label={isPeer ? t('assistants.contact.peer.aria', { name: senderName }) : undefined}
                            className={cn(
                              'rounded-2xl px-3 py-2 typography-ui',
                              isUser
                                ? 'bg-[var(--primary-base)] text-[var(--primary-foreground)]'
                                : isPeer
                                  ? 'border border-dashed border-border bg-[var(--surface-muted)] text-foreground'
                                  : 'bg-[var(--surface-elevated)] text-foreground',
                            )}
                          >
                            {part.text}
                          </div>
                        )
                      }
                      return null
                    })}
                  </div>
                </div>
              )
            })}
            {sending ? (
              <p className="typography-micro text-muted-foreground">{t('assistants.contact.sending')}</p>
            ) : null}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-border/40 px-4 py-3 sm:px-6">
        {sendError ? <p className="mb-2 typography-micro text-[var(--status-error)]">{sendError}</p> : null}
        <div className="mx-auto flex w-full max-w-2xl items-end gap-2">
          <Textarea
            simple
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={sending}
            placeholder={t('assistants.contact.placeholder', { name: displayName })}
            aria-label={t('assistants.contact.placeholder', { name: displayName })}
            className="min-h-11 max-h-36 flex-1 resize-none rounded-2xl border border-border/60 bg-[var(--surface-elevated)] px-3 py-2"
          />
          <Button
            type="button"
            size="sm"
            disabled={sending || !draft.trim()}
            onClick={() => { void submit() }}
          >
            {t('assistants.contact.send')}
          </Button>
        </div>
        <p className="mx-auto mt-2 max-w-2xl typography-micro text-muted-foreground">
          {t('assistants.contact.composerHint')}
        </p>
      </div>
    </div>
  )
}
