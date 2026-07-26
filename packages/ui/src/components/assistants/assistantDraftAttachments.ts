/**
 * Pure helpers for Assistant surface draft attachment projection and synthetic-part restore.
 * Root composer chips subscribe only to DraftRecord.attachments order; synthetic views
 * map only for consumeSyntheticParts and never enter resources.attachments.
 */
import type { AttachedFile } from "@/stores/types/sessionTypes"
import type { DraftRecord, DraftSyntheticPart } from "@/sync/input-draft-types"

/** Project root attachment views in DraftRecord.attachments order only. */
export const projectRootAttachmentViews = (
  record: Pick<DraftRecord, "attachments"> | null | undefined,
  viewsByRefID: Record<string, AttachedFile> | null | undefined,
): AttachedFile[] => {
  if (!record?.attachments?.length || !viewsByRefID) return []
  return record.attachments.flatMap((attachment) => {
    const view = viewsByRefID[attachment.attachmentRefID]
    return view ? [view] : []
  })
}

/**
 * Map synthetic draft parts to send-time parts with resolved attachment views.
 * Does not include root attachments.
 */
export const mapSyntheticPartsWithViews = (
  parts: readonly DraftSyntheticPart[],
  viewsByRefID: Record<string, AttachedFile> | null | undefined,
): Array<{
  partID: string
  text: string
  synthetic?: boolean
  attachments: AttachedFile[]
}> => {
  const views = viewsByRefID ?? {}
  return parts.map((part) => ({
    partID: part.partID,
    text: part.text,
    ...(part.synthetic === true ? { synthetic: true as const } : {}),
    attachments: part.attachments.flatMap((attachment) => views[attachment.attachmentRefID] ? [views[attachment.attachmentRefID]!] : []),
  }))
}

/**
 * Merge restored synthetic parts into currently retained draft parts.
 * - Replaces by partID when the restored item already exists.
 * - Appends new restored parts that are not present.
 * - Keeps concurrent/retained parts (e.g. mobile handoff marker) not in restored.
 */
export const mergeSyntheticPartsByPartID = (
  current: readonly DraftSyntheticPart[],
  restored: readonly DraftSyntheticPart[],
): DraftSyntheticPart[] => {
  if (restored.length === 0) return [...current]
  const byID = new Map<string, DraftSyntheticPart>()
  for (const part of current) {
    byID.set(part.partID, part)
  }
  for (const part of restored) {
    byID.set(part.partID, part)
  }
  // Preserve current order for retained entries; append purely new restored IDs in restore order.
  const seen = new Set<string>()
  const merged: DraftSyntheticPart[] = []
  for (const part of current) {
    const next = byID.get(part.partID)
    if (next) {
      merged.push(next)
      seen.add(part.partID)
    }
  }
  for (const part of restored) {
    if (seen.has(part.partID)) continue
    merged.push(part)
    seen.add(part.partID)
  }
  return merged
}
