import React from 'react'
import { useEvent } from '@reactuses/core'
import { ChatPromptComposer, type ChatPromptAttachment } from '@/components/chat/ChatPromptComposer'
import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import { createUuid } from '@/lib/uuid'
import { cn } from '@/lib/utils'
import { donateNativeAssistantInteraction } from '@/apps/MobileShareBridge'
import { useUIStore } from '@/stores/useUIStore'
import {
  sendAssistantContactMessage,
  useAssistantCapabilityQuery,
  useAssistantContactMessagesQuery,
  useAssistantSnapshotQuery,
  type AssistantDTO,
} from '@/queries/assistantQueries'
import { getAssistantPresentation } from './assistantPresentation'
import {
  beginContactComposerSubmit,
  contactOptimisticSending,
  contactSendErrorMessage,
  createContactSendGate,
  EMPTY_CONTACT_MESSAGES,
  markContactOptimisticFailed,
  mergeContactTranscript,
  reconcileContactOptimisticTurns,
  scopeContactOptimisticTurns,
  type ContactOptimisticTurn,
} from './contactOptimisticTurns'
import { AssistantAssistantCard } from './AssistantAssistantCard'
import { AssistantScheduleCard } from './AssistantScheduleCard'
import { AssistantSessionCard } from './AssistantSessionCard'
import { AssistantWorkingAvatar } from './AssistantWorkingAvatar'
import { useAssistantContactWorkingStore, useAssistantWorking } from './assistantWorking'
import {
  filesFromClipboard,
  filesFromDrop,
  mergeContactComposerAttachments,
  readContactComposerFiles,
} from './contactComposerAttachments'

const SETTLE_TEXT: Record<string, 'assistants.contact.settle.complete' | 'assistants.contact.settle.error' | 'assistants.contact.settle.question'> = {
  'oc.settle.complete': 'assistants.contact.settle.complete',
  'oc.settle.error': 'assistants.contact.settle.error',
  'oc.settle.question': 'assistants.contact.settle.question',
}

type AssistantConversationSurfaceProps = {
  assistant: AssistantDTO
  warning?: string | null
  active: boolean
}

/**
 * Grok-like contact transcript. Renders OpenChamber-owned bubbles and
 * first-class session cards — not ChatContainer, Activity, or markdown links.
 *
 * Cards are assistant-emitted UI (assign_session, create_assistant,
 * schedule_task; later watch/PR). The composer is a message box — not slash
 * commands. Peer DMs arrive from the harness/API. TODO(watch/summon): inbound
 * unsolicited user pushes and full summon-to-work MUST use this transcript.
 * Do not invent a second inbox.
 */
