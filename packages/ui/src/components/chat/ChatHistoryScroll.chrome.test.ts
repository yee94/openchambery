import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, expect, test } from 'vitest';
import { build } from 'vite';
import { compileProductionCssAsync, evidenceRoot, keepEvidence, openChromeSession, openPageSession, resolveChrome } from '../ui/chromeCdpHarness';

const here = dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
type Sample = { run: string | null; prepared: boolean; top: number; max: number; anchorTop: number | null; anchorOffset: number | null; anchorBottom: number | null; fingerDelta: number; loads: number; pinned: boolean; viewportHeight: number };
const workDirs: string[] = [];

afterAll(() => {
    if (!keepEvidence()) for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!resolveChrome()).each(['normal', 'delayed-resize', 'virtualize-transition', 'continued-drag', 'desktop-short', 'desktop-warmup', 'desktop-warmup-pinned', 'desktop-warmup-small-pinned', 'partial-turn', 'mobile-partial-turn', 'fast-entry', 'fast-entry-desktop-wheel', 'fast-entry-desktop-key', 'compact-prepend', 'compact-prepend-desktop', 'turn-prepend', 'turn-prepend-desktop'] as const)('history prepend keeps the reading row (%s)', async (scenario) => {
    const fastEntry = scenario.startsWith('fast-entry');
    const desktop = scenario.includes('desktop') || scenario === 'partial-turn';
    const width = desktop ? 1200 : 402;
    const height = desktop ? 800 : 874;
    const partialTurn = scenario === 'partial-turn' || scenario === 'mobile-partial-turn';
    const pinnedWarmup = scenario.startsWith('desktop-warmup') && scenario.endsWith('-pinned');
    const work = mkdtempSync(join(evidenceRoot(), 'history-scroll-'));
    workDirs.push(work);
    await build({
        configFile: false, logLevel: 'error', mode: 'production', esbuild: { jsxDev: false }, root: join(here, '../../..'), publicDir: false,
        resolve: { alias: { '@': join(here, '../..'), '@openchamber/ui': join(here, '../..') } },
        worker: { format: 'es' },
        build: {
            outDir: work, emptyOutDir: false, minify: false,
            lib: { entry: join(here, 'ChatHistoryScroll.fixture.tsx'), formats: ['es'], name: 'HistoryScroll', fileName: () => 'entry.js' },
        },
    });
    const html = join(work, 'index.html');
    const css = await compileProductionCssAsync(join(here, '../..'));
    writeFileSync(html, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\nhtml,body,#root{margin:0;height:100%;overflow:hidden}</style></head><body><div id="root"></div><script>
window.process={env:{NODE_ENV:'production'}};window.global=window;window.__OPENCHAMBER_SURFACE__='${desktop ? 'web' : 'mobile'}';window.errors=[];window.resizeWarnings=0;
window.addEventListener('error',e=>{
  if(e.message==='ResizeObserver loop completed with undelivered notifications.')window.resizeWarnings++;
  else window.errors.push(e.message);
});
</script><script type="module" src="/entry.js"></script></body></html>`);
    console.info('[history-scroll fixture]', html);
    writeFileSync(join(work, 'scenario.json'), JSON.stringify({ scenario, width, height }));
    const samples: Sample[] = [];
    const server = createServer((req, res) => {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (path === '/sample') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => { samples.push(JSON.parse(body)); res.end('ok'); });
            return;
        }
        try {
            res.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : 'text/html');
            res.end(readFileSync(join(work, path === '/' ? 'index.html' : path)));
        } catch { res.writeHead(404).end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server missing address');
    const browser = await openChromeSession({ width, height });
    try {
        const page = await openPageSession(browser, { width, height, standalone: false });
        if (desktop) await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await page.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/?scenario=${scenario}` });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect(await page.evaluate('window.errors')).toEqual([]);
        expect((await page.evaluate<Sample>('window.historyScrollFixture.sample()')).loads).toBe(0);
        const opened = await page.evaluate<Sample>('window.historyScrollFixture.sample()');
        expect(Math.abs(opened.max - opened.top), 'cold open must reach the bottom without an out-of-range initial offset').toBeLessThan(3);
        await page.evaluate('window.historyScrollFixture.prepare()');
        const prepared = await page.evaluate<Sample>('window.historyScrollFixture.sample()');
        let releasedReadingDistance: number | null = null;
        expect(prepared.loads).toBe(0);
        if (partialTurn) {
            expect(await page.evaluate('getComputedStyle(document.querySelector("[data-history-scroller]")).overflowY')).toBe('auto');
            expect(await page.evaluate('document.body.textContent.includes("HIDDEN_PARTIAL_PROCESS")')).toBe(false);
            await page.evaluate('void (window.retainedAnswer = document.querySelector(\'[data-message-id="partial-final"]\'))');
        }
        if (scenario.startsWith('desktop-warmup')) {
            await page.evaluate(`window.retainedWarmupRow = document.querySelector('[data-message-id="message-100"]');
                window.retainedWarmupBody = window.retainedWarmupRow.querySelector('p');
                window.warmupHides = [];
                const revealRoot = document.querySelector('[data-markdown-pin-reveal]');
                new MutationObserver(records => {
                    for (const record of records) {
                        if (record.oldValue?.includes('hidden') || revealRoot.style.visibility === 'hidden') {
                            window.warmupHides.push(record.oldValue);
                        }
                    }
                }).observe(revealRoot, { attributes: true, attributeOldValue: true, attributeFilter: ['style'] });`);
            await page.evaluate(`new Promise((resolve, reject) => {
                const started = performance.now();
                const tick = () => {
                    if (window.historyScrollFixture.sample().loads === 1 && document.querySelector('[data-message-id="${scenario === 'desktop-warmup-small-pinned' ? 'message-005' : 'message-049'}"]')) return resolve();
                    if (performance.now() - started > 10000) return reject(new Error('warmup did not commit'));
                    requestAnimationFrame(tick);
                }; tick();
            })`);
            expect(await page.evaluate('window.retainedWarmupRow.isConnected'), 'existing history DOM must survive virtualization activation').toBe(true);
            expect(await page.evaluate('window.retainedWarmupBody?.isConnected'), 'painted Markdown must not return to a skeleton').toBe(true);
        } else if (scenario === 'fast-entry-desktop-key') {
            await page.evaluate('document.querySelector("[data-history-scroller]").tabIndex = -1; document.querySelector("[data-history-scroller]").focus({preventScroll:true})');
            await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 });
            await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 });
            expect((await page.evaluate<Sample>('window.historyScrollFixture.sample()')).pinned).toBe(false);
        } else if (scenario === 'fast-entry-desktop-wheel') {
            await page.evaluate('void (window.firstHistoryWheel = new Promise(resolve => document.querySelector("[data-history-scroller]").addEventListener("wheel", () => requestAnimationFrame(resolve), {once:true})))');
            await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 400, deltaX: 0, deltaY: -900 });
            await page.evaluate('window.firstHistoryWheel');
            expect((await page.evaluate<Sample>('window.historyScrollFixture.sample()')).pinned).toBe(false);
        } else if (desktop) {
            if (scenario === 'desktop-short') expect(prepared.max).toBe(0);
            await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 180, y: 400, deltaX: 0, deltaY: -100 });
        } else if (fastEntry) {
            await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 180, y: 200 }] });
            await page.evaluate('new Promise(requestAnimationFrame)');
            await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 180, y: 280 }] });
            expect((await page.evaluate<Sample>('window.historyScrollFixture.sample()')).pinned,
                'the first new drag must release entry-stick before the next fling frame').toBe(false);
            // Frame-paced, equal-distance samples give Chromium a real fling
            // velocity instead of two IPC-timed jumps whose prediction can reverse.
            for (const y of [360, 440, 520, 600, 680, 760]) {
                await page.evaluate('new Promise(requestAnimationFrame)');
                await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 180, y }] });
            }
            await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            const released = await page.evaluate<Sample>('window.historyScrollFixture.sample()');
            releasedReadingDistance = released.max - released.top;
            expect(releasedReadingDistance, 'the drag must actually move away from the live edge').toBeGreaterThan(400);
        } else {
            await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 180, y: 400 }] });
            await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 180, y: 420 }] });
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const before = await page.evaluate<Sample>('window.historyScrollFixture.sample()');
        if (!fastEntry && !desktop) await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const after = await page.evaluate<Sample>('window.historyScrollFixture.sample()');
        console.info('[history-scroll positions]', { before, after });
        expect(after.loads).toBe(1);
        expect(after.max - prepared.max, 'the fetched history must actually be rendered').toBeGreaterThan(partialTurn ? 100 : desktop ? 500 : 2000);
        if (partialTurn) {
            expect(await page.evaluate('document.querySelector(\'[data-message-id="partial-final"]\') === window.retainedAnswer')).toBe(true);
            expect(await page.evaluate('getComputedStyle(document.querySelector("[data-history-scroller]")).overflowY')).toBe('auto');
            expect(await page.evaluate('document.body.textContent.includes("HIDDEN_EARLIER_PROCESS")')).toBe(false);
            expect(Math.abs(after.anchorTop! - after.anchorOffset! - after.fingerDelta), 'enriching the turn must preserve the answer reading position').toBeLessThan(scenario === 'partial-turn' ? 3 : 24);
        }
        if (scenario.startsWith('desktop-warmup')) {
            expect(await page.evaluate('window.warmupHides'), 'background history must never hide the painted transcript').toEqual([]);
        }
        if (releasedReadingDistance !== null) {
            // Preserve the distance the real gesture reached. Native inertia
            // may carry it farther, but prepending must never pull it back.
            expect(after.max - after.top).toBeGreaterThanOrEqual(releasedReadingDistance - 24);
        } else if (scenario !== 'desktop-short' && !pinnedWarmup) {
            expect(after.max - after.top).toBeGreaterThan(scenario === 'virtualize-transition' || scenario === 'desktop-warmup' ? 100 : desktop && fastEntry ? 500 : 1000);
        }
        if (pinnedWarmup) expect(Math.abs(after.max - after.top)).toBeLessThan(1);
        if (scenario === 'desktop-warmup-small-pinned') {
            expect(await page.evaluate('document.querySelectorAll("[data-turn-entry][data-index]").length'), 'short desktop history must stay in normal flow below twelve history entries').toBe(0);
        }
        if (scenario === 'desktop-warmup') {
            expect(Math.abs(after.anchorTop! - after.anchorOffset!), 'background prepend must retain the exact reading offset').toBeLessThan(1);
            expect(await page.evaluate('window.retainedWarmupRow.isConnected && window.retainedWarmupBody.isConnected')).toBe(true);
        }
        if (pinnedWarmup) {
            expect(after.pinned).toBe(true);
        } else if (fastEntry) {
            expect(after.pinned, 'a fresh fling during entry must cancel follow before history arrives').toBe(false);
        } else {
            expect(after.anchorTop).not.toBeNull();
            expect(after.anchorTop!).toBeLessThan(after.viewportHeight);
            expect(after.anchorBottom!).toBeGreaterThan(0);
        }
        if (scenario === 'normal') {
            await page.evaluate('window.historyScrollFixture.resume()');
            await new Promise((resolve) => setTimeout(resolve, 700));
            const bottom = await page.evaluate<Sample>('window.historyScrollFixture.sample()');
            expect(Math.abs(bottom.max - bottom.top), 'jump must land at the live edge').toBeLessThan(3);
            await page.evaluate('window.historyScrollFixture.grow()');
            await new Promise((resolve) => setTimeout(resolve, 700));
            const grown = await page.evaluate<Sample>('window.historyScrollFixture.sample()');
            expect(grown.max).toBeGreaterThan(bottom.max);
            expect(Math.abs(grown.max - grown.top), 'late growth must retain the bottom pin').toBeLessThan(3);
            await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 180, y: 400, deltaX: 0, deltaY: -400 });
            await new Promise((resolve) => setTimeout(resolve, 400));
            const released = await page.evaluate<Sample>('window.historyScrollFixture.sample()');
            expect(released.pinned).toBe(false);
            await page.evaluate('window.historyScrollFixture.grow()');
            await new Promise((resolve) => setTimeout(resolve, 700));
            const reading = await page.evaluate<Sample>('window.historyScrollFixture.sample()');
            expect(Math.abs(reading.top - released.top), 'growth must not pull the reader back after a wheel release').toBeLessThan(3);
            expect(reading.pinned).toBe(false);
        }
        if (process.env.IOS_HISTORY_SIM === '1' && !desktop) {
            const app = join(work, 'HistoryScroll.app');
            mkdirSync(app);
            const { stdout: sdk } = await exec('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']);
            await exec('xcrun', ['swiftc', '-parse-as-library', join(here, 'ChatHistoryScroll.ios.fixture.swift'), '-sdk', sdk.trim(),
                '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-ios18.0-simulator`,
                '-o', join(app, 'HistoryScroll')]);
            writeFileSync(join(app, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.openchamber.history-regression</string>
<key>CFBundleExecutable</key><string>HistoryScroll</string><key>CFBundleName</key><string>HistoryScroll</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string><key>UILaunchScreen</key><dict/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>
</dict></plist>`);
            await exec('codesign', ['--force', '--sign', '-', app]);
            await exec('xcrun', ['simctl', 'install', 'booted', app]);
            const run = String(Date.now());
            await exec('xcrun', ['simctl', 'launch', '--terminate-running-process', 'booted',
                'org.openchamber.history-regression', `http://127.0.0.1:${address.port}/?native=1&run=${run}&scenario=${scenario}`]);
            const deadline = Date.now() + 15000;
            while (!samples.some((item) => item.run === run && item.prepared && item.loads === 0 && item.top > 0 && (fastEntry || item.top < 1200))) {
                if (Date.now() > deadline) throw new Error('iOS fixture did not reach the history read position');
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            await exec('xcrun', ['simctl', 'io', 'booted', 'screenshot', join(work, 'ios-before.png')]);
            const gestures = fastEntry
                ? [['begin', .2], ['move', .6], ['move', .85], ['end', .85]] as const
                : scenario === 'delayed-resize' || scenario === 'virtualize-transition'
                ? [['begin', .4], ['move', .42], ['end', .42]] as const
                : [['begin', .4], ['move', .42], ['move', .46], ['move', .5], ['move', .53], ['end', .53]] as const;
            let held: Sample | undefined;
            for (const [type, y] of gestures) {
                if (!fastEntry && scenario !== 'normal' && type === 'end') {
                    await new Promise((resolve) => setTimeout(resolve, 1800));
                    held = samples.filter((item) => item.run === run).at(-1);
                }
                await exec(process.execPath, [join(here, '../../../../mobile/node_modules/serve-sim/dist/serve-sim.js'), 'gesture', JSON.stringify({ type, x: .5, y })]);
                await new Promise((resolve) => setTimeout(resolve, 60));
            }
            if (!fastEntry && scenario !== 'normal') {
                writeFileSync(join(work, 'ios-held-samples.json'), JSON.stringify(samples.filter((item) => item.run === run), null, 2));
                expect(held?.loads).toBe(1);
                expect(held?.anchorTop).not.toBeNull();
                expect(Math.abs(held!.anchorTop! - held!.anchorOffset! - held!.fingerDelta), 'loading must not move the reading row under a held finger').toBeLessThan(24);
            }
            if (fastEntry) {
                const initialMax = samples.find((item) => item.run === run && item.prepared && item.loads === 0)!.max;
                const settleDeadline = Date.now() + 10000;
                while ((samples.filter((item) => item.run === run).at(-1)?.max ?? initialMax) - initialMax < 2000) {
                    if (Date.now() > settleDeadline) throw new Error('iOS fling settled without adopting fetched history');
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 2500));
            const native = samples.filter((item) => item.run === run);
            const last = native.at(-1)!;
            writeFileSync(join(work, 'ios-samples.json'), JSON.stringify(native, null, 2));
            await exec('xcrun', ['simctl', 'io', 'booted', 'screenshot', join(work, 'ios-after.png')]);
            console.info('[iOS history evidence]', JSON.stringify({ firstLoaded: native.find((item) => item.loads), last }));
            expect(last.loads).toBe(1);
            const prepared = native.find((item) => item.prepared && item.loads === 0)!;
            expect(last.max - prepared.max, 'iOS must render the fetched history after the gesture settles').toBeGreaterThan(partialTurn ? 100 : 2000);
            expect(last.max - last.top, 'iOS must keep reading history rather than return to the live edge').toBeGreaterThan(scenario === 'virtualize-transition' ? 100 : 1000);
            expect(last.pinned).toBe(false);
            if (!fastEntry) {
                expect(last.anchorTop).not.toBeNull();
                expect(last.anchorTop!).toBeLessThan(last.viewportHeight);
                expect(last.anchorBottom!).toBeGreaterThan(0);
            }
            if (!fastEntry && scenario !== 'normal') {
                expect(Math.abs(last.anchorTop! - last.anchorOffset! - last.fingerDelta), 'the reading anchor must move only by the physical finger travel').toBeLessThan(24);
            }
        }
        console.info('[history ResizeObserver deferred notifications]', await page.evaluate('window.resizeWarnings'));
        expect(await page.evaluate('window.errors')).toEqual([]);
    } finally {
        await browser.close();
        if (process.env.IOS_HISTORY_SIM === '1') {
            await exec('xcrun', ['simctl', 'terminate', 'booted', 'org.openchamber.history-regression']).catch(() => undefined);
            await exec('xcrun', ['simctl', 'uninstall', 'booted', 'org.openchamber.history-regression']);
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}, 60_000);
