import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';

import { getMobileWindowMotionSurfaceLayout } from '@/components/ui/MobileWindowMotionRecipe';
import {
  compileProductionCssAsync,
  evidenceRoot,
  isNearColor,
  keepEvidence,
  openChromeSession,
  openPageSession,
  resolveChrome,
  type RgbSample,
} from '@/components/ui/chromeCdpHarness';

/**
 * Production-linked layout harness:
 * - Compiles real packages/ui/src/index.css (Tailwind + mobile.css)
 * - Emulates display-mode:standalone via CDP (production body::after lives there)
 * - Device metrics 390x844 — no synthetic body::after, no pad/hide CSS overrides
 * - Asserts real bottom pixels + pseudo opacity + gap at sheetBottom-2
 */

const here = dirname(fileURLToPath(import.meta.url));
const uiSrc = join(here, '..');
const filesSurfaceSource = readFileSync(join(here, 'MobileFilesSurface.tsx'), 'utf-8');
const mobileCssSource = readFileSync(join(uiSrc, 'styles/mobile.css'), 'utf-8');

const DARK_IFRAME = { r: 11, g: 61, b: 11 }; // #0b3d0b
const LIGHT_SHELL = { r: 248, g: 247, b: 243 }; // #f8f7f3
const WHITE = { r: 255, g: 255, b: 255 };

const chromeAvailable = Boolean(resolveChrome());

