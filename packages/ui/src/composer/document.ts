import { DRAFT_COMPOSER_REFERENCE_LIMITS, type DraftComposerDocument } from '@/sync/input-draft-types';
import {
    COMPOSER_REFERENCE_LIMITS,
    getComposerCanonicalCodecs,
    getComposerReferencePayloadBudget,
    isComposerReferenceKind,
    type ComposerCanonicalCodec,
    type ComposerReference,
    type ComposerReferenceMaterializationContext,
    type NewComposerReference,
    validateComposerReferencePayload,
} from './extensions';
import { compileComposerSendPlan } from './send-plan';

export { COMPOSER_REFERENCE_LIMITS, decorateComposerReference, isValidComposerSessionId } from './extensions';
export type { ComposerReference, NewComposerReference, PasteComposerReference, SessionComposerReference } from './extensions';
export type ComposerDocument = DraftComposerDocument;

const clamp = (value: number, maximum: number): number => Math.max(0, Math.min(value, maximum));
const isBoundedString = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum;

const isReferenceShape = (value: unknown): value is ComposerReference => {
    if (typeof value !== 'object' || value === null) return false;
    const reference = value as Record<string, unknown>;
    if (!isBoundedString(reference.id, COMPOSER_REFERENCE_LIMITS.displayLength) || !isBoundedString(reference.display, COMPOSER_REFERENCE_LIMITS.displayLength)
        || !Number.isSafeInteger(reference.start) || !Number.isSafeInteger(reference.end) || typeof reference.kind !== 'string') return false;
    return isComposerReferenceKind(reference.kind)
        && validateComposerReferencePayload(reference.kind, reference);
};

export interface ComposerDocumentValidation { document: ComposerDocument; rejectedIds: string[]; rejectedCount: number; budgetExceeded: boolean; payloadBudgetExceeded: boolean; }

/** Keeps every independently valid reference, ordered by UTF-16 range, and isolates malformed entries. */
export const validateComposerDocument = (text: string, references: readonly unknown[]): ComposerDocumentValidation => {
    const rejectedIds: string[] = [];
    let rejectedCount = 0;
    const candidates: Array<{ reference: ComposerReference; index: number }> = [];
    const limit = Math.min(references.length, COMPOSER_REFERENCE_LIMITS.referenceCount);
    for (let index = 0; index < limit; index += 1) {
        const value = references[index];
        if (!isReferenceShape(value)) {
            if (typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).id === 'string') rejectedIds.push((value as Record<string, unknown>).id as string);
            rejectedCount += 1;
            continue;
        }
        candidates.push({ reference: value, index });
    }
    candidates.sort((left, right) => left.reference.start - right.reference.start || left.index - right.index);
    const valid: ComposerReference[] = [];
    const ids = new Set<string>();
    let previousEnd = 0;
    let totalOpaquePayloadLength = 0;
    let referencePayloadBudgetExceeded = false;
    for (const { reference } of candidates) {
        if (ids.has(reference.id) || reference.start < previousEnd || reference.start < 0 || reference.end <= reference.start
            || reference.end > text.length || text.slice(reference.start, reference.end) !== reference.display) {
            rejectedIds.push(reference.id);
            rejectedCount += 1;
            continue;
        }
        ids.add(reference.id);
        previousEnd = reference.end;
        const payloadBudget = getComposerReferencePayloadBudget(reference);
        totalOpaquePayloadLength += payloadBudget?.category === 'opaque-text' ? payloadBudget.length : 0;
        if (totalOpaquePayloadLength > DRAFT_COMPOSER_REFERENCE_LIMITS.totalPastePayloadLength) {
            rejectedIds.push(reference.id);
            rejectedCount += 1;
            ids.delete(reference.id);
            previousEnd = valid.at(-1)?.end ?? 0;
            referencePayloadBudgetExceeded = true;
            totalOpaquePayloadLength -= payloadBudget?.category === 'opaque-text' ? payloadBudget.length : 0;
            continue;
        }
        valid.push(reference);
    }
    rejectedCount += references.length - limit;
    return { document: { text, references: valid }, rejectedIds, rejectedCount, budgetExceeded: references.length > COMPOSER_REFERENCE_LIMITS.referenceCount, payloadBudgetExceeded: referencePayloadBudgetExceeded };
};

/**
 * Normalizes a document produced by the Draft parser or insertion validator.
 * Local edit paths retain typed payloads and validate their IDs, ranges, display
 * slices, overlap, and opaque payload-length budget without re-scanning payloads.
 */
