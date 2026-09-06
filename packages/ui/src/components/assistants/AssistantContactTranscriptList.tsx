import React from 'react'
import { useEvent } from '@reactuses/core'
import { LegendList } from '@legendapp/list/react'
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer'
import { MarkdownHydrationProvider } from '@/components/chat/markdown/MarkdownHydrationProvider'
import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { AssistantContactMessage, AssistantDTO } from '@/queries/assistantQueries'
import { getAssistantPresentation } from './assistantPresentation'
import { AssistantAssistantCard } from './AssistantAssistantCard'
import { AssistantScheduleCard } from './AssistantScheduleCard'
import { AssistantSessionCard } from './AssistantSessionCard'
import { AssistantWorkingAvatar } from './AssistantWorkingAvatar'
import type { ContactOptimisticTurn } from './contactOptimisticTurns'

const SETTLE_TEXT: Record<string, 'assistants.contact.settle.complete' | 'assistants.contact.settle.error' | 'assistants.contact.settle.question'> = {
  'oc.settle.complete': 'assistants.contact.settle.complete',
  'oc.settle.error': 'assistants.contact.settle.error',
  'oc.settle.question': 'assistants.contact.settle.question',
}

const CONTACT_ESTIMATED_ITEM_SIZE = 80

type AssistantContactTranscriptListProps = {
  messages: readonly AssistantContactMessage[]
  assistant: AssistantDTO
  peerName: (fromAssistantID: string | null, fromAssistantName: string | null) => string
  resolveSender: (message: AssistantContactMessage) => { id: string; name: string; emoji?: string | null }
  working: boolean
  warning?: string | null
  optimisticByID: Map<string, ContactOptimisticTurn>
  hasNextPage: boolean
  isFetchingNextPage: boolean
  catalogRevision?: number
  onLoadOlder: () => void
}

const AssistantContactRow: React.FC<{
  message: AssistantContactMessage
  peerName: AssistantContactTranscriptListProps['peerName']
  resolveSender: AssistantContactTranscriptListProps['resolveSender']
  working: boolean
  optimistic?: ContactOptimisticTurn
}> = ({ message, peerName, resolveSender, working, optimistic }) => {
  const { t } = useI18n()
  const isUser = message.role === 'user'
  const isPeer = message.role === 'peer'
  const sender = resolveSender(message)
  const senderName = isPeer ? peerName(message.fromAssistantID, message.fromAssistantName) : sender.name
  return (
    <div
      className={cn('flex w-full py-1', isUser ? 'justify-end' : 'justify-start')}
      data-assistant-contact-role={message.role}
      data-assistant-contact-turn-status={optimistic?.status}
    >
      {!isUser ? (
        <AssistantWorkingAvatar
          name={sender.id}
          emoji={sender.emoji ?? undefined}
          size={24}
          label={senderName}
          working={!isPeer && working}
          className="mt-1 mr-2"
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
          if (part.type === 'card' && part.cardType === 'assistant') {
            return <AssistantAssistantCard key={`${message.messageID}:card:${index}`} card={part} />
          }
          if (part.type === 'card' && part.cardType === 'schedule') {
            return <AssistantScheduleCard key={`${message.messageID}:card:${index}`} card={part} />
          }
          if (part.type === 'file' && part.mime.startsWith('image/') && part.url) {
            return (
              <img
                key={`${message.messageID}:file:${index}`}
                src={part.url}
                alt={part.filename || t('assistants.contact.attachment.image')}
                className="max-h-64 max-w-full rounded-2xl border border-border object-contain"
                data-assistant-contact-image=""
              />
            )
          }
          if (part.type === 'file') {
            return (
              <div
                key={`${message.messageID}:file:${index}`}
                className="flex max-w-full items-center gap-2 rounded-2xl border border-border bg-[var(--surface-elevated)] px-3 py-2"
                data-assistant-contact-file=""
              >
                <Icon name="file-text" className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate typography-ui">
                  {part.filename || t('assistants.contact.attachment.file')}
                </span>
              </div>
            )
          }
          if (part.type === 'text' && part.text.trim()) {
            const settleKey = SETTLE_TEXT[part.text]
            return (
              <div
                key={`${message.messageID}:text:${index}`}
                aria-label={isPeer ? t('assistants.contact.peer.aria', { name: senderName }) : undefined}
                className={cn(
                  'max-w-full rounded-2xl px-3 py-2 typography-ui [&_.markdown-content]:leading-relaxed [&_.markdown-content>*:first-child]:mt-0 [&_.markdown-content>*:last-child]:mb-0',
                  isUser
                    ? 'bg-[var(--primary-base)] text-[var(--primary-foreground)] [&_.markdown-content]:text-[var(--primary-foreground)]'
                    : isPeer
                      ? 'border border-dashed border-border bg-[var(--surface-muted)] text-foreground'
                      : 'border border-border/60 bg-[var(--surface-muted)] text-foreground',
                )}
              >
                {settleKey ? t(settleKey) : (
                  <MarkdownRenderer
                    content={part.text}
                    messageId={`${message.messageID}:text:${index}`}
                    variant="assistant"
                    enableFileReferences={false}
                  />
                )}
              </div>
            )
          }
          return null
        })}
        {optimistic?.status === 'sending' ? (
          <p className="typography-micro text-muted-foreground">{t('assistants.contact.sending')}</p>
        ) : null}
        {optimistic?.status === 'failed' ? (
          <p className="typography-micro text-[var(--status-error)]">{optimistic.error || t('assistants.contact.sendFailed')}</p>
        ) : null}
      </div>
    </div>
  )
}

