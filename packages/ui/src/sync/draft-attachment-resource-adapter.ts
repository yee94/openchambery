/**
 * Explicit DraftKey attachment resource adapter for ChatInput / Assistant surfaces.
 * Binds one DraftKey + input-store state getter; never routes through activeAttachmentDraft.
 *
 * Root attachment mutations (add/remove/clear/replace/VS Code) share a module-level
 * per-draftKeyString serial lane so fire-and-forget clear→restore across factory
 * instances stays ordered. Replacement is a single CAS via replaceDraftRootAttachments.
 *
 * Send consumption: clearRootAttachments is true only for committed+current CAS.
 * Failure restore uses restoreDraftRootAttachments (live metadata merge, not whole-table
 * view rebuild) so concurrent user adds and missing-view live rows are preserved.
 */
import type { AttachedFile } from '@/stores/types/sessionTypes'
import { draftKeyString, type DraftKey } from './input-draft-types'
import type { DraftCommitResult, useInputStore } from './input-store'

export type DraftAttachmentInputState = Pick<
  ReturnType<typeof useInputStore.getState>,
  | 'getDraft'
  | 'getDraftAttachmentViews'
  | 'setDraftAttachments'
  | 'addDraftLocalAttachment'
  | 'addDraftDurableAttachment'
  | 'removeDraftAttachment'
  | 'addDraftVSCodeFileAttachment'
  | 'addDraftVSCodeSelectionAttachment'
  | 'replaceDraftRootAttachments'
  | 'restoreDraftRootAttachments'
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

/** True only when a root replace CAS published into the current memory epoch. */
export const isRootAttachmentReplaceCommitted = (
  result: DraftCommitResult | undefined,
): boolean => result?.status === 'committed' && result.current === true

/** Per-draftKeyString serial chain shared across all adapter factory instances. */
const rootAttachmentFlights = new Map<string, Promise<unknown>>()

const runRootAttachmentExclusive = async <T>(
  key: DraftKey,
  fn: () => Promise<T> | T,
): Promise<T> => {
  const id = draftKeyString(key)
  const previous = rootAttachmentFlights.get(id) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => gate)
  rootAttachmentFlights.set(id, tail)
  await previous.catch(() => undefined)
  try {
    return await fn()
  } finally {
    release()
    if (rootAttachmentFlights.get(id) === tail) rootAttachmentFlights.delete(id)
  }
}

export type DraftAttachmentResourceAdapter = {
  key: DraftKey
  addLocal: (file: File) => Promise<void>
  /**
   * Removes by attachmentID. True when the live draft no longer holds that
   * attachmentID (memory-first remove that already cleared memory counts even
   * when durability later reports false). Exception / unresolved → false.
   */
  removeByAttachmentID: (attachmentID: string) => Promise<boolean>
  /**
   * Root attachments only — preserves synthetic-part ownership. Memory-first so
   * sent attachment chips disappear immediately; persistence continues in store.
   */
  clearRootAttachments: () => Promise<boolean>
  /**
   * Restores failed send attachments without clobbering concurrent live adds or
   * live metadata that lacks a view. Enters the DraftKey serial lane, calls
   * restoreDraftRootAttachments (up to one conflict retry with a fresh live read).
   * True only for committed+current; failed/stale stop without republish.
   */
  restoreRootAttachments: (failedAttachments: readonly AttachedFile[]) => Promise<boolean>
  /**
   * Replaces root AttachedFile[] with one CAS commit (serialized per draft key).
   * Promise settles for ordering; callers may ignore it (no unhandled rejection).
   */
  replaceRootAttachments: (attachments: readonly AttachedFile[]) => Promise<DraftCommitResult | undefined>
  addVSCodeFile: (path: string, name: string, size: number | null) => Promise<void>
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
    await runRootAttachmentExclusive(key, async () => {
      await getInput().addDraftLocalAttachment(key, file)
    })
  },
  removeByAttachmentID: async (attachmentID) => {
    try {
      return await runRootAttachmentExclusive(key, async () => {
        const input = getInput()
        const ref = resolveDraftAttachmentRefID(key, attachmentID, input)
        // Already gone — treated as consumed for the current process.
        if (!ref) {
          const stillPresent = input.getDraft(key)
            && [...(input.getDraft(key)?.attachments ?? []), ...(input.getDraft(key)?.syntheticParts.flatMap((p) => p.attachments) ?? [])]
              .some((item) => item.attachmentID === attachmentID)
          return !stillPresent
        }
        try {
          await input.removeDraftAttachment(key, ref)
        } catch {
          // Memory-first remove may have applied before durability failed; re-check live.
        }
        const record = input.getDraft(key)
        if (!record) return true
        const present = [...record.attachments, ...record.syntheticParts.flatMap((part) => part.attachments)]
          .some((item) => item.attachmentID === attachmentID)
        return !present
      })
    } catch {
      return false
    }
  },
  clearRootAttachments: async () => {
    try {
      return await runRootAttachmentExclusive(key, async () => {
        const input = getInput()
        const current = input.getDraft(key)
        if (!current || current.attachments.length === 0) return true
        const cleared = input.setDraftAttachments(key, [])
        return cleared?.attachments.length === 0
      })
    } catch {
      return false
    }
  },
  restoreRootAttachments: async (failedAttachments) => {
    try {
      return await runRootAttachmentExclusive(key, async () => {
        const attempt = async (): Promise<DraftCommitResult> => (
          getInput().restoreDraftRootAttachments(key, failedAttachments)
        )
        let result = await attempt()
        // Conflict: re-read live and retry once on the same lane.
        if (result.status === 'conflict') {
          result = await attempt()
        }
        // Durability failed / stale: stop without further republish.
        if (result.status === 'failed' || result.status === 'stale') {
          return false
        }
        return isRootAttachmentReplaceCommitted(result)
      })
    } catch {
      return false
    }
  },
  replaceRootAttachments: async (attachments) => {
    try {
      return await runRootAttachmentExclusive(key, async () => (
        getInput().replaceDraftRootAttachments(key, attachments)
      ))
    } catch {
      // Fire-and-forget callers must not observe unhandled rejection; lane still advances.
      return undefined
    }
  },
  addVSCodeFile: async (path, name, size) => {
    await runRootAttachmentExclusive(key, () => {
      getInput().addDraftVSCodeFileAttachment(key, path, name, size)
    })
  },
  addVSCodeSelection: async (path, file) => {
    await runRootAttachmentExclusive(key, async () => {
      await getInput().addDraftVSCodeSelectionAttachment(key, path, file)
    })
  },
})
