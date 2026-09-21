import { writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { compileProductionCssAsync, evidenceRoot, keepEvidence, openChromeSession, openPageSession, resolveChrome } from '../ui/chromeCdpHarness';
import { ASSISTANT_MESSAGE_PREVIEW_CLASS } from './assistantMessagePreview';

test.skipIf(!resolveChrome())('assistant previews clamp long Chinese and English to two lines at 375px', async () => {
  const root = evidenceRoot();
  const css = await compileProductionCssAsync(join(dirname(fileURLToPath(import.meta.url)), '../..'));
  const htmlPath = join(root, 'assistant-preview.html');
  const texts = ['最新消息内容预览'.repeat(60), 'UnbrokenEnglishMessage'.repeat(24)];
  // Geometry fixture uses the production list classes and actual shared preview class.
  writeFileSync(htmlPath, `<!doctype html><html class="mobile-pointer"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><main class="w-full min-w-0 p-4">${texts.map((text) => `
    <div class="oc-mobile-floating-surface oc-mobile-assistant-card-shell">
      <button type="button" class="oc-mobile-assistant-card">
        <span class="size-10 shrink-0" aria-hidden="true"></span>
        <span class="oc-mobile-assistant-card-content min-w-0 flex-1">
          <span class="oc-mobile-assistant-name block truncate">Assistant</span>
          <span data-preview class="oc-mobile-assistant-summary ${ASSISTANT_MESSAGE_PREVIEW_CLASS}">${text}</span>
        </span>
      </button>
    </div>
    <button type="button" class="flex w-full min-w-0 items-center gap-3 px-3 py-3">
      <span class="size-6 shrink-0" aria-hidden="true"></span>
      <span class="min-w-0 flex-1"><span class="block truncate">Assistant</span><span data-preview class="${ASSISTANT_MESSAGE_PREVIEW_CLASS} mt-1.5">${text}</span></span>
    </button>`).join('')}</main></body></html>`);
  const session = await openChromeSession({ width: 375, height: 812 });
  try {
    const page = await openPageSession(session, { width: 375, height: 812, standalone: false });
    await page.navigateFile(htmlPath);
    const measures = await page.evaluate<Array<{ clamp: string; height: number; lineHeight: number; scrollHeight: number; width: number; scrollWidth: number }>>(`Array.from(document.querySelectorAll('[data-preview]')).map(el => { const s = getComputedStyle(el); return { clamp: s.webkitLineClamp, height: el.getBoundingClientRect().height, lineHeight: parseFloat(s.lineHeight), scrollHeight: el.scrollHeight, width: el.clientWidth, scrollWidth: el.scrollWidth }; })`);
    console.info('Assistant preview Chrome measurements', measures);
    for (const measure of measures) {
      expect(measure.clamp).toBe('2');
      expect(measure.height).toBeCloseTo(measure.lineHeight * 2, 0);
      expect(measure.scrollHeight).toBeGreaterThan(measure.height);
    }
    expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(375);
    expect(await page.evaluate<boolean>(`Array.from(document.querySelectorAll('[data-preview]')).every(el => ['clip', 'hidden'].includes(getComputedStyle(el).overflowX) && el.getBoundingClientRect().right <= 375)`)).toBe(true);
    expect(await page.evaluate<boolean>(`(() => { const button = document.querySelector('button'); button.focus(); return document.activeElement === button; })()`)).toBe(true);
    await page.screenshotPng(join(root, 'assistant-preview-375.png'));
    console.info('Assistant preview Chrome evidence', { width: 375, measures, root });
  } finally {
    await session.close();
    if (!keepEvidence()) rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
