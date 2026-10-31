import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { expect, test } from 'vitest';
import { evidenceRoot, keepEvidence, openChromeSession, openPageSession, resolveChrome } from '../../components/ui/chromeCdpHarness';

test('standalone avatar CPU budgets and production lifecycle', async () => {
  if (!resolveChrome()) throw new Error('Avatar performance gate requires Chrome/Chromium; it must not silently skip.');
  const repo = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
  const evidence = evidenceRoot();
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const result = await build({
    configFile: join(repo, 'scripts/experiments/assistant-avatar/vite.config.mts'),
    logLevel: 'error',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    resolve: { alias: { 'react-dom/client': 'react-dom/profiling' } },
    build: {
      write: false, emptyOutDir: false,
      lib: { entry: join(repo, 'scripts/experiments/assistant-avatar/performance.tsx'), name: 'AvatarPerformanceFixture', formats: ['iife'] },
    },
  }).finally(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });
  const bundle = (Array.isArray(result) ? result[0] : result);
  if (!('output' in bundle)) throw new Error('Expected a standalone avatar browser bundle');
  const code = bundle.output.find((item) => item.type === 'chunk')?.code;
  if (!code) throw new Error('Avatar browser fixture did not build');
  const css = bundle.output.filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item) => item.type === 'asset' ? (typeof item.source === 'string' ? item.source : Buffer.from(item.source).toString()) : '').join('\n');
  const html = join(evidence, 'avatar-performance.html');
  writeFileSync(html, `<!doctype html><html><body><style>${css}</style><script>window.addEventListener('error',event=>window.avatarFixtureError=event.message);</script><script>${code.replaceAll('</script', '<\\/script')}</script></body></html>`);
  const chrome = await openChromeSession({ width: 1200, height: 700 });
  try {
    const page = await openPageSession(chrome, { width: 1200, height: 700, standalone: false });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 700, deviceScaleFactor: 1, mobile: false });
    await page.navigateFile(html);
    expect(await page.evaluate('window.avatarFixtureError ?? null')).toBeNull();
    expect(await page.evaluate('matchMedia("(any-hover: hover) and (any-pointer: fine)").matches')).toBe(true);
    type Sample = { count: number; motion: string; randomizeShape: boolean; samples: number; median: number; p95: number; max: number };
    const samples = await page.evaluate<Sample[]>('[avatarPerformance.benchmark(1,"idle",true),avatarPerformance.benchmark(20,"idle"),avatarPerformance.benchmark(20,"working")]');
    writeFileSync(join(evidence, 'avatar-performance.json'), JSON.stringify(samples, null, 2));
    console.log('Avatar CPU budgets (model + SVG writes, ms):', samples);
    expect(samples[0].p95).toBeLessThan(4);
    expect(samples[1].p95).toBeLessThan(8);
    expect(samples[2].p95).toBeLessThan(10);
    await page.evaluate('avatarPerformance.mount(20)');
    expect(await page.evaluate('avatarPerformance.commits()')).toBeGreaterThan(0);
    const pointerListeners = async () => {
      const { result } = await page.send('Runtime.evaluate', { expression: 'window' });
      const { listeners } = await page.send('DOMDebugger.getEventListeners', { objectId: (result as { objectId: string }).objectId });
      return (listeners as Array<{ type: string }>).filter((listener) => listener.type === 'pointermove').length;
    };
    expect(await pointerListeners()).toBe(1);
    expect(await page.evaluate('avatarPerformance.pointerBurst()')).toEqual({ reads: 0, writes: 0, commits: 0 });
    expect(await page.evaluate('document.querySelectorAll("[data-avatar-active=true]").length')).toBe(20);
    expect(await page.evaluate('[...document.querySelectorAll("[data-procedural-avatar] svg")].every(svg=>svg.getBoundingClientRect().width===44 && svg.getBoundingClientRect().height===44)')).toBe(true);
    expect(await page.evaluate('avatarPerformance.updateUnrelated()')).toEqual({ writes: 0 });
    const live = await page.evaluate<{ commits: number; writes: number; active: number }>('avatarPerformance.steady()');
    expect(live.commits).toBe(0);
    expect(live.writes).toBeGreaterThan(0);
    await page.evaluate('avatarPerformance.mount(20,0,"idle")');
    expect(await pointerListeners()).toBe(1);
    expect(await page.evaluate('avatarPerformance.pointerBurst()')).toEqual({ reads: 0, writes: 0, commits: 0 });
    const idle = await page.evaluate<{ commits: number; writes: number; active: number }>('avatarPerformance.steady()');
    expect(idle.commits).toBe(0);
    expect(idle.writes).toBeGreaterThan(0);
    await page.evaluate('avatarPerformance.mount(20,0,"idle",false)');
    expect(await pointerListeners()).toBe(0);
    expect(await page.evaluate('avatarPerformance.pointerBurst()')).toEqual({ reads: 0, writes: 0, commits: 0 });
    expect(await page.evaluate('avatarPerformance.steady()')).toEqual({ commits: 0, writes: 0, active: 20 });
    expect(await page.evaluate('avatarPerformance.synchronized()')).toEqual(Array(20).fill(true));
    expect(await pointerListeners()).toBe(0);
    const synchronized = await page.evaluate<{ commits: number; writes: number; active: number }>('avatarPerformance.steady()');
    expect(synchronized.commits).toBe(0);
    expect(synchronized.writes).toBeGreaterThan(0);
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await page.evaluate('avatarPerformance.mount(20,0,"idle")');
    expect(await page.evaluate('matchMedia("(any-hover: hover) and (any-pointer: fine)").matches')).toBe(false);
    expect(await pointerListeners()).toBe(0);
    expect(await page.evaluate('avatarPerformance.steady()')).toEqual({ commits: 0, writes: 0, active: 20 });
    await page.evaluate('avatarPerformance.mount(20)');
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page.evaluate('avatarPerformance.steady()');
    expect(await page.evaluate('avatarPerformance.steady()')).toEqual({ commits: 0, writes: 0, active: 0 });
    expect(await pointerListeners()).toBe(0);
    await page.evaluate('avatarPerformance.unmount()');
    expect(await page.evaluate('document.querySelectorAll("[data-procedural-avatar]").length')).toBe(0);
  } finally {
    await chrome.close();
    if (!keepEvidence()) rmSync(evidence, { recursive: true, force: true });
  }
}, 120_000);
