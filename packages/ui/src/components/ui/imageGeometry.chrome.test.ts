import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { evidenceRoot, openChromeSession, openPageSession, resolveChrome } from './chromeCdpHarness';

test.skipIf(!resolveChrome()).each([1500, 500, 3000])('content images stay inside their fixed frame with lazy Markdown theme overrides (width=%s)', async (width) => {
  const here = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(join(here, 'image-loading.css'), 'utf8');
  const theme = readFileSync(join(here, '../chat/markstream/markstreamTheme.css'), 'utf8')
    .replace(/^@import .*;$/gm, '');
  const work = mkdtempSync(join(evidenceRoot(), 'image-geometry-'));
  const file = join(work, 'index.html');
  const src = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="1000"/>`)}`;
  writeFileSync(file, `<style>${css}</style><style>${theme}</style>
    <div class="oc-markstream-host"><div class="markstream-react" style="width:269px">
    <span class="oc-image-frame" data-image-content="mobile" data-image-state="loading"><img src="${src}"></span>
    <span data-md-image-presentation="true" data-mobile-image="true" style="display:block"><img src="${src}" data-md-image-state="loading"></span>
    <p id="next">Next message</p></div></div>`);
  const browser = await openChromeSession({ width: 390, height: 844 });
  try {
    const page = await openPageSession(browser, { width: 390, height: 844, standalone: false });
    await page.navigateFile(file);
    const measurements = await page.evaluate<Array<{ phase: string; width: number; imageWidth: number; frame: number; image: number; overflow: number; next: number }>>(`(async () => {
      await Promise.all([...document.images].map(i => i.decode()));
      const result = [];
      for (const phase of ['loading', 'loaded', 'error']) {
        document.querySelector('.oc-image-frame').dataset.imageState = phase;
        document.querySelector('[data-md-image-presentation] img').dataset.mdImageState = phase;
        for (const frame of document.querySelectorAll('.oc-image-frame, [data-md-image-presentation]')) {
          const f = frame.getBoundingClientRect(), i = frame.querySelector('img').getBoundingClientRect();
          result.push({ phase, width: f.width, imageWidth: i.width, frame: f.height, image: i.height, overflow: i.bottom - f.bottom, next: document.querySelector('#next').getBoundingClientRect().top });
        }
      }
      return result;
    })()`);
    expect(measurements).toHaveLength(6);
    for (const sample of measurements) {
      expect(sample.frame).toBe(160);
      expect(sample.image).toBeGreaterThan(0);
      expect(sample.image).toBeLessThanOrEqual(160);
      expect(sample.overflow).toBeLessThanOrEqual(0);
      expect(sample.next).toBe(measurements[0].next);
      if (sample.phase === 'loaded') {
        expect(sample.width).toBeCloseTo(Math.min(269, width / 1000 * 160), 0);
        expect(sample.imageWidth).toBeCloseTo(sample.width, 0);
      }
    }
  } finally {
    await browser.close();
    rmSync(work, { recursive: true, force: true });
  }
}, 60_000);
