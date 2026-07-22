import { countUnicodeCodePoints } from "@/lib/unicodeMetrics"

export type DraftOwner =
  | { kind: "session"; ownerID: string }
  | { kind: "draft"; ownerID: string }
  | { kind: "surface"; ownerID: string }

export type DraftAttachmentOwner = DraftOwner
  | { kind: "queue"; ownerID: string }
  | { kind: "send"; ownerID: string }

export type DraftKey = {
  transportIdentity: string
  owner: DraftOwner
}

const requiredIdentity = (value: string, name: string): string => {
  if (!value) throw new Error(`${name} must be non-empty`)
  return value
}

/** Stable durable keys intentionally exclude runtime generation. */
export const sessionDraftKey = ({ transportIdentity }: Pick<DraftKey, "transportIdentity">, sessionID: string): DraftKey => ({
  transportIdentity: requiredIdentity(transportIdentity, "transportIdentity"),
  owner: { kind: "session", ownerID: requiredIdentity(sessionID, "sessionID") },
})

/** Stable durable keys intentionally exclude runtime generation. */
export const newSessionDraftKey = ({ transportIdentity }: Pick<DraftKey, "transportIdentity">, draftID: string): DraftKey => ({
  transportIdentity: requiredIdentity(transportIdentity, "transportIdentity"),
  owner: { kind: "draft", ownerID: requiredIdentity(draftID, "draftID") },
})

/** A non-primary chat surface owns a stable, transport-scoped draft partition. */
export const surfaceDraftKey = ({ transportIdentity }: Pick<DraftKey, "transportIdentity">, surfaceID: string): DraftKey => ({
  transportIdentity: requiredIdentity(transportIdentity, "transportIdentity"),
  owner: { kind: "surface", ownerID: requiredIdentity(surfaceID, "surfaceID") },
})

export type DraftAttachmentReference = {
  transportIdentity: string
  owner: DraftAttachmentOwner
  attachmentOccurrenceRefID: string
}

const MAX_DURABLE_URL_LENGTH = 8_192

export const isDurableURL = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_DURABLE_URL_LENGTH) return false
  try {
    const protocol = new URL(value).protocol
    return protocol === "http:" || protocol === "https:" || protocol === "file:"
  } catch {
    return false
  }
}

export const draftKeyString = (key: DraftKey): string => JSON.stringify([
  key.transportIdentity,
  key.owner.kind,
  key.owner.ownerID,
])

export const draftAttachmentRefID = (reference: DraftAttachmentReference): string => JSON.stringify([
  reference.transportIdentity,
  reference.owner.kind,
  reference.owner.ownerID,
  reference.attachmentOccurrenceRefID,
])

export const draftRootAttachmentOccurrenceRefID = (attachmentRefID: string): string => JSON.stringify(["root", attachmentRefID])

export const draftSyntheticPartAttachmentOccurrenceRefID = (partID: string, attachmentRefID: string): string => JSON.stringify(["part", partID, attachmentRefID])

export type DraftAttachmentLocator =
  | { kind: "blob"; blobID: string }
  | { kind: "url"; url: string }

export type DraftAttachmentMetadata = {
  attachmentID: string
  attachmentRefID: string
  filename: string
  mimeType: string
  size: number
  locator: DraftAttachmentLocator
  source: "local" | "vscode" | "server"
  serverPath?: string
  vscodePath?: string
  vscodeSource?: "file" | "selection"
}

export type DraftSyntheticPart = {
  partID: string
  text: string
  attachments: DraftAttachmentMetadata[]
  synthetic?: boolean
}

export type DraftMention = {
  kind: "file" | "directory" | "agent"
  value: string
  path: string
  label: string
  range: { start: number; end: number }
}

/** Authored file/agent identity retained while a composer document is queued. */
export const DRAFT_MENTION_LIMITS = {
  mentionCount: 1_000,
  valueLength: 8_192,
  pathLength: 8_192,
  labelLength: 512,
} as const

type DraftSessionComposerReference = {
  id: string
  kind: "session"
  start: number
  end: number
  display: string
  sessionId: string
}

type DraftPasteComposerReference = {
  id: string
  kind: "paste"
  start: number
  end: number
  display: string
  text: string
  characterCount: number
  index: number
}

type DraftSkillComposerReference = {
  id: string
  kind: "skill"
  start: number
  end: number
  display: string
  skillName: string
}

type DraftCommandComposerReference = {
  id: string
  kind: "command"
  start: number
  end: number
  display: string
  commandName: string
  reference: string
}

export type DraftComposerReference = DraftSessionComposerReference | DraftPasteComposerReference | DraftSkillComposerReference | DraftCommandComposerReference
export type DraftComposerDocument = { text: string; references: DraftComposerReference[] }

