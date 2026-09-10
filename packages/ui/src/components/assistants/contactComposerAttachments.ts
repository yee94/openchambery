import { createUuid } from '@/lib/uuid'
import type { ChatPromptAttachment } from '@/components/chat/ChatPromptComposer'

export const MAX_CONTACT_COMPOSER_FILE_BYTES = 25 * 1024 * 1024
const MAX_CONTACT_COMPOSER_FILES = 64
export type ContactComposerAttachment = ChatPromptAttachment & { file: File }

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
): Promise<{ attachments: ContactComposerAttachment[]; skippedTooLarge: number }> => {
  const attachments: ContactComposerAttachment[] = []
  let skippedTooLarge = 0
  for (const file of Array.from(files || [])) {
    if (!file || file.size <= 0) continue
    if (file.size > MAX_CONTACT_COMPOSER_FILE_BYTES) {
      skippedTooLarge += 1
      continue
    }
    const url = URL.createObjectURL(file)
    attachments.push({
      id: createId(),
      url,
      name: file.name.trim() || 'attachment',
      mime: file.type.trim() || 'application/octet-stream',
      file,
    })
  }
  return { attachments, skippedTooLarge }
}

export const mergeContactComposerAttachments = <T extends ChatPromptAttachment>(
  current: readonly T[],
  incoming: readonly T[],
): T[] => {
  const combined = [...current, ...incoming]
  for (const attachment of combined.slice(MAX_CONTACT_COMPOSER_FILES)) {
    if (attachment.url.startsWith('blob:')) URL.revokeObjectURL(attachment.url)
  }
  return combined.slice(0, MAX_CONTACT_COMPOSER_FILES)
}