export const AssistantConversationSurface: React.FC<AssistantConversationSurfaceProps> = ({
  assistant,
  warning,
  active,
}) => {
  const { t } = useI18n()
  const isMobile = useUIStore((state) => state.isMobile)
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
  const [attachments, setAttachments] = React.useState<ChatPromptAttachment[]>([])
  const [optimisticTurns, setOptimisticTurns] = React.useState<ContactOptimisticTurn[]>([])
  const [sendError, setSendError] = React.useState<string | null>(null)
  const sendGate = React.useMemo(() => createContactSendGate(), [])
  const setContactSending = useAssistantContactWorkingStore((state) => state.setSending)
  const working = useAssistantWorking(assistant.id, assistant.assignedSessionIDs ?? [], Boolean(assistant.working))
  const scrollerRef = React.useRef<HTMLDivElement | null>(null)
  const messages = contactQuery.data?.messages ?? EMPTY_CONTACT_MESSAGES
  const transcript = mergeContactTranscript(messages, optimisticTurns, assistant.id)
  const sending = contactOptimisticSending(optimisticTurns)

  React.useEffect(() => {
    setSendError(null)
    setOptimisticTurns((current) => reconcileContactOptimisticTurns(
      scopeContactOptimisticTurns(current, assistant.id),
      messages,
    ))
  }, [assistant.id, messages])

  React.useEffect(() => {
    setContactSending(assistant.id, sending)
  }, [assistant.id, sending, setContactSending])

  React.useEffect(() => {
    const id = assistant.id
    return () => {
      setContactSending(id, false)
    }
  }, [assistant.id, setContactSending])

  React.useEffect(() => {
    const node = scrollerRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [transcript.length, sending])

  const addFiles = useEvent(async (files: ArrayLike<File> | null) => {
    const result = await readContactComposerFiles(files)
    if (result.skippedTooLarge > 0) {
      setSendError(t('assistants.contact.attachment.tooLarge'))
    }
    if (result.attachments.length === 0) return
    setAttachments((current) => mergeContactComposerAttachments(current, result.attachments))
  })
  const handlePaste = useEvent((event: React.ClipboardEvent) => {
    const files = filesFromClipboard(event.clipboardData)
    if (files.length === 0) return
    event.preventDefault()
    void addFiles(files)
  })
  const handleDragOver = useEvent((event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  })
  const handleDrop = useEvent((event: React.DragEvent) => {
    const files = filesFromDrop(event.dataTransfer)
    if (files.length === 0) return
    event.preventDefault()
    void addFiles(files)
  })
  const submit = useEvent(async () => {
    const text = draft
    const staged = attachments
    const sentAssistantID = assistant.id
    const begun = beginContactComposerSubmit({
      gate: sendGate,
      sending: contactOptimisticSending(optimisticTurns),
      text,
      attachments: staged,
      assistantID: sentAssistantID,
      createMessageID: () => `oc_contact_${createUuid()}`,
    })
    if (!begun.ok) return
    setOptimisticTurns((current) => [...current, begun.turn])
    setDraft('')
    setAttachments([])
    setSendError(null)
    try {
      await sendAssistantContactMessage(sentAssistantID, begun.messageID, { parts: begun.parts })
      if (capabilityQuery.data?.serverInstanceID) {
        void donateNativeAssistantInteraction({
          serverInstanceID: capabilityQuery.data.serverInstanceID,
          assistantID: sentAssistantID,
          name: displayName,
          avatarSeed: sentAssistantID,
          ...(presentation.avatarEmoji ? { avatarEmoji: presentation.avatarEmoji } : {}),
        }).catch(() => undefined)
      }
    } catch (error) {
      const detail = contactSendErrorMessage(error, {
        noProvider: t('assistants.contact.noProvider'),
        sendFailed: t('assistants.contact.sendFailed'),
        timedOut: t('assistants.contact.timedOut'),
      })
      setOptimisticTurns((current) => markContactOptimisticFailed(current, begun.messageID, detail))
    } finally {
      sendGate.release()
    }
  })

  const loadFailed = contactQuery.isError && transcript.length === 0
  const empty = contactQuery.isSuccess && transcript.length === 0
  const optimisticByID = new Map(optimisticTurns.map((turn) => [turn.messageID, turn]))

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
            {transcript.map((message) => {
              const isUser = message.role === 'user'
              const isPeer = message.role === 'peer'
              const senderName = isPeer ? peerName(message.fromAssistantID, message.fromAssistantName) : displayName
              const sender = isPeer && message.fromAssistantID
                ? snapshotQuery.data?.assistants.find((item) => item.id === message.fromAssistantID)
                : assistant
              const senderPresentation = sender ? getAssistantPresentation(sender.name) : null
              const optimistic = optimisticByID.get(message.messageID)
              return (
                <div
                  key={message.messageID}
                  className={cn('flex w-full', isUser ? 'justify-end' : 'justify-start')}
                  data-assistant-contact-role={message.role}
                  data-assistant-contact-turn-status={optimistic?.status}
                >
                  {!isUser ? (
                    <AssistantWorkingAvatar
                      name={sender?.id || message.fromAssistantID || assistant.id}
                      emoji={senderPresentation?.avatarEmoji}
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
                            {SETTLE_TEXT[part.text] ? t(SETTLE_TEXT[part.text]) : part.text}
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
            })}
          </div>
        )}
      </div>
      <footer
        className="relative z-10 shrink-0 bg-background"
        data-assistant-contact-composer=""
      >
        {sendError ? (
          <p className="chat-input-column mb-2 typography-micro text-[var(--status-error)]">{sendError}</p>
        ) : null}
        <form
          className={cn('relative w-full pt-1.5 pb-4', isMobile && 'bottom-safe-area oc-mobile-composer')}
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <div className="chat-input-column relative overflow-visible">
            <ChatPromptComposer
              layout="inline"
              value={draft}
              attachments={attachments}
              pending={false}
              isMobile={isMobile}
              placeholder={t('assistants.contact.placeholder', { name: displayName })}
              sendLabel={t('assistants.contact.send')}
              addFilesLabel={t('assistants.contact.addFiles')}
              removeAttachmentLabel={t('assistants.contact.removeAttachment')}
              fileAccept="*/*"
              onChange={(value) => setDraft(value)}
              onSubmit={() => {
                void submit()
              }}
              onAddFiles={(files) => {
                void addFiles(files)
              }}
              onRemoveAttachment={(id) => {
                setAttachments((current) => current.filter((attachment) => attachment.id !== id))
              }}
              onPaste={handlePaste}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              className={cn('relative z-10', isMobile && 'oc-mobile-composer-surface')}
              style={{ borderRadius: '1.5rem' }}
              data-assistant-contact-composer-surface=""
              textareaProps={{
                'aria-label': t('assistants.contact.placeholder', { name: displayName }),
              }}
            />
          </div>
        </form>
      </footer>
    </div>
  )
}
