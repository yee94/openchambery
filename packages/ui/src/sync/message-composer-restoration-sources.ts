/**
 * Composer restoration source payload builders (sent message + queue sidecars).
 * Path/mention/data-URL helpers live here; CAS commit/rollback is separate.
 */
import { materializeComposerReferenceTokens } from '@/composer/document'
import { isSyntheticPart } from '@/lib/messages/synthetic'
import { createUuid } from '@/lib/uuid'
import type { AttachedFile } from '@/stores/types/sessionTypes'
import {
  draftRootAttachmentOccurrenceRefID,
  isDurableURL,
  parseDraftComposerDocument,
  parseDraftMentions,
  type DraftAttachmentMetadata,
  type DraftComposerDocument,
  type DraftMention,
  type DraftSyntheticPart,
} from './input-draft-types'
import type { DraftSnapshot } from './input-store'

export type ComposerRestorationPayload = {
  snapshot: DraftSnapshot
  values: ReadonlyMap<string, Blob | string>
}

const isHttpOrFileURL = (value: string): boolean => {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:' || protocol === 'file:'
  } catch {
    return false
  }
}

type SentMessageRestorationOptions = {
  sessionTitles?: ReadonlyMap<string, string>
  createID?: () => string
  /** Session project root for resolving absolute file:// URLs to relative mention tokens. */
  directory?: string | null
  /** Alias of directory (call-site convenience). */
  root?: string | null
}

const partText = (part: Record<string, unknown>): string => {
  if (typeof part.text === 'string') return part.text
  if (typeof part.content === 'string') return part.content
  return ''
}

/** Authoritative directory MIME: application/x-directory, with inode/directory compatibility. */
const isDirectoryMime = (mime: string): boolean => {
  const normalized = mime.trim().toLowerCase()
  return normalized === 'application/x-directory' || normalized === 'inode/directory'
}

const normalizeFsPath = (value: string): string => value.replace(/\\/g, '/')

const stripTrailingSlashes = (value: string): string => {
  if (value.length <= 1) return value
  return value.replace(/\/+$/, '') || '/'
}

/** Decodes a file:// URL into a filesystem path (POSIX + Windows drive letters). */
export const pathFromFileURLString = (url: string): string | null => {
  if (!url.startsWith('file:')) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') return null
    let pathname = decodeURIComponent(parsed.pathname)
    // Windows: file:///C:/path or file://localhost/C:/path → pathname "/C:/path"
    if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1)
    // UNC residual host (rare): file://server/share → keep host/share shape when pathname alone is incomplete
    if (parsed.hostname && parsed.hostname !== 'localhost' && !/^[A-Za-z]:/.test(pathname)) {
      pathname = `//${parsed.hostname}${pathname.startsWith('/') ? pathname : `/${pathname}`}`
    }
    return normalizeFsPath(pathname)
  } catch {
    return null
  }
}

/** Builds relative path when absolute path is under the session directory (trailing slash tolerant). */
export const relativePathUnderDirectory = (absolutePath: string, directory: string): string | null => {
  const abs = stripTrailingSlashes(normalizeFsPath(absolutePath))
  const root = stripTrailingSlashes(normalizeFsPath(directory))
  if (!root || !abs) return null
  // Case-insensitive drive letter comparison for Windows roots.
  const absKey = /^[A-Za-z]:/.test(abs) ? abs[0]!.toLowerCase() + abs.slice(1) : abs
  const rootKey = /^[A-Za-z]:/.test(root) ? root[0]!.toLowerCase() + root.slice(1) : root
  if (absKey === rootKey) return ''
  if (!absKey.startsWith(`${rootKey}/`)) return null
  return absKey.slice(rootKey.length + 1)
}

const uniqueNonEmpty = (values: readonly string[]): string[] =>
  values.filter((value, index, all) => value.length > 0 && all.indexOf(value) === index)