export const DRAFT_COMPOSER_REFERENCE_LIMITS = {
  referenceCount: 1_000,
  idLength: 512,
  displayLength: 514,
  sessionIDLength: 128,
  skillNameLength: 511,
  commandNameLength: 511,
  commandReferenceLength: 8_192,
  pastePayloadLength: 100_000,
  totalPastePayloadLength: 200_000,
} as const

/** Persisted width reservation used by Composer's trigger-icon display contract. */
export const DRAFT_COMPOSER_TRIGGER_ICON_SLOT = '\u2003'

export type DraftRecord = {
  version: 1
  key: DraftKey
  revision: number
  text: string
  attachments: DraftAttachmentMetadata[]
  syntheticParts: DraftSyntheticPart[]
  mentions: DraftMention[]
  /** v1 records without this field remain durable and hydrate as an empty sidecar. */
  composerReferences?: DraftComposerReference[]
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object") return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key))
const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0
const isStringValue = (value: unknown): value is string => typeof value === "string"
const isNonNegativeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const isBoundedString = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum

const isUTF16Boundary = (text: string, offset: number): boolean => {
  if (offset <= 0 || offset >= text.length) return true
  const previous = text.charCodeAt(offset - 1), next = text.charCodeAt(offset)
  return !(previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF)
}

/** Parses complete authored file/agent mention metadata against its visible text. */
export const parseDraftMentions = (text: string, value: unknown): DraftMention[] | undefined => {
  if (!Array.isArray(value) || value.length > DRAFT_MENTION_LIMITS.mentionCount) return undefined
  const mentions: DraftMention[] = []
  const occurrences = new Set<string>()
  let previousEnd = 0
  for (const candidate of value) {
    if (!isPlainObject(candidate) || !hasOnlyKeys(candidate, ["kind", "value", "path", "label", "range"]) || (candidate.kind !== "file" && candidate.kind !== "directory" && candidate.kind !== "agent") || !isBoundedString(candidate.value, DRAFT_MENTION_LIMITS.valueLength) || !isBoundedString(candidate.path, DRAFT_MENTION_LIMITS.pathLength) || !isBoundedString(candidate.label, DRAFT_MENTION_LIMITS.labelLength) || !isPlainObject(candidate.range) || !hasOnlyKeys(candidate.range, ["start", "end"]) || !isNonNegativeInteger(candidate.range.start) || !isNonNegativeInteger(candidate.range.end) || candidate.range.end <= candidate.range.start || candidate.range.end > text.length || candidate.range.start < previousEnd || !isUTF16Boundary(text, candidate.range.start) || !isUTF16Boundary(text, candidate.range.end) || text.slice(candidate.range.start, candidate.range.end) !== `@${candidate.value}`) return undefined
    const occurrence = JSON.stringify([candidate.kind, candidate.value, candidate.path, candidate.label, candidate.range.start, candidate.range.end])
    if (occurrences.has(occurrence)) return undefined
    occurrences.add(occurrence)
    previousEnd = candidate.range.end
    mentions.push({ kind: candidate.kind, value: candidate.value, path: candidate.path, label: candidate.label, range: { start: candidate.range.start, end: candidate.range.end } })
  }
  return mentions
}

export const isValidDraftComposerSessionID = (value: unknown): value is string => isBoundedString(value, DRAFT_COMPOSER_REFERENCE_LIMITS.sessionIDLength) && /^[A-Za-z0-9_-]+$/.test(value)
export const isValidDraftComposerSkillName = (value: unknown): value is string => isBoundedString(value, DRAFT_COMPOSER_REFERENCE_LIMITS.skillNameLength) && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)
export const isValidDraftComposerCommandName = (value: unknown): value is string => isBoundedString(value, DRAFT_COMPOSER_REFERENCE_LIMITS.commandNameLength) && /^[\p{L}\p{N}._/-]+$/u.test(value)
export const isValidDraftComposerCommandReference = (value: unknown): value is string => isBoundedString(value, DRAFT_COMPOSER_REFERENCE_LIMITS.commandReferenceLength) && !/[\]\r\n]/u.test(value)

