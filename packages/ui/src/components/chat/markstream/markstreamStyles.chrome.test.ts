import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { build } from 'vite';
import {
  compileProductionCssAsync, evidenceRoot, keepEvidence, openChromeSession,
  openPageSession, resolveChrome,
} from '../../ui/chromeCdpHarness';

const here = dirname(fileURLToPath(import.meta.url));
const uiSrc = resolve(here, '../../..');
type Measurement = {
  card: Record<string, string>;
  header: Record<string, string>;
  copy: Record<string, string>;
  wrap: Record<string, string>;
  text: string;
  libraryHeaderCount: number;
  codeId: string | null;
  width: number;
};
type Replay = { legacy: Measurement; nested: Measurement; global: Record<string, string> };

describe('Markstream nested legacy code card Chromium styles', () => {
  test.skipIf(!resolveChrome())('preserves legacy chrome in light/dark mobile and A→B→A content', async () => {
    const work = mkdtempSync(join(evidenceRoot(), 'markstream-styles-'));
    const boundary = join(here, 'markstreamStyles.chrome.boundary.fixture.tsx');
    const css = await compileProductionCssAsync(uiSrc);
    await build({
      configFile: false,
      mode: 'production',
      root: join(uiSrc, '..'),
      publicDir: false,
      esbuild: { jsxDev: false },
      resolve: { alias: [
        { find: /^@\/(contexts\/useThemeSystem|hooks\/useEffectiveDirectory|hooks\/useRuntimeAPIs)$/, replacement: boundary },
        { find: '@', replacement: uiSrc },
      ] },
      build: {
        emptyOutDir: false, minify: false, outDir: work,
        lib: {
          entry: join(here, 'markstreamStyles.chrome.fixture.tsx'),
          formats: ['iife'], name: 'MarkstreamStyleFixture',
          fileName: () => 'fixture.js', cssFileName: 'fixture',
        },
      },
    });
    writeFileSync(join(work, 'production.css'), css);
    writeFileSync(join(work, 'index.html'), `<!doctype html><html><head>
      <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <link rel="stylesheet" href="/production.css"><link rel="stylesheet" href="/fixture.css">
      </head><body><div id="root"></div><script>window.process={env:{NODE_ENV:'production'}};window.global=window;</script>
      <script src="/fixture.js"></script></body></html>`);
    // Serve generated worker assets over HTTP so the actual Shiki worker can run.
    const server = createServer((request, response) => {
      const path = resolve(work, `.${new URL(request.url ?? '/', 'http://fixture').pathname}`);
      if (!path.startsWith(`${work}${sep}`)) { response.writeHead(403).end(); return; }
      try {
        const mime: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
        response.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
        response.end(readFileSync(path));
      } catch { response.writeHead(404).end(); }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture HTTP server unavailable');
    const session = await openChromeSession({ width: 390, height: 844 });
    try {
      const page = await openPageSession(session, { width: 390, height: 844, standalone: false });
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await page.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/index.html` });
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await page.evaluate<boolean>('Boolean(window.markstreamStyleReplay)')) break;
        await new Promise((done) => setTimeout(done, 50));
      }
      expect(await page.evaluate('typeof window.markstreamStyleReplay')).toBe('function');
      const evidence: Record<string, unknown> = {};
      for (const dark of [false, true]) {
        const mode = dark ? 'dark' : 'light';
        const first = await page.evaluate<Replay>(`window.markstreamStyleReplay(${dark})`);
        evidence[mode] = first;
        await page.screenshotPng(join(work, `${mode}-390.png`));
        // Capture matching declarations, including nested layers, directly from CSSOM.
        evidence[`${mode}-rules`] = await page.evaluate(`(() => {
          const card = document.querySelector('#nested [data-component="markdown-code"]');
          const header = card.firstElementChild;
          const matches = [];
          const visit = (rules, layers = []) => { for (const rule of rules) {
            if (rule.selectorText && (card.matches(rule.selectorText) || header.matches(rule.selectorText)) && /border/.test(rule.style.cssText)) {
              matches.push({selector: rule.selectorText, style: rule.style.cssText, layers});
            }
            if (rule.cssRules) visit(rule.cssRules, rule.constructor.name === 'CSSLayerBlockRule' ? [...layers, rule.name] : layers);
          }};
          for (const sheet of document.styleSheets) visit(sheet.cssRules);
          return matches;
        })()`);
        evidence[`${mode}-variables`] = await page.evaluate(`(() => {
          const card = document.querySelector('#nested [data-component="markdown-code"]');
          const ancestors = [];
          for (let node = card; node; node = node.parentElement) {
            const css = getComputedStyle(node);
            ancestors.push({class: node.className, border: css.getPropertyValue('--border'), interactiveBorder: css.getPropertyValue('--interactive-border')});
          }
          return ancestors;
        })()`);
      }
      // Lazy loading the library must preserve legacy-only/global border styles.
      evidence['library-disabled'] = await page.evaluate(`(async () => {
        const sheet = document.querySelector('link[href="/fixture.css"]').sheet;
        sheet.disabled = true;
        const result = await window.markstreamStyleReplay(false);
        sheet.disabled = false;
        return result;
      })()`);
      evidence['library-universal-selectors'] = await page.evaluate(`(() => {
        const selectors = [];
        const visit = rules => { for (const rule of rules) {
          if (rule.selectorText?.includes('*')) selectors.push(rule.selectorText);
          if (rule.cssRules) visit(rule.cssRules);
        }};
        visit(document.querySelector('link[href="/fixture.css"]').sheet.cssRules);
        return selectors;
      })()`);
      writeFileSync(join(work, 'computed.json'), JSON.stringify(evidence, null, 2));
      console.info('[Markstream Chromium evidence]', work, Object.fromEntries(
        ['light', 'dark'].map((key) => {
          const result = evidence[key] as Replay;
          return [key, { legacy: result.legacy.card['border-top-color'], nested: result.nested.card['border-top-color'], header: result.nested.header['border-bottom-color'] }];
        }),
      ));
      const standalone = evidence['library-disabled'] as Replay;
      const light = evidence.light as Replay;
      expect(light.legacy.card).toEqual(standalone.legacy.card);
      expect(light.legacy.header).toEqual(standalone.legacy.header);
      expect(light.global).toEqual(standalone.global);
      const reversed = await page.evaluate<Replay>(`(async () => {
        const library = document.querySelector('link[href="/fixture.css"]');
        const production = document.querySelector('link[href="/production.css"]');
        production.before(library);
        const result = await window.markstreamStyleReplay(false);
        production.after(library);
        return result;
      })()`);
      expect(reversed.nested.card).toEqual(light.nested.card);
      expect(reversed.nested.header).toEqual(light.nested.header);
      expect(reversed.nested.copy).toEqual(light.nested.copy);
      expect(reversed.nested.wrap).toEqual(light.nested.wrap);
      for (const mode of ['light', 'dark']) {
        const result = evidence[mode] as Replay;
        expect(result.nested.libraryHeaderCount).toBe(0);
        expect(result.nested.card, `${mode} card`).toEqual(result.legacy.card);
        expect(result.nested.header, `${mode} header`).toEqual(result.legacy.header);
        expect(result.nested.copy, `${mode} copy`).toEqual(result.legacy.copy);
        expect(result.nested.wrap, `${mode} wrap`).toEqual(result.legacy.wrap);
        expect(result.nested.card['border-top-width']).toBe('1px');
        expect(result.nested.card['border-radius']).toBe('16px');
        expect(result.nested.header['border-bottom-width']).toBe('1px');
        expect(result.nested.header['border-top-width']).toBe('0px');
        expect(result.nested.width).toBeLessThanOrEqual(358);
        expect(result.nested.text).toBe(result.legacy.text);
      }
      // Both navigation back to A's IDs and changing content under identical IDs.
      for (const sameIds of [false, true]) {
        const a = await page.evaluate<Replay>(`window.markstreamStyleReplay(false, 'A', ${sameIds})`);
        const b = await page.evaluate<Replay>(`window.markstreamStyleReplay(false, 'B', ${sameIds})`);
        const back = await page.evaluate<Replay>(`window.markstreamStyleReplay(false, 'A', ${sameIds})`);
        expect(b.nested.text).toContain('second sample');
        expect(back.nested.text).toContain('https://example.com/health');
        expect(back.nested.text).toBe(a.nested.text);
        expect(back.nested.codeId).toBe(a.nested.codeId);
        expect(back.nested.card).toEqual(a.nested.card);
      }
      const scroll = await page.evaluate<{ initialHeight: number; heights: number[]; visibility: string[] }>(
        'window.markstreamScrollReplay()',
      );
      writeFileSync(join(work, 'scroll-geometry.json'), JSON.stringify(scroll, null, 2));
      expect(scroll.visibility).toEqual(Array(12).fill('visible'));
      expect(scroll.heights).toEqual(Array(scroll.heights.length).fill(scroll.initialHeight));
    } finally {
      await session.close();
      await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
      if (!keepEvidence()) rmSync(work, { recursive: true, force: true });
    }
  }, 180_000);
});
