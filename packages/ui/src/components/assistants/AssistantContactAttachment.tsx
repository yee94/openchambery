import React from 'react'
import { useEvent } from '@reactuses/core'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/icon/Icon'
import { useResolvedImageSource, useRuntimeTransportIdentity } from '@/components/chat/imageSource'
import { getAssistantAttachmentBlob, getAssistantAttachmentDisplay } from '@/lib/assistant-attachment-cache'
import type { AssistantAttachmentDescriptor } from '@/lib/assistant-attachment-upload'
import type { AssistantContactFilePart } from '@/queries/assistantDTO'
import { useI18n } from '@/lib/i18n'

const imageClass = 'max-h-72 max-w-full rounded-[1.35rem] border border-border/40 object-contain'

function CachedAttachment({ assistantID, descriptor }: { assistantID: string; descriptor: AssistantAttachmentDescriptor }) {
  const { t } = useI18n()
  const transport = useRuntimeTransportIdentity()
  const { attachmentID, sha256, size, mime, filename } = descriptor
  const stableDescriptor = React.useMemo(() => ({ type: 'file' as const, attachmentID, sha256, size, mime, filename }), [attachmentID, sha256, size, mime, filename])
  const image = mime.startsWith('image/')
  const [attempt, setAttempt] = React.useState(0)
  const [url, setUrl] = React.useState('')
  const [failed, setFailed] = React.useState(false)
  const [downloading, setDownloading] = React.useState(false)
  const downloadRef = React.useRef<AbortController | null>(null)
  const downloadUrls = React.useRef<string[]>([])
  React.useEffect(() => {
    setUrl('')
    setFailed(false)
    const controller = new AbortController()
    let release: (() => void) | undefined
    if (image) void getAssistantAttachmentDisplay(assistantID, stableDescriptor, { signal: controller.signal }).then((display) => {
      if (controller.signal.aborted) { display.release(); return }
      release = display.release
      setUrl(display.url)
    }).catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => { controller.abort(); release?.() }
  }, [assistantID, stableDescriptor, transport, image, attempt])
  React.useEffect(() => () => {
    downloadRef.current?.abort()
    downloadUrls.current.forEach((value) => URL.revokeObjectURL(value))
    downloadUrls.current = []
  }, [assistantID, stableDescriptor, transport])
  const download = useEvent(async () => {
    if (downloadRef.current) return
    const controller = new AbortController()
    downloadRef.current = controller
    setDownloading(true)
    setFailed(false)
    try {
      const blob = await getAssistantAttachmentBlob(assistantID, stableDescriptor, { signal: controller.signal })
      if (controller.signal.aborted) return
      downloadUrls.current.forEach((value) => URL.revokeObjectURL(value))
      const objectUrl = URL.createObjectURL(blob)
      downloadUrls.current = [objectUrl]
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = filename || t('assistants.contact.attachment.file')
      document.body.appendChild(link)
      link.click()
      link.remove()
    } catch { if (!controller.signal.aborted) setFailed(true) }
    finally {
      if (downloadRef.current === controller) downloadRef.current = null
      if (!controller.signal.aborted) setDownloading(false)
    }
  })
  const name = filename || t(image ? 'assistants.contact.attachment.image' : 'assistants.contact.attachment.file')
  if (image && url && !failed) return <img src={url} alt={name} className={imageClass} onError={() => setFailed(true)} data-assistant-contact-image="" />
  return <div className="flex max-w-full flex-col gap-1 rounded-[1.25rem] bg-[var(--surface-muted)] px-3.5 py-2.5 ring-1 ring-inset ring-[var(--surface-subtle)]" data-assistant-contact-file="">
    <span className="flex min-w-0 items-center gap-2.5"><Icon name="file-text" className="size-4 shrink-0 text-muted-foreground" /><span className="truncate typography-ui">{name}</span></span>
    {failed ? <p role="alert" className="typography-micro text-[var(--status-error)]">{t('assistants.contact.attachment.loadFailed')}</p> : null}
    {image && !failed || downloading ? <span role="status" className="typography-micro text-muted-foreground">{t('common.loading')}</span> :
      <Button type="button" size="sm" variant="ghost" onClick={image ? () => setAttempt((value) => value + 1) : () => void download()}>{t(failed ? 'chat.history.retry' : 'assistants.contact.attachment.download')}</Button>}
  </div>
}

function LegacyAttachment({ part }: { part: AssistantContactFilePart & { url: string } }) {
  const { t } = useI18n()
  // Historical contact URLs have no workspace authority. Only direct web/data/blob sources enter the shared resolver.
  const safeSource = /^(?:https?:|data:|blob:)/i.test(part.url) ? part.url : ''
  const source = useResolvedImageSource(safeSource, '')
  const [failed, setFailed] = React.useState(false)
  if (part.mime.startsWith('image/') && source && !failed) return <img src={source} alt={part.filename || t('assistants.contact.attachment.image')} className={imageClass} onError={() => setFailed(true)} data-assistant-contact-image="" />
  return <div className="flex max-w-full items-center gap-2.5 rounded-[1.25rem] bg-[var(--surface-muted)] px-3.5 py-2.5" data-assistant-contact-file="">
    <Icon name="file-text" className="size-4 shrink-0 text-muted-foreground" /><span className="truncate typography-ui">{part.filename || t('assistants.contact.attachment.file')}</span>
    {failed ? <Button type="button" size="sm" variant="ghost" onClick={() => setFailed(false)}>{t('chat.history.retry')}</Button> : null}
  </div>
}

export function AssistantContactAttachment({ assistantID, part }: { assistantID: string; part: AssistantContactFilePart }) {
  const transport = useRuntimeTransportIdentity()
  return 'attachmentID' in part ? <CachedAttachment key={`${transport}:${assistantID}:${part.attachmentID}:${part.sha256}`} assistantID={assistantID} descriptor={part} /> : <LegacyAttachment key={`${transport}:${part.url}`} part={part} />
}