const parseComposerReference = (value: unknown): DraftComposerReference | undefined => {
  if (!isPlainObject(value) || !isBoundedString(value.id, DRAFT_COMPOSER_REFERENCE_LIMITS.idLength) || !isBoundedString(value.display, DRAFT_COMPOSER_REFERENCE_LIMITS.displayLength) || !isNonNegativeInteger(value.start) || !isNonNegativeInteger(value.end) || value.end <= value.start) return undefined
  if (value.kind === "session" && hasOnlyKeys(value, ["id", "kind", "start", "end", "display", "sessionId"]) && isValidDraftComposerSessionID(value.sessionId)) return { id: value.id, kind: "session", start: value.start, end: value.end, display: value.display, sessionId: value.sessionId }
  if (value.kind === "paste" && hasOnlyKeys(value, ["id", "kind", "start", "end", "display", "text", "characterCount", "index"]) && typeof value.text === "string" && value.text.length <= DRAFT_COMPOSER_REFERENCE_LIMITS.pastePayloadLength && isNonNegativeInteger(value.characterCount) && value.characterCount === countUnicodeCodePoints(value.text) && isNonNegativeInteger(value.index) && value.index >= 1) return { id: value.id, kind: "paste", start: value.start, end: value.end, display: value.display, text: value.text, characterCount: value.characterCount, index: value.index }
  if (value.kind === "skill" && hasOnlyKeys(value, ["id", "kind", "start", "end", "display", "skillName"]) && isValidDraftComposerSkillName(value.skillName) && (value.display === `/${value.skillName}` || value.display === `/${DRAFT_COMPOSER_TRIGGER_ICON_SLOT}${value.skillName}`)) return { id: value.id, kind: "skill", start: value.start, end: value.end, display: value.display, skillName: value.skillName }
  if (value.kind === "command" && hasOnlyKeys(value, ["id", "kind", "start", "end", "display", "commandName", "reference"]) && isValidDraftComposerCommandName(value.commandName) && isValidDraftComposerCommandReference(value.reference) && (value.display === `/${value.commandName}` || value.display === `/${DRAFT_COMPOSER_TRIGGER_ICON_SLOT}${value.commandName}`)) return { id: value.id, kind: "command", start: value.start, end: value.end, display: value.display, commandName: value.commandName, reference: value.reference }
  return undefined
}

/** Parses one complete durable sidecar. A rejected reference rejects the document. */
export const parseDraftComposerDocument = (text: string, value: unknown): DraftComposerDocument | undefined => {
  if (!Array.isArray(value) || value.length > DRAFT_COMPOSER_REFERENCE_LIMITS.referenceCount) return undefined
  const references = value.map(parseComposerReference)
  if (!references.every(Boolean)) return undefined
  const parsed = references as DraftComposerReference[]
  const ids = new Set<string>()
  let previousEnd = 0
  let totalPastePayloadLength = 0
  for (const reference of parsed) {
    if (ids.has(reference.id) || reference.start < previousEnd || reference.end > text.length || text.slice(reference.start, reference.end) !== reference.display) return undefined
    ids.add(reference.id)
    previousEnd = reference.end
    if (reference.kind === "paste") {
      totalPastePayloadLength += reference.text.length
      if (totalPastePayloadLength > DRAFT_COMPOSER_REFERENCE_LIMITS.totalPastePayloadLength) return undefined
    }
  }
  return { text, references: parsed }
}

const isSafeValue = (value: unknown, seen: Set<object>): boolean => {
  if (value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)) return true
  if (typeof value !== "object" || value instanceof Blob || (typeof File !== "undefined" && value instanceof File) || (!Array.isArray(value) && !isPlainObject(value))) return false
  if (seen.has(value)) return false
  seen.add(value)
  const safe = Object.values(value).every((child) => isSafeValue(child, seen))
  seen.delete(value)
  return safe
}

const parseOwner = (value: unknown): DraftOwner | undefined => {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["kind", "ownerID"]) || !isString(value.ownerID)) return undefined
  if (value.kind === "session" || value.kind === "draft" || value.kind === "surface") return { kind: value.kind, ownerID: value.ownerID }
  return undefined
}

const parseKey = (value: unknown): DraftKey | undefined => {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["transportIdentity", "owner"]) || !isString(value.transportIdentity)) return undefined
  const owner = parseOwner(value.owner)
  return owner ? { transportIdentity: value.transportIdentity, owner } : undefined
}

const parseLocator = (value: unknown): DraftAttachmentLocator | undefined => {
  if (!isPlainObject(value) || !isString(value.kind)) return undefined
  if (value.kind === "blob" && hasOnlyKeys(value, ["kind", "blobID"]) && isString(value.blobID)) return { kind: "blob", blobID: value.blobID }
  if (value.kind !== "url" || !hasOnlyKeys(value, ["kind", "url"]) || !isDurableURL(value.url)) return undefined
  return { kind: "url", url: value.url }
}

