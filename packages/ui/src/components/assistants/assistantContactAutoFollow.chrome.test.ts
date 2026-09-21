import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'
import { build } from 'vite'

import {
  evidenceRoot,
  keepEvidence,
  openChromeSession,
  openPageSession,
  resolveChrome,
} from '../ui/chromeCdpHarness'

type Measure = {
  top: number
  scrollHeight: number
  clientHeight: number
  maxTop: number
  writes: number
}

const here = dirname(fileURLToPath(import.meta.url))
const uiSrc = join(here, '../..')
const chromeAvailable = Boolean(resolveChrome())
const evidenceDirs: string[] = []

afterAll(() => {
  if (keepEvidence()) return
  for (const dir of evidenceDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('Assistant contact auto-follow in Chrome', () => {
  test.skipIf(!chromeAvailable).each(['prepend', 'existing ownership', 'touch', 'scrollbar', 'DOM', 'cumulative', 'late-scrollbar', 'late-wheel', 'late-touch-pointer', 'late-previous-touch'] as const)('%s', async (scenario) => {
    const root = evidenceRoot()
    evidenceDirs.push(root)
    const work = mkdtempSync(join(root, 'assistant-contact-scroll-'))
    const htmlPath = join(work, 'harness.html')
    const bundlePath = join(work, 'browser-entry.iife.js')

    await build({
      configFile: false,
      mode: 'production',
      root: join(uiSrc, '..'),
      publicDir: false,
      esbuild: { jsxDev: false },
      resolve: { alias: { '@': uiSrc } },
      build: {
        emptyOutDir: false,
        minify: false,
        outDir: work,
        lib: {
          entry: join(here, 'assistantContactAutoFollow.chrome.fixture.tsx'),
          formats: ['iife'],
          name: 'AssistantContactAutoFollowChromeFixture',
          fileName: () => 'browser-entry.iife.js',
        },
      },
    })

    const bundle = readFileSync(bundlePath, 'utf8')
    writeFileSync(htmlPath, `<!doctype html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body><div id="root"></div>
<script>
window.process = { env: { NODE_ENV: 'production' } };
window.global = window;
window.__assistantContactScrollError = null;
window.addEventListener('error', (event) => {
  window.__assistantContactScrollError = String(event.error && event.error.stack || event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  window.__assistantContactScrollError = String(event.reason && event.reason.stack || event.reason);
});
</script>
<script>${bundle}</script></body>
</html>`, 'utf8')

    const session = await openChromeSession({ width: 390, height: 844 })
    try {
      const page = await openPageSession(session, { width: 390, height: 844, standalone: false })
      await page.navigateFile(htmlPath)
      const api = 'window.assistantContactAutoFollowHarness'
      let ready = false
      let harnessError: string | null = null
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const state = await page.evaluate<{ ready: boolean; error: string | null }>(
          `({ ready: Boolean(${api}), error: window.__assistantContactScrollError })`,
        )
        ready = state.ready
        harnessError = state.error
        if (ready || harnessError) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(harnessError, `browser harness error: ${harnessError}`).toBeNull()
      expect(ready, 'browser harness API became ready').toBe(true)
      const initial = await page.evaluate<Measure>(`${api}.measure()`)
      expect(initial.top).toBe(initial.maxTop)

      if (scenario === 'prepend') {
        const evidence = await page.evaluate<{ before: number; afterPrepend: number; afterImage: number; messages: number }>(`${api}.prependEvidence()`)
        console.info('[assistant prepend and late image evidence]', evidence)
        process.stdout.write(`${JSON.stringify({ scenario: 'assistant-prepend-late-image', ...evidence })}\n`)
        expect(evidence.messages).toBe(40)
        expect(Math.abs(evidence.afterPrepend - evidence.before)).toBeLessThanOrEqual(2)
        expect(Math.abs(evidence.afterImage - evidence.before)).toBeLessThanOrEqual(2)
        return
      }

      if (scenario !== 'existing ownership') {
        const race = await page.evaluate<{
          beforeGrowth: Measure
          afterGrowth: Measure
          afterDelivery: Measure
          afterLateGrowth: Measure
          scrollEventsBeforeGrowth: number
          scrollEventsAfterGrowth: number
          scrollEventsAfterDelivery: number
        }>(`${api}.slightTouchBeforeLayout('${scenario}')`)
        console.info('[assistant contact delayed native scroll evidence]', { scenario, ...race })
        const expectedTop = scenario === 'cumulative' ? 600 : 599
        expect(race.beforeGrowth.top).toBe(expectedTop)
        expect(race.beforeGrowth.writes).toBe(0)
        expect(race.scrollEventsBeforeGrowth).toBe(0)
        expect(race.scrollEventsAfterGrowth).toBe(0)
        if (scenario === 'cumulative') expect(race.scrollEventsAfterDelivery).toBe(0)
        else expect(race.scrollEventsAfterDelivery).toBeGreaterThan(0)
        expect.soft({ top: race.afterGrowth.top, writes: race.afterGrowth.writes }, 'before native scroll delivery')
          .toEqual({ top: expectedTop, writes: 0 })
        expect.soft({ top: race.afterDelivery.top, writes: race.afterDelivery.writes }, 'after native scroll delivery')
          .toEqual({ top: expectedTop, writes: 0 })
        expect.soft({ top: race.afterLateGrowth.top, writes: race.afterLateGrowth.writes }, 'growth after native scroll delivery')
          .toEqual({ top: expectedTop, writes: 0 })
        if (scenario.startsWith('late-')) {
          expect(race.afterDelivery.maxTop - race.afterDelivery.top).toBe(1)
          expect(race.afterLateGrowth.maxTop).toBe(660)
        }
        const resumed = await page.evaluate<Measure>(`${api}.resumeAtBottomWithTouch()`)
        expect(resumed.top).toBe(660)
        const growth = await page.evaluate<Measure>(`${api}.patch({ height: 920, revision: 2 })`)
        expect({ top: growth.top, writes: growth.writes }).toEqual({ top: 720, writes: 1 })
        console.info('[assistant contact resumed evidence]', { scenario, resumed, growth })
        return
      }

      await page.evaluate<void>(`${api}.resetWrites()`)
      const switched = await page.evaluate<Measure>(`${api}.patch({ assistantID: 'assistant-b' })`)
      expect(switched.top).toBe(switched.maxTop)
      expect(switched.writes).toBe(0)

      await page.evaluate<void>(`${api}.resetWrites()`)
      const noOpStream = await page.evaluate<Measure>(`${api}.patch({ revision: 1 })`)
      expect(noOpStream.writes).toBe(0)

      const growingAtBottom = await page.evaluate<Measure>(`${api}.patch({ revision: 2, height: 900 })`)
      expect(growingAtBottom.top).toBe(growingAtBottom.maxTop)
      expect(growingAtBottom.writes).toBe(1)

      const released = await page.evaluate<Measure>(`${api}.releaseAt(120)`)
      expect(released.top).toBe(120)
      const streamWhileReading = await page.evaluate<Measure>(`${api}.patch({ revision: 3, height: 980 })`)
      expect(streamWhileReading.top).toBe(120)
      expect(streamWhileReading.writes).toBe(0)

      const programBottom = await page.evaluate<Measure>(`${api}.programBottom()`)
      expect(programBottom.top).toBe(programBottom.maxTop)
      const asyncMarkdownGrowth = await page.evaluate<Measure>(`${api}.patch({ height: 1080 })`)
      expect(asyncMarkdownGrowth.top).toBe(programBottom.maxTop)
      expect(asyncMarkdownGrowth.writes).toBe(0)

      const resumed = await page.evaluate<Measure>(`${api}.resumeAtBottomWithTouch()`)
      expect(resumed.top).toBe(resumed.maxTop)
      const asyncImageGrowth = await page.evaluate<Measure>(`${api}.patch({ height: 1180 })`)
      expect(asyncImageGrowth.top).toBe(asyncImageGrowth.maxTop)
      expect(asyncImageGrowth.writes).toBe(1)

      await page.evaluate<Measure>(`${api}.patch({ active: false })`)
      await page.evaluate<void>(`${api}.resetWrites()`)
      const inactiveGrowth = await page.evaluate<Measure>(`${api}.patch({ assistantID: 'assistant-a', height: 1280 })`)
      expect(inactiveGrowth.top).toBe(asyncImageGrowth.maxTop)
      expect(inactiveGrowth.writes).toBe(0)

      const reactivated = await page.evaluate<Measure>(`${api}.patch({ active: true })`)
      expect(reactivated.top).toBe(reactivated.maxTop)
      expect(reactivated.writes).toBe(1)

      console.info('[assistant contact auto-follow Chrome evidence]', {
        work,
        initial,
        growingAtBottom,
        streamWhileReading,
        asyncMarkdownGrowth,
        asyncImageGrowth,
        inactiveGrowth,
        reactivated,
      })
    } finally {
      await session.close()
    }
  }, 180_000)
})