export const normalizeTrustedComposerDocument = (document: { text: string; references: readonly ComposerReference[] }): ComposerDocument => {
    const references = [...document.references].sort((left, right) => left.start - right.start || left.end - right.end);
    const valid: ComposerReference[] = [];
    const ids = new Set<string>();
    let previousEnd = 0;
    let totalOpaquePayloadLength = 0;
    for (const reference of references) {
        if (!isBoundedString(reference.id, COMPOSER_REFERENCE_LIMITS.idLength) || !isBoundedString(reference.display, COMPOSER_REFERENCE_LIMITS.displayLength)
            || !isComposerReferenceKind(reference.kind) || !Number.isSafeInteger(reference.start) || !Number.isSafeInteger(reference.end)
            || ids.has(reference.id) || reference.start < previousEnd || reference.start < 0 || reference.end <= reference.start
            || reference.end > document.text.length || document.text.slice(reference.start, reference.end) !== reference.display) continue;
        const payloadBudget = getComposerReferencePayloadBudget(reference);
        const opaqueLength = payloadBudget?.category === 'opaque-text' ? payloadBudget.length : 0;
        if (totalOpaquePayloadLength + opaqueLength > DRAFT_COMPOSER_REFERENCE_LIMITS.totalPastePayloadLength) continue;
        ids.add(reference.id);
        previousEnd = reference.end;
        totalOpaquePayloadLength += opaqueLength;
        valid.push(reference);
    }
    return { text: document.text, references: valid };
};

export const canAddPasteComposerReference = (document: ComposerDocument, text: string): boolean => {
    if (text.length > DRAFT_COMPOSER_REFERENCE_LIMITS.pastePayloadLength) return false;
    const current = validateComposerDocument(document.text, document.references);
    if (current.budgetExceeded || current.payloadBudgetExceeded) return false;
    const used = current.document.references.reduce((total, reference) => {
        const budget = getComposerReferencePayloadBudget(reference);
        return total + (budget?.category === 'opaque-text' ? budget.length : 0);
    }, 0);
    return used + text.length <= DRAFT_COMPOSER_REFERENCE_LIMITS.totalPastePayloadLength;
};

const expandedEditRange = (references: readonly ComposerReference[], start: number, end: number): { start: number; end: number } => {
    const touched = references.filter((reference) => (start === end
        ? start > reference.start && start < reference.end
        : reference.start < end && reference.end > start));
    return touched.length === 0 ? { start, end } : {
        start: Math.min(start, ...touched.map((reference) => reference.start)),
        end: Math.max(end, ...touched.map((reference) => reference.end)),
    };
};

export interface ComposerReferenceInsertionOptions {
    inlineBoundaries?: boolean;
    /** Also insert ordinary spaces when the chip sits at the document start/end. */
    padDocumentEdges?: boolean;
}

export function insertComposerReference(document: ComposerDocument, selectionStart: number, selectionEnd: number, reference: NewComposerReference, options: ComposerReferenceInsertionOptions = {}): { document: ComposerDocument; caret: number; edit: ComposerEdit } {
    const current = normalizeTrustedComposerDocument(document);
    if (!validateComposerReferencePayload(reference.kind, reference as Record<string, unknown>)) return { document: current, caret: clamp(selectionEnd, current.text.length), edit: { oldStart: selectionStart, oldEnd: selectionEnd, newEnd: selectionEnd } };
    const selectedStart = clamp(selectionStart, current.text.length);
    const selectedEnd = Math.max(selectedStart, clamp(selectionEnd, current.text.length));
    const range = expandedEditRange(current.references, selectedStart, selectedEnd);
    const before = current.text.slice(0, range.start);
    const after = current.text.slice(range.end);
    const leadingSpace = options.inlineBoundaries
        && (before.length > 0 || options.padDocumentEdges)
        && !/\s$/.test(before) ? ' ' : '';
    const trailingSpace = options.inlineBoundaries
        && (after.length > 0 || options.padDocumentEdges)
        && !/^\s/.test(after) ? ' ' : '';
    const text = `${before}${leadingSpace}${reference.display}${trailingSpace}${after}`;
    const inserted = { ...reference, start: range.start + leadingSpace.length, end: range.start + leadingSpace.length + reference.display.length } as ComposerReference;
    const delta = leadingSpace.length + reference.display.length + trailingSpace.length - (range.end - range.start);
    const retained = current.references.filter((item) => item.end <= range.start || item.start >= range.end).map((item) => item.start >= range.end
        ? { ...item, start: item.start + delta, end: item.end + delta } : item);
    return { document: normalizeTrustedComposerDocument({ text, references: [...retained, inserted] }), caret: inserted.end, edit: { oldStart: range.start, oldEnd: range.end, newEnd: range.start + leadingSpace.length + reference.display.length + trailingSpace.length } };
}

