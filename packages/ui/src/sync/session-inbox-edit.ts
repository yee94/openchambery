import { skillAttachmentsFromText } from '@/composer/skill-attachments'
import type { DraftKey } from './input-draft-types'
import { buildSentMessageComposerRestoration, commitComposerRestoration, rollbackComposerRestoration } from './message-composer-restoration'
import { captureInboxRuntimeScope, isCurrentInboxRuntimeScope, forgetUnpromotedInbox } from './session-inbox-overlay'
import { cancelSessionInbox, fetchSessionInboxAuthority } from './session-prompt-api'

/** Restore durably before cancelling; an ambiguous cancellation must retain the recovered draft. */
export async function editSessionInboxIntoDraft(input: {
  sessionID: string
  inboxID: string
  directory: string
  targetKey: DraftKey
  expectedRevision: number | 'absent'
  runtimeGeneration: number
  isCurrent: () => boolean
}): Promise<boolean> {
  const runtime = captureInboxRuntimeScope()
  const current = () => isCurrentInboxRuntimeScope(runtime) && input.isCurrent()
  if (!current() || input.targetKey.transportIdentity !== runtime.transportIdentity || input.runtimeGeneration !== runtime.generation) return false
  const authority = await fetchSessionInboxAuthority(input)
  if (!current() || !authority.current) return false
  const item = authority.items.find((entry) => entry.id === input.inboxID)
  if (!item || item.delivery !== 'queue') throw new Error('inbox-edit-no-longer-queued')
  const parts: Record<string, unknown>[] = []
  let text = item.payload.text
  const entries = (value: unknown): Record<string, unknown>[] => {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry !== 'object')) throw new Error('inbox-edit-invalid-payload')
    return value
  }
  for (const skill of entries(item.payload.skills)) {
    if (typeof skill.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(skill.id)) throw new Error('inbox-edit-invalid-skill')
    if (!skillAttachmentsFromText(text).some((entry) => entry.id === skill.id)) text += `\n[skill:${skill.id}]`
  }
  parts.push({ type: 'text', text })
  for (const file of entries(item.payload.files)) {
    if (typeof file.uri !== 'string' || !file.uri) throw new Error('inbox-edit-invalid-file')
    parts.push({ type: 'file', url: file.uri, filename: file.name })
  }
  for (const agent of entries(item.payload.agents)) {
    if (typeof agent.name !== 'string' || !agent.name) throw new Error('inbox-edit-invalid-agent')
    parts.push({ type: 'agent', name: agent.name })
  }
  const payload = await buildSentMessageComposerRestoration(parts, { directory: input.directory })
  if (!current()) return false
  const restored = await commitComposerRestoration({ key: input.targetKey, expectedRevision: input.expectedRevision, payload, runtime })
  if (restored.status !== 'committed' || !restored.current || !restored.durable) throw new Error('inbox-edit-draft-not-committed')
  const rollback = async () => {
    if (restored.previous && restored.result?.record) {
      await rollbackComposerRestoration({ key: input.targetKey, restoredRevision: restored.result.record.revision, previous: restored.previous, runtime })
    }
  }
  if (!current()) {
    await rollback()
    return false
  }
  // A newer local edit must not be overwritten; cancellation still targets only this inbox identity.
  try {
    await cancelSessionInbox(input)
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined
    if (typeof status === 'number' && status >= 400 && status < 500) await rollback()
    throw error
  }
  if (!isCurrentInboxRuntimeScope(runtime)) return false
  forgetUnpromotedInbox(input.sessionID, input.inboxID, 'cancelled')
  return current()
}
