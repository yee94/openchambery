import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useInputStore, type InputDraftRuntimeCapture } from "@/sync/input-store"
import { draftKeyString, parseDraftComposerDocument, type DraftComposerDocument, type DraftKey, type DraftMention, type DraftRecord } from "@/sync/input-draft-types"
import { insertComposerReference, materializeComposerDocument, mergeComposerRecovery, normalizeComposerReferenceDeletionWhitespace, reconcileComposerDocument, resolveComposerReferenceDeletion, validateComposerDocument, type ComposerDocument } from "./document"
import { diffComposerDocumentResources, type ComposerResourceDelta, type ComposerReference, type NewComposerReference } from "./extensions"
import { createComposerReferenceHistorySnapshot, emptyComposerReferenceHistory, pushComposerReferenceHistory, redoComposerReferenceHistory, undoComposerReferenceHistory } from "./reference-history"

type InputStoreApi = Pick<typeof useInputStore, "getState" | "subscribe">
export type ComposerInputMode = "compose" | "history-preview"
export type ComposerResourcesChangedPort = (delta: ComposerResourceDelta) => void | Promise<void>

export type ComposerRecordUpdate = "local-echo" | "same-document-metadata" | "external-document" | "ignore"
export type ComposerLocalCommit = { keyID: string; revision: number; fingerprint: string }
export type ComposerRecordCursor = { keyID: string; epoch: number; appliedRevision: number }
export type ComposerPreviewState = { real: ComposerDocument; realMentions: DraftMention[] }
export type ComposerMentionsUpdater = (mentions: readonly DraftMention[], document: ComposerDocument) => DraftMention[]

const documentFromRecord = (record: Pick<DraftRecord, "text" | "composerReferences"> | undefined): ComposerDocument => ({ text: record?.text ?? "", references: record?.composerReferences ?? [] })
const cloneDocument = (document: ComposerDocument): ComposerDocument => ({ text: document.text, references: document.references.map((reference) => ({ ...reference })) })
const cloneKey = (key: DraftKey): DraftKey => ({ transportIdentity: key.transportIdentity, owner: { ...key.owner } })

/** A stable complete-document identity used to distinguish store echoes from restores. */
export const composerDocumentFingerprint = (document: DraftComposerDocument): string => JSON.stringify([document.text, document.references])
export const composerKeyMatchesRequest = (key: DraftKey | null, requestedKeyID: string | null): key is DraftKey => key !== null && requestedKeyID !== null && draftKeyString(key) === requestedKeyID

export type ComposerKeyBinding = {
  document: ComposerDocument
  mentions: DraftMention[]
  revision: number
  key: DraftKey | null
  keyID: string | null
}

export const resolveComposerKeyBinding = (draftKey: DraftKey | null, sessionTitles: ReadonlyMap<string, string>, getDraft: (key: DraftKey) => DraftRecord | undefined): ComposerKeyBinding => {
  const key = draftKey ? cloneKey(draftKey) : null
  const record = key ? getDraft(key) : undefined
  return {
    document: materializeComposerDocument(documentFromRecord(record), sessionTitles),
    mentions: record?.mentions ?? [],
    revision: record?.revision ?? 0,
    key,
    keyID: key ? draftKeyString(key) : null,
  }
}

export const classifyComposerRecordUpdate = (current: DraftComposerDocument, incoming: DraftRecord | undefined, local: ComposerLocalCommit | undefined, cursor: ComposerRecordCursor): ComposerRecordUpdate => {
  if (!incoming || draftKeyString(incoming.key) !== cursor.keyID || incoming.revision < cursor.appliedRevision) return "ignore"
  const fingerprint = composerDocumentFingerprint(documentFromRecord(incoming))
  if (local?.keyID === cursor.keyID && local.revision === incoming.revision && local.fingerprint === fingerprint) return "local-echo"
  if (incoming.revision === cursor.appliedRevision) return "ignore"
  return fingerprint === composerDocumentFingerprint(current) ? "same-document-metadata" : "external-document"
}

export const rebaseComposerMentions = (mentions: readonly DraftMention[], document: ComposerDocument, edit: { oldStart: number; oldEnd: number; newEnd: number }): DraftMention[] => {
  const delta = edit.newEnd - edit.oldEnd
  return mentions.flatMap((mention) => {
    if (mention.range.start < edit.oldEnd && mention.range.end > edit.oldStart) return []
    const range = mention.range.start >= edit.oldEnd ? { start: mention.range.start + delta, end: mention.range.end + delta } : mention.range
    return document.text.slice(range.start, range.end) === `@${mention.value}` ? [{ ...mention, range }] : []
  })
}

