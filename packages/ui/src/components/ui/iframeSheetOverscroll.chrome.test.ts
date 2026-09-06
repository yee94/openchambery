/**
 * Real Chrome iframe-realm event tests for attachIframeSheetOverscroll.
 * Bundles production module via esbuild; dispatches TouchEvents inside iframe document.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';

import {
  bundleUiModule,
  evidenceRoot,
  keepEvidence,
  openChromeSession,
  openPageSession,
  resolveChrome,
} from './chromeCdpHarness';

const here = dirname(fileURLToPath(import.meta.url));
const uiSrc = join(here, '../..');
const chromeAvailable = Boolean(resolveChrome());
const evidenceDirs: string[] = [];

afterAll(() => {
  if (keepEvidence()) return;
  for (const dir of evidenceDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('iframeSheetOverscroll Chrome iframe realm', () => {
  test.skipIf(!chromeAvailable)(
    'screen coords stay monotonic under surface transform; form/nested block; one begin/finish',
    async () => {
      const root = evidenceRoot();
      evidenceDirs.push(root);
      const work = mkdtempSync(join(root, 'overscroll-chrome-'));
      const htmlPath = join(work, 'harness.html');

      // Dedicated browser entry wires registry + attach inside the real Chrome iframe realm.
      const testEntry = join(work, 'browser-entry.ts');
      writeFileSync(testEntry, `
import {
  attachIframeSheetOverscroll,
  MOBILE_WINDOW_MOTION_ID_ATTR,
} from ${JSON.stringify(join(here, 'iframeSheetOverscroll.ts'))};
import { registerMobileWindowMotionController } from ${JSON.stringify(join(here, 'MobileWindowMotionRegistry.ts'))};

async function runHarness() {
  const surface = document.querySelector('[' + MOBILE_WINDOW_MOTION_ID_ATTR + ']') as HTMLElement;
  const iframe = document.querySelector('iframe') as HTMLIFrameElement;
  await new Promise<void>((resolve) => {
    if (iframe.contentDocument?.readyState === 'complete') resolve();
    else iframe.addEventListener('load', () => resolve(), { once: true });
  });
  await new Promise((r) => setTimeout(r, 40));
  const doc = iframe.contentDocument!;
  const begins: string[] = [];
  const finishes: string[] = [];
  const progress: number[] = [];
  let geometryReads = 0;
  let countGeometry = false;
  const surfaceHeight = surface.getBoundingClientRect().height || 640;
  const originalGbr = surface.getBoundingClientRect.bind(surface);
  // Count production geometry reads only. Do NOT re-add translateY — CSS transform
  // already shifts the real layout box returned by the browser.
  surface.getBoundingClientRect = () => {
    if (countGeometry) geometryReads += 1;
    return originalGbr();
  };

  const unregister = registerMobileWindowMotionController('chrome-overscroll', {
    begin: (op) => { begins.push(op); return true; },
    update: (p) => {
      progress.push(p);
      surface.style.transform = 'translate3d(0,' + (p * 100) + '%,0)';
    },
    finish: (f) => { finishes.push(f); },
    interrupt: () => undefined,
  });

  const detach = attachIframeSheetOverscroll(iframe);

  const dispatch = (
    type: string,
    opts: { clientX: number; clientY: number; screenX: number; screenY: number; timeStamp: number; target?: Element; touchesCount?: number },
  ) => {
    const target = opts.target ?? doc.documentElement;
    const t = new Touch({
      identifier: 1,
      target,
      clientX: opts.clientX,
      clientY: opts.clientY,
      screenX: opts.screenX,
      screenY: opts.screenY,
      pageX: opts.clientX,
      pageY: opts.clientY,
    });
    const extras: Touch[] = [];
    if ((opts.touchesCount ?? 1) > 1 && type !== 'touchend') {
      extras.push(new Touch({
        identifier: 2, target,
        clientX: opts.clientX + 8, clientY: opts.clientY + 8,
        screenX: opts.screenX + 8, screenY: opts.screenY + 8,
        pageX: opts.clientX + 8, pageY: opts.clientY + 8,
      }));
    }
    const active = type === 'touchend' || type === 'touchcancel' ? [] : [t, ...extras];
    const ev = new TouchEvent(type, {
      bubbles: true, cancelable: true,
      touches: active, targetTouches: active, changedTouches: [t],
    });
    Object.defineProperty(ev, 'timeStamp', { value: opts.timeStamp });
    target.dispatchEvent(ev);
    return ev;
  };

  // Client coords from the real iframe box (outside production geometry counting).
  const toClientY = (screenY: number) => {
    countGeometry = false;
    const top = iframe.getBoundingClientRect().top;
    countGeometry = true;
    return screenY - top;
  };

  // --- form field must not begin
  const field = doc.getElementById('field')!;
  let t = 1000;
  countGeometry = true;
  dispatch('touchstart', { clientX: 10, clientY: 10, screenX: 10, screenY: 10, timeStamp: t, target: field });
  t += 16;
  dispatch('touchmove', { clientX: 10, clientY: 80, screenX: 10, screenY: 80, timeStamp: t, target: field });
  const beginsAfterForm = begins.length;

  // --- nested scroller not at top must not begin
  const nest = doc.getElementById('nest') as HTMLElement;
  nest.scrollTop = 40;
  const nestChild = nest.firstElementChild as HTMLElement;
  t = 2000;
  dispatch('touchstart', { clientX: 20, clientY: 20, screenX: 20, screenY: 20, timeStamp: t, target: nestChild });
  t += 16;
  dispatch('touchmove', { clientX: 20, clientY: 100, screenX: 20, screenY: 100, timeStamp: t, target: nestChild });
  const beginsAfterNest = begins.length;
  nest.scrollTop = 0;

  // --- main pad drag with independent screen vs client (surface moves)
  const pad = doc.getElementById('pad')!;
  const screenPath = [180, 200, 240, 300, 380, 480];
  t = 3000;
  geometryReads = 0;
  countGeometry = true;
  const prevented: boolean[] = [];
  for (let i = 0; i < screenPath.length; i++) {
    const screenY = screenPath[i]!;
    const clientY = toClientY(screenY);
    const ev = dispatch(i === 0 ? 'touchstart' : 'touchmove', {
      clientX: 40, clientY, screenX: 120, screenY, timeStamp: t, target: pad,
    });
    if (i > 0) prevented.push(ev.defaultPrevented);
    t += 16;
  }
  // hold fixed screen — progress must stay exactly steady
  const holdY = screenPath[screenPath.length - 1]!;
  const progressAtHold = progress[progress.length - 1] ?? 0;
  const holdSamples: number[] = [];
  for (let i = 0; i < 5; i++) {
    dispatch('touchmove', {
      clientX: 40, clientY: toClientY(holdY), screenX: 120, screenY: holdY, timeStamp: t, target: pad,
    });
    holdSamples.push(progress[progress.length - 1] ?? -1);
    t += 16;
  }
  dispatch('touchend', {
    clientX: 40, clientY: toClientY(holdY), screenX: 120, screenY: holdY, timeStamp: t, target: pad,
  });
  countGeometry = false;

  const mono = progress.every((p, i) => i === 0 || p >= progress[i - 1]! - 1e-9);
  const holdSteady = holdSamples.every((p) => Math.abs(p - progressAtHold) < 1e-9);
  const outerTravel = holdY - screenPath[0]!;
  const finalProgress = progress[progress.length - 1] ?? 0;

  detach();
  unregister();

  return {
    beginsAfterForm,
    beginsAfterNest,
    begins,
    finishes,
    progress,
    mono,
    holdSteady,
    holdSamples,
    progressAtHold,
    preventedAfterArm: prevented,
    finalProgress,
    expectedMinProgress: outerTravel / surfaceHeight * 0.9,
    geometryReadsDuringDrag: geometryReads,
    styleLeft: Boolean(doc.querySelector('style[data-oc-sheet-overscroll]')),
  };
}

(window as unknown as { OcIframeOverscroll: { runHarness: typeof runHarness } }).OcIframeOverscroll = { runHarness };
`, 'utf8');

      const bundleEntry = join(work, 'browser-entry.iife.js');
      await bundleUiModule(testEntry, bundleEntry, uiSrc);

      writeFileSync(htmlPath, `<!doctype html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="margin:0;background:#111">
  <div data-oc-motion-id="chrome-overscroll" id="surface"
    style="position:fixed;left:0;right:0;bottom:0;height:640px;display:flex;flex-direction:column;background:#222">
    <iframe id="frame" style="flex:1;border:0;width:100%;background:#0b3d0b"
      srcdoc="<!doctype html><html><body style='margin:0;height:2400px;background:#0b3d0b'>
        <div id='nest' style='height:120px;overflow:auto'><div style='height:800px'>nested</div></div>
        <input id='field' />
        <div id='pad' style='height:400px'>pad</div>
      </body></html>"></iframe>
  </div>
  <script src="./browser-entry.iife.js"></script>
  <script>
    window.__done = false;
    window.__out = null;
    window.__err = null;
    (async () => {
      try {
        const api = window.OcIframeOverscroll;
        if (!api || typeof api.runHarness !== 'function') {
          throw new Error('OcIframeOverscroll.runHarness missing keys=' + Object.keys(window).filter(k => /oc|iframe/i.test(k)).join(','));
        }
        window.__out = await api.runHarness();
      } catch (e) {
        window.__err = String(e && e.stack || e);
      }
      window.__done = true;
    })();
  </script>
</body>
</html>`, 'utf8');

      const session = await openChromeSession({ width: 390, height: 844 });
      try {
        const page = await openPageSession(session, { width: 390, height: 844, standalone: false });
        await page.navigateFile(htmlPath);
        let out: Record<string, unknown> | null = null;
        let err: string | null = null;
        for (let i = 0; i < 80; i++) {
          const state = await page.evaluate<{ done: boolean; out: Record<string, unknown> | null; err: string | null }>(
            `({ done: window.__done === true, out: window.__out, err: window.__err })`,
          );
          if (state.done) {
            out = state.out;
            err = state.err;
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(err, `browser harness error: ${err}`).toBeNull();
        expect(out).toBeTruthy();
        const result = out!;

        expect(result.beginsAfterForm).toBe(0);
        expect(result.beginsAfterNest).toBe(0);
        expect(result.begins).toEqual(['dismiss']);
        expect(result.finishes).toEqual(['commit']);
        expect(result.mono).toBe(true);
        expect(result.holdSteady).toBe(true);
        expect(result.holdSamples).toEqual(
          Array.from({ length: 5 }, () => result.progressAtHold),
        );
        expect(Number(result.finalProgress)).toBeGreaterThanOrEqual(Number(result.expectedMinProgress));
        // Accepted move frames must preventDefault.
        const prevented = result.preventedAfterArm as boolean[];
        expect(prevented.length).toBeGreaterThan(0);
        expect(prevented.every(Boolean)).toBe(true);
        // Start-only geometry: at most one read at gesture start.
        expect(Number(result.geometryReadsDuringDrag)).toBeLessThanOrEqual(1);
        expect(result.styleLeft).toBe(false);

        console.info('[iframe-overscroll chrome evidence]', {
          work,
          progress: result.progress,
          begins: result.begins,
          finishes: result.finishes,
          geometryReadsDuringDrag: result.geometryReadsDuringDrag,
        });
      } finally {
        await session.close();
      }
    },
    180_000,
  );
});
