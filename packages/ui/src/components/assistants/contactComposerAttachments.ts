import { createUuid } from '@/lib/uuid'
import type { ChatPromptAttachment } from '@/components/chat/ChatPromptComposer'

export const MAX_CONTACT_COMPOSER_FILE_BYTES = 50 * 1024 * 1024
export const MAX_CONTACT_COMPOSER_FILES = 64

const readFileAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => {
    resolve(typeof reader.result === 'string' ? reader.result : '')
  }
  reader.onerror = () => {
    reject(reader.error ?? new Error('read_failed'))
  }
  reader.readAsDataURL(file)
})

export const filesFromClipboard = (clipboardData: DataTransfer | null | undefined): File[] => {
  if (!clipboardData) return []
  const fromFiles = Array.from(clipboardData.files || [])
  if (fromFiles.length > 0) return fromFiles
  return Array.from(clipboardData.items || [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file instanceof File)
}

export const filesFromDrop = (dataTransfer: DataTransfer | null | undefined): File[] => (
  Array.from(dataTransfer?.files || [])
)

export const readContactComposerFiles = async (
  files: ArrayLike<File> | null | undefined,
  createId: () => string = createUuid,
): Promise<{ attachments: ChatPromptAttachment[]; skippedTooLarge: number }> => {
  const attachments: ChatPromptAttachment[] = []
  let skippedTooLarge = 0
  for (const file of Array.from(files || [])) {
    if (!file || file.size <= 0) continue
    if (file.size > MAX_CONTACT_COMPOSER_FILE_BYTES) {
      skippedTooLarge += 1
      continue
    }
    const url = await readFileAsDataUrl(file)
    if (!url.startsWith('data:')) continue
    attachments.push({
      id: createId(),
      url,
      name: file.name.trim() || 'attachment',
      mime: file.type.trim() || 'application/octet-stream',
    })
  }
  return { attachments, skippedTooLarge }
}

export const mergeContactComposerAttachments = (
  current: readonly ChatPromptAttachment[],
  incoming: readonly ChatPromptAttachment[],
): ChatPromptAttachment[] => [...current, ...incoming].slice(0, MAX_CONTACT_COMPOSER_FILES)
