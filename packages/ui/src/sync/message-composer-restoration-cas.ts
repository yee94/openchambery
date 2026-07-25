/**
 * Composer restoration CAS capture / commit / rollback.
 * Source payload builders live in message-composer-restoration-sources.ts.
 */
import type { AttachedFile } from '@/stores/types/sessionTypes'
import {
  draftKeyString,
  type DraftKey,
  type DraftRecord,
} from './input-draft-types'
import {
  useInputStore,
  type DraftCommitResult,
  type InputDraftRuntimeCapture,
} from './input-store'
import type { ComposerRestorationPayload } from './message-composer-restoration-sources'

type ComposerRestorationCommitInput = {
  key: DraftKey
  expectedRevision: number | 'absent'
  payload: ComposerRestorationPayload
  runtime?: InputDraftRuntimeCapture
  input?: Pick<ReturnType<typeof useInputStore.getState>, 'captureDraftRuntime' | 'commitDraftSnapshot'> & Partial<Pick<ReturnType<typeof useInputStore.getState>, 'getDraft' | 'draftAttachmentViews'>>
}

type ComposerRestorationCommitResult = {
  status: DraftCommitResult['status']
  current: boolean
  durable: boolean
  result?: DraftCommitResult
  /** Prior memory draft for CAS rollback after a later API failure. */
  previous?: { record: DraftRecord | null; views: Record<string, AttachedFile>; expectedRevision: number | 'absent' }
}

const cloneRecord = (record: DraftRecord | undefined): DraftRecord | null => {
  if (!record) return null
  return JSON.parse(JSON.stringify(record)) as DraftRecord
}

const cloneViews = (views: Record<string, AttachedFile> | undefined): Record<string, AttachedFile> => {
  if (!views) return {}
  return { ...views }
}

/** Captures the current draft for CAS rollback after a failed remote operation. */
const captureComposerDraftState = (
  key: DraftKey,
  input: Partial<Pick<ReturnType<typeof useInputStore.getState>, 'getDraft' | 'draftAttachmentViews'>> = useInputStore.getState(),
): { record: DraftRecord | null; views: Record<string, AttachedFile>; expectedRevision: number | 'absent' } => {
  const record = input.getDraft?.(key) ?? null
  const views = cloneViews(input.draftAttachmentViews?.[draftKeyString(key)])
  return { record: cloneRecord(record ?? undefined), views, expectedRevision: record?.revision ?? 'absent' }
}

/**
 * Commits a full restoration payload via commitDraftSnapshot.
 * Invalid payloads fail without writing. Captures previous state for later rollback.
 */
export const commitComposerRestoration = async (
  input: ComposerRestorationCommitInput,
): Promise<ComposerRestorationCommitResult> => {
  const store = input.input ?? useInputStore.getState()
  const previous = captureComposerDraftState(input.key, {
    getDraft: store.getDraft?.bind(store),
    draftAttachmentViews: store.draftAttachmentViews,
  })
  let result: DraftCommitResult
  try {
    result = await store.commitDraftSnapshot({
      key: input.key,
      expectedRevision: input.expectedRevision,
      runtime: input.runtime ?? store.captureDraftRuntime(),
      snapshot: input.payload.snapshot,
      values: input.payload.values,
    })
  } catch {
    return { status: 'failed', current: false, durable: false, previous }
  }
  // Preserve commitDraftSnapshot's real status/current/durable.
  // Queue bridges gate remove on draft.durable; user actions require status=committed && current.
  return {
    status: result.status,
    current: result.current,
    durable: result.durable,
    result,
    previous,
  }
}

/**
 * Rolls back to a previously captured draft using CAS on the restored revision.
 * A conflict means the user continued editing — keep their newer revision.
 * Prior absence uses durable deleteDraftSnapshot so memory returns to true absence.
 * Only status=committed && current=true reports rolled-back.
 */
export const rollbackComposerRestoration = async (input: {
  key: DraftKey
  restoredRevision: number
  previous: { record: DraftRecord | null; views: Record<string, AttachedFile>; expectedRevision: number | 'absent' }
  runtime?: InputDraftRuntimeCapture
  input?: Pick<ReturnType<typeof useInputStore.getState>, 'captureDraftRuntime' | 'commitDraftSnapshot' | 'deleteDraftSnapshot' | 'getDraft'>
}): Promise<{ status: 'rolled-back' | 'conflict' | 'failed' | 'skipped'; current: boolean }> => {
  const store = input.input ?? useInputStore.getState()
  const current = store.getDraft(input.key)
  if (!current || current.revision !== input.restoredRevision) {
    return { status: 'conflict', current: true }
  }
  if (!input.previous.record) {
    // Absent prior draft: durable CAS delete restores true absence (not empty snapshot).
    try {
      const result = await store.deleteDraftSnapshot({
        key: input.key,
        expectedRevision: input.restoredRevision,
        runtime: input.runtime ?? store.captureDraftRuntime(),
      })
      if (result.status === 'conflict') return { status: 'conflict', current: true }
      if (result.status === 'committed' && result.current) return { status: 'rolled-back', current: true }
      return { status: 'failed', current: result.current }
    } catch {
      return { status: 'failed', current: false }
    }
  }
  const previous = input.previous.record
  const values = new Map<string, Blob | string>()
  for (const attachment of [...previous.attachments, ...previous.syntheticParts.flatMap((part) => part.attachments)]) {
    const view = input.previous.views[attachment.attachmentRefID]
    if (attachment.locator.kind === 'url') values.set(attachment.attachmentRefID, attachment.locator.url)
    else if (view?.file) values.set(attachment.attachmentRefID, view.file)
    else if (view?.dataUrl) values.set(attachment.attachmentRefID, view.dataUrl)
  }
  try {
    const result = await store.commitDraftSnapshot({
      key: input.key,
      expectedRevision: input.restoredRevision,
      runtime: input.runtime ?? store.captureDraftRuntime(),
      snapshot: {
        text: previous.text,
        attachments: previous.attachments,
        syntheticParts: previous.syntheticParts,
        mentions: previous.mentions,
        ...(previous.composerReferences === undefined ? {} : { composerReferences: previous.composerReferences }),
      },
      values,
    })
    if (result.status === 'conflict') return { status: 'conflict', current: true }
    if (result.status === 'committed' && result.current) return { status: 'rolled-back', current: true }
    return { status: 'failed', current: result.current }
  } catch {
    return { status: 'failed', current: false }
  }
}