const mentionPathCandidates = (pathFromFileURL: string, directory: string | null | undefined): string[] => {
  const normalized = normalizeFsPath(pathFromFileURL)
  const withoutTrailing = stripTrailingSlashes(normalized)
  const withTrailing = withoutTrailing === '/' ? '/' : `${withoutTrailing}/`
  const candidates = [
    normalized,
    withoutTrailing,
    withTrailing,
    normalized.replace(/^\/+/, ''),
    withoutTrailing.replace(/^\/+/, ''),
    withTrailing.replace(/^\/+/, ''),
  ]
  if (directory) {
    const relative = relativePathUnderDirectory(normalized, directory)
    if (relative !== null) {
      const relNoSlash = stripTrailingSlashes(relative)
      const relWithSlash = relNoSlash ? `${relNoSlash}/` : ''
      candidates.push(relative, relNoSlash, relWithSlash)
      if (normalized.endsWith('/') || pathFromFileURL.endsWith('/')) {
        candidates.push(relNoSlash ? `${relNoSlash}/` : '')
      }
    }
  }
  return uniqueNonEmpty(candidates)
}

const decodeDataURL = async (url: string): Promise<Blob> => {
  const response = await fetch(url)
  if (!response.ok) throw new Error('composer-restoration-data-url')
  return response.blob()
}

