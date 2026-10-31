import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

import { compileProductionCssAsync, evidenceRoot, keepEvidence, openChromeSession, openPageSession, resolveChrome } from '../ui/chromeCdpHarness'

test.skipIf(!resolveChrome())('keyboard curtain never creates an outer assistant scrollport or changes message width', async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const view = readFileSync(join(here, 'AssistantView.tsx'), 'utf8')
  const surface = readFileSync(join(here, 'AssistantConversationSurface.tsx'), 'utf8')
  const workspace = view.match(/className="([^"]+)" data-presentation="workspace"/)![1]
  const pane = view.match(/className=\{cn\('(relative flex min-h-0 min-w-0 flex-1 flex-col [^']+)'/)![1]
  const transcript = surface.match(/'(min-h-0 flex-1 overflow-x-hidden overflow-y-auto [^']+)'/)![1]
  const content = surface.match(/className="([^"]+)" data-assistant-contact-content/)![1]
  const form = surface.match(/className=\{cn\('(relative w-full [^']+)', isMobile && '([^']+)'/)!
  const css = await compileProductionCssAsync(join(here, '../..'))
  const root = evidenceRoot()
  const chrome = await openChromeSession({ width: 390, height: 844 })
  try {
    const html = join(root, 'assistant-keyboard.html')
    writeFileSync(html, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>
      <main id="shell" style="width:390px;height:800px;display:flex;flex-direction:column">
        <div id="workspace" class="${workspace}"><div id="pane" class="${pane}">
          <div class="flex min-h-0 flex-1 flex-col bg-background">
            <div data-assistant-contact-transcript class="${transcript} pb-11 pt-5">
              <div data-assistant-contact-content class="${content}">
                <div id="messages" style="height:480px;flex-shrink:0">${'消息正文保持同一宽度。'.repeat(50)}</div>
              </div>
            </div>
            <footer class="relative z-10 shrink-0 bg-background pt-1">
              <form class="${form[1]} ${form[2]}"><textarea style="height:48px"></textarea></form>
            </footer>
          </div>
        </div></div>
      </main></body></html>`)
    const page = await openPageSession(chrome, { width: 390, height: 844, standalone: false })
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
    await page.navigateFile(html)
    const results = await page.evaluate<Array<{
      mode: string
      rows: Array<{ open: boolean; width: number; x: number; outerOverflow: string[]; outerScroll: number[]; transcriptRange: number }>
    }>>(`(async () => {
      const shell = document.querySelector('#shell');
      const composer = document.querySelector('form');
      const content = document.querySelector('[data-assistant-contact-content]');
      const transcript = document.querySelector('[data-assistant-contact-transcript]');
      const outer = ['workspace', 'pane'].map(id => document.getElementById(id));
      const results = [];
      for (const mode of ['android', 'ios', 'hosted']) for (const height of [480, 1200]) {
        document.querySelector('#messages').style.height = height + 'px';
        document.documentElement.className = mode === 'android' ? 'mobile-pointer yuri-capacitor-app yuri-platform-android'
          : mode === 'ios' ? 'mobile-pointer yuri-capacitor-app' : 'mobile-pointer';
        const rows = [];
        for (const open of [false, true, false, true, false, true, false]) {
          document.documentElement.classList.toggle('yuri-keyboard-open', open && mode !== 'hosted');
          shell.style.height = open && mode !== 'android' ? '480px' : '800px';
          composer.style.transform = open && mode === 'android' ? 'translate3d(0,-300px,0)' : '';
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          outer.forEach(node => { node.scrollTop = 100; });
          const rect = content.getBoundingClientRect();
          rows.push({ open, width: rect.width, x: rect.x,
            outerOverflow: outer.map(node => getComputedStyle(node).overflowY),
            outerScroll: outer.map(node => node.scrollTop),
            transcriptRange: transcript.scrollHeight - transcript.clientHeight });
          outer.forEach(node => { node.scrollTop = 0; });
        }
        transcript.scrollTop = 100;
        if (transcript.scrollHeight > transcript.clientHeight && transcript.scrollTop === 0) throw new Error('transcript scrolling disabled');
        results.push({ mode: mode + '-' + height, rows });
      }
      return results;
    })()`)
    for (const { mode, rows } of results) {
      if (mode.endsWith('1200')) expect(rows.some(row => row.transcriptRange > 0), `${mode}: exercise actual transcript overflow`).toBe(true)
      for (const row of rows) {
        expect(row.outerOverflow.every(overflow => overflow === 'clip' || overflow === 'hidden'), `${mode}: outer overflow ${row.outerOverflow}`).toBe(true)
        expect(row.outerScroll, `${mode}: outer frames must not scroll`).toEqual([0, 0])
        expect(row.width, `${mode}: message width`).toBe(rows[0].width)
        expect(row.x, `${mode}: message horizontal position`).toBe(rows[0].x)
      }
    }
  } finally {
    await chrome.close()
    if (!keepEvidence()) rmSync(root, { recursive: true, force: true })
  }
}, 120_000)
