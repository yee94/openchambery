import '@/lib/brand-storage-bootstrap';
import { DRAFT_COMPOSER_REFERENCE_LIMITS, parseDraftComposerDocument, type DraftComposerDocument, type DraftComposerReference } from "./input-draft-types"

const V2_TYPE = "yuri-composer-reference-draft"
const V1_TYPE = "yuri-pasted-text-draft"

const codePointCount = (text: string): number => Array.from(text).length
const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const boundedString = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum

const legacyPasteReferences = (text: string, values: unknown[]): DraftComposerReference[] => {
  const references: DraftComposerReference[] = []
  const occupied: Array<{ start: number; end: number }> = []
  let totalPayload = 0
  for (let valueIndex = 0; valueIndex < Math.min(values.length, DRAFT_COMPOSER_REFERENCE_LIMITS.referenceCount); valueIndex += 1) {
    const value = values[valueIndex]
    if (!isPlainObject(value) || !boundedString(value.id, DRAFT_COMPOSER_REFERENCE_LIMITS.idLength) || !boundedString(value.token, DRAFT_COMPOSER_REFERENCE_LIMITS.displayLength) || typeof value.text !== "string" || value.text.length > DRAFT_COMPOSER_REFERENCE_LIMITS.pastePayloadLength || typeof value.characterCount !== "number" || !Number.isSafeInteger(value.characterCount) || value.characterCount !== codePointCount(value.text) || typeof value.index !== "number" || !Number.isSafeInteger(value.index) || value.index < 1) continue
    for (let start = text.indexOf(value.token); start >= 0 && references.length < DRAFT_COMPOSER_REFERENCE_LIMITS.referenceCount; start = text.indexOf(value.token, start + value.token.length)) {
      const end = start + value.token.length
      if (occupied.some((range) => range.start < end && range.end > start) || totalPayload + value.text.length > DRAFT_COMPOSER_REFERENCE_LIMITS.totalPastePayloadLength) continue
      const occurrence = references.filter((reference) => reference.id.startsWith(`${value.id}:`)).length
      references.push({ id: `${value.id}:${occurrence}`, kind: "paste", start, end, display: value.token, text: value.text, characterCount: value.characterCount, index: value.index })
      occupied.push({ start, end })
      totalPayload += value.text.length
    }
  }
  return references.sort((left, right) => left.start - right.start)
}

/** Converts legacy localStorage payloads into visible text plus a durable sidecar. */
export const parseLegacyDraftComposerDocument = (serialized: string): DraftComposerDocument => {
  try {
    const parsed: unknown = JSON.parse(serialized)
    if (!isPlainObject(parsed) || typeof parsed.text !== "string") return { text: serialized, references: [] }
    if (parsed.type === V2_TYPE || parsed.type === 'openchamber-composer-reference-draft') {
      const document = parsed.version === 2 ? parseDraftComposerDocument(parsed.text, parsed.references) : undefined
      return document ?? { text: parsed.text, references: [] }
    }
    if (parsed.type === V1_TYPE || parsed.type === 'openchamber-pasted-text-draft') {
      const references = parsed.version === 1 && Array.isArray(parsed.references) ? legacyPasteReferences(parsed.text, parsed.references) : []
      return parseDraftComposerDocument(parsed.text, references) ?? { text: parsed.text, references: [] }
    }
  } catch { /* Plain legacy drafts retain their original visible text. */ }
  return { text: serialized, references: [] }
}
