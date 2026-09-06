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
import {
  AssistantContactTranscriptList,
  resolveContactSender,
} from './AssistantContactTranscriptList'
import { useAssistantContactWorkingStore, useAssistantWorking } from './assistantWorking'
import {
  filesFromClipboard,
  filesFromDrop,
  mergeContactComposerAttachments,
  readContactComposerFiles,
} from './contactComposerAttachments'

type AssistantConversationSurfaceProps = {
  assistant: AssistantDTO
  warning?: string | null
  active: boolean
}

/**
 * Grok-like contact transcript. Renders OpenChamber-owned bubbles and
 * first-class session cards on main's LegendList + MarkdownRenderer path —
 * not ChatContainer, Activity, thinking, StickToBottom, Virtua, or TanStack Virtual.
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
  const messages = contactQuery.messages.length > 0 ? contactQuery.messages : EMPTY_CONTACT_MESSAGES
  const transcript = mergeContactTranscript(messages, optimisticTurns, assistant.id)
  const sending = contactOptimisticSending(optimisticTurns)
  const loadOlder = useEvent(() => {
    if (!contactQuery.hasNextPage || contactQuery.isFetchingNextPage) return
    void contactQuery.fetchNextPage()
  })
  const resolveSender = useEvent((message: (typeof transcript)[number]) => (
    resolveContactSender(message, assistant, snapshotQuery.data?.assistants)
  ))

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
  const statusBanner = warning ? (
    <p className="mb-3 px-4 typography-micro text-[var(--status-warning)] sm:px-6">{warning}</p>
  ) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {loadFailed ? (
        <div className="flex min-h-0 flex-1 flex-col justify-center px-4 py-4 sm:px-6">
          {statusBanner}
          <div className="flex min-h-40 flex-col items-center justify-center text-center">
            <Icon name="error-warning" className="size-6 text-muted-foreground" />
            <p className="mt-3 typography-ui text-muted-foreground">{t('assistants.contact.loadFailed')}</p>
          </div>
        </div>
      ) : empty ? (
        <div className="flex min-h-0 flex-1 flex-col justify-center px-4 py-4 sm:px-6">
          {statusBanner}
          <div className="flex min-h-40 flex-col items-center justify-center text-center">
            <p className="typography-ui-header font-semibold">{t('assistants.conversation.emptyTitle', { name: displayName })}</p>
            <p className="mt-2 max-w-md typography-ui text-muted-foreground">{t('assistants.contact.empty')}</p>
          </div>
        </div>
      ) : (
        <AssistantContactTranscriptList
          messages={transcript}
          assistant={assistant}
          peerName={peerName}
          resolveSender={resolveSender}
          working={working}
          warning={warning}
          optimisticByID={optimisticByID}
          hasNextPage={Boolean(contactQuery.hasNextPage)}
          isFetchingNextPage={contactQuery.isFetchingNextPage}
          catalogRevision={snapshotQuery.data?.revision}
          onLoadOlder={loadOlder}
        />
      )}
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
