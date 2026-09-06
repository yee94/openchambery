import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { build } from 'vite';

import {
  compileProductionCssAsync,
  evidenceRoot,
  keepEvidence,
  openChromeSession,
  openPageSession,
  resolveChrome,
} from '../ui/chromeCdpHarness';

type PaintSample = {
  phase: string;
  frame: number;
  userPresent: boolean;
  userTop: number | null;
  userHeight: number | null;
  userVisibility: string | null;
  headerPresent: boolean;
  headerTop: number | null;
  headerHeight: number | null;
  headerVisibility: string | null;
  scrollerPresent: boolean;
  scrollerTop: number | null;
  scrollerHeight: number | null;
  composerPresent: boolean;
  composerTop: number | null;
  composerHeight: number | null;
  composerVisibility: string | null;
  loadingPlaceholder: boolean;
  pinReveal: string | null;
};
type ClaimTiming = 'fast' | 'slow';

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

const closeEnough = (left: number | null, right: number | null, tolerance = 0.5) => (
  left !== null && right !== null && Math.abs(left - right) <= tolerance
);

describe('draft transcript handoff Chrome continuity', () => {
  test.skipIf(!chromeAvailable)(
    'keeps the committed user turn visible through fast and slow claims at the real ChatContainer seam',
    async () => {
      const evidence = evidenceRoot();
      evidenceDirs.push(evidence);
      const work = mkdtempSync(join(evidence, 'draft-handoff-chrome-'));
      const htmlPath = join(work, 'harness.html');
      const css = await compileProductionCssAsync(uiSrc);
      const bodyFixture = join(here, 'draftTranscriptHandoff.chrome.body.fixture.tsx');
      const inputFixture = join(here, 'draftTranscriptHandoff.chrome.input.fixture.tsx');
      const timelineFixture = join(here, 'draftTranscriptHandoff.chrome.timeline.fixture.tsx');
      const syncFixture = join(here, 'draftTranscriptHandoff.chrome.sync.fixture.ts');
      const useSyncFixture = join(here, 'draftTranscriptHandoff.chrome.use-sync.fixture.ts');

      await build({
        configFile: false,
        mode: 'production',
        root: join(uiSrc, '..'),
        publicDir: false,
        esbuild: { jsxDev: false },
        resolve: {
          alias: [
            { find: /^\.\/message\/(MessageBody|ToolOutputDialog)$/, replacement: bodyFixture },
            { find: /^\.\/ChatInput$/, replacement: inputFixture },
            { find: /^\.\/TimelineDialog$/, replacement: timelineFixture },
            { find: '@/sync/sync-context', replacement: syncFixture },
            { find: '@/sync/use-sync', replacement: useSyncFixture },
            { find: '@', replacement: uiSrc },
          ],
        },
        build: {
          emptyOutDir: false,
          minify: false,
          outDir: work,
          lib: {
            entry: join(here, 'draftTranscriptHandoff.chrome.fixture.tsx'),
            formats: ['iife'],
            name: 'DraftTranscriptHandoffChromeFixture',
            fileName: () => 'browser-entry.iife.js',
          },
        },
      });

      const browserBundle = readFileSync(join(work, 'browser-entry.iife.js'), 'utf8');
      writeFileSync(htmlPath, `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>${css}</style>
</head>
<body style="margin:0">
  <div id="root" style="height:844px"></div>
  <script>
    window.process = { env: { NODE_ENV: 'production' } };
    window.global = window;
    window.__draftHandoffHarnessError = null;
    window.addEventListener('error', (event) => {
      window.__draftHandoffHarnessError = String(event.error && event.error.stack || event.message);
    });
    window.addEventListener('unhandledrejection', (event) => {
      window.__draftHandoffHarnessError = String(event.reason && event.reason.stack || event.reason);
    });
  </script>
  <script>${browserBundle}</script>
</body>
</html>`, 'utf8');

      const browser = await openChromeSession({ width: 1024, height: 900 });
      try {
        for (const claimTiming of ['fast', 'slow'] satisfies ClaimTiming[]) {
          for (const width of [1024, 390]) {
            const page = await openPageSession(browser, { width, height: 844, standalone: false });
            await page.navigateFile(htmlPath);
            let ready = false;
            let harnessError: string | null = null;
            for (let attempt = 0; attempt < 100; attempt += 1) {
              const state = await page.evaluate<{ ready: boolean; error: string | null }>(
                `({ ready: Boolean(window.draftHandoffReplay), error: window.__draftHandoffHarnessError })`,
              );
              ready = state.ready;
              harnessError = state.error;
              if (ready || harnessError) break;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            expect(harnessError, `browser harness error: ${harnessError}`).toBeNull();
            expect(ready, 'browser harness API became ready').toBe(true);

            const samples = await page.evaluate<PaintSample[]>(
              `window.draftHandoffReplay.replay(${JSON.stringify(claimTiming)})`,
            );
            const shotPath = join(work, `handoff-${claimTiming}-${width}.png`);
            await page.screenshotPng(shotPath);
            console.info('[draft handoff Chrome evidence]', { claimTiming, width, shotPath, samples });

            const draft = samples[0]!;
            expect(draft.phase).toBe('draft');
            expect(draft.userPresent).toBe(true);
            expect(draft.headerPresent).toBe(true);
            expect(draft.scrollerPresent).toBe(true);
            expect(draft.composerPresent).toBe(true);
            expect(draft.composerVisibility).toBe('hidden');
            expect(draft.userVisibility).toBe('visible');
            expect(draft.headerVisibility).toBe('visible');
            expect(draft.pinReveal).not.toBe('pending');

            for (const frame of samples.slice(1)) {
              const label = `${claimTiming}:${width}:${frame.phase}:${frame.frame}`;
              expect(frame.loadingPlaceholder, `${label} loading placeholder`).toBe(false);
              expect(frame.userPresent, `${label} user`).toBe(true);
              expect(frame.headerPresent, `${label} header`).toBe(true);
              expect(frame.userVisibility, `${label} user visibility`).toBe('visible');
              expect(frame.headerVisibility, `${label} header visibility`).toBe('visible');
              expect(frame.scrollerPresent, `${label} scroller`).toBe(true);
              expect(frame.composerPresent, `${label} composer`).toBe(true);
              expect(closeEnough(frame.userTop, draft.userTop), `${label} user top`).toBe(true);
              expect(closeEnough(frame.userHeight, draft.userHeight), `${label} user height`).toBe(true);
              expect(closeEnough(frame.headerTop, draft.headerTop), `${label} header top`).toBe(true);
              expect(closeEnough(frame.headerHeight, draft.headerHeight), `${label} header height`).toBe(true);
              expect(closeEnough(frame.scrollerTop, draft.scrollerTop), `${label} scroller top`).toBe(true);
              expect(closeEnough(frame.scrollerHeight, draft.scrollerHeight), `${label} scroller height`).toBe(true);
              expect(closeEnough(frame.composerTop, draft.composerTop), `${label} composer top`).toBe(true);
              expect(closeEnough(frame.composerHeight, draft.composerHeight), `${label} composer height`).toBe(true);
            }

            const claimed = samples.filter((frame) => frame.phase === 'claimed');
            expect(claimed).toHaveLength(4);
            expect(claimed[0]?.pinReveal).toBe('ready');
            expect(claimed.every((frame) => frame.pinReveal !== 'pending')).toBe(true);
          }
        }
      } finally {
        await browser.close();
      }
    },
    180_000,
  );
});
