import { describe, expect, test } from 'bun:test'
import type { AttachedFile } from '@/stores/types/sessionTypes'
import {
  activeEditorSelectionLabel,
  isActiveEditorFileAttached,
  isActiveEditorSelectionAttached,
} from './FileAttachment'

const file = (partial: Partial<AttachedFile> & Pick<AttachedFile, 'id' | 'filename'>): AttachedFile => ({
  id: partial.id,
  file: new File([], partial.filename),
  dataUrl: partial.dataUrl ?? '',
  mimeType: partial.mimeType ?? 'text/plain',
  filename: partial.filename,
  size: partial.size ?? 0,
  source: partial.source ?? 'local',
  ...(partial.vscodePath ? { vscodePath: partial.vscodePath } : {}),
  ...(partial.vscodeSource ? { vscodeSource: partial.vscodeSource } : {}),
})

describe('ActiveEditorFileSuggestion attach helpers', () => {
  test('detects vscode file attachments by path', () => {
    const attached = [
      file({
        id: 'a',
        filename: 'hello.ts',
        source: 'vscode',
        vscodeSource: 'file',
        vscodePath: '/workspace/hello.ts',
      }),
    ]
    expect(isActiveEditorFileAttached(attached, '/workspace/hello.ts')).toBe(true)
    expect(isActiveEditorFileAttached(attached, '/workspace/other.ts')).toBe(false)
    expect(isActiveEditorFileAttached([], '/workspace/hello.ts')).toBe(false)
  })

  test('detects selection attachments by path and label', () => {
    const attached = [
      file({
        id: 's',
        filename: 'src/a.ts:1-3',
        source: 'vscode',
        vscodeSource: 'selection',
        vscodePath: '/repo/src/a.ts',
      }),
    ]
    expect(isActiveEditorSelectionAttached(attached, '/repo/src/a.ts', 'src/a.ts:1-3')).toBe(true)
    expect(isActiveEditorSelectionAttached(attached, '/repo/src/a.ts', 'src/a.ts:2')).toBe(false)
    expect(isActiveEditorSelectionAttached(attached, '/other', 'src/a.ts:1-3')).toBe(false)
  })

  test('builds compact selection labels', () => {
    expect(activeEditorSelectionLabel('rel/a.ts', { startLine: 4, endLine: 4 })).toBe('rel/a.ts:4')
    expect(activeEditorSelectionLabel('rel/a.ts', { startLine: 1, endLine: 3 })).toBe('rel/a.ts:1-3')
    expect(activeEditorSelectionLabel('rel/a.ts', null)).toBe('')
  })
})
