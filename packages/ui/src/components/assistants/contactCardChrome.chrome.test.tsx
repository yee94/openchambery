import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import { compileProductionCssAsync, evidenceRoot, keepEvidence, openChromeSession, openPageSession, resolveChrome } from '../ui/chromeCdpHarness'
import { AssistantAssistantCard } from './AssistantAssistantCard'
import { AssistantScheduleCard } from './AssistantScheduleCard'
import { AssistantSessionCard } from './AssistantSessionCard'
import { CONTACT_CARD_COVER_CLASS, CONTACT_SESSION_CARD_COVER_CLASS } from './contactCardChrome'

// Render the production card markup with deterministic runtime data. Chrome owns layout.
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key.endsWith('.busy') ? 'Working' : key.endsWith('.question') ? '需要你' : key }) }))
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }))
vi.mock('@/apps/mobileAppContext', () => ({ useMobileAppActions: () => null }))
vi.mock('@/lib/platform', () => ({ isIPadApp: () => false }))
vi.mock('@/stores/useGlobalSessionsStore', () => ({ useGlobalSessionsStore: () => null }))
vi.mock('@/sync/sync-context', () => ({ useGlobalSessionStatus: () => undefined }))
vi.mock('@/router/sessionLookup', () => ({ findSessionById: vi.fn() }))
vi.mock('@/sync/openSessionWithFeedback', () => ({ openSessionWithFeedback: vi.fn() }))
vi.mock('@/stores/useUIStore', () => ({ useUIStore: { getState: vi.fn() } }))
vi.mock('@/stores/useAssistantUIStore', () => ({ openAssistant: vi.fn() }))
vi.mock('@/mobile/useMobileNavigationStore', () => ({ useMobileNavigationStore: { getState: vi.fn() } }))

const here = dirname(fileURLToPath(import.meta.url))
const longTitle = '移动端助手会话宽度修复_' + 'unbroken-session-title-'.repeat(12)
const metadata = 'project-model-branch-'.repeat(12)

function cards(short = false) {
  const title = short ? 'Hi' : longTitle
  return [
    ...['busy', 'question'].map((status) => <AssistantSessionCard key={status} card={{ type: 'card', cardType: 'session', sessionID: 'layout-test', directory: short ? '/p' : `/projects/${metadata}`, title, status, branch: short ? null : metadata }} />),
    <AssistantAssistantCard key="assistant" card={{ type: 'card', cardType: 'assistant', assistantID: 'layout-test', name: title, providerID: short ? 'p' : metadata, modelID: short ? 'm' : metadata, mode: 'continuous' }} />,
    <AssistantScheduleCard key="schedule" card={{ type: 'card', cardType: 'schedule', taskID: 'layout-test', projectID: 'p', name: title, kind: short ? 'daily' : metadata, time: null, timezone: null, prompt: null }} />,
  ].map((card, index) => (
    // Mirror the transcript's padding, avatar rail, and shrinkable message column.
    <div key={index} className="flex w-full justify-start" data-short={short}>
      <div className="mr-2.5 flex w-8 shrink-0 justify-center pt-0.5" />
      <div className="flex min-w-0 flex-col gap-1.5 max-w-[min(84%,34rem)] items-start">{card}</div>
    </div>
  ))
}

type Measurement = {
  kind: string; short: boolean; width: number; parentWidth: number; right: number; parentRight: number
  scrollWidth: number; clientWidth: number; titleWidth: number; titleScrollWidth: number
  ellipsis: string; titleFont: number; statusWidth: number; statusScrollWidth: number; statusRight: number
}

