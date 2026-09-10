import React from 'react'
import { useEvent } from '@reactuses/core'
import { ChatPromptComposer } from '@/components/chat/ChatPromptComposer'
import { Button } from '@/components/ui/button'
import { uploadAssistantAttachment, type AssistantAttachmentDescriptor } from '@/lib/assistant-attachment-upload'
import { AssistantContactAttachment } from './AssistantContactAttachment'
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer'
import { useRuntimeTransportIdentity } from '@/components/chat/imageSource'
import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import { subscribeOpenchamberEvents, type OpenChamberEvent } from '@/lib/openchamberEvents'
import { createUuid } from '@/lib/uuid'
import { cn } from '@/lib/utils'
import { donateNativeAssistantInteraction } from '@/apps/MobileShareBridge'
import { useUIStore } from '@/stores/useUIStore'
import {
  confirmContactAdmissionByMessageID,
  sendAssistantContactMessage,
  useAssistantCapabilityQuery,
  useAssistantContactMessagesQuery,
  useAssistantSnapshotQuery,
  type AssistantDTO,
} from '@/queries/assistantQueries'
import { AssistantAPIError } from '@/queries/assistantDTO'
import { getAssistantPresentation } from './assistantPresentation'
import {
  admitContactTurnPreview,
  applyContactBubbleDelta,
  applyServerContactTurnAuthority,
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
import { useAssistantContactWorkingStore } from './assistantWorking'
import { useAssistantContactAutoFollow } from './useAssistantContactAutoFollow'
import {
  filesFromClipboard,
  filesFromDrop,
  mergeContactComposerAttachments,
  readContactComposerFiles,
  type ContactComposerAttachment,
} from './contactComposerAttachments'

/** Legacy internal settle markers — never render as user-visible bubbles. */
const isInternalSettleText = (text: string) => text.trim().startsWith('oc.settle.')

type AssistantConversationSurfaceProps = {
  assistant: AssistantDTO
  warning?: string | null
  active: boolean
  overlayHeader?: boolean
}

/**
 * Grok-like contact transcript. Renders OpenChamber-owned bubbles and
 * first-class session cards — not ChatContainer or Activity. Assistant/peer
 * text goes through MarkdownRenderer (markstream by default).
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
  overlayHeader = false,
}) => {
  const { t } = useI18n()
  const transportIdentity = useRuntimeTransportIdentity()
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
  const [attachments, setAttachments] = React.useState<ContactComposerAttachment[]>([])
  const retrySendRef = React.useRef<{ assistantID: string; text: string; attachments: ContactComposerAttachment[]; messageID: string } | null>(null)
  const uploadedRef = React.useRef(new Map<string, AssistantAttachmentDescriptor>())
  const uploadControllerRef = React.useRef(new AbortController())
  React.useEffect(() => {
    const controller = new AbortController()
    uploadControllerRef.current = controller
    return () => controller.abort()
  }, [assistant.id, transportIdentity])
  const previewUrlsRef = React.useRef(new Set<string>())
  React.useEffect(() => {
    const next = new Set(attachments.map((attachment) => attachment.url))
    for (const url of previewUrlsRef.current) if (!next.has(url)) URL.revokeObjectURL(url)
    previewUrlsRef.current = next
  }, [attachments])
  React.useEffect(() => () => { for (const url of previewUrlsRef.current) URL.revokeObjectURL(url) }, [])
  const [optimisticTurns, setOptimisticTurns] = React.useState<ContactOptimisticTurn[]>([])
  const [turnPreviews, setTurnPreviews] = React.useState<ContactTurnPreview[]>([])
  const [sendError, setSendError] = React.useState<string | null>(null)
  React.useEffect(() => {
    uploadedRef.current.clear()
    retrySendRef.current = null
    setOptimisticTurns([])
    setTurnPreviews([])
    setSendError(null)
  }, [transportIdentity])
  const sendGate = React.useMemo(() => createContactSendGate(), [])
  const settledTurnIDsRef = React.useRef(new Set<string>())
  const admissionRevisionByTurnIDRef = React.useRef(new Map<string, number>())
  const setContactWorking = useAssistantContactWorkingStore((state) => state.setWorking)
  const messages = contactQuery.data?.messages ?? EMPTY_CONTACT_MESSAGES
  const scopedOptimisticTurns = scopeContactOptimisticTurns(optimisticTurns, assistant.id)
  const scopedTurnPreviews = scopeContactTurnPreviews(turnPreviews, assistant.id)
  const transcript = mergeContactTranscript(messages, scopedOptimisticTurns, assistant.id, scopedTurnPreviews)
    .filter((message) => {
      // Drop legacy pure oc.settle.* rows so they leave no empty avatar shell.
      const parts = Array.isArray(message.parts) ? message.parts : []
      if (parts.length === 0) return true
      return parts.some((part) => !(part.type === 'text' && isInternalSettleText(part.text)))
    })
  const sending = contactOptimisticSending(scopedOptimisticTurns)
  const processing = contactTurnPreviewWorking(scopedTurnPreviews)
  // Server working is authoritative across remount; local preview is temporary.
  const serverWorking = Boolean(assistant.working || assistant.activeContactTurn)
  // Domain snapshot revision only — never the per-assistant config revision.
  const snapshotRevision = snapshotQuery.data?.revision ?? null
  const streamingTextLength = scopedTurnPreviews.reduce((total, preview) => (
    total + preview.bubbles.reduce((bubbleTotal, bubble) => bubbleTotal + bubble.text.length, 0)
  ), 0)
  const previewByTurnID = new Map(scopedTurnPreviews.map((preview) => [preview.turnID, preview]))
  const pageFlightRef = React.useRef(false)
  const loadEarlier = useEvent(async (automatic = false) => {
    if (!active || pageFlightRef.current || contactQuery.isFetchingPreviousPage || contactQuery.isFillingMessageGap) return
    if (automatic && contactQuery.previousPageError) return
    if (!contactQuery.hasPreviousPage && !contactQuery.hasMessageGap) return
    pageFlightRef.current = true
    preparePrepend()
    try {
      if (contactQuery.hasMessageGap) await contactQuery.retryMessageGap()
      else await contactQuery.fetchPreviousPage()
    } catch { /* Query retains the loaded transcript and exposes the retry state. */ }
    finally { pageFlightRef.current = false }
  })
  const { scrollRef, contentRef, preparePrepend } = useAssistantContactAutoFollow({
    active,
    assistantID: assistant.id,
    contentRevision: `${transcript[0]?.messageID}:${transcript.length}:${streamingTextLength}:${contactQuery.isFetchingPreviousPage}:${contactQuery.hasPreviousPage}:${contactQuery.isFillingMessageGap}`,
    onLoadEarlier: () => { void loadEarlier(true) },
  })

  React.useEffect(() => {
    setSendError(null)
    settledTurnIDsRef.current.clear()
    admissionRevisionByTurnIDRef.current = new Map()
    setOptimisticTurns((current) => scopeContactOptimisticTurns(current, assistant.id))
    setTurnPreviews((current) => scopeContactTurnPreviews(current, assistant.id))
  }, [assistant.id])

  React.useEffect(() => {
    setOptimisticTurns((current) => reconcileContactOptimisticTurns(current, messages))
  }, [messages])

  // Seed busy / clear stale local previews from snapshot authority (missed SSE end,
  // APP restart, durable error rows). Old idle snapshots cannot wipe a newer send.
  React.useEffect(() => {
    const pendingSendTurnIDs = new Set(
      scopedOptimisticTurns.filter((turn) => turn.status === 'sending').map((turn) => turn.messageID),
    )
    setTurnPreviews((current) => applyServerContactTurnAuthority(current, {
      assistantID: assistant.id,
      activeContactTurn: assistant.activeContactTurn
        ? { turnID: assistant.activeContactTurn.turnID, admittedAt: assistant.activeContactTurn.admittedAt }
        : null,
      serverWorking,
      snapshotRevision,
      admissionRevisionByTurnID: admissionRevisionByTurnIDRef.current,
      pendingSendTurnIDs,
      messages,
      settledTurnIDs: settledTurnIDsRef.current,
    }))
  }, [
    assistant.activeContactTurn,
    assistant.id,
    messages,
    scopedOptimisticTurns,
    serverWorking,
    snapshotRevision,
  ])

  React.useEffect(() => {
    // Never write local false over server busy — list green dots use snapshot too.
    setContactWorking(assistant.id, sending || processing || serverWorking)
  }, [assistant.id, processing, sending, serverWorking, setContactWorking])

  React.useEffect(() => {
    const id = assistant.id
    return () => {
      // Drop only this surface's local overlay. Snapshot serverWorking remains.
      setContactWorking(id, false)
    }
  }, [assistant.id, setContactWorking])

  const handleContactEvent = useEvent((event: OpenChamberEvent) => {
    if (!('assistantID' in event) || event.assistantID !== assistant.id) return
    if (event.type === 'contact-turn-start') {
      // A fresh start for this turn must win over a stale end that arrived first.
      settledTurnIDsRef.current.delete(event.turnID)
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
      // requireExisting avoids inventing a failed row from a stale end after remount
      // when server already dropped the turn; never wipe a different live turnID.
      setTurnPreviews((current) => reconcileContactTurnPreviews(
        endContactTurnPreview(current, event, { requireExisting: true }),
        messages,
      ))
    }
  })

  React.useEffect(() => {
    if (!active) return
    return subscribeOpenchamberEvents(handleContactEvent)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- active and Assistant identity own subscription lifecycle; useEvent keeps the handler current.
  }, [active, assistant.id])

  const addFiles = useEvent(async (files: ArrayLike<File> | null) => {
    if (sending) return
    const uploadController = uploadControllerRef.current
    const result = await readContactComposerFiles(files)
    if (uploadController.signal.aborted) {
      result.attachments.forEach((attachment) => URL.revokeObjectURL(attachment.url))
      return
    }
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
    const uploadController = uploadControllerRef.current
    const text = draft
    const staged = attachments
    const sentAssistantID = assistant.id
    const previous = retrySendRef.current
    const retryID = previous?.assistantID === sentAssistantID && previous.text === text && previous.attachments === staged ? previous.messageID : null
    const begun = beginContactComposerSubmit({
      gate: sendGate,
      sending: contactOptimisticSending(scopedOptimisticTurns),
      text,
      attachments: staged,
      assistantID: sentAssistantID,
      createMessageID: () => retryID || `oc_contact_${createUuid()}`,
    })
    if (!begun.ok) return
    retrySendRef.current = { assistantID: sentAssistantID, text, attachments: staged, messageID: begun.messageID }
    setOptimisticTurns((current) => [...current.filter((turn) => turn.messageID !== begun.messageID), begun.turn])
    setSendError(null)
    const clearSentDraft = () => {
      setDraft((current) => current === text ? '' : current)
      setAttachments((current) => current.filter((attachment) => !staged.includes(attachment)))
      staged.forEach((attachment) => uploadedRef.current.delete(`${sentAssistantID}:${attachment.id}`))
      retrySendRef.current = null
    }
    try {
      const descriptors: AssistantAttachmentDescriptor[] = []
      for (const attachment of staged) {
        const key = `${sentAssistantID}:${attachment.id}`
        let descriptor = uploadedRef.current.get(key)
        if (!descriptor) {
          descriptor = await uploadAssistantAttachment(sentAssistantID, attachment.file, attachment.id, uploadController.signal)
          if (uploadController.signal.aborted) return
          uploadedRef.current.set(key, descriptor)
        }
        descriptors.push(descriptor)
      }
      if (uploadController.signal.aborted) return
      const parts = [...begun.parts.filter((part) => part.type === 'text'), ...descriptors]
      setOptimisticTurns((current) => current.map((turn) => turn.messageID === begun.messageID ? { ...turn, parts } : turn))
      const admitted = await sendAssistantContactMessage(sentAssistantID, begun.messageID, { parts })
      if (uploadController.signal.aborted) return
      clearSentDraft()
      if (typeof admitted.revision === 'number') {
        admissionRevisionByTurnIDRef.current.set(begun.messageID, admitted.revision)
      }
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
      if (uploadController.signal.aborted) return
      // Uncertain admission: re-check the original messageID — never mint a second send.
      if (error instanceof AssistantAPIError && error.code === 'admission_timeout') {
        try {
          const confirmed = await confirmContactAdmissionByMessageID(sentAssistantID, begun.messageID)
          if (uploadController.signal.aborted) return
          if (confirmed) {
            clearSentDraft()
            if (typeof confirmed.revision === 'number') {
              admissionRevisionByTurnIDRef.current.set(begun.messageID, confirmed.revision)
            }
            setOptimisticTurns((current) => markContactOptimisticAdmitted(current, begun.messageID))
            if (!settledTurnIDsRef.current.has(begun.messageID)) {
              setTurnPreviews((current) => admitContactTurnPreview(current, sentAssistantID, begun.messageID))
            }
            return
          }
        } catch {
          // Fall through to failed — still the same messageID, no retry with a new id.
        }
      }
      const detail = contactSendErrorMessage(error, {
        noProvider: t('assistants.contact.noProvider'),
        sendFailed: t('assistants.contact.sendFailed'),
        timedOut: t('assistants.contact.timedOut'),
      })
      setOptimisticTurns((current) => markContactOptimisticFailed(current, begun.messageID, detail))
      setSendError(detail)
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
        ref={scrollRef}
        className={cn(
          'min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pb-9 sm:px-8 sm:pb-12',
          overlayHeader
            ? 'pt-[calc(max(0.625rem,var(--oc-safe-area-top,0px))+var(--oc-mobile-detail-navigation-height)+1.25rem)]'
            : 'pt-5 sm:pt-7',
        )}
        // Match primary chat: disable native scroll anchoring so async Markdown
        // / image growth cannot yank the viewport mid-gesture, and contain
        // overscroll so rubber-band stays on this scroller.
        style={{ overflowAnchor: 'none', overscrollBehavior: 'contain', overscrollBehaviorY: 'contain' }}
        data-assistant-contact-transcript=""
      >
        {warning ? (
          <p className="mb-3 typography-micro text-[var(--status-warning)]">{warning}</p>
        ) : null}
        {loadFailed ? (
          <div ref={contentRef} className="mx-auto flex h-full min-h-56 max-w-xs flex-col items-center justify-center pb-16 text-center" data-assistant-contact-error="">
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
            <Button type="button" size="sm" variant="ghost" onClick={() => void contactQuery.refetch()}>{t('chat.history.retry')}</Button>
          </div>
        ) : empty ? (
          <div ref={contentRef} className="mx-auto flex h-full min-h-56 max-w-sm flex-col items-center justify-center pb-16 text-center" data-assistant-contact-empty="">
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
          <div ref={contentRef} className="mx-auto flex w-full max-w-[42rem] flex-col">
            {contactQuery.isPending ? <p role="status" className="py-3 text-center typography-micro text-muted-foreground">{t('common.loading')}</p> : null}
            {contactQuery.hasPreviousPage || contactQuery.hasMessageGap ? <div className="mb-3 flex flex-col items-center gap-1" data-assistant-contact-pagination="" aria-busy={contactQuery.isFetchingPreviousPage || contactQuery.isFillingMessageGap}>
              {contactQuery.previousPageError ? <p role="alert" className="typography-micro text-[var(--status-error)]">{t('chat.history.loadOlderFailed')}</p> : null}
              {contactQuery.hasMessageGap ? <p role="status" className="typography-micro text-muted-foreground">{t('assistants.contact.history.gap')}</p> : null}
              <Button type="button" size="sm" variant="ghost" disabled={contactQuery.isFetchingPreviousPage || contactQuery.isFillingMessageGap} onClick={() => void loadEarlier()}>
                {t(contactQuery.isFetchingPreviousPage || contactQuery.isFillingMessageGap ? 'chat.history.loadingMore' : contactQuery.previousPageError || contactQuery.hasMessageGap ? 'chat.history.retry' : 'chat.history.loadOlder')}
              </Button>
            </div> : null}
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
                  data-message-id={message.messageID}
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
                      if (part.type === 'file') {
                        return <AssistantContactAttachment key={`${message.messageID}:file:${index}`} assistantID={assistant.id} part={part} />
                      }
                      if (part.type === 'text' && isInternalSettleText(part.text)) {
                        // Legacy oc.settle.* markers: card status already shows outcome.
                        return null
                      }
                      if (part.type === 'text' && (part.text.trim() || message.status === 'streaming')) {
                        const useMarkdown = !isUser
                        return (
                          <div
                            key={`${message.messageID}:text:${index}`}
                            aria-label={isPeer ? t('assistants.contact.peer.aria', { name: senderName }) : undefined}
                            data-assistant-contact-text=""
                            className={cn(
                              'min-w-0 max-w-full [overflow-wrap:anywhere] rounded-[1.35rem] px-4 py-2.5 typography-markdown leading-6',
                              useMarkdown ? null : 'whitespace-pre-wrap',
                              isUser
                                ? 'rounded-[1.15rem] rounded-br-lg bg-[var(--primary-base)]/90 text-[var(--primary-foreground)]'
                                : isPeer
                                  ? 'rounded-[1.25rem] border border-dashed border-border/50 bg-[var(--surface-muted)]/70 text-foreground'
                                  : cn('bg-[var(--surface-muted)] text-foreground', sameAssistantRun && 'rounded-tl-lg'),
                            )}
                          >
                            {useMarkdown ? (
                              <MarkdownRenderer
                                content={part.text}
                                messageId={message.messageID}
                                isAnimated={false}
                                isStreaming={message.status === 'streaming'}
                                variant="assistant"
                                enableFileReferences={false}
                                className="w-full min-w-0 [overflow-wrap:anywhere]"
                              />
                            ) : part.text}
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
          <div className="chat-input-column mb-2 flex items-center gap-2"><p role="alert" className="typography-micro text-[var(--status-error)]">{sendError}</p>{retrySendRef.current ? <Button type="button" size="sm" variant="ghost" disabled={sending} onClick={() => void submit()}>{t('chat.history.retry')}</Button> : null}</div>
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
              pending={sending}
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
                if (sending) return
                uploadedRef.current.delete(`${assistant.id}:${id}`)
                retrySendRef.current = null
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
