import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

import {
  compileProductionCssAsync,
  evidenceRoot,
  openChromeSession,
  openPageSession,
  resolveChrome,
} from '@/components/ui/chromeCdpHarness';

test.skipIf(!resolveChrome())('bundled QR scanner stays transparent above the native camera and restores both themes on exit', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const css = await compileProductionCssAsync(join(here, '..'));
  const work = mkdtempSync(join(evidenceRoot(), 'qr-scanner-backdrop-'));
  const browser = await openChromeSession({ width: 390, height: 844 });
  try {
    const file = join(work, 'index.html');
    writeFileSync(file, `<!doctype html>
      <html class="device-mobile mobile-pointer yuri-capacitor-app yuri-platform-android">
      <head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
      <body><div id="root">Connection screen</div><button class="yuri-barcode-scanner-chrome">×</button></body>
      </html>`);
    const page = await openPageSession(browser, { width: 390, height: 844, standalone: false });
    await page.navigateFile(file);

    const samples = await page.evaluate<Array<{
      theme: string;
      phase: string;
      html: string;
      body: string;
      content: string;
      cancel: string;
    }>>(`(() => {
      const samples = [];
      const root = document.documentElement;
      for (const [theme, color] of [['light', '#ffffff'], ['dark', '#171515']]) {
        root.style.setProperty('--background', color, 'important');
        root.style.colorScheme = theme;
        for (const phase of ['before', 'scanning', 'after']) {
          root.classList.toggle('yuri-barcode-scanner-active', phase === 'scanning');
          samples.push({
            theme, phase,
            html: getComputedStyle(root).backgroundColor,
            body: getComputedStyle(document.body).backgroundColor,
            content: getComputedStyle(document.getElementById('root')).visibility,
            cancel: getComputedStyle(document.querySelector('button')).visibility,
          });
        }
      }
      return samples;
    })()`);

    expect(samples).toHaveLength(6);
    for (const sample of samples) {
      const scanning = sample.phase === 'scanning';
      const background = scanning ? 'rgba(0, 0, 0, 0)'
        : sample.theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(23, 21, 21)';
      expect(sample.html, `${sample.theme}/${sample.phase} document canvas`).toBe(background);
      expect(sample.body, `${sample.theme}/${sample.phase} body`).toBe(background);
      expect(sample.content).toBe(scanning ? 'hidden' : 'visible');
      expect(sample.cancel).toBe('visible');
    }
  } finally {
    await browser.close();
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);
