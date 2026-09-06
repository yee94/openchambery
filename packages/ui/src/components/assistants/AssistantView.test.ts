import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMobileShareHandoffMarkerPart } from '@/apps/mobileShareDraftHandoff'
import { createInputStore } from '@/sync/input-store'
import { surfaceDraftKey } from '@/sync/input-draft-types'
import { mergeSyntheticPartsByPartID, projectRootAttachmentViews } from './assistantDraftAttachments'

const directory = dirname(fileURLToPath(import.meta.url))

describe('AssistantView synthetic part consumption', () => {
  test('contact AssistantView no longer consumes ChatInput draft markers', async () => {
    const source = await readFile(join(directory, 'AssistantView.tsx'), 'utf8')
    expect(source).not.toContain('consumeDraftSyntheticParts')
    expect(source).not.toContain('ensureAssistantSession')
  })

  test('consume retain keeps handoff marker in draft and returns other parts', () => {
    const store = createInputStore({ persistenceEnabled: false })
    const draftKey = surfaceDraftKey({ transportIdentity: 'runtime' }, 'assistant:a1')
    store.getState().ensureDraft(draftKey)
    store.getState().setDraftSyntheticParts(draftKey, [
      { partID: 'mobile-share-handoff:share', text: '', attachments: [], synthetic: true },
      { partID: 'send', text: 'context', attachments: [] },
    ])
    // Mirror AssistantView.resources.consumeSyntheticParts retain contract.
    const consumed = store.getState().consumeDraftSyntheticParts(draftKey, isMobileShareHandoffMarkerPart)
    expect(consumed).toEqual([{ partID: 'send', text: 'context', attachments: [] }])
    expect(store.getState().getDraft(draftKey)?.syntheticParts).toEqual([
      { partID: 'mobile-share-handoff:share', text: '', attachments: [], synthetic: true },
    ])
  })

  test('restore merge keeps handoff marker after failed-send restore', () => {
    const store = createInputStore({ persistenceEnabled: false })
    const draftKey = surfaceDraftKey({ transportIdentity: 'runtime' }, 'assistant:a1')
    store.getState().ensureDraft(draftKey)
    store.getState().setDraftSyntheticParts(draftKey, [
      { partID: 'mobile-share-handoff:share', text: '', attachments: [], synthetic: true },
    ])
    const current = store.getState().getDraft(draftKey)?.syntheticParts ?? []
    const restored = [{ partID: 'send', text: 'context', attachments: [] }]
    store.getState().setDraftSyntheticParts(draftKey, mergeSyntheticPartsByPartID(current, restored))
    expect(store.getState().getDraft(draftKey)?.syntheticParts?.map((part) => part.partID)).toEqual([
      'mobile-share-handoff:share',
      'send',
    ])
  })

  test('keeps root-only attachment projection helpers for share modules', async () => {
    const source = await readFile(join(directory, 'assistantDraftAttachments.ts'), 'utf8')
    expect(source).toContain('projectRootAttachmentViews')
    expect(source).toContain('mergeSyntheticPartsByPartID')
    const view = await readFile(join(directory, 'AssistantView.tsx'), 'utf8')
    expect(view).not.toContain('hydrateDraftAttachments(draftKey)')
    expect(view).not.toContain('Object.values(attachmentViews)')
  })

  test('attachment metadata identity changes when attachments arrive without revision coupling', () => {
    // Pure signature used by AssistantView: refs only, not full draft revision/text.
    const identityOf = (attachments: string[], synthetic: Array<{ partID: string; refs: string[] }>) => {
      const root = attachments.join('\u0001')
      const parts = synthetic.map((part) => `${part.partID}\u0002${part.refs.join('\u0001')}`).join('\u0003')
      return `${root}\u0004${parts}`
    }
    const empty = identityOf([], [])
    const late = identityOf(['["root","a"]'], [{ partID: 'p', refs: ['["part","p","s"]'] }])
    expect(empty).not.toBe(late)
    // Text/revision would change without metadata identity change:
    const sameMeta = identityOf(['["root","a"]'], [{ partID: 'p', refs: ['["part","p","s"]'] }])
    expect(sameMeta).toBe(late)
  })

  test('projectRootAttachmentViews excludes synthetic refs', () => {
    expect(projectRootAttachmentViews(
      {
        attachments: [
          {
            attachmentID: 'r',
            attachmentRefID: '["root","r"]',
            filename: 'r.txt',
            mimeType: 'text/plain',
            size: 1,
            locator: { kind: 'url', url: 'x' },
            source: 'local',
          },
        ],
      },
      {
        '["root","r"]': {
          id: 'r',
          file: new File([], 'r.txt'),
          dataUrl: 'data:text/plain,r',
          mimeType: 'text/plain',
          filename: 'r.txt',
          size: 1,
          source: 'local',
        },
        '["part","p","s"]': {
          id: 's',
          file: new File([], 's.txt'),
          dataUrl: 'data:text/plain,s',
          mimeType: 'text/plain',
          filename: 's.txt',
          size: 1,
          source: 'local',
        },
      },
    ).map((item) => item.id)).toEqual(['r'])
  })
})

describe('AssistantView contact surface', () => {
  test('does not ensure an OpenCode session to show the contact transcript', async () => {
    const source = await readFile(join(directory, 'AssistantView.tsx'), 'utf8')
    expect(source).toContain('<AssistantConversationSurface')
    expect(source).not.toContain('ensureAssistantSession')
    expect(source).not.toContain('refreshBinding')
    expect(source).toContain("t('assistants.conversation.contactHint')")
  })

  test('pending capability or snapshot uses a loading spinner, not unavailable copy', async () => {
    const source = await readFile(join(directory, 'AssistantView.tsx'), 'utf8')
    expect(source).toContain('resolveAssistantWorkspacePresentation')
    expect(source).toContain('data-assistant-workspace-loading')
    expect(source).toContain("t('common.loading')")
    expect(source).toContain("name=\"loader-4\"")
    expect(source).not.toContain("isPending) return renderState('ai-agent', t('assistants.state.unavailable')")
    expect(source).toContain('snapshotSettled: snapshotQuery.isSuccess')
    expect(source).toContain('hasAssistant: Boolean(assistant)')
  })
})
