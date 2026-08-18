import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

const sourceUrl = new URL('./MobileApp.tsx', import.meta.url)

test('overflow refresh uses the authoritative user transcript path', async () => {
  const source = await readFile(sourceUrl, 'utf8')

  expect(source).toContain('useLiveSessionStatus(currentSessionId ?? \'\')')
  expect(source).not.toContain('useGlobalSessionStatus(currentSessionId')
  expect(source).toContain('const refreshCurrentTranscript = useEvent(() => {')
  expect(source).toContain('await sync.refreshSessionTranscript(sessionID, { directory })')
  expect(source).toContain('if (!sessionID || isTranscriptRefreshing || isSessionBusy) return')
  expect(source).toContain("key: 'refresh-transcript'")
  expect(source).toContain('disabled: isTranscriptRefreshing || isSessionBusy')
    expect(source).toContain("t('sessions.sidebar.session.menu.refreshTranscript')")
    expect(source).toContain("t('sessions.sidebar.session.menu.refreshTranscriptSuccess')")
    expect(source).toContain("t('sessions.sidebar.session.menu.refreshTranscriptFailed')")
  expect(source).not.toContain('ensureTranscriptInitial')
  expect(source).toContain("useMobileTranscriptSyncHint(currentSessionId ?? '', effectiveDirectory || undefined)")
  expect(source).toContain('const statusLabel = syncHint ?? secondaryLabel')
  expect(source).toContain('directory={target.directory}')
})