export const AssistantContactTranscriptList: React.FC<AssistantContactTranscriptListProps> = ({
  messages,
  assistant,
  peerName,
  resolveSender,
  working,
  warning,
  optimisticByID,
  hasNextPage,
  isFetchingNextPage,
  catalogRevision = 0,
  onLoadOlder,
}) => {
  const { t } = useI18n()
  const handleStartReached = useEvent(() => {
    if (!hasNextPage || isFetchingNextPage) return
    onLoadOlder()
  })
  const renderItem = useEvent(({ item }: { item: AssistantContactMessage }) => (
    <AssistantContactRow
      message={item}
      peerName={peerName}
      resolveSender={resolveSender}
      working={working}
      optimistic={optimisticByID.get(item.messageID)}
    />
  ))
  const optimisticEpoch = [...optimisticByID.values()]
    .map((turn) => `${turn.messageID}:${turn.status}`)
    .join(',')
  const header = (
    <div className="pt-4">
      {warning ? (
        <p className="mb-3 typography-micro text-[var(--status-warning)]">{warning}</p>
      ) : null}
      {isFetchingNextPage ? (
        <p className="mb-2 typography-micro text-muted-foreground" aria-busy="true">
          {t('chat.history.loadOlder')}
        </p>
      ) : null}
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-assistant-contact-transcript="">
      <MarkdownHydrationProvider enabled>
        <LegendList<AssistantContactMessage>
          data={messages as AssistantContactMessage[]}
          extraData={`${assistant.id}:${working}:${isFetchingNextPage}:${catalogRevision}:${optimisticEpoch}`}
          keyExtractor={(item) => item.messageID}
          renderItem={renderItem}
          estimatedItemSize={CONTACT_ESTIMATED_ITEM_SIZE}
          recycleItems={false}
          initialScrollAtEnd
          maintainScrollAtEnd={!isFetchingNextPage}
          maintainVisibleContentPosition={{ data: true, size: isFetchingNextPage }}
          onStartReached={handleStartReached}
          onStartReachedThreshold={0.4}
          ListHeaderComponent={header}
          className="min-h-0 flex-1"
          contentContainerClassName="mx-auto w-full max-w-2xl px-4 pb-4 sm:px-6"
        />
      </MarkdownHydrationProvider>
    </div>
  )
}

export const resolveContactSender = (
  message: AssistantContactMessage,
  assistant: AssistantDTO,
  assistants: readonly AssistantDTO[] | undefined,
) => {
  if (message.role === 'peer' && message.fromAssistantID) {
    const sender = assistants?.find((item) => item.id === message.fromAssistantID)
    if (sender) {
      const presentation = getAssistantPresentation(sender.name)
      return {
        id: sender.id,
        name: presentation.displayName || sender.name,
        emoji: presentation.avatarEmoji,
      }
    }
    return {
      id: message.fromAssistantID,
      name: message.fromAssistantName || assistant.name,
      emoji: null,
    }
  }
  const presentation = getAssistantPresentation(assistant.name)
  return {
    id: assistant.id,
    name: presentation.displayName || assistant.name,
    emoji: presentation.avatarEmoji,
  }
}