export const normalizeComposerMentionsForCommit = (mentions: readonly DraftMention[]): DraftMention[] => mentions
  .map((mention, index) => ({ mention, index }))
  .sort((left, right) => left.mention.range.start - right.mention.range.start || left.mention.range.end - right.mention.range.end || left.index - right.index)
  .map(({ mention }) => mention)

export const applyBrowserComposerEdit = (document: ComposerDocument, mentions: readonly DraftMention[], nextText: string, selectionStart: number, selectionEnd = selectionStart): { document: ComposerDocument; mentions: DraftMention[]; requiresTextCorrection: boolean; selectionStart: number; selectionEnd: number; removedReferences: ComposerReference[] } => {
  const result = reconcileComposerDocument(document, nextText, selectionStart, selectionEnd)
  return { document: result.document, mentions: rebaseComposerMentions(mentions, result.document, result.edit), requiresTextCorrection: result.requiresTextCorrection, selectionStart: result.selectionStart, selectionEnd: result.selectionEnd, removedReferences: result.removedReferences }
}

export const enterComposerHistoryPreview = (document: ComposerDocument, mentions: readonly DraftMention[], historyDocument: ComposerDocument): { preview: ComposerPreviewState; document: ComposerDocument; mentions: DraftMention[] } => ({
  preview: { real: cloneDocument(document), realMentions: [...mentions] }, document: { text: historyDocument.text, references: [] }, mentions: [],
})
export const exitComposerHistoryPreview = (preview: ComposerPreviewState): { document: ComposerDocument; mentions: DraftMention[] } => ({ document: preview.real, mentions: preview.realMentions })

const mergeRecoveryMentions = (failed: readonly DraftMention[], current: readonly DraftMention[], document: ComposerDocument, offset: number): DraftMention[] => {
  const candidates = [...failed, ...current.map((mention) => ({ ...mention, range: { start: mention.range.start + offset, end: mention.range.end + offset } }))]
  const seen = new Set<string>()
  return candidates.filter((mention) => {
    const identity = `${mention.kind}:${mention.value}:${mention.range.start}:${mention.range.end}`
    if (seen.has(identity) || document.text.slice(mention.range.start, mention.range.end) !== `@${mention.value}`) return false
    seen.add(identity)
    return true
  })
}

export const planComposerRecovery = (capture: Pick<ComposerSubmissionCapture, "document" | "mentions">, current: Pick<DraftRecord, "text" | "composerReferences" | "mentions"> | undefined): { document: ComposerDocument; mentions: DraftMention[] } => {
  const currentDocument = documentFromRecord(current)
  const document = mergeComposerRecovery(capture.document, currentDocument)
  const offset = capture.document.text === currentDocument.text && JSON.stringify(capture.document.references) === JSON.stringify(currentDocument.references) ? 0 : capture.document.text.length + 2
  return { document, mentions: mergeRecoveryMentions(capture.mentions, current?.mentions ?? [], document, offset) }
}

export type ComposerSubmissionCapture = { key: DraftKey; keyID: string; revision: number; document: ComposerDocument; mentions: DraftMention[]; epoch: number; runtime: InputDraftRuntimeCapture }

export type UseComposerControllerOptions = {
  draftKey: DraftKey | null
  sessionTitles: ReadonlyMap<string, string>
  persistenceEnabled: boolean
  onResourcesChanged?: ComposerResourcesChangedPort
  store?: InputStoreApi
}

