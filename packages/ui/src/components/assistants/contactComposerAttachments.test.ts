import { describe, expect, test, vi } from 'vitest'
import {
  MAX_CONTACT_COMPOSER_FILE_BYTES,
  filesFromClipboard,
  filesFromDrop,
  mergeContactComposerAttachments,
  readContactComposerFiles,
} from './contactComposerAttachments'

class FakeFileReader {
  result: string | ArrayBuffer | null = null
  onload: ((event: ProgressEvent<FileReader>) => void) | null = null
  onerror: ((event: ProgressEvent<FileReader>) => void) | null = null
  readAsDataURL(file: Blob) {
    this.result = `data:${file.type || 'application/octet-stream'};base64,eA==`
    queueMicrotask(() => this.onload?.({} as ProgressEvent<FileReader>))
  }
}

describe('contactComposerAttachments', () => {
  test('retains original files and creates blob previews within the 25 MiB limit', async () => {
    vi.stubGlobal('FileReader', FakeFileReader)
    const image = new File(['img'], 'shot.png', { type: 'image/png' })
    const file = new File(['hi'], 'notes.txt', { type: 'text/plain' })
    const result = await readContactComposerFiles([image, file], () => 'att_1')
    expect(result.skippedTooLarge).toBe(0)
    expect(result.attachments).toEqual([
      { id: 'att_1', url: expect.stringMatching(/^blob:/), name: 'shot.png', mime: 'image/png', file: image },
      { id: 'att_1', url: expect.stringMatching(/^blob:/), name: 'notes.txt', mime: 'text/plain', file },
    ])
    expect(MAX_CONTACT_COMPOSER_FILE_BYTES).toBe(25 * 1024 * 1024)
    result.attachments.forEach((attachment) => URL.revokeObjectURL(attachment.url))
    vi.unstubAllGlobals()
  })

  test('skips oversized files and collects clipboard plus drop files', async () => {
    vi.stubGlobal('FileReader', FakeFileReader)
    const huge = new File(['x'], 'huge.bin', { type: 'application/octet-stream' })
    Object.defineProperty(huge, 'size', { value: MAX_CONTACT_COMPOSER_FILE_BYTES + 1 })
    const result = await readContactComposerFiles([huge])
    expect(result.attachments).toEqual([])
    expect(result.skippedTooLarge).toBe(1)

    const pasted = new File(['x'], 'paste.png', { type: 'image/png' })
    const clipboard = {
      files: [pasted],
      items: [],
    } as unknown as DataTransfer
    expect(filesFromClipboard(clipboard).map((file) => file.name)).toEqual(['paste.png'])
    expect(filesFromDrop({ files: [pasted] } as unknown as DataTransfer).map((file) => file.name)).toEqual(['paste.png'])
    expect(mergeContactComposerAttachments(
      [{ id: 'a', url: 'data:text/plain;base64,eA==', name: 'a.txt', mime: 'text/plain' }],
      [{ id: 'b', url: 'data:image/png;base64,eA==', name: 'b.png', mime: 'image/png' }],
    )).toHaveLength(2)
    vi.unstubAllGlobals()
  })
})