const hasExpectedAttachmentOccurrence = (value: string, attachmentID: string, partID?: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return false
    if (partID === undefined) return parsed.length === 2 && parsed[0] === "root" && parsed[1] === attachmentID
    return parsed.length === 3 && parsed[0] === "part" && parsed[1] === partID && parsed[2] === attachmentID
  } catch {
    return false
  }
}

const parseAttachment = (value: unknown, partID?: string): DraftAttachmentMetadata | undefined => {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["attachmentID", "attachmentRefID", "filename", "mimeType", "size", "locator", "source", "serverPath", "vscodePath", "vscodeSource"])) return undefined
  if (!isString(value.attachmentID) || !isString(value.attachmentRefID) || !hasExpectedAttachmentOccurrence(value.attachmentRefID, value.attachmentID, partID) || !isString(value.filename) || !isStringValue(value.mimeType) || !isNonNegativeInteger(value.size)) return undefined
  if (value.source !== "local" && value.source !== "vscode" && value.source !== "server") return undefined
  if ((value.serverPath !== undefined && !isString(value.serverPath)) || (value.vscodePath !== undefined && !isString(value.vscodePath)) || (value.vscodeSource !== undefined && value.vscodeSource !== "file" && value.vscodeSource !== "selection")) return undefined
  if (value.source === "server" && !isString(value.serverPath)) return undefined
  if (value.source === "vscode" && (!isString(value.vscodePath) || (value.vscodeSource !== "file" && value.vscodeSource !== "selection"))) return undefined
  const locator = parseLocator(value.locator)
  if (!locator) return undefined
  return { attachmentID: value.attachmentID, attachmentRefID: value.attachmentRefID, filename: value.filename, mimeType: value.mimeType, size: value.size, locator, source: value.source, ...(value.serverPath === undefined ? {} : { serverPath: value.serverPath }), ...(value.vscodePath === undefined ? {} : { vscodePath: value.vscodePath }), ...(value.vscodeSource === undefined ? {} : { vscodeSource: value.vscodeSource }) }
}

export const parseDraftRecord = (value: unknown): DraftRecord | undefined => {
  if (!isSafeValue(value, new Set()) || !isPlainObject(value) || !hasOnlyKeys(value, ["version", "key", "revision", "text", "attachments", "syntheticParts", "mentions", "composerReferences"]) || value.version !== 1 || !isNonNegativeInteger(value.revision) || value.revision < 1 || typeof value.text !== "string" || !Array.isArray(value.attachments) || !Array.isArray(value.syntheticParts) || !Array.isArray(value.mentions)) return undefined
  const text = value.text
  const key = parseKey(value.key)
  const attachments = value.attachments.map((attachment) => parseAttachment(attachment))
  const syntheticParts = value.syntheticParts.map((part) => {
    if (!isPlainObject(part) || !hasOnlyKeys(part, ["partID", "text", "attachments", "synthetic"]) || !isString(part.partID) || typeof part.text !== "string" || !Array.isArray(part.attachments) || (part.synthetic !== undefined && typeof part.synthetic !== "boolean")) return undefined
    const partID = part.partID
    const partText = part.text
    const partAttachments = part.attachments.map((attachment) => parseAttachment(attachment, partID))
    return partAttachments.every(Boolean) ? { partID, text: partText, attachments: partAttachments as DraftAttachmentMetadata[], ...(part.synthetic === undefined ? {} : { synthetic: part.synthetic }) } : undefined
  })
  const mentions = parseDraftMentions(text, value.mentions)
  const composerDocument = value.composerReferences === undefined ? { text, references: [] } : parseDraftComposerDocument(text, value.composerReferences)
  if (!key || !attachments.every(Boolean) || !syntheticParts.every(Boolean) || !mentions || !composerDocument) return undefined
  const parsedAttachments = attachments as DraftAttachmentMetadata[]
  const parsedParts = syntheticParts as DraftSyntheticPart[]
  const attachmentRefIDs = new Set<string>()
  for (const attachment of [...parsedAttachments, ...parsedParts.flatMap((part) => part.attachments)]) {
    if (attachmentRefIDs.has(attachment.attachmentRefID)) return undefined
    attachmentRefIDs.add(attachment.attachmentRefID)
  }
  if (new Set(parsedParts.map((part) => part.partID)).size !== parsedParts.length) return undefined
  return { version: 1, key, revision: value.revision, text, attachments: parsedAttachments, syntheticParts: parsedParts, mentions, ...(value.composerReferences === undefined ? {} : { composerReferences: composerDocument.references }) }
}

export const cloneDraftRecord = (record: DraftRecord): DraftRecord | undefined => parseDraftRecord(record)

export const isDraftRecordPersistable = (record: unknown): record is DraftRecord => !!parseDraftRecord(record)