/** Coordinates one durable composer draft while leaving rendering and submission UI to ChatInput. */
export const useComposerController = ({ draftKey, sessionTitles, persistenceEnabled, onResourcesChanged, store = useInputStore }: UseComposerControllerOptions) => {
  const keyID = draftKey ? draftKeyString(draftKey) : null
  const record = useSyncExternalStore(store.subscribe, () => keyID ? store.getState().drafts[keyID] : undefined, () => undefined)
  const hydration = useSyncExternalStore(store.subscribe, () => keyID ? store.getState().draftHydration[keyID] ?? "idle" : "idle", () => "idle")
  const persistence = useSyncExternalStore(store.subscribe, () => keyID ? store.getState().draftPersistence[keyID] : undefined, () => undefined)
  const [document, setDocument] = useState<ComposerDocument>(() => resolveComposerKeyBinding(draftKey, sessionTitles, store.getState().getDraft).document)
  const [mentions, setMentions] = useState<DraftMention[]>(() => resolveComposerKeyBinding(draftKey, sessionTitles, store.getState().getDraft).mentions)
  const [inputMode, setInputMode] = useState<ComposerInputMode>("compose")
  const documentRef = useRef(document)
  const mentionsRef = useRef(mentions)
  const titlesRef = useRef(sessionTitles)
  const onResourcesChangedRef = useRef(onResourcesChanged)
  const draftKeyRef = useRef(draftKey)
  const keyRef = useRef<DraftKey | null>(draftKey ? cloneKey(draftKey) : null)
  const requestedKeyIDRef = useRef<string | null>(keyID)
  const activeKeyRef = useRef<string | null>(keyID)
  const epochRef = useRef(0)
  const appliedRevisionRef = useRef(record?.revision ?? 0)
  const localCommitRef = useRef<ComposerLocalCommit | undefined>(undefined)
  const previewRef = useRef<ComposerPreviewState | undefined>(undefined)
  const referenceHistoryRef = useRef(emptyComposerReferenceHistory())

  documentRef.current = document
  mentionsRef.current = mentions
  titlesRef.current = sessionTitles
  onResourcesChangedRef.current = onResourcesChanged
  draftKeyRef.current = draftKey
  requestedKeyIDRef.current = keyID
  const publish = useCallback((nextDocument: ComposerDocument, nextMentions: DraftMention[]): void => {
    documentRef.current = nextDocument
    mentionsRef.current = nextMentions
    setDocument(nextDocument)
    setMentions(nextMentions)
  }, [])
  const notifyResourcesChanged = useCallback((previous: ComposerDocument, next: ComposerDocument): void => {
    const delta = diffComposerDocumentResources(previous, next)
    void onResourcesChangedRef.current?.(delta)
  }, [])

  useEffect(() => { void store.getState().setDraftPersistenceEnabled(persistenceEnabled) }, [persistenceEnabled, store])

  useLayoutEffect(() => {
    epochRef.current += 1
    const epoch = epochRef.current
    activeKeyRef.current = keyID
    const binding = resolveComposerKeyBinding(draftKeyRef.current, titlesRef.current, store.getState().getDraft)
    const activeDraftKey = binding.key
    keyRef.current = binding.key
    localCommitRef.current = undefined
    previewRef.current = undefined
    referenceHistoryRef.current = emptyComposerReferenceHistory()
    setInputMode("compose")
    appliedRevisionRef.current = binding.revision
    publish(binding.document, binding.mentions)
    if (activeDraftKey?.owner.kind === "draft") {
      const expectedRevision = binding.revision
      void store.getState().claimLegacyNewDraft(activeDraftKey).then((claimed) => {
        const current = store.getState().getDraft(activeDraftKey)
        if (!claimed || !composerKeyMatchesRequest(keyRef.current, keyID) || activeKeyRef.current !== keyID || requestedKeyIDRef.current !== keyID || epochRef.current !== epoch || appliedRevisionRef.current !== expectedRevision || current?.revision !== claimed.revision) return
        appliedRevisionRef.current = claimed.revision
        publish(materializeComposerDocument(documentFromRecord(claimed), titlesRef.current), claimed.mentions)
      })
    }
  }, [keyID, publish, store])

  useEffect(() => {
    if (!keyID || activeKeyRef.current !== keyID || previewRef.current) return
    const kind = classifyComposerRecordUpdate(documentRef.current, record, localCommitRef.current, { keyID, epoch: epochRef.current, appliedRevision: appliedRevisionRef.current })
    if (kind === "ignore") return
    if (record) appliedRevisionRef.current = record.revision
    if (kind === "local-echo" || kind === "same-document-metadata") {
      if (record) setMentions(record.mentions)
      return
    }
    if (kind === "external-document" && record) {
      localCommitRef.current = undefined
      publish(materializeComposerDocument(documentFromRecord(record), titlesRef.current), record.mentions)
      setInputMode("compose")
    }
  }, [keyID, publish, record])

  const commit = useCallback((next: ComposerDocument, nextMentions: DraftMention[]): DraftRecord | undefined => {
    const key = keyRef.current
    if (!composerKeyMatchesRequest(key, requestedKeyIDRef.current) || previewRef.current) return undefined
    const previous = documentRef.current
    const committed = store.getState().setDraftComposerState(key, { document: next, mentions: normalizeComposerMentionsForCommit(nextMentions) })
    if (!committed) return undefined
    const normalized = documentFromRecord(committed)
    localCommitRef.current = { keyID: draftKeyString(key), revision: committed.revision, fingerprint: composerDocumentFingerprint(normalized) }
    appliedRevisionRef.current = committed.revision
    publish(normalized, committed.mentions)
    notifyResourcesChanged(previous, normalized)
    return committed
  }, [store, publish, notifyResourcesChanged])
  const recordReferenceHistory = useCallback((
    before: ComposerDocument,
    beforeMentions: readonly DraftMention[],
    beforeSelection: { start: number; end: number },
    after: ComposerDocument,
    afterMentions: readonly DraftMention[],
    afterSelection: { start: number; end: number },
  ): void => {
    referenceHistoryRef.current = pushComposerReferenceHistory(referenceHistoryRef.current, {
      before: createComposerReferenceHistorySnapshot(before, beforeMentions, beforeSelection),
      after: createComposerReferenceHistorySnapshot(after, afterMentions, afterSelection),
    })
  }, [])

  const promotePreview = useCallback((): boolean => {
    if (!previewRef.current) return false
    previewRef.current = undefined
    setInputMode("compose")
    return true
  }, [])
  const replacePlainDocument = useCallback((text: string): DraftRecord | undefined => { promotePreview(); return commit({ text, references: [] }, []) }, [commit, promotePreview])
  const replaceMaterializedDocument = useCallback((next: ComposerDocument, mentions: DraftMention[] = []): DraftRecord | undefined => {
    promotePreview()
    const parsed = parseDraftComposerDocument(next.text, next.references)
    return parsed ? commit(materializeComposerDocument(parsed, titlesRef.current), mentions) : undefined
  }, [commit, promotePreview])
  const applyBrowserEdit = useCallback((nextText: string, selectionStart: number, selectionEnd = selectionStart): { start: number; end: number; requiresTextCorrection: boolean } => {
    const preview = promotePreview()
    const before = cloneDocument(documentRef.current)
    const beforeMentions = preview ? [] : mentionsRef.current
    const result = applyBrowserComposerEdit(before, beforeMentions, nextText, selectionStart, selectionEnd)
    commit(result.document, result.mentions)
    if (result.removedReferences.length > 0) {
      recordReferenceHistory(before, beforeMentions, { start: result.selectionStart, end: result.selectionEnd }, result.document, result.mentions, { start: result.selectionStart, end: result.selectionEnd })
    }
    return { start: result.selectionStart, end: result.selectionEnd, requiresTextCorrection: result.requiresTextCorrection }
  }, [commit, promotePreview, recordReferenceHistory])
  const applyProgrammaticEdit = useCallback((edit: { start: number; end: number; text: string }, mentionsUpdater?: ComposerMentionsUpdater): { start: number; end: number } => {
    const current = documentRef.current
    const start = Math.max(0, Math.min(edit.start, current.text.length)); const end = Math.max(start, Math.min(edit.end, current.text.length))
    const preview = promotePreview()
    const result = reconcileComposerDocument(current, `${current.text.slice(0, start)}${edit.text}${current.text.slice(end)}`, start + edit.text.length)
    const rebasedMentions = rebaseComposerMentions(preview ? [] : mentionsRef.current, result.document, result.edit)
    commit(result.document, mentionsUpdater ? mentionsUpdater(rebasedMentions, result.document) : rebasedMentions)
    return { start: result.selectionStart, end: result.selectionEnd }
  }, [commit, promotePreview])
  const replaceProgrammaticText = useCallback((nextText: string, mentionsUpdater?: ComposerMentionsUpdater): { start: number; end: number } => {
    const current = documentRef.current
    return applyProgrammaticEdit({ start: 0, end: current.text.length, text: nextText }, mentionsUpdater)
  }, [applyProgrammaticEdit])
  const insertReference = useCallback((selectionStart: number, selectionEnd: number, reference: NewComposerReference, options?: Parameters<typeof insertComposerReference>[4]): { start: number; end: number; caret: number; document: ComposerDocument } => {
    const preview = promotePreview()
    const inserted = insertComposerReference(documentRef.current, selectionStart, selectionEnd, reference, options)
    commit(inserted.document, rebaseComposerMentions(preview ? [] : mentionsRef.current, inserted.document, inserted.edit))
    return { start: inserted.caret, end: inserted.caret, caret: inserted.caret, document: inserted.document }
  }, [commit, promotePreview])
  const deleteReference = useCallback((intent: { key: "Backspace" | "Delete"; selectionStart: number; selectionEnd: number; altKey?: boolean }): { start: number; end: number } | null => {
    const before = cloneDocument(documentRef.current)
    const deleted = resolveComposerReferenceDeletion(before, intent)
    if (!deleted) return null
    const preview = promotePreview()
    const beforeMentions = preview ? [] : mentionsRef.current
    const deletedMentions = rebaseComposerMentions(beforeMentions, deleted.document, deleted.edit)
    const normalized = normalizeComposerReferenceDeletionWhitespace(deleted.document.text, deleted.caret)
    const reconciled = reconcileComposerDocument(deleted.document, normalized.text, normalized.caret)
    const nextMentions = rebaseComposerMentions(deletedMentions, reconciled.document, reconciled.edit)
    commit(reconciled.document, nextMentions)
    recordReferenceHistory(
      before,
      beforeMentions,
      { start: intent.selectionStart, end: intent.selectionEnd },
      reconciled.document,
      nextMentions,
      { start: reconciled.selectionStart, end: reconciled.selectionEnd },
    )
    return { start: reconciled.selectionStart, end: reconciled.selectionEnd }
  }, [commit, promotePreview, recordReferenceHistory])
  const restoreReferenceHistory = useCallback((direction: "undo" | "redo"): { start: number; end: number } | null => {
    if (previewRef.current) return null
    const restored = direction === "undo"
      ? undoComposerReferenceHistory(referenceHistoryRef.current, documentRef.current)
      : redoComposerReferenceHistory(referenceHistoryRef.current, documentRef.current)
    if (!restored || !commit(restored.snapshot.document, restored.snapshot.mentions)) return null
    referenceHistoryRef.current = restored.history
    return restored.snapshot.selection
  }, [commit])
  const commitMentions = useCallback((nextMentions: DraftMention[]): DraftRecord | undefined => commit(documentRef.current, nextMentions), [commit])
  const enterHistoryPreview = useCallback((historyDocument: ComposerDocument): void => {
    const transition = previewRef.current ? { document: { text: historyDocument.text, references: [] }, mentions: [] } : enterComposerHistoryPreview(documentRef.current, mentionsRef.current, historyDocument)
    if ("preview" in transition) previewRef.current = transition.preview
    setInputMode("history-preview")
    publish(transition.document, transition.mentions)
  }, [publish])
  const exitHistoryPreview = useCallback((): void => {
    const preview = previewRef.current
    if (!preview) return
    previewRef.current = undefined
    setInputMode("compose")
    const restored = exitComposerHistoryPreview(preview)
    publish(restored.document, restored.mentions)
  }, [publish])
  const captureSubmission = useCallback((): ComposerSubmissionCapture | null => {
    const key = keyRef.current
    if (!composerKeyMatchesRequest(key, requestedKeyIDRef.current)) return null
    const current = store.getState().getDraft(key)
    return { key: cloneKey(key), keyID: draftKeyString(key), revision: current?.revision ?? 0, document: cloneDocument(documentRef.current), mentions: mentionsRef.current.map((mention) => ({ ...mention, range: { ...mention.range } })), epoch: epochRef.current, runtime: store.getState().captureDraftRuntime() }
  }, [store])
  const recoverSubmission = useCallback((capture: ComposerSubmissionCapture): DraftRecord | undefined => {
    const recovered = planComposerRecovery(capture, store.getState().getDraft(capture.key))
    const current = documentFromRecord(store.getState().getDraft(capture.key))
    const previous = validateComposerDocument(current.text, current.references).document
    const committed = store.getState().setDraftComposerState(capture.key, { ...recovered, mentions: normalizeComposerMentionsForCommit(recovered.mentions) })
    if (committed) {
      const next = documentFromRecord(committed)
      notifyResourcesChanged(previous, next)
    }
    return committed
  }, [notifyResourcesChanged, store])

  const getDocument = useCallback(() => documentRef.current, [])
  return useMemo(() => ({ document, mentions, confirmedFileMentions: mentions.filter((mention) => mention.kind === "file" || mention.kind === "directory"), inputMode, hydration, persistence, getDocument, replacePlainDocument, replaceMaterializedDocument, applyBrowserEdit, applyProgrammaticEdit, replaceProgrammaticText, insertReference, deleteReference, restoreReferenceHistory, commitMentions, enterHistoryPreview, exitHistoryPreview, captureSubmission, recoverSubmission }), [applyBrowserEdit, applyProgrammaticEdit, captureSubmission, commitMentions, deleteReference, document, enterHistoryPreview, exitHistoryPreview, getDocument, hydration, inputMode, insertReference, mentions, persistence, recoverSubmission, replaceMaterializedDocument, replacePlainDocument, replaceProgrammaticText, restoreReferenceHistory])
}
