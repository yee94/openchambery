/**
 * Explicit DraftKey attachment resource adapter for ChatInput / Assistant surfaces.
 * Binds one DraftKey + input-store state getter; never routes through activeAttachmentDraft.
 */
import type { AttachedFile } from '@/stores/types/sessionTypes'
import type { DraftKey } from './input-draft-types'
import type { useInputStore } from './input-store'

export type DraftAttachmentInputState = Pick<
  ReturnType<typeof useInputStore.getState>,
  | 'getDraft'
  | 'addDraftLocalAttachment'
  | 'addDraftDurableAttachment'
  | 'removeDraftAttachment'
  | 'addDraftVSCodeFileAttachment'
  | 'addDraftVSCodeSelectionAttachment'
>

/** Resolves AttachedFile.id (attachmentID) to DraftRecord attachmentRefID for removeDraftAttachment. */
export const resolveDraftAttachmentRefID = (
  key: DraftKey,
  attachmentID: string,
  input: Pick<DraftAttachmentInputState, 'getDraft'>,
): string | undefined => {
  const record = input.getDraft(key)
  if (!record) return undefined
  const attachment = [...record.attachments, ...record.syntheticParts.flatMap((part) => part.attachments)]
    .find((item) => item.attachmentID === attachmentID)
  return attachment?.attachmentRefID
}

export type DraftAttachmentResourceAdapter = {
  key: DraftKey
  addLocal: (file: File) => Promise<void>
  removeByAttachmentID: (attachmentID: string) => void
  /** Root attachments only — preserves synthetic-part ownership. */
  clearRootAttachments: () => void
  /** Replaces root AttachedFile[] while preserving server/vscode metadata semantics. */
  replaceRootAttachments: (attachments: readonly AttachedFile[]) => void
  addVSCodeFile: (path: string, name: string, size: number | null) => void
  addVSCodeSelection: (path: string, file: File) => Promise<void>
}

/**
 * Factory: bind one DraftKey and a live input-store getter.
 * Callers capture `key` at interaction time so async key switches still write the target draft.
 */
export const createDraftAttachmentResourceAdapter = (
  key: DraftKey,
  getInput: () => DraftAttachmentInputState,
): DraftAttachmentResourceAdapter => ({
  key,
  addLocal: async (file) => {
    await getInput().addDraftLocalAttachment(key, file)
  },
  removeByAttachmentID: (attachmentID) => {
    const input = getInput()
    const ref = resolveDraftAttachmentRefID(key, attachmentID, input)
    if (ref) void input.removeDraftAttachment(key, ref)
  },
  clearRootAttachments: () => {
    const input = getInput()
    const record = input.getDraft(key)
    for (const attachment of record?.attachments ?? []) {
      void input.removeDraftAttachment(key, attachment.attachmentRefID)
    }
  },
  replaceRootAttachments: (attachments) => {
    void (async () => {
      const input = getInput()
      const record = input.getDraft(key)
      for (const attachment of record?.attachments ?? []) {
        await input.removeDraftAttachment(key, attachment.attachmentRefID)
      }
      for (const attachment of attachments) {
        if (attachment.source === 'server' && attachment.dataUrl) {
          input.addDraftDurableAttachment(key, {
            attachmentID: attachment.id,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            size: attachment.size,
            source: 'server',
            url: attachment.dataUrl,
            serverPath: attachment.serverPath,
          })
        } else {
          await input.addDraftLocalAttachment(key, attachment.file, {
            attachmentID: attachment.id,
            filename: attachment.filename,
            source: attachment.source === 'vscode' ? 'vscode' : 'local',
            vscodePath: attachment.vscodePath,
            vscodeSource: attachment.vscodeSource === 'selection' ? 'selection' : undefined,
          })
        }
      }
    })()
  },
  addVSCodeFile: (path, name, size) => {
    getInput().addDraftVSCodeFileAttachment(key, path, name, size)
  },
  addVSCodeSelection: async (path, file) => {
    await getInput().addDraftVSCodeSelectionAttachment(key, path, file)
  },
})