describe('contact card width', () => {
  test('caps content-hugging covers against both their parent and rem limit', () => {
    expect(CONTACT_CARD_COVER_CLASS).toContain('w-fit min-w-0 max-w-[min(100%,15rem)]')
    expect(CONTACT_SESSION_CARD_COVER_CLASS).toContain('w-fit min-w-0 max-w-[min(100%,20rem)]')
    const surface = readFileSync(join(here, 'AssistantConversationSurface.tsx'), 'utf8')
    expect(surface).toContain('flex min-w-0 flex-col gap-1.5')
    expect(surface).toContain('max-w-[min(84%,34rem)] items-start')
    expect(surface).toContain('mr-2.5 flex w-8 shrink-0 justify-center pt-0.5')
  })

  test.skipIf(!resolveChrome())('measures production cards and CSS at phone widths with enlarged text', async () => {
    const css = await compileProductionCssAsync(join(here, '../..'))
    const root = evidenceRoot()
    const htmlPath = join(root, 'contact-card-width.html')
    const markup = renderToStaticMarkup(<main className="px-4"><div className="mx-auto flex w-full max-w-[42rem] flex-col">{cards()}{cards(true)}</div></main>)
    writeFileSync(htmlPath, `<!doctype html><html class="mobile-pointer"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${markup}</body></html>`)
    const session = await openChromeSession({ width: 390, height: 844 })
    try {
      const page = await openPageSession(session, { width: 390, height: 844, standalone: false })
      await page.navigateFile(htmlPath)
      await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true })
      const oldOverflow = await page.evaluate<number>(`(() => {
        const cards = [...document.querySelectorAll('[data-assistant-contact-card]')];
        cards.forEach(el => {
          el.style.maxWidth = el.dataset.assistantContactCard === 'session' ? '20rem' : '15rem';
          el.style.minWidth = 'auto';
        });
        const overflow = Math.max(...cards.map(el => el.getBoundingClientRect().right - el.parentElement.getBoundingClientRect().right));
        cards.forEach(el => { el.style.removeProperty('max-width'); el.style.removeProperty('min-width'); });
        return overflow;
      })()`)
      expect(oldOverflow, 'the previous fixed-rem cap reproduces right-side overflow at 320px').toBeGreaterThan(1)
      const evidence: { width: number; textScale: number; cards: Measurement[] }[] = []
      for (const width of [320, 375, 390, 430]) {
        await page.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true })
        for (const scale of [1, 1.5, 2]) {
          // Text-only enlargement exercises the fixed viewport with 100/150/200% text.
          // It deliberately leaves spacing/rem geometry unchanged.
          const measurements = await page.evaluate<Measurement[]>(`(() => {
            document.querySelectorAll('h3').forEach(el => el.style.setProperty('font-size', '${14 * scale}px', 'important'));
            document.querySelectorAll('p, h3 + span').forEach(el => el.style.setProperty('font-size', '${12 * scale}px', 'important'));
            return [...document.querySelectorAll('[data-assistant-contact-card]')].map(el => {
              const rect = el.getBoundingClientRect();
              const parent = el.parentElement.getBoundingClientRect();
              const title = el.querySelector('h3');
              const status = title.nextElementSibling?.tagName === 'SPAN' ? title.nextElementSibling : null;
              return { kind: el.dataset.assistantContactCard, short: el.parentElement.parentElement.dataset.short === 'true',
                width: rect.width, parentWidth: parent.width, right: rect.right, parentRight: parent.right,
                scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
                titleWidth: title.clientWidth, titleScrollWidth: title.scrollWidth,
                ellipsis: getComputedStyle(title).textOverflow, titleFont: parseFloat(getComputedStyle(title).fontSize),
                statusWidth: status?.clientWidth ?? 0, statusScrollWidth: status?.scrollWidth ?? 0,
                statusRight: status?.getBoundingClientRect().right ?? 0 };
            });
          })()`)
          expect(measurements).toHaveLength(8)
          for (const m of measurements) {
            const label = `${width}px / ${scale * 100}% / ${m.kind} / short=${m.short}`
            expect(m.width, label).toBeLessThanOrEqual(Math.min(m.parentWidth, (m.kind === 'session' ? 20 : 15) * 16) + 1)
            expect(m.right, label).toBeLessThanOrEqual(m.parentRight + 1)
            expect(m.right, label).toBeLessThanOrEqual(width - 16 + 1)
            expect(m.scrollWidth, label).toBeLessThanOrEqual(m.clientWidth + 1)
            expect(m.titleFont, label).toBe(14 * scale)
            expect(m.ellipsis, label).toBe('ellipsis')
            expect(m.titleWidth, label).toBeGreaterThan(0)
            if (!m.short) expect(m.titleScrollWidth, label).toBeGreaterThan(m.titleWidth)
            if (m.kind === 'session') {
              expect(m.statusWidth, label).toBeGreaterThan(0)
              expect(m.statusScrollWidth, label).toBeLessThanOrEqual(m.statusWidth + 1)
              expect(m.statusRight, label).toBeLessThanOrEqual(m.right - 14 + 1)
            }
          }
          if (width === 430 && scale === 1) {
            expect(measurements[7].width).toBeLessThan(measurements[3].width)
          }
          evidence.push({ width, textScale: scale, cards: measurements })
        }
      }
      writeFileSync(join(root, 'contact-card-width-measurements.json'), JSON.stringify({ oldOverflow, evidence }, null, 2))
    } finally {
      await session.close()
      if (!keepEvidence()) rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)
})
