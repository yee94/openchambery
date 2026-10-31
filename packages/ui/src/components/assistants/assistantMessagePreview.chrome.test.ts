import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { compileProductionCssAsync, evidenceRoot, keepEvidence, openChromeSession, openPageSession, resolveChrome } from '../ui/chromeCdpHarness';
import { ASSISTANT_MESSAGE_PREVIEW_CLASS } from './assistantMessagePreview';

test.skipIf(!resolveChrome())('mobile assistant cards retain press growth without nested scrollers on press or swipe', async () => {
  const root = evidenceRoot();
  const source = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const css = await compileProductionCssAsync(source);
  const cardSource = readFileSync(join(source, 'mobile/assistant/MobileAssistantTab.tsx'), 'utf8');
  const shellClass = cardSource.match(/<MobileFloatingSurface className="([^"]*yuri-mobile-assistant-card-shell[^"]*)"/)?.[1];
  const feedback = cardSource.match(/data-mobile-press-feedback="([^"]+)"/)?.[1];
  expect(shellClass).toBeTruthy();
  expect(feedback).toBeTruthy();
  const htmlPath = join(root, 'assistant-card-press.html');
  writeFileSync(htmlPath, `<!doctype html><html class="mobile-pointer device-mobile"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>
    <main style="height:100dvh;overflow-y:auto;padding:16px">
      <div class="yuri-mobile-assistant-catalog">${Array.from({ length: 3 }, (_, index) => `
        <div class="yuri-mobile-floating-surface ${shellClass}">
          <div style="position:absolute;inset:0;display:flex;justify-content:flex-end"><button>Edit</button><button>Delete</button></div>
          <button data-card="${index}" type="button" data-mobile-press-feedback="${feedback}" class="yuri-mobile-assistant-card relative z-10" style="transform:translate3d(0,0,0)">
            <span class="yuri-mobile-assistant-avatar"></span>
            <span class="yuri-mobile-assistant-card-content min-w-0 flex-1"><span class="yuri-mobile-assistant-name block truncate">Bot ${index}</span><span class="yuri-mobile-assistant-summary ${ASSISTANT_MESSAGE_PREVIEW_CLASS}">Latest message</span></span>
          </button>
        </div>`).join('')}</div>
    </main></body></html>`);
  const session = await openChromeSession({ width: 375, height: 812 });
  try {
    const page = await openPageSession(session, { width: 375, height: 812, standalone: false });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await page.navigateFile(htmlPath);
    const measure = () => page.evaluate<{ width: number; height: number; overflowX: string; overflowY: string; scale: string; nestedScroll: number; pageHeight: number }>(`(() => {
      const card = document.querySelector('[data-card="0"]'), shell = card.parentElement, style = getComputedStyle(shell), rect = card.getBoundingClientRect();
      shell.scrollTop = 16;
      return { width: rect.width, height: rect.height, overflowX: style.overflowX, overflowY: style.overflowY, scale: getComputedStyle(card).scale, nestedScroll: shell.scrollTop, pageHeight: document.querySelector('main').scrollHeight };
    })()`);
    const initial = await measure();
    await page.send('DOM.enable');
    await page.send('CSS.enable');
    const { root: documentNode } = await page.send('DOM.getDocument');
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: (documentNode as { nodeId: number }).nodeId, selector: '[data-card="0"]' });
    await page.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['active', 'hover'] });
    await page.evaluate(`new Promise(resolve => { let frames = 0; function next() { if (++frames === 12) resolve(); else requestAnimationFrame(next); } requestAnimationFrame(next); })`);
    const pressed = await measure();
    expect(pressed.width).toBeGreaterThan(initial.width);
    expect(pressed.height).toBeGreaterThan(initial.height);
    expect(Number(pressed.scale)).toBeGreaterThan(1);
    expect(pressed.overflowX).toBe('clip');
    expect(pressed.overflowY).toBe('clip');
    expect(pressed.nestedScroll).toBe(0);
    expect(pressed.pageHeight).toBe(initial.pageHeight);
    await page.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    await page.evaluate(`document.querySelector('[data-card="0"]').style.transform = 'translate3d(-72px,0,0)'`);
    await page.evaluate(`new Promise(resolve => { let frames = 0; function next() { if (++frames === 24) resolve(); else requestAnimationFrame(next); } requestAnimationFrame(next); })`);
    const swiped = await measure();
    expect(swiped.width).toBe(initial.width);
    expect(swiped.overflowY).toBe('clip');
    expect(swiped.nestedScroll).toBe(0);
    expect(await page.evaluate(`(() => { const catalog = document.querySelector('.yuri-mobile-assistant-catalog'); for (let i = 0; i < 20; i++) catalog.append(catalog.lastElementChild.cloneNode(true)); const main = document.querySelector('main'); main.scrollTop = 100; return main.scrollTop; })()`)).toBeGreaterThan(0);
  } finally {
    await session.close();
    if (!keepEvidence()) rmSync(root, { recursive: true, force: true });
  }
}, 180_000);

test.skipIf(!resolveChrome())('assistant previews truncate long Chinese and English to one line at 375px', async () => {
  const root = evidenceRoot();
  const css = await compileProductionCssAsync(join(dirname(fileURLToPath(import.meta.url)), '../..'));
  const htmlPath = join(root, 'assistant-preview.html');
  const texts = ['最新消息内容预览'.repeat(60), 'UnbrokenEnglishMessage'.repeat(24)];
  // Geometry fixture uses the production list classes and actual shared preview class.
  writeFileSync(htmlPath, `<!doctype html><html class="mobile-pointer"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><main class="w-full min-w-0 p-4">${texts.map((text) => `
    <div class="yuri-mobile-floating-surface yuri-mobile-assistant-card-shell">
      <button type="button" class="yuri-mobile-assistant-card">
        <span class="size-10 shrink-0" aria-hidden="true"></span>
        <span class="yuri-mobile-assistant-card-content min-w-0 flex-1">
          <span class="yuri-mobile-assistant-name block truncate">Assistant</span>
          <span data-preview class="yuri-mobile-assistant-summary ${ASSISTANT_MESSAGE_PREVIEW_CLASS}">${text}</span>
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
      expect(measure.height).toBeCloseTo(measure.lineHeight, 0);
      expect(measure.scrollWidth).toBeGreaterThan(measure.width);
    }
    expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(375);
    expect(await page.evaluate<boolean>(`Array.from(document.querySelectorAll('[data-preview]')).every(el => getComputedStyle(el).textOverflow === 'ellipsis' && getComputedStyle(el).whiteSpace === 'nowrap')`)).toBe(true);
    expect(await page.evaluate<boolean>(`Array.from(document.querySelectorAll('[data-preview]')).every(el => ['clip', 'hidden'].includes(getComputedStyle(el).overflowX) && el.getBoundingClientRect().right <= 375)`)).toBe(true);
    expect(await page.evaluate<boolean>(`(() => { const button = document.querySelector('button'); button.focus(); return document.activeElement === button; })()`)).toBe(true);
    await page.screenshotPng(join(root, 'assistant-preview-375.png'));
    console.info('Assistant preview Chrome evidence', { width: 375, measures, root });
  } finally {
    await session.close();
    if (!keepEvidence()) rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