const buildFixtureHtml = (opts: {
  mode: 'preview' | 'source' | 'inert-preview' | 'default-sheet';
  compiledCss: string;
  surfaceClass: string;
  bodyClass: string;
  viewerClass: string;
  safePadPx: number;
}): string => {
  const previewMarker = opts.mode === 'preview' || opts.mode === 'inert-preview'
    ? ' data-mobile-html-preview="true"'
    : '';
  const overlayActive = opts.mode === 'inert-preview' ? 'false' : 'true';
  const inertAttr = opts.mode === 'inert-preview' ? ' inert=""' : '';
  const viewerInner = opts.mode === 'source'
    ? `<div data-testid="source-body" style="flex:1;min-height:0;background:#0b3d0b;color:#fff;overflow:auto">source mode content</div>`
    : `<div class="min-h-0 flex-1 overflow-hidden bg-background">
         <div class="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
           <iframe
             data-testid="html-iframe"
             class="h-full min-h-0 w-full flex-1 border-none"
             style="background:#0b3d0b;display:block;width:100%;height:100%;border:0"
             srcdoc="<!doctype html><html><body style='margin:0;background:#0b3d0b;min-height:200vh'></body></html>"
           ></iframe>
         </div>
       </div>`;

  return `<!doctype html>
<html class="device-mobile oc-capacitor-app mobile-pointer" style="color-scheme: light;">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <style>
${opts.compiledCss}
  </style>
  <style>
    /* Tokens only — no pad/hide/body::after overrides of production rules. */
    :root {
      --background: #f8f7f3;
      --oc-app-bottom-safe: ${opts.safePadPx}px;
      --oc-safe-area-bottom: ${opts.safePadPx}px;
      --safe-area-inset-bottom: ${opts.safePadPx}px;
      --oc-safe-area-bottom-visual: ${opts.safePadPx}px;
    }
    html, body { margin: 0; width: 100%; height: 100%; background: #111; }
    /* Open bottom sheet fills the emulated mobile viewport. */
    [data-oc-motion-id] {
      position: fixed !important;
      left: 0; right: 0; bottom: 0; top: auto;
      height: 720px;
      max-height: 720px;
      width: 100%;
      max-width: none;
      margin: 0;
      display: flex;
      flex-direction: column;
      min-height: 0;
      background: var(--background);
    }

  </style>
</head>
<body>
  <div
    class="oc-mobile-window-motion oc-mobile-window-motion-active"
    data-mobile-overlay-active="${overlayActive}"
    role="dialog"${inertAttr}
  >
    <div class="${opts.surfaceClass}" data-oc-motion-id="mobile-direct-file" data-testid="sheet">
      <div class="flex min-h-0 flex-1 flex-col">
        <div class="${opts.bodyClass}" data-page-scroll-lock="true" data-testid="sheet-body">
          <div class="flex h-full min-h-0 flex-col overflow-hidden bg-background">
            <div class="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
              <div class="${opts.viewerClass}" data-testid="html-viewer"${previewMarker}>
                ${viewerInner}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
};

const measureScript = `(() => {
  const sheet = document.querySelector('[data-oc-motion-id]');
  const body = document.querySelector('[data-testid="sheet-body"]');
  const iframe = document.querySelector('[data-testid="html-iframe"]');
  const viewer = document.querySelector('[data-testid="html-viewer"]');
  const sheetRect = sheet.getBoundingClientRect();
  const bodyRect = body.getBoundingClientRect();
  const iframeRect = iframe ? iframe.getBoundingClientRect() : null;
  const viewerRect = viewer.getBoundingClientRect();
  const cs = getComputedStyle(sheet);
  const visibleIframeBottom = iframeRect
    ? Math.min(iframeRect.bottom, bodyRect.bottom, viewerRect.bottom)
    : bodyRect.bottom;
  // Physical sheet / viewport bottom — do NOT retreat to bodyBottom.
  const probeY = Math.floor(sheetRect.bottom - 2);
  const probeX = Math.floor((sheetRect.left + sheetRect.right) / 2);
  const inViewport = probeX >= 0 && probeY >= 0
    && probeX < window.innerWidth && probeY < window.innerHeight;
  const hits = inViewport && typeof document.elementsFromPoint === 'function'
    ? document.elementsFromPoint(probeX, probeY)
    : [];
  const afterOpacity = getComputedStyle(document.body, '::after').opacity;
  const afterHeight = getComputedStyle(document.body, '::after').height;
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    sheetBottom: sheetRect.bottom,
    bodyBottom: bodyRect.bottom,
    iframeBottom: iframeRect ? iframeRect.bottom : null,
    visibleIframeBottom,
    gapSheetMinusIframe: +(sheetRect.bottom - visibleIframeBottom).toFixed(2),
    gapSheetMinusBody: +(sheetRect.bottom - bodyRect.bottom).toFixed(2),
    sheetPaddingBottom: parseFloat(cs.paddingBottom) || 0,
    probeX,
    probeY,
    inViewport,
    probeTags: hits.map((el) => el.tagName),
    probeTestIds: hits.map((el) => el.getAttribute && el.getAttribute('data-testid')).filter(Boolean),
    afterOpacity,
    afterHeight,
    hasPreviewMarker: viewer.hasAttribute('data-mobile-html-preview'),
    displayModeStandalone: matchMedia('(display-mode: standalone)').matches,
    surfaceClassName: sheet.className,
    hasPwaOverlayPanel: sheet.classList.contains('pwa-overlay-panel'),
    appBottomSafe: getComputedStyle(document.documentElement).getPropertyValue('--oc-app-bottom-safe').trim(),
  };
})()`;

type Measure = {
  innerWidth: number;
  innerHeight: number;
  sheetBottom: number;
  bodyBottom: number;
  iframeBottom: number | null;
  visibleIframeBottom: number;
  gapSheetMinusIframe: number;
  gapSheetMinusBody: number;
  sheetPaddingBottom: number;
  probeX: number;
  probeY: number;
  inViewport: boolean;
  probeTags: string[];
  probeTestIds: string[];
  afterOpacity: string;
  afterHeight: string;
  hasPreviewMarker: boolean;
  displayModeStandalone: boolean;
  surfaceClassName: string;
  hasPwaOverlayPanel: boolean;
  appBottomSafe: string;
};

const evidenceDirs: string[] = [];
afterAll(() => {
  if (keepEvidence()) return;
  for (const dir of evidenceDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('MobileFilesSurface HTML preview production layout', () => {
  test('source contracts: markers, no negative margin, structural body::after hide', () => {
    expect(filesSurfaceSource).toContain('data-mobile-html-preview');
    expect(filesSurfaceSource).toContain('data-mobile-html-fullscreen');
    expect(filesSurfaceSource).not.toContain('oc-html-file-preview-open');
    expect(filesSurfaceSource).not.toMatch(/mb-\[calc\(-1\*max\(0\.5rem/);
    expect(mobileCssSource).toContain('[data-oc-motion-id]:has([data-mobile-html-preview="true"])');
    expect(mobileCssSource).toContain('[data-mobile-overlay-active="true"]:not([inert])');
    expect(mobileCssSource).toContain('@media (display-mode: standalone)');
    expect(mobileCssSource).toMatch(/display-mode:\s*standalone[\s\S]*data-mobile-html-preview/);
  });

  test.skipIf(!chromeAvailable)(
    'CDP standalone + production CSS: preview edge green, source keeps pad, screenshots differ',
    async () => {
      const compiledCssRaw = await compileProductionCssAsync(uiSrc);
      expect(compiledCssRaw.includes('data-mobile-html-preview')).toBe(true);
      // Production body::after + hide live under display-mode:standalone. CDP media
      // feature emulation is unreliable for this query; unwrap ONLY that media
      // wrapper (AST-preserving) so the same production declarations apply.
      expect(
        /@media\s*\(\s*display-mode\s*:\s*standalone\s*\)/.test(compiledCssRaw),
      ).toBe(true);
      const compiledCss = compiledCssRaw.replace(
        /@media\s*\(\s*display-mode\s*:\s*standalone\s*\)\s*\{/g,
        '/* production standalone block unwrapped for harness */\n@media all {',
      );

      const surfaceClass = [
        'oc-mobile-floating-shell',
        getMobileWindowMotionSurfaceLayout('sheet', 'bottom'),
      ].join(' ');
      const bodyClass = 'flex min-h-0 flex-1 flex-col overflow-hidden';
      const viewerClass = 'flex min-h-0 flex-1 flex-col overflow-hidden bg-background';
      const safePadPx = 34;
      const root = evidenceRoot();
      evidenceDirs.push(root);

      const session = await openChromeSession({ width: 390, height: 844 });
      try {
        const page = await openPageSession(session, { width: 390, height: 844, standalone: true });

        const runMode = async (mode: 'preview' | 'source' | 'inert-preview') => {
          const dir = mkdtempSync(join(root, `${mode}-`));
          const htmlPath = join(dir, 'fixture.html');
          const shotPath = join(dir, 'fixture.png');
          writeFileSync(htmlPath, buildFixtureHtml({
            mode,
            compiledCss,
            surfaceClass,
            bodyClass,
            viewerClass,
            safePadPx,
          }), 'utf8');
          await page.navigateFile(htmlPath);
          // Allow iframe layout + :has matching.
          await new Promise((r) => setTimeout(r, 200));
          const measure = await page.evaluate<Measure>(measureScript);
          await page.screenshotPng(shotPath);
          const pixels = await page.sampleScreenshotCenterColumn(shotPath, [0, 1, 2, 8, 16, 33, 40]);
          return { measure, shotPath, pixels, dir };
        };

        const preview = await runMode('preview');
        const source = await runMode('source');
        const inert = await runMode('inert-preview');

        // Viewport must match device metrics (no 55px chrome clip).
        expect(preview.measure.innerWidth).toBe(390);
        expect(preview.measure.innerHeight).toBe(844);
        // After standalone unwrap, matchMedia may still report browser; paint rules apply.
        expect(preview.measure.inViewport).toBe(true);
        expect(preview.measure.probeY).toBe(Math.floor(preview.measure.sheetBottom - 2));

        // Preview: zero pad, iframe reaches sheet bottom, ::after hidden, bottom pixels dark green.
        expect(preview.measure.hasPreviewMarker).toBe(true);
        expect(preview.measure.sheetPaddingBottom).toBeLessThanOrEqual(1);
        expect(
          preview.measure.gapSheetMinusIframe,
          `preview gap=${preview.measure.gapSheetMinusIframe} shot=${preview.shotPath}`,
        ).toBeLessThanOrEqual(2);
        expect(Number.parseFloat(preview.measure.afterOpacity)).toBe(0);
        expect(
          preview.measure.probeTags.includes('IFRAME')
            || preview.measure.probeTestIds.includes('html-iframe'),
          `probe tags=${JSON.stringify(preview.measure.probeTags)} ids=${JSON.stringify(preview.measure.probeTestIds)}`,
        ).toBe(true);
        const previewBottom = preview.pixels.filter((p: RgbSample) => p.y >= preview.measure.sheetBottom - 4);
        expect(previewBottom.length).toBeGreaterThan(0);
        for (const sample of previewBottom) {
          expect(
            isNearColor(sample, DARK_IFRAME) && !isNearColor(sample, WHITE, 10),
            `preview pixel y=${sample.y} rgb=(${sample.r},${sample.g},${sample.b}) shot=${preview.shotPath}`,
          ).toBe(true);
        }

        // Source: keeps safe pad; bottom pixels are shell/overlay — not edge-to-edge dark iframe.
        expect(source.measure.hasPreviewMarker).toBe(false);
        expect(source.measure.hasPwaOverlayPanel).toBe(true);
        expect(source.measure.appBottomSafe).toContain('34');
        // Source must reserve a real bottom band (production recipe/capacitor pad).
        // Preview zeros it; source/inert must keep a strictly larger pad.
        expect(
          source.measure.sheetPaddingBottom,
          `source pad=${source.measure.sheetPaddingBottom} class=${source.measure.surfaceClassName}`,
        ).toBeGreaterThanOrEqual(8);
        expect(source.measure.gapSheetMinusBody).toBeGreaterThanOrEqual(8);
        expect(Number.parseFloat(source.measure.afterOpacity)).toBeGreaterThan(0.5);
        const sourceBottom = source.pixels.filter((p: RgbSample) => p.y >= source.measure.sheetBottom - 4);
        expect(sourceBottom.length).toBeGreaterThan(0);
        const sourceIsNotFullGreen = sourceBottom.some(
          (sample: RgbSample) => isNearColor(sample, WHITE, 20) || isNearColor(sample, LIGHT_SHELL, 20),
        );
        expect(
          sourceIsNotFullGreen,
          `source bottom must show pad/overlay not full green; samples=${JSON.stringify(sourceBottom)} shot=${source.shotPath}`,
        ).toBe(true);

        // Screenshots must visibly differ at the bottom band.
        const previewY843 = preview.pixels.find((p: RgbSample) => p.y >= 840);
        const sourceY843 = source.pixels.find((p: RgbSample) => p.y >= 840);
        expect(previewY843 && sourceY843).toBeTruthy();
        if (previewY843 && sourceY843) {
          const differs = Math.abs(previewY843.r - sourceY843.r) > 20
            || Math.abs(previewY843.g - sourceY843.g) > 20
            || Math.abs(previewY843.b - sourceY843.b) > 20;
          expect(differs, `preview=${JSON.stringify(previewY843)} source=${JSON.stringify(sourceY843)}`).toBe(true);
        }

        // Inert overlay with preview marker must NOT zero pad / hide ::after.
        expect(inert.measure.hasPreviewMarker).toBe(true);
        expect(inert.measure.sheetPaddingBottom).toBeGreaterThanOrEqual(8);
        expect(Number.parseFloat(inert.measure.afterOpacity)).toBeGreaterThan(0.5);
        // Preview zeroed pad; inert/source must keep a larger pad than preview.
        expect(inert.measure.sheetPaddingBottom).toBeGreaterThan(preview.measure.sheetPaddingBottom + 4);
        expect(source.measure.sheetPaddingBottom).toBeGreaterThan(preview.measure.sheetPaddingBottom + 4);

        // Report absolute evidence paths for parent inspection.
        console.info('[html-preview-layout evidence]', {
          previewShot: preview.shotPath,
          sourceShot: source.shotPath,
          inertShot: inert.shotPath,
          previewMeasure: preview.measure,
          sourceMeasure: {
            sheetPaddingBottom: source.measure.sheetPaddingBottom,
            gapSheetMinusBody: source.measure.gapSheetMinusBody,
            afterOpacity: source.measure.afterOpacity,
          },
          previewPixels: preview.pixels,
          sourcePixels: source.pixels,
        });
      } finally {
        await session.close();
      }
    },
    180_000,
  );
});