const findExactMentionToken = (text: string, token: string, occupied: ReadonlySet<string>): { start: number; end: number } | null => {
  let from = 0
  while (from < text.length) {
    const start = text.indexOf(token, from)
    if (start < 0) return null
    const end = start + token.length
    const key = `${start}:${end}`
    const before = start > 0 ? text[start - 1] : ''
    const after = text[end] ?? ''
    const startsAtBoundary = !before || /[\s([{\"'`,.;:!?]/.test(before)
    const endsAtBoundary = !after || /[\s)\]}\"'`,.;:!?]/.test(after)
    if (!occupied.has(key) && startsAtBoundary && endsAtBoundary) return { start, end }
    from = start + 1
  }
  return null
}

type AgentToken = { token: string; name: string }

/** Prefer source.value token; fall back to name. Returns the body token (with @) and bare name. */
const agentTokenFromPart = (part: Record<string, unknown>): AgentToken | null => {
  const source = part.source && typeof part.source === 'object' ? part.source as { value?: unknown } : null
  const sourceValue = typeof source?.value === 'string' ? source.value.trim() : ''
  if (sourceValue) {
    const token = sourceValue.startsWith('@') ? sourceValue : `@${sourceValue}`
    const name = token.slice(1)
    if (name) return { token, name }
  }
  const rawName = typeof part.name === 'string' ? part.name.trim() : ''
  if (!rawName) return null
  const name = rawName.startsWith('@') ? rawName.slice(1) : rawName
  if (!name) return null
  return { token: `@${name}`, name }
}

/**
 * Restores a complete Composer payload from authored message parts.
 * Filters synthetic parts; materializes skill/command/session tokens;
 * recovers agent/file/directory mentions; promotes remaining files to root attachments.
 */
export const buildSentMessageComposerRestoration = async (
  parts: readonly Record<string, unknown>[],
  options: SentMessageRestorationOptions = {},
): Promise<ComposerRestorationPayload> => {
  const createID = options.createID ?? createUuid
  const directory = options.directory ?? options.root ?? null
  const authored = parts.filter((part) => !isSyntheticPart(part as never))
  const textParts = authored.filter((part) => part.type === 'text')
  const agentParts = authored.filter((part) => part.type === 'agent')
  const fileParts = authored.filter((part) => part.type === 'file')

  // Preserve leading/trailing whitespace from authored text parts; join multi-part with \n.
  let text = textParts.map(partText).join('\n')
  const agents: AgentToken[] = []
  for (const part of agentParts) {
    const agent = agentTokenFromPart(part)
    if (agent) agents.push(agent)
  }
  // Stable prepend when the authored body lacks the agent token (prefer source.value spelling).
  for (const agent of [...agents].reverse()) {
    if (!findExactMentionToken(text, agent.token, new Set())) text = text ? `${agent.token} ${text}` : agent.token
  }

  const materialized = materializeComposerReferenceTokens(text, options.sessionTitles ?? new Map())
  text = materialized.text
  const composerReferences = materialized.references as DraftComposerDocument['references']

  const mentions: DraftMention[] = []
  const occupied = new Set<string>()
  for (const agent of agents) {
    const range = findExactMentionToken(text, agent.token, occupied)
    if (!range) continue
    occupied.add(`${range.start}:${range.end}`)
    mentions.push({ kind: 'agent', value: agent.name, path: agent.name, label: agent.name, range })
  }

  const attachments: DraftAttachmentMetadata[] = []
  const values = new Map<string, Blob | string>()

  for (const part of fileParts) {
    const url = typeof part.url === 'string' ? part.url : ''
    if (!url) continue
    const mimeType = typeof part.mime === 'string' ? part.mime : 'application/octet-stream'
    const filename = typeof part.filename === 'string' ? part.filename : 'attachment'
    const pathFromFileURL = url.startsWith('file:') ? pathFromFileURLString(url) : null
    if (pathFromFileURL) {
      const candidates = mentionPathCandidates(pathFromFileURL, directory)
      let matched: { path: string; range: { start: number; end: number } } | null = null
      for (const candidate of candidates) {
        const range = findExactMentionToken(text, `@${candidate}`, occupied)
        if (range) {
          matched = { path: candidate, range }
          break
        }
      }
      if (matched) {
        occupied.add(`${matched.range.start}:${matched.range.end}`)
        // Kind is authoritative MIME only — never infer directory from missing extension (README etc.).
        const kind = isDirectoryMime(mimeType) ? 'directory' : 'file'
        mentions.push({ kind, value: matched.path, path: matched.path, label: matched.path, range: matched.range })
        continue
      }
    }

    const attachmentID = createID()
    const attachmentRefID = draftRootAttachmentOccurrenceRefID(attachmentID)
    if (url.startsWith('data:')) {
      const blob = await decodeDataURL(url)
      values.set(attachmentRefID, blob)
      attachments.push({
        attachmentID,
        attachmentRefID,
        filename,
        mimeType: blob.type || mimeType,
        size: blob.size,
        source: 'local',
        locator: { kind: 'blob', blobID: attachmentID },
      })
      continue
    }
    // Durable http(s)/file URLs use url locators; non-durable oversize URLs fail.
    if (isHttpOrFileURL(url)) {
      if (!isDurableURL(url)) throw new Error('composer-restoration-url-too-long')
      attachments.push({
        attachmentID,
        attachmentRefID,
        filename,
        mimeType,
        size: 0,
        source: url.startsWith('file:') ? 'server' : 'local',
        locator: { kind: 'url', url },
        ...(url.startsWith('file:') && pathFromFileURL ? { serverPath: pathFromFileURL } : {}),
      })
      values.set(attachmentRefID, url)
      continue
    }
    throw new Error('composer-restoration-invalid-attachment-url')
  }

  mentions.sort((left, right) => left.range.start - right.range.start)
  const validatedMentions = parseDraftMentions(text, mentions)
  if (!validatedMentions) throw new Error('composer-restoration-invalid-mentions')
  const validatedComposer = parseDraftComposerDocument(text, composerReferences)
  if (!validatedComposer) throw new Error('composer-restoration-invalid-composer')

  return {
    snapshot: {
      text,
      composerReferences: validatedComposer.references,
      attachments,
      syntheticParts: [],
      mentions: validatedMentions,
    },
    values,
  }
}

type QueueComposerRestorationSource = {
  content: string
  composerDocument?: { text: string; references?: unknown } | DraftComposerDocument | null
  composerMentions?: readonly unknown[] | DraftMention[] | null
  attachments?: readonly AttachedFile[] | null
  /** Pre-mapped draft metadata + values (server/local bridge download path). */
  draftAttachments?: readonly DraftAttachmentMetadata[]
  draftValues?: ReadonlyMap<string, Blob | string>
  syntheticParts?: DraftSyntheticPart[]
}

/**
 * Builds restoration from a queue item's composer sidecars and attachments.
 * Invalid sidecars fail before commit so the live draft is preserved.
 */
export const buildQueueComposerRestoration = async (
  source: QueueComposerRestorationSource,
  options: { createID?: () => string } = {},
): Promise<ComposerRestorationPayload> => {
  const createID = options.createID ?? createUuid
  const text = source.composerDocument?.text ?? source.content
  const references = source.composerDocument && 'references' in source.composerDocument
    ? source.composerDocument.references ?? []
    : []
  const composer = parseDraftComposerDocument(text, references)
  const mentions = parseDraftMentions(text, source.composerMentions ?? [])
  if (!composer || !mentions) throw new Error('composer-restoration-invalid-sidecars')

  if (source.draftAttachments) {
    return {
      snapshot: {
        text,
        composerReferences: composer.references,
        attachments: [...source.draftAttachments],
        syntheticParts: source.syntheticParts ?? [],
        mentions,
      },
      values: source.draftValues ?? new Map(),
    }
  }

  const attachments: DraftAttachmentMetadata[] = []
  const values = new Map<string, Blob | string>()
  for (const file of source.attachments ?? []) {
    const attachmentID = file.id || createID()
    const attachmentRefID = draftRootAttachmentOccurrenceRefID(attachmentID)
    const dataUrl = file.dataUrl
    if (dataUrl.startsWith('data:')) {
      const blob = file.file?.size ? file.file : await decodeDataURL(dataUrl)
      values.set(attachmentRefID, blob)
      attachments.push({
        attachmentID,
        attachmentRefID,
        filename: file.filename,
        mimeType: file.mimeType || blob.type || 'application/octet-stream',
        size: blob.size,
        source: file.source === 'vscode' ? 'vscode' : file.source === 'server' ? 'server' : 'local',
        locator: { kind: 'blob', blobID: attachmentID },
        ...(file.serverPath ? { serverPath: file.serverPath } : {}),
        ...(file.vscodePath ? { vscodePath: file.vscodePath } : {}),
        ...(file.vscodeSource === 'selection' || file.vscodeSource === 'file' ? { vscodeSource: file.vscodeSource } : {}),
      })
      continue
    }
    if (isHttpOrFileURL(dataUrl)) {
      if (!isDurableURL(dataUrl)) {
        // Non-durable oversize URL: materialize from the File when present.
        if (!(file.file instanceof Blob)) throw new Error('composer-restoration-url-too-long')
        values.set(attachmentRefID, file.file)
        attachments.push({
          attachmentID,
          attachmentRefID,
          filename: file.filename,
          mimeType: file.mimeType || file.file.type || 'application/octet-stream',
          size: file.file.size,
          source: file.source === 'vscode' ? 'vscode' : file.source === 'server' ? 'server' : 'local',
          locator: { kind: 'blob', blobID: attachmentID },
          ...(file.serverPath ? { serverPath: file.serverPath } : {}),
          ...(file.vscodePath ? { vscodePath: file.vscodePath } : {}),
          ...(file.vscodeSource === 'selection' || file.vscodeSource === 'file' ? { vscodeSource: file.vscodeSource } : {}),
        })
        continue
      }
      attachments.push({
        attachmentID,
        attachmentRefID,
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.size,
        source: file.source === 'vscode' ? 'vscode' : file.source === 'server' ? 'server' : 'local',
        locator: { kind: 'url', url: dataUrl },
        ...(file.serverPath ? { serverPath: file.serverPath } : {}),
        ...(file.vscodePath ? { vscodePath: file.vscodePath } : {}),
        ...(file.vscodeSource === 'selection' || file.vscodeSource === 'file' ? { vscodeSource: file.vscodeSource } : {}),
      })
      values.set(attachmentRefID, dataUrl)
      continue
    }
    if (file.file && file.file.size >= 0) {
      values.set(attachmentRefID, file.file)
      attachments.push({
        attachmentID,
        attachmentRefID,
        filename: file.filename,
        mimeType: file.mimeType || file.file.type || 'application/octet-stream',
        size: file.file.size,
        source: file.source === 'vscode' ? 'vscode' : file.source === 'server' ? 'server' : 'local',
        locator: { kind: 'blob', blobID: attachmentID },
        ...(file.serverPath ? { serverPath: file.serverPath } : {}),
        ...(file.vscodePath ? { vscodePath: file.vscodePath } : {}),
        ...(file.vscodeSource === 'selection' || file.vscodeSource === 'file' ? { vscodeSource: file.vscodeSource } : {}),
      })
      continue
    }
    throw new Error('composer-restoration-invalid-attachment')
  }

  return {
    snapshot: {
      text,
      composerReferences: composer.references,
      attachments,
      syntheticParts: source.syntheticParts ?? [],
      mentions,
    },
    values,
  }
}
