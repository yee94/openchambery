import React from 'react'
import { useEvent } from '@reactuses/core'
import { ChatPromptComposer, type ChatPromptAttachment } from '@/components/chat/ChatPromptComposer'
import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import { subscribeOpenchamberEvents, type OpenChamberEvent } from '@/lib/openchamberEvents'
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
  admitContactTurnPreview,
  applyContactBubbleDelta,
  beginContactComposerSubmit,
  contactOptimisticSending,
  contactTurnPreviewWorking,
  contactSendErrorMessage,
  createContactSendGate,
  EMPTY_CONTACT_MESSAGES,
  endContactTurnPreview,
  markContactOptimisticAdmitted,
  markContactOptimisticFailed,
  mergeContactTranscript,
  reconcileContactOptimisticTurns,
  reconcileContactTurnPreviews,
  scopeContactOptimisticTurns,
  scopeContactTurnPreviews,
  type ContactOptimisticTurn,
  type ContactTurnPreview,
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
  const [turnPreviews, setTurnPreviews] = React.useState<ContactTurnPreview[]>([])
  const [sendError, setSendError] = React.useState<string | null>(null)
  const sendGate = React.useMemo(() => createContactSendGate(), [])
  const settledTurnIDsRef = React.useRef(new Set<string>())
  const setContactWorking = useAssistantContactWorkingStore((state) => state.setWorking)
  const working = useAssistantWorking(assistant.id, assistant.assignedSessionIDs ?? [], Boolean(assistant.working))
  const scrollerRef = React.useRef<HTMLDivElement | null>(null)
  const messages = contactQuery.data?.messages ?? EMPTY_CONTACT_MESSAGES
  const scopedOptimisticTurns = scopeContactOptimisticTurns(optimisticTurns, assistant.id)
  const scopedTurnPreviews = scopeContactTurnPreviews(turnPreviews, assistant.id)
  const transcript = mergeContactTranscript(messages, scopedOptimisticTurns, assistant.id, scopedTurnPreviews)
  const sending = contactOptimisticSending(scopedOptimisticTurns)
  const processing = contactTurnPreviewWorking(scopedTurnPreviews)
  const streamingTextLength = scopedTurnPreviews.reduce((total, preview) => (
    total + preview.bubbles.reduce((bubbleTotal, bubble) => bubbleTotal + bubble.text.length, 0)
  ), 0)
  const previewByTurnID = new Map(scopedTurnPreviews.map((preview) => [preview.turnID, preview]))

  React.useEffect(() => {
    setSendError(null)
    settledTurnIDsRef.current.clear()
    setOptimisticTurns((current) => scopeContactOptimisticTurns(current, assistant.id))
    setTurnPreviews((current) => scopeContactTurnPreviews(current, assistant.id))
  }, [assistant.id])

  React.useEffect(() => {
    setOptimisticTurns((current) => reconcileContactOptimisticTurns(current, messages))
    setTurnPreviews((current) => reconcileContactTurnPreviews(current, messages))
  }, [messages])

  React.useEffect(() => {
    setContactWorking(assistant.id, sending || processing)
  }, [assistant.id, processing, sending, setContactWorking])

  React.useEffect(() => {
    const id = assistant.id
    return () => {
      setContactWorking(id, false)
    }
  }, [assistant.id, setContactWorking])

  const handleContactEvent = useEvent((event: OpenChamberEvent) => {
    if (!('assistantID' in event) || event.assistantID !== assistant.id) return
    if (event.type === 'contact-turn-start') {
      if (settledTurnIDsRef.current.has(event.turnID)) return
      setTurnPreviews((current) => admitContactTurnPreview(current, event.assistantID, event.turnID, event.occurredAt))
      return
    }
    if (event.type === 'contact-bubble-delta') {
      if (settledTurnIDsRef.current.has(event.turnID)) return
      setTurnPreviews((current) => applyContactBubbleDelta(current, event))
      return
    }
    if (event.type === 'contact-turn-end') {
      settledTurnIDsRef.current.add(event.turnID)
      setTurnPreviews((current) => reconcileContactTurnPreviews(endContactTurnPreview(current, event), messages))
    }
  })

  React.useEffect(() => {
    if (!active) return
    return subscribeOpenchamberEvents(handleContactEvent)
  }, [active, assistant.id])

  React.useEffect(() => {
    const node = scrollerRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [streamingTextLength, transcript.length])

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
      sending: contactOptimisticSending(scopedOptimisticTurns),
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
      setOptimisticTurns((current) => markContactOptimisticAdmitted(current, begun.messageID))
      if (!settledTurnIDsRef.current.has(begun.messageID)) {
        setTurnPreviews((current) => admitContactTurnPreview(current, sentAssistantID, begun.messageID))
      }
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
  const optimisticByID = new Map(scopedOptimisticTurns.map((turn) => [turn.messageID, turn]))

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 pt-5 pb-9 sm:px-8 sm:pt-7 sm:pb-12"
        data-assistant-contact-transcript=""
      >
        {warning ? (
          <p className="mb-3 typography-micro text-[var(--status-warning)]">{warning}</p>
        ) : null}
        {loadFailed ? (
          <div className="mx-auto flex h-full min-h-56 max-w-xs flex-col items-center justify-center pb-16 text-center" data-assistant-contact-error="">
            <div className="relative">
              <AssistantWorkingAvatar
                name={assistant.id}
                emoji={presentation.avatarEmoji}
                size={44}
                label={displayName}
              />
              <span aria-hidden className="absolute -right-1 -bottom-1 flex size-5 items-center justify-center rounded-full bg-[var(--surface-elevated)] text-[var(--status-error)] ring-2 ring-background">
                <Icon name="error-warning" className="size-3" />
              </span>
            </div>
            <p className="mt-4 typography-ui-label font-medium text-foreground">{displayName}</p>
            <p className="mt-1.5 typography-ui leading-6 text-muted-foreground">{t('assistants.contact.loadFailed')}</p>
          </div>
        ) : empty ? (
          <div className="mx-auto flex h-full min-h-56 max-w-sm flex-col items-center justify-center pb-16 text-center" data-assistant-contact-empty="">
            <AssistantWorkingAvatar
              name={assistant.id}
              emoji={presentation.avatarEmoji}
              size={48}
              label={displayName}
              className="opacity-90"
            />
            <p className="mt-5 typography-ui-header font-medium tracking-[-0.01em] text-foreground">{t('assistants.conversation.emptyTitle', { name: displayName })}</p>
            <p className="mt-2 max-w-xs typography-ui leading-6 text-muted-foreground/80">{t('assistants.contact.empty')}</p>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-[42rem] flex-col">
            {transcript.map((message, messageIndex) => {
              const previousMessage = messageIndex > 0 ? transcript[messageIndex - 1] : null
              const isUser = message.role === 'user'
              const isPeer = message.role === 'peer'
              const sameAssistantRun = message.role === 'assistant'
                && previousMessage?.role === 'assistant'
                && previousMessage.turnID === message.turnID
              const startsTurn = previousMessage?.turnID !== message.turnID
              const showAvatar = !isUser && (isPeer || !sameAssistantRun)
              const senderName = isPeer ? peerName(message.fromAssistantID, message.fromAssistantName) : displayName
              const sender = isPeer && message.fromAssistantID
                ? snapshotQuery.data?.assistants.find((item) => item.id === message.fromAssistantID)
                : assistant
              const senderPresentation = sender ? getAssistantPresentation(sender.name) : null
              const optimistic = optimisticByID.get(message.messageID)
              const preview = previewByTurnID.get(message.turnID)
              const processingRow = message.status === 'admitted' && message.messageID.endsWith(':preview:admitted')
              const failedPreviewRow = message.status === 'failed' && message.messageID.endsWith(':preview:failed')
              return (
                <div
                  key={message.messageID}
                  className={cn(
                    'flex w-full',
                    isUser ? 'justify-end' : 'justify-start',
                    startsTurn ? 'mt-6 first:mt-0' : sameAssistantRun ? 'mt-1.5' : 'mt-3',
                  )}
                  data-assistant-contact-role={message.role}
                  data-assistant-contact-turn-status={optimistic?.status ?? message.status}
                  data-assistant-contact-run-start={message.role === 'assistant' && !sameAssistantRun ? '' : undefined}
                >
                  {!isUser ? (
                    <div className="mr-2.5 flex w-8 shrink-0 justify-center pt-0.5">
                      {showAvatar ? (
                        <AssistantWorkingAvatar
                          name={sender?.id || message.fromAssistantID || assistant.id}
                          emoji={senderPresentation?.avatarEmoji}
                          size={28}
                          label={senderName}
                          working={!isPeer && working}
                        />
                      ) : (
                        <span className="size-7" aria-hidden />
                      )}
                    </div>
                  ) : null}
                  <div className={cn(
                    'flex min-w-0 flex-col gap-1.5',
                    isUser ? 'max-w-[min(82%,30rem)] items-end' : 'max-w-[min(84%,34rem)] items-start',
                  )}>
                    {isPeer ? (
                      <span className="mb-0.5 px-1 typography-micro text-muted-foreground/75">
                        {t('assistants.contact.peer.from', { name: senderName })}
                      </span>
                    ) : null}
                    {processingRow ? (
                      <div
                        role="status"
                        aria-label={t('assistants.contact.processing')}
                        className="inline-flex w-fit items-center gap-1 rounded-full bg-[var(--surface-muted)] px-3.5 py-2.5 text-muted-foreground/70"
                        data-assistant-contact-processing=""
                      >
                        <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:-0.45s] [animation-duration:1.4s] motion-reduce:animate-none" />
                        <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:-0.22s] [animation-duration:1.4s] motion-reduce:animate-none" />
                        <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current [animation-duration:1.4s] motion-reduce:animate-none" />
                      </div>
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
                            className="max-h-72 max-w-full rounded-[1.35rem] border border-border/40 object-contain"
                            data-assistant-contact-image=""
                          />
                        )
                      }
                      if (part.type === 'file') {
                        return (
                          <div
                            key={`${message.messageID}:file:${index}`}
                            className="flex max-w-full items-center gap-2.5 rounded-[1.25rem] bg-[var(--surface-muted)] px-3.5 py-2.5 ring-1 ring-inset ring-[var(--surface-subtle)]"
                            data-assistant-contact-file=""
                          >
                            <Icon name="file-text" className="size-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 truncate typography-ui">
                              {part.filename || t('assistants.contact.attachment.file')}
                            </span>
                          </div>
                        )
                      }
                      if (part.type === 'text' && (part.text.trim() || message.status === 'streaming')) {
                        return (
                          <div
                            key={`${message.messageID}:text:${index}`}
                            aria-label={isPeer ? t('assistants.contact.peer.aria', { name: senderName }) : undefined}
                            className={cn(
                              'whitespace-pre-wrap break-words rounded-[1.35rem] px-4 py-2.5 typography-ui leading-6',
                              isUser
                                ? 'rounded-[1.15rem] rounded-br-lg bg-[var(--primary-base)]/90 text-[var(--primary-foreground)]'
                                : isPeer
                                  ? 'rounded-[1.25rem] border border-dashed border-border/50 bg-[var(--surface-muted)]/70 text-foreground'
                                  : cn('bg-[var(--surface-muted)] text-foreground', sameAssistantRun && 'rounded-tl-lg'),
                            )}
                          >
                            {SETTLE_TEXT[part.text] ? t(SETTLE_TEXT[part.text]) : part.text}
                            {message.status === 'streaming' && index === message.parts.length - 1 ? (
                              <span
                                aria-hidden
                                className="ml-0.5 inline-block h-[1em] w-px translate-y-[0.12em] animate-pulse bg-current opacity-45 [animation-duration:1.1s] motion-reduce:animate-none"
                                data-assistant-contact-streaming-caret=""
                              />
                            ) : null}
                          </div>
                        )
                      }
                      return null
                    })}
                    {optimistic?.status === 'sending' ? (
                      <p className="px-1 typography-micro text-muted-foreground/75">{t('assistants.contact.sending')}</p>
                    ) : null}
                    {optimistic?.status === 'failed' ? (
                      <p className="px-1 typography-micro text-[var(--status-error)]">{optimistic.error || t('assistants.contact.sendFailed')}</p>
                    ) : null}
                    {failedPreviewRow ? (
                      <p className="px-1 typography-micro text-[var(--status-error)]">{preview?.error || t('assistants.contact.sendFailed')}</p>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
      <footer
        className="relative z-10 shrink-0 bg-background pt-1"
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