export interface ComposerEdit { oldStart: number; oldEnd: number; newEnd: number; }
export const mapComposerCaretThroughEdit = (caret: number, edit: ComposerEdit): number => caret <= edit.oldStart ? caret : caret >= edit.oldEnd ? caret + edit.newEnd - edit.oldEnd : edit.newEnd;

export interface ComposerReconciliation {
    document: ComposerDocument;
    edit: ComposerEdit;
    requiresTextCorrection: boolean;
    selectionStart: number;
    selectionEnd: number;
    caret: number;
    mapCaret: (caret: number) => number;
    removedReferences: ComposerReference[];
}

export const reconcileComposerDocument = (document: ComposerDocument, nextText: string, nextSelectionStart = nextText.length, nextSelectionEnd = nextSelectionStart): ComposerReconciliation => {
    const current = normalizeTrustedComposerDocument(document);
    let prefix = 0;
    const commonLength = Math.min(current.text.length, nextText.length);
    while (prefix < commonLength && current.text[prefix] === nextText[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < current.text.length - prefix && suffix < nextText.length - prefix && current.text[current.text.length - suffix - 1] === nextText[nextText.length - suffix - 1]) suffix += 1;
    const browserEdit = { oldStart: prefix, oldEnd: current.text.length - suffix, newEnd: nextText.length - suffix };
    const range = expandedEditRange(current.references, browserEdit.oldStart, browserEdit.oldEnd);
    const requiresTextCorrection = range.start !== browserEdit.oldStart || range.end !== browserEdit.oldEnd;
    const removedReferences = current.references.filter((reference) => reference.start < range.end && reference.end > range.start);
    const inserted = nextText.slice(browserEdit.oldStart, browserEdit.newEnd);
    const text = `${current.text.slice(0, range.start)}${inserted}${current.text.slice(range.end)}`;
    const edit = { oldStart: range.start, oldEnd: range.end, newEnd: range.start + inserted.length };
    const delta = edit.newEnd - edit.oldEnd;
    const references = current.references.filter((reference) => reference.end <= range.start || reference.start >= range.end).map((reference) => reference.start >= range.end
        ? { ...reference, start: reference.start + delta, end: reference.end + delta } : reference);
    const mapNextPosition = (position: number, affinity: 'start' | 'end'): number => {
        const bounded = clamp(position, nextText.length);
        const rightRemnantEnd = browserEdit.newEnd + range.end - browserEdit.oldEnd;
        const mapped = bounded <= range.start ? bounded
            : bounded < browserEdit.oldStart || (bounded === browserEdit.oldStart && affinity === 'start') ? range.start
                : bounded < browserEdit.newEnd || (bounded === browserEdit.newEnd && affinity === 'start') ? range.start + bounded - browserEdit.oldStart
                    : bounded <= rightRemnantEnd ? edit.newEnd
                        : edit.newEnd + bounded - rightRemnantEnd;
        return clamp(mapped, text.length);
    };
    const selectionStart = mapNextPosition(nextSelectionStart, 'start');
    const selectionEnd = Math.max(selectionStart, mapNextPosition(nextSelectionEnd, 'end'));
    const reconciled = normalizeTrustedComposerDocument({ text, references });
    return { document: reconciled, edit, requiresTextCorrection, selectionStart, selectionEnd, caret: selectionEnd, mapCaret: (caret) => clamp(mapComposerCaretThroughEdit(caret, edit), reconciled.text.length), removedReferences };
};

export const expandComposerReferenceSelection = (selectionStart: number, selectionEnd: number, references: readonly ComposerReference[]): { start: number; end: number } | null => {
    const range = expandedEditRange(references, selectionStart, selectionEnd);
    return range.start === selectionStart && range.end === selectionEnd ? null : range;
};

const wordDeletionRange = (text: string, key: 'Backspace' | 'Delete', caret: number): { start: number; end: number } => {
    let start = caret; let end = caret;
    if (key === 'Backspace') { while (start > 0 && /\s/.test(text[start - 1])) start -= 1; while (start > 0 && !/\s/.test(text[start - 1])) start -= 1; }
    else { while (end < text.length && /\s/.test(text[end])) end += 1; while (end < text.length && !/\s/.test(text[end])) end += 1; }
    return { start, end };
};

export const resolveComposerReferenceDeletion = (document: ComposerDocument, intent: { key: 'Backspace' | 'Delete'; selectionStart: number; selectionEnd: number; altKey?: boolean }): { document: ComposerDocument; caret: number; edit: ComposerEdit; removedIds: string[]; removedReferences: ComposerReference[] } | null => {
    const current = normalizeTrustedComposerDocument(document);
    const start = clamp(intent.selectionStart, current.text.length); const end = Math.max(start, clamp(intent.selectionEnd, current.text.length));
    const deletion = start !== end ? { start, end } : intent.altKey ? wordDeletionRange(current.text, intent.key, start) : intent.key === 'Backspace' ? { start: Math.max(0, start - 1), end: start } : { start, end: Math.min(current.text.length, start + 1) };
    const expanded = expandComposerReferenceSelection(deletion.start, deletion.end, current.references);
    if (!expanded) return null;
    const removed = current.references.filter((reference) => reference.start < expanded.end && reference.end > expanded.start);
    const text = `${current.text.slice(0, expanded.start)}${current.text.slice(expanded.end)}`;
    const references = current.references.filter((reference) => !removed.includes(reference)).map((reference) => reference.start >= expanded.end ? { ...reference, start: reference.start - (expanded.end - expanded.start), end: reference.end - (expanded.end - expanded.start) } : reference);
    return { document: normalizeTrustedComposerDocument({ text, references }), caret: expanded.start, edit: { oldStart: expanded.start, oldEnd: expanded.end, newEnd: expanded.start }, removedIds: removed.map((reference) => reference.id), removedReferences: removed };
};

/** Collapses the whitespace left by an atomic Composer reference deletion. */
export const normalizeComposerReferenceDeletionWhitespace = (text: string, caret: number): { text: string; caret: number } => {
    let start = caret;
    let end = caret;
    while (start > 0 && /\s/.test(text[start - 1])) start -= 1;
    while (end < text.length && /\s/.test(text[end])) end += 1;
    const separator = start > 0 && end < text.length ? ' ' : '';
    return {
        text: `${text.slice(0, start)}${separator}${text.slice(end)}`,
        caret: start + separator.length,
    };
};

export type ComposerSerializationResult = { ok: true; text: string; chunks?: import('./send-plan').ComposerSendChunk[]; semantics?: import('./extensions').ComposerReferenceSemantic[] } | { ok: false; reason: 'invalid-references' | 'reference-budget-exceeded' | 'reference-payload-budget-exceeded' | 'canonical-output-too-large' };

export const serializeComposerDocument = (document: ComposerDocument, mode: 'queue-canonical' | 'direct-send-display' = 'queue-canonical'): ComposerSerializationResult => {
    const validation = validateComposerDocument(document.text, document.references);
    if (validation.budgetExceeded) return { ok: false, reason: 'reference-budget-exceeded' };
    if (validation.payloadBudgetExceeded) return { ok: false, reason: 'reference-payload-budget-exceeded' };
    if (validation.rejectedCount > 0) return { ok: false, reason: 'invalid-references' };
    const compiled = compileComposerSendPlan(validation.document, mode);
    return compiled.ok
        ? { ok: true, text: compiled.text, chunks: compiled.plan.chunks, semantics: compiled.plan.semantics }
        : compiled;
};

interface ComposerCanonicalCandidate { codec: ComposerCanonicalCodec; match: RegExpExecArray; adapterOrder: number; matchOrder: number; }
const compareCanonicalCandidates = (left: ComposerCanonicalCandidate, right: ComposerCanonicalCandidate): number => left.match.index - right.match.index || left.adapterOrder - right.adapterOrder || left.matchOrder - right.matchOrder;

const collectComposerCanonicalCandidates = (text: string): ComposerCanonicalCandidate[] | null => {
    if (text.length > COMPOSER_REFERENCE_LIMITS.canonicalOutputLength || text.length > COMPOSER_REFERENCE_LIMITS.visibleTextLength) return null;
    const candidates: ComposerCanonicalCandidate[] = [];
    let candidateCount = 0;
    for (const [adapterOrder, codec] of getComposerCanonicalCodecs().entries()) {
        codec.matcher.lastIndex = 0;
        let match: RegExpExecArray | null; let matchOrder = 0;
        while ((match = codec.matcher.exec(text)) !== null) {
            candidateCount += 1;
            if (candidateCount > COMPOSER_REFERENCE_LIMITS.referenceCount) return null;
            const candidate = { codec, match, adapterOrder, matchOrder };
            matchOrder += 1;
            const insertion = candidates.findIndex((existing) => compareCanonicalCandidates(candidate, existing) < 0);
            if (insertion === -1) candidates.push(candidate); else candidates.splice(insertion, 0, candidate);
        }
    }
    return candidates;
};

/** Restores a persisted document while preserving valid sidecars and materializing disjoint canonical tokens. */
export const materializeComposerDocument = (document: ComposerDocument, sessionTitles: ReadonlyMap<string, string>): ComposerDocument => {
    const current = validateComposerDocument(document.text, document.references).document;
    const candidates = collectComposerCanonicalCandidates(current.text);
    if (candidates === null) return current;
    const context = { text: current.text, sessionTitles } satisfies ComposerReferenceMaterializationContext;
    const references: ComposerReference[] = []; let result = ''; let copied = 0; let occupiedUntil = 0;
    const ids = new Set(current.references.map((reference) => reference.id));
    const replacements: Array<{ start: number; end: number; display: string; reference: ComposerReference }> = [];
    for (const candidate of candidates) {
        const { match, codec } = candidate; const start = match.index; const end = start + match[0].length;
        if (start < occupiedUntil) continue;
        if (current.references.some((reference) => reference.start < end && reference.end > start)) continue;
        const display = codec.resolveDisplay(match, context);
        if (display === null) continue;
        if (display.length > COMPOSER_REFERENCE_LIMITS.displayLength) continue;
        const materialized = codec.materialize(match, display, start);
        let id = materialized.id;
        while (ids.has(id)) id = `materialized:${id}`;
        ids.add(id);
        replacements.push({ start, end, display, reference: { ...materialized, id } });
        occupiedUntil = end;
    }
    copied = 0;
    let offset = 0;
    for (const replacement of replacements) {
        result += `${current.text.slice(copied, replacement.start)}${replacement.display}`;
        const start = replacement.start + offset;
        references.push({ ...replacement.reference, start, end: start + replacement.display.length });
        offset += replacement.display.length - (replacement.end - replacement.start);
        copied = replacement.end;
    }
    result += current.text.slice(copied);
    if (result.length > COMPOSER_REFERENCE_LIMITS.visibleTextLength) return current;
    const rebased = current.references.map((reference) => {
        const priorDelta = replacements.filter((replacement) => replacement.end <= reference.start)
            .reduce((total, replacement) => total + replacement.display.length - (replacement.end - replacement.start), 0);
        return { ...reference, start: reference.start + priorDelta, end: reference.end + priorDelta };
    });
    return validateComposerDocument(result, [...rebased, ...references]).document;
};

export const materializeComposerReferenceTokens = (text: string, sessionTitles: ReadonlyMap<string, string>): ComposerDocument => {
    return materializeComposerDocument({ text, references: [] }, sessionTitles);
};

export const materializeSessionMentionTokens = (text: string, titles: ReadonlyMap<string, string>): ComposerDocument => materializeComposerReferenceTokens(text, titles);

/** Restores the failed snapshot before current input with a stable separator and collision-safe reference ids. */
export const mergeComposerRecovery = (failed: ComposerDocument, current: ComposerDocument, separator = '\n\n'): ComposerDocument => {
    const left = validateComposerDocument(failed.text, failed.references).document;
    const right = validateComposerDocument(current.text, current.references).document;
    if (left.text === right.text && JSON.stringify(left.references) === JSON.stringify(right.references)) return right;
    const ids = new Set(left.references.map((reference) => reference.id));
    const uniqueId = (id: string): string => { let candidate = id; while (ids.has(candidate)) candidate = `recovered:${candidate}`; ids.add(candidate); return candidate; };
    const offset = left.text.length + separator.length;
    return validateComposerDocument(`${left.text}${separator}${right.text}`, [...left.references, ...right.references.map((reference) => ({ ...reference, id: uniqueId(reference.id), start: reference.start + offset, end: reference.end + offset }))]).document;
};
