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

type FrameMeasure = {
  label: string;
  userTop: number;
  userHeight: number;
  userNode: number;
  headerTop: number;
  headerHeight: number;
  headerNode: number;
  headerWrapperTop: number;
  headerWrapperHeight: number;
  headerWrapperNode: number;
  bodyTop: number | null;
  bodyHeight: number | null;
  bodyNode: number | null;
  occupiedHeight: number;
  headingText: string;
};

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

const closeEnough = (left: number, right: number, tolerance = 0.5) => (
  Math.abs(left - right) <= tolerance
);

describe('pending assistant header Chrome continuity', () => {
  test.skipIf(!chromeAvailable)(
    'replays MessageList state in real Chrome with production CSS',
    async () => {
      const root = evidenceRoot();
      evidenceDirs.push(root);
      const work = mkdtempSync(join(root, 'pending-header-chrome-'));
      const bundlePath = join(work, 'browser-entry.iife.js');
      const htmlPath = join(work, 'harness.html');
      const css = await compileProductionCssAsync(uiSrc);
      const bodyFixturePath = join(here, 'pendingAssistantHeaderContinuity.chrome.body.fixture.tsx');
      const syncFixturePath = join(here, 'pendingAssistantHeaderContinuity.chrome.sync.fixture.ts');
      // Browser replay keeps production MessageList, TurnItem, ChatMessage,
      // TurnAssistantHeader, and MessageHeader. The body renderer is reduced to
      // deterministic text without completion-only footer content, and
      // MessageList's live-part subscription returns an empty snapshot because
      // this fixture supplies each replay frame directly.
      await build({
        configFile: false,
        mode: 'production',
        root: join(uiSrc, '..'),
        publicDir: false,
        esbuild: { jsxDev: false },
        resolve: {
          alias: [
            { find: /^\.\/message\/(MessageBody|ToolOutputDialog)$/, replacement: bodyFixturePath },
            { find: '@', replacement: uiSrc },
          ],
        },
        plugins: [{
          name: 'pending-header-sync-boundary',
          enforce: 'pre',
          resolveId(source, importer) {
            if (
              importer?.includes('/MessageList.tsx')
              && (source === '@/sync/sync-context' || source.includes('/sync/sync-context'))
            ) {
              return syncFixturePath;
            }
            return null;
          },
        }],
        build: {
          emptyOutDir: false,
          minify: false,
          outDir: work,
          lib: {
            entry: join(here, 'pendingAssistantHeaderContinuity.chrome.fixture.tsx'),
            formats: ['iife'],
            name: 'PendingAssistantHeaderChromeFixture',
            fileName: () => 'browser-entry.iife.js',
          },
        },
      });
      const browserBundle = readFileSync(bundlePath, 'utf8');
      writeFileSync(htmlPath, `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>${css}</style>
</head>
<body>
  <div id="root"></div>
  <script>
    window.process = { env: { NODE_ENV: 'production' } };
    window.global = window;
    window.__pendingHeaderHarnessError = null;
    window.addEventListener('error', (event) => {
      window.__pendingHeaderHarnessError = String(event.error && event.error.stack || event.message);
    });
    window.addEventListener('unhandledrejection', (event) => {
      window.__pendingHeaderHarnessError = String(event.reason && event.reason.stack || event.reason);
    });
  </script>
  <script>${browserBundle}</script>
</body>
</html>`, 'utf8');

      const session = await openChromeSession({ width: 1024, height: 900 });
      try {
        for (const width of [1024, 390]) {
          const page = await openPageSession(session, { width, height: 844, standalone: false });
          await page.navigateFile(htmlPath);
          let ready = false;
          let harnessError: string | null = null;
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const state = await page.evaluate<{ ready: boolean; error: string | null }>(
              `({ ready: Boolean(window.pendingHeaderReplay), error: window.__pendingHeaderHarnessError })`,
            );
            ready = state.ready;
            harnessError = state.error;
            if (ready || harnessError) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          expect(harnessError, `browser harness error: ${harnessError}`).toBeNull();
          expect(ready, 'browser harness API became ready').toBe(true);
          const frames: FrameMeasure[] = [];
          for (const [label, frame] of [
            ['pending-busy', 'pending'],
            ['assistant-empty-busy', 'empty'],
            ['assistant-streaming-busy', 'streaming'],
            ['assistant-streaming-idle', 'idle'],
            ['assistant-completed', 'completed'],
          ] as const) {
            frames.push(await page.evaluate<FrameMeasure>(
              `window.pendingHeaderReplay.replay(${JSON.stringify(label)}, ${JSON.stringify(frame)})`,
            ));
          }
          await new Promise((resolve) => setTimeout(resolve, 700));
          const finalVisibility = await page.evaluate<string>(
            `getComputedStyle(document.querySelector('h3')).visibility`,
          );
          const shotPath = join(work, `continuity-${width}.png`);
          await page.screenshotPng(shotPath);
          console.info('[pending-header Chrome evidence]', { width, shotPath, finalVisibility, frames });
          expect(finalVisibility).toBe('visible');

          const first = frames[0]!;
          for (const frame of frames) {
            expect(frame.userNode).toBe(first.userNode);
            expect(frame.headerNode).toBe(first.headerNode);
            expect(frame.headerWrapperNode).toBe(first.headerWrapperNode);
            expect(closeEnough(frame.userTop, first.userTop)).toBe(true);
            expect(closeEnough(frame.userHeight, first.userHeight)).toBe(true);
            expect(closeEnough(frame.headerTop, first.headerTop)).toBe(true);
            expect(closeEnough(frame.headerHeight, first.headerHeight)).toBe(true);
            expect(closeEnough(frame.headerWrapperTop, first.headerWrapperTop)).toBe(true);
            expect(closeEnough(frame.headerWrapperHeight, first.headerWrapperHeight)).toBe(true);
          }
          const empty = frames[1]!;
          const busy = frames[2]!;
          const idle = frames[3]!;
          const completed = frames[4]!;
          expect(closeEnough(empty.occupiedHeight, first.occupiedHeight)).toBe(true);
          expect(closeEnough(idle.occupiedHeight, busy.occupiedHeight)).toBe(true);
          expect(completed.bodyNode).toBe(busy.bodyNode);
          expect(closeEnough(completed.bodyTop!, busy.bodyTop!)).toBe(true);
          expect(closeEnough(completed.bodyHeight!, busy.bodyHeight!)).toBe(true);
          expect(closeEnough(completed.headerWrapperTop, busy.headerWrapperTop)).toBe(true);
          expect(closeEnough(completed.headerWrapperHeight, busy.headerWrapperHeight)).toBe(true);
          expect(closeEnough(completed.occupiedHeight, busy.occupiedHeight)).toBe(true);
        }
      } finally {
        await session.close();
      }
    },
    180_000,
  );
});
