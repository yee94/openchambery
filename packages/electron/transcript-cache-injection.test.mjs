import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const mainPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.mjs')

describe('Electron transcript-cache SQLite injection', () => {
  it('passes a userData-scoped transcriptCacheDbPath into startWebUiServer', () => {
    const source = fs.readFileSync(mainPath, 'utf8')
    expect(source).toContain("transcriptCacheDbPath: path.join(app.getPath('userData'), 'transcript-cache.sqlite')")
    expect(source).toContain('startWebUiServer({')
    expect(source).toContain("sessionIndexDbPath: path.join(app.getPath('userData'), 'session-index.sqlite')")
    expect(source).toContain("messageQueueDbPath: path.join(app.getPath('userData'), 'message-queue.sqlite')")
  })
})
